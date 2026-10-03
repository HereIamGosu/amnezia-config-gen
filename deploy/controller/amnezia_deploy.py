#!/usr/bin/env python3
"""amnezia-deploy — pull-based blue/green deployment controller for awgconfig.com.

The VPS pulls; nothing pushes to it. The controller discovers the latest CI-published image in
GHCR (``:main`` is only a discovery pointer), verifies tag <-> digest <-> revision, starts it in the
inactive slot (loopback only, production hardening), checks it, switches the nginx upstream file
(the only nginx file it owns), proves through the public hostname that the target release answers
(``X-App-Revision``), and rolls back otherwise. Containers always run from ``image@sha256:...``.

Commands: status | check | deploy [SHA] | rollback | finalize | reconcile | pause | resume |
bootstrap --legacy-sha SHA. Run ``amnezia-deploy -h``. Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
try:
    import fcntl  # Linux only (the VPS); absent on Windows dev machines
except ImportError:  # pragma: no cover
    fcntl = None
import hashlib
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

# --- trusted, fixed identity (never taken from input) ----------------------------------------
REGISTRY = "ghcr.io"
REPOSITORY = "hereiamgosu/amnezia-config-gen"
IMAGE = f"{REGISTRY}/{REPOSITORY}"
CHANNEL_TAG = "main"
SOURCE_URL = "https://github.com/HereIamGosu/amnezia-config-gen"
PUBLIC_HOST = "awgconfig.com"
ARCHITECTURE = "amd64"

SLOTS = {
    "blue": {"port": 13100, "name": "amnezia-web-blue"},
    "green": {"port": 13101, "name": "amnezia-web-green"},
}
LEGACY_NAME = "amnezia-web"  # bootstrap occupant of the blue port (deploy/deploy.sh era)
OTHER = {"blue": "green", "green": "blue"}

# Production hardening, identical to deploy/docker-compose.yml.
MEMORY_BYTES = 256 * 1024 * 1024
NANO_CPUS = 1_000_000_000
PIDS_LIMIT = 128

HEALTH_DEADLINE_S = 90  # image HEALTHCHECK: interval 30s, start period 10s
PUBLIC_PROPAGATION_S = 15
RATE_LIMIT_WAIT_S = 90  # nginx amnezia_api zone: 30 r/min per IP (a token every 2 s), Retry-After 30
GRACE_S = 300
KNOWN_GOOD_KEEP = 4
SMOKE_LATENCY_LIMIT_S = 5.0

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
MANIFEST_TYPES = {
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
}
ACCEPT = ",".join(sorted(MANIFEST_TYPES) + [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
])

STAGES = ("DISCOVER", "PULL", "VERIFY", "PREPARE_SLOT", "START_CANDIDATE", "WAIT_HEALTH",
          "CANDIDATE_SMOKE", "SWITCH_PREPARE", "NGINX_TEST", "NGINX_RELOAD", "PUBLIC_SMOKE",
          "COMMIT_STATE", "GRACE", "STOP_OLD", "SUCCESS")


class Paths:
    def __init__(self, state_dir="/var/lib/amnezia-deploy", conf_dir="/etc/amnezia-deploy",
                 upstream_file="/etc/nginx/amnezia-deploy/upstream.conf"):
        self.state_dir = state_dir
        self.conf_dir = conf_dir
        self.upstream_file = upstream_file

    def __getattr__(self, name):
        files = {"state": "state.json", "attempt": "last-attempt.json", "event": "last-event.json",
                 "lock": "lock", "active_revision": "active-revision", "failed": "failed-digests.json"}
        if name in files:
            return os.path.join(self.state_dir, files[name])
        if name == "paused":
            return os.path.join(self.conf_dir, "paused")
        if name == "keep_old":
            return os.path.join(self.conf_dir, "keep-old-slot")
        raise AttributeError(name)


class DeployError(Exception):
    def __init__(self, stage, category, message, retry_after=None):
        super().__init__(message)
        self.stage = stage
        self.category = category
        self.retry_after = retry_after


class NeedsReconciliation(Exception):
    pass


# --- small utilities ---------------------------------------------------------------------------
def now_iso(t=None):
    return dt.datetime.fromtimestamp(time.time() if t is None else t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def write_atomic(path, text, mode=0o644):
    """tmp in the same directory -> fsync -> rename -> fsync(dir)."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    if os.name == "posix":  # make the rename itself durable
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


def write_json(path, data):
    write_atomic(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


# --- real system adapter (replaced by a fake in tests) -----------------------------------------
class _SniHTTPSConnection(http.client.HTTPSConnection):
    """Connects to 127.0.0.1 but speaks TLS/SNI/Host for PUBLIC_HOST — the real public path
    through nginx, without depending on external DNS."""

    def connect(self):
        sock = socket.create_connection(("127.0.0.1", 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=PUBLIC_HOST)


class System:
    def __init__(self):
        self._token = None

    # processes
    def run(self, args, timeout=120, check=True):
        res = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if check and res.returncode != 0:
            raise RuntimeError(f"{' '.join(args[:3])}… exited {res.returncode}: {res.stderr.strip()[:300]}")
        return res

    def docker_inspect(self, name):
        res = self.run(["docker", "inspect", "--type", "container", name], check=False)
        if res.returncode != 0:
            return None
        return json.loads(res.stdout)[0]

    def image_inspect(self, ref):
        res = self.run(["docker", "image", "inspect", ref], check=False)
        if res.returncode != 0:
            return None
        return json.loads(res.stdout)[0]

    def docker(self, *args, timeout=300):
        return self.run(["docker", *args], timeout=timeout)

    def image_refs(self):
        res = self.run(["docker", "image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}", IMAGE], check=False)
        return [line for line in res.stdout.split() if DIGEST_RE.match(line.split("@")[-1])]

    # nginx
    def nginx_test(self):
        res = self.run(["nginx", "-t"], check=False)
        return res.returncode == 0, res.stderr.strip()[-500:]

    def nginx_reload(self):
        res = self.run(["systemctl", "reload", "nginx"], check=False)
        return res.returncode == 0, res.stderr.strip()[-500:]

    # registry (anonymous pull token; the package is public)
    def _registry(self, path, accept=None):
        if self._token is None:
            with urllib.request.urlopen(f"https://{REGISTRY}/token?scope=repository:{REPOSITORY}:pull", timeout=20) as r:
                self._token = json.load(r)["token"]
        req = urllib.request.Request(f"https://{REGISTRY}/v2/{REPOSITORY}/{path}",
                                     headers={"Authorization": f"Bearer {self._token}", **({"Accept": accept} if accept else {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
        except urllib.error.HTTPError as err:
            return err.code, {}, b""

    def registry_manifest(self, reference):
        return self._registry(f"manifests/{reference}", ACCEPT)

    def registry_blob(self, digest):
        return self._registry(f"blobs/{digest}")

    # http
    def http_get(self, port, path, timeout=10):
        return self._request(http.client.HTTPConnection("127.0.0.1", port, timeout=timeout), path, "127.0.0.1")

    def public_get(self, path, timeout=15):
        return self._request(_SniHTTPSConnection(PUBLIC_HOST, 443, timeout=timeout, context=ssl.create_default_context()), path, PUBLIC_HOST)

    @staticmethod
    def _request(conn, path, host):
        started = time.monotonic()
        try:
            conn.request("GET", path, headers={"Host": host, "User-Agent": "amnezia-deploy", "Connection": "close"})
            resp = conn.getresponse()
            body = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, body, time.monotonic() - started
        finally:
            conn.close()

    def schedule_finalize(self, seconds, op_id):
        """One-shot transient timer for the end of the grace period (not the deployment timer)."""
        res = self.run(["systemd-run", f"--unit=amnezia-deploy-finalize-{op_id}", f"--on-active={int(seconds)}",
                        "--description=amnezia-deploy: stop the old slot after the grace period",
                        "/usr/local/sbin/amnezia-deploy", "finalize"], check=False)
        return res.returncode == 0

    # misc
    def time(self):
        return time.time()

    def sleep(self, seconds):
        time.sleep(seconds)

    def log(self, record):
        line = json.dumps(record, sort_keys=True)
        print(line, flush=True)
        try:
            import syslog
            syslog.openlog("amnezia-deploy")
            syslog.syslog(syslog.LOG_INFO, line)
        except Exception:  # noqa: BLE001 — logging must never break a deployment
            pass


# --- registry discovery ------------------------------------------------------------------------
class Candidate:
    def __init__(self, sha, digest, config_digest):
        self.sha, self.digest, self.config_digest = sha, digest, config_digest

    @property
    def ref(self):
        return f"{IMAGE}@{self.digest}"

    def as_dict(self):
        return {"source_sha": self.sha, "image_digest": self.digest, "config_digest": self.config_digest}


def _manifest(sysm, reference):
    status, headers, body = sysm.registry_manifest(reference)
    if status == 404:
        raise DeployError("DISCOVER", "not_found", f"{IMAGE}:{reference} does not exist")
    if status != 200:
        raise DeployError("DISCOVER", "registry_error", f"registry answered {status} for {reference}")
    digest = "sha256:" + sha256_hex(body)
    if headers.get("docker-content-digest") not in (None, digest):
        raise DeployError("DISCOVER", "digest_mismatch", f"manifest bytes do not match the announced digest for {reference}")
    manifest = json.loads(body)
    media = manifest.get("mediaType") or headers.get("content-type", "").split(";")[0]
    if media not in MANIFEST_TYPES or "config" not in manifest:
        raise DeployError("DISCOVER", "unsupported_manifest", f"{reference} is not a single-platform image manifest ({media})")
    return digest, manifest


def discover(sysm, sha=None):
    """:main (or the given SHA tag) -> digest -> config -> revision; the SHA tag must resolve to
    the same digest. Returns the immutable candidate."""
    if sha is not None and not SHA_RE.match(sha):
        raise DeployError("DISCOVER", "bad_input", "a deployment SHA must be a full 40-character commit SHA")
    reference = sha or CHANNEL_TAG
    digest, manifest = _manifest(sysm, reference)
    config_digest = manifest["config"]["digest"]
    if not DIGEST_RE.match(config_digest):
        raise DeployError("DISCOVER", "unsupported_manifest", "config digest has an unexpected format")
    status, _, blob = sysm.registry_blob(config_digest)
    if status != 200 or "sha256:" + sha256_hex(blob) != config_digest:
        raise DeployError("VERIFY", "config_mismatch", "image config blob is missing or does not match its digest")
    config = json.loads(blob)
    labels = (config.get("config") or {}).get("Labels") or {}
    env = dict(e.split("=", 1) for e in (config.get("config") or {}).get("Env") or [] if "=" in e)
    revision = labels.get("org.opencontainers.image.revision", "")
    problems = []
    if not SHA_RE.match(revision):
        problems.append(f"revision label {revision!r} is not a full SHA")
    if env.get("APP_REVISION") != revision:
        problems.append("APP_REVISION does not match the revision label")
    if labels.get("org.opencontainers.image.source") != SOURCE_URL:
        problems.append("image source label is not this repository")
    if config.get("architecture") != ARCHITECTURE or config.get("os") != "linux":
        problems.append(f"platform {config.get('os')}/{config.get('architecture')} does not fit this host")
    if (config.get("config") or {}).get("User") != "node":
        problems.append("image does not run as the non-root user node")
    if sha is not None and revision != sha:
        problems.append(f"tag {sha} holds revision {revision}")
    if problems:
        raise DeployError("VERIFY", "metadata_mismatch", "; ".join(problems))
    if sha is None:
        tag_digest, _ = _manifest(sysm, revision)
        if tag_digest != digest:
            raise DeployError("VERIFY", "tag_mismatch", f":{CHANNEL_TAG} and :{revision} resolve to different digests")
    return Candidate(revision, digest, config_digest)


# --- containers --------------------------------------------------------------------------------
def container_name(sysm, slot):
    """Controller-named container, or the legacy bootstrap container for blue."""
    name = SLOTS[slot]["name"]
    if sysm.docker_inspect(name) is not None:
        return name
    if slot == "blue":
        legacy = sysm.docker_inspect(LEGACY_NAME)
        if legacy is not None and _host_port(legacy) == SLOTS["blue"]["port"]:
            return LEGACY_NAME
    return name


def _host_port(info):
    bindings = ((info.get("HostConfig") or {}).get("PortBindings") or {}).get("3000/tcp") or []
    for b in bindings:
        if b.get("HostIp") == "127.0.0.1" and str(b.get("HostPort", "")).isdigit():
            return int(b["HostPort"])
    return None


def container_revision(info):
    labels = (info.get("Config") or {}).get("Labels") or {}
    return labels.get("amnezia.deploy.sha") or labels.get("org.opencontainers.image.revision")


def describe_container(sysm, slot):
    name = container_name(sysm, slot)
    info = sysm.docker_inspect(name)
    if info is None:
        return {"slot": slot, "name": name, "exists": False}
    state = info.get("State") or {}
    labels = (info.get("Config") or {}).get("Labels") or {}
    return {
        "slot": slot, "name": name, "exists": True, "legacy": name == LEGACY_NAME,
        "running": bool(state.get("Running")), "health": (state.get("Health") or {}).get("Status"),
        "revision": container_revision(info), "digest": labels.get("amnezia.deploy.digest"),
        "port": _host_port(info),
    }


def constraint_problems(info, slot):
    hc = info.get("HostConfig") or {}
    problems = []
    if not hc.get("ReadonlyRootfs"):
        problems.append("root filesystem is writable")
    if [c.upper() for c in hc.get("CapDrop") or []] != ["ALL"]:
        problems.append("capabilities are not all dropped")
    if not any(o.startswith("no-new-privileges") for o in hc.get("SecurityOpt") or []):
        problems.append("no-new-privileges is not set")
    if hc.get("Memory") != MEMORY_BYTES:
        problems.append("memory limit differs")
    if hc.get("NanoCpus") != NANO_CPUS:
        problems.append("cpu limit differs")
    if hc.get("PidsLimit") != PIDS_LIMIT:
        problems.append("pids limit differs")
    if (hc.get("LogConfig") or {}).get("Type") != "json-file" or (hc.get("LogConfig") or {}).get("Config", {}).get("max-size") != "10m":
        problems.append("log limits differ")
    if (info.get("Config") or {}).get("User") != "node":
        problems.append("container does not run as node")
    bindings = (hc.get("PortBindings") or {}).get("3000/tcp") or []
    if [(b.get("HostIp"), str(b.get("HostPort"))) for b in bindings] != [("127.0.0.1", str(SLOTS[slot]["port"]))]:
        problems.append(f"port binding is not exactly 127.0.0.1:{SLOTS[slot]['port']}")
    if (hc.get("RestartPolicy") or {}).get("Name") != "unless-stopped":
        problems.append("restart policy is not unless-stopped")
    return problems


def run_args(slot, cand):
    name, port = SLOTS[slot]["name"], SLOTS[slot]["port"]
    return [
        "run", "-d", "--name", name, "--restart", "unless-stopped",
        "-p", f"127.0.0.1:{port}:3000",
        "--read-only", "--tmpfs", "/tmp:size=16m", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--memory", str(MEMORY_BYTES), "--cpus", "1", "--pids-limit", str(PIDS_LIMIT),
        "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        "--stop-timeout", "10",
        "-e", "NODE_ENV=production", "-e", f"APP_REVISION={cand.sha}",
        "--label", f"amnezia.deploy.slot={slot}", "--label", f"amnezia.deploy.sha={cand.sha}",
        "--label", f"amnezia.deploy.digest={cand.digest}",
        cand.ref,
    ]


def wait_healthy(sysm, name, deadline_s=HEALTH_DEADLINE_S):
    end = sysm.time() + deadline_s
    while True:
        info = sysm.docker_inspect(name)
        state = (info or {}).get("State") or {}
        status = (state.get("Health") or {}).get("Status")
        if status == "healthy":
            return
        if info is None or not state.get("Running"):
            raise DeployError("WAIT_HEALTH", "not_running", f"{name} is not running")
        if status == "unhealthy":
            raise DeployError("WAIT_HEALTH", "unhealthy", f"{name} reported unhealthy")
        if sysm.time() >= end:
            raise DeployError("WAIT_HEALTH", "health_timeout", f"{name} not healthy after {deadline_s}s")
        sysm.sleep(2)


def _check_response(stage, label, resp, expected_rev, json_body, legacy):
    status, headers, body, elapsed = resp
    if status == 429:
        retry = headers.get("retry-after", "")
        raise DeployError(stage, "rate_limited", f"{label} answered 429 (nginx rate limit)",
                          retry_after=int(retry) if retry.isdigit() else None)
    if status != 200:
        raise DeployError(stage, "http_status", f"{label} answered {status}")
    ctype = headers.get("content-type", "")
    if json_body:
        if not ctype.startswith("application/json"):
            raise DeployError(stage, "content_type", f"{label} content-type {ctype!r}")
        try:
            json.loads(body)
        except ValueError:
            raise DeployError(stage, "invalid_json", f"{label} body is not JSON") from None
        if headers.get("cache-control") != "no-store":
            raise DeployError(stage, "cache_control", f"{label} is cacheable")
    elif not ctype.startswith("text/html"):
        raise DeployError(stage, "content_type", f"{label} content-type {ctype!r}")
    got = headers.get("x-app-revision")
    if legacy:
        if got is not None:
            raise DeployError(stage, "revision_mismatch", f"{label} answered revision {got}, expected the legacy release")
    elif got != expected_rev:
        raise DeployError(stage, "revision_mismatch", f"{label} answered revision {got!r}, expected {expected_rev}")
    if elapsed > SMOKE_LATENCY_LIMIT_S:
        raise DeployError(stage, "latency", f"{label} took {elapsed:.1f}s")
    return round(elapsed * 1000)


def smoke(sysm, stage, fetch, expected_rev, legacy=False):
    """GET / , /api/status, /api/healthcheck. /api/iplist and WARP registration are not gates:
    they depend on external upstreams and the image already passed the CI smoke."""
    return {path: _check_response(stage, path, fetch(path), expected_rev, path != "/", legacy)
            for path in ("/", "/api/status", "/api/healthcheck")}


def public_smoke(sysm, expected_rev, legacy=False):
    """Through nginx with real TLS/SNI/Host; retries while reloaded workers take over.

    A 429 comes from nginx's per-IP limit (127.0.0.1 is shared with local tools), not from the
    release: it proves nothing either way, so it is waited out (Retry-After) up to a longer but
    finite deadline. If the revision still cannot be proven, the caller switches back."""
    started = sysm.time()
    while True:
        try:
            return smoke(sysm, "PUBLIC_SMOKE", sysm.public_get, expected_rev, legacy)
        except (DeployError, OSError) as err:
            limited = isinstance(err, DeployError) and err.category == "rate_limited"
            end = started + (RATE_LIMIT_WAIT_S if limited else PUBLIC_PROPAGATION_S)
            if sysm.time() >= end:
                if isinstance(err, DeployError):
                    raise
                raise DeployError("PUBLIC_SMOKE", "connection", str(err)) from None
            # The zone refills a token every 2 s, so a short pause is enough; Retry-After caps it.
            sysm.sleep(min(getattr(err, "retry_after", None) or 5, 10, max(1, end - sysm.time())) if limited else 1)


# --- nginx upstream file (the only nginx file this controller writes) ---------------------------
def upstream_text(slot, sha, digest, at):
    return (
        "# Managed by amnezia-deploy — rewritten atomically on every switch. Do not edit by hand;\n"
        "# use `amnezia-deploy rollback` / `deploy`. Included by sites-available/amnezia-web.\n"
        f"# slot={slot} sha={sha or 'unknown'} digest={digest or 'local-bootstrap'} written={at}\n"
        "upstream amnezia_backend {\n"
        f"    server 127.0.0.1:{SLOTS[slot]['port']};\n"
        "}\n"
    )


def upstream_slot(text):
    if text is None:
        return None
    ports = re.findall(r"^\s*server\s+127\.0\.0\.1:(\d+)\s*;", text, re.M)
    if len(ports) != 1:
        return None
    return next((s for s, v in SLOTS.items() if v["port"] == int(ports[0])), None)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def switch_upstream(sysm, paths, slot, sha, digest, op):
    """Write -> nginx -t -> reload; on any failure restore the previous file (and config)."""
    previous = read_text(paths.upstream_file)
    op.stage("SWITCH_PREPARE")
    write_atomic(paths.upstream_file, upstream_text(slot, sha, digest, now_iso(sysm.time())))
    op.stage("NGINX_TEST")
    ok, err = sysm.nginx_test()
    if not ok:
        _restore_upstream(sysm, paths, previous, reload=False)
        raise DeployError("NGINX_TEST", "nginx_test_failed", f"nginx -t failed: {err}")
    op.stage("NGINX_RELOAD")
    ok, err = sysm.nginx_reload()
    if not ok:
        _restore_upstream(sysm, paths, previous, reload=True)
        raise DeployError("NGINX_RELOAD", "nginx_reload_failed", f"nginx reload failed: {err}")
    return previous


def _restore_upstream(sysm, paths, previous, reload):
    if previous is not None:
        write_atomic(paths.upstream_file, previous)
    ok, err = sysm.nginx_test()
    if not ok:
        raise DeployError("NGINX_TEST", "restore_failed", f"restored upstream does not pass nginx -t: {err}")
    if reload:
        ok, err = sysm.nginx_reload()
        if not ok:
            raise DeployError("NGINX_RELOAD", "restore_failed", f"reload after restore failed: {err}")


# --- state -------------------------------------------------------------------------------------
def validate_state(state):
    problems = []
    if not isinstance(state, dict) or state.get("schema_version") != 1:
        return ["unknown schema"]
    if state.get("active_slot") not in SLOTS:
        problems.append("active_slot")
    if not SHA_RE.match(str(state.get("source_sha", ""))):
        problems.append("source_sha")
    if state.get("image_digest") is not None and not DIGEST_RE.match(str(state["image_digest"])):
        problems.append("image_digest")
    if state.get("image_digest") is None and not state.get("bootstrap"):
        problems.append("image_digest missing outside bootstrap")
    if state.get("previous_slot") not in (None, *SLOTS):
        problems.append("previous_slot")
    return problems


def load_state(paths):
    try:
        state = read_json(paths.state)
    except ValueError:
        raise NeedsReconciliation("state.json is not valid JSON") from None
    if state is None:
        return None
    problems = validate_state(state)
    if problems:
        raise NeedsReconciliation(f"state.json is inconsistent: {', '.join(problems)}")
    return state


def write_active_revision(paths, sha):
    """Plain SHA of the release nginx serves, for the VPS telemetry collector (revision_file)."""
    if sha:
        write_atomic(paths.active_revision, sha + "\n")


def slot_record(state, prefix=""):
    return {"slot": state.get(f"{prefix}slot" if prefix else "active_slot"),
            "sha": state.get(f"{prefix}source_sha"), "digest": state.get(f"{prefix}image_digest"),
            "bootstrap": bool(state.get(f"{prefix}bootstrap"))}


# --- operation bookkeeping ---------------------------------------------------------------------
class Operation:
    def __init__(self, sysm, paths, kind):
        self.sysm, self.paths, self.kind = sysm, paths, kind
        self.id = uuid.uuid4().hex[:12]
        self.started = sysm.time()
        self.current = None
        self.target = {}
        self.attempt = {"operation_id": self.id, "type": kind, "started_at": now_iso(self.started)}

    def stage(self, name):
        assert name in STAGES, name
        self.current = name
        self.log(result="running")

    def log(self, **extra):
        self.sysm.log({"ts": now_iso(self.sysm.time()), "operation_id": self.id, "op": self.kind,
                       "stage": self.current, "target_sha": self.target.get("sha"),
                       "target_digest": self.target.get("digest"), "slot": self.target.get("slot"),
                       "duration_s": round(self.sysm.time() - self.started, 1), **extra})

    def finish(self, result, error=None, previous_sha=None, record_attempt=True, record_event=True):
        """last-attempt.json: every invocation that reached a decision (monitoring: the controller runs).
        last-event.json: only real operations (deploy/rollback/...), never no-op or paused checks."""
        duration = round(self.sysm.time() - self.started, 1)
        rec = {**self.attempt, "ended_at": now_iso(self.sysm.time()), "result": result,
               "stage": self.current, "target": self.target, "duration_s": duration}
        if error is not None:
            rec["error_category"] = getattr(error, "category", "internal")
            rec["error"] = str(error)[:500]
        if record_attempt:
            write_json(self.paths.attempt, rec)
        if not record_event:
            self.log(result=result)
            return
        write_json(self.paths.event, {
            "event_id": self.id, "type": self.kind, "result": result, "stage": self.current,
            "source_sha": self.target.get("sha"), "previous_sha": previous_sha,
            "digest": self.target.get("digest"), "slot": self.target.get("slot"),
            "duration_s": duration, "timestamp": now_iso(self.sysm.time()), "operation_id": self.id,
            **({"error_category": rec["error_category"], "error": rec["error"]} if error is not None else {}),
        })
        self.log(result=result, **({"error": str(error)[:300]} if error is not None else {}))


# --- reconciliation ----------------------------------------------------------------------------
def public_revision(sysm):
    """'<sha>' if the public answer names a release, None for the legacy (headerless) release.
    Uses `/`: it carries X-App-Revision like every response but has no nginx request limit."""
    end = sysm.time() + 30
    while True:
        try:
            status, headers, _, _ = sysm.public_get("/")
            if status == 200:
                return headers.get("x-app-revision")
            problem = f"public / answered {status}"
        except OSError as err:
            problem = f"public endpoint unreachable: {err}"
        if sysm.time() >= end:
            raise NeedsReconciliation(problem)
        sysm.sleep(5)


def _matches(container, revision):
    if not container.get("exists") or not container.get("running") or container.get("health") != "healthy":
        return False
    if revision is None:
        return bool(container.get("legacy"))
    return container.get("revision") == revision


def reconcile(sysm, paths, state, fix=True):
    """Evidence order: what nginx actually serves (public revision + upstream file), running
    containers, image metadata, then state.json. Safe fixes only; contradictions raise."""
    if state is None:
        raise NeedsReconciliation("not bootstrapped: run `amnezia-deploy bootstrap`")
    containers = {slot: describe_container(sysm, slot) for slot in SLOTS}
    file_slot = upstream_slot(read_text(paths.upstream_file))
    active = state["active_slot"]

    # The active container is down (e.g. after a reboot) and everything points at it: start it.
    if fix and file_slot == active and containers[active].get("exists") and not containers[active].get("running"):
        sysm.docker("start", containers[active]["name"])
        wait_healthy(sysm, containers[active]["name"])
        containers[active] = describe_container(sysm, active)

    served = public_revision(sysm)
    serving = [s for s in SLOTS if _matches(containers[s], served)]
    if file_slot in serving:
        serving = [file_slot]
    if len(serving) != 1:
        raise NeedsReconciliation(f"public revision {served or 'legacy'} matches {len(serving)} healthy slots "
                                  f"(upstream file: {file_slot}); refusing to guess")
    real = serving[0]
    actions = []
    if file_slot != real:
        # Crash between writing the upstream file and reloading: the running config still serves
        # `real`. Rewriting the file to match changes no traffic.
        if not fix:
            raise NeedsReconciliation(f"upstream file points to {file_slot}, nginx serves {real}")
        c = containers[real]
        write_atomic(paths.upstream_file, upstream_text(real, c.get("revision"), c.get("digest"), now_iso(sysm.time())))
        ok, err = sysm.nginx_test()
        if not ok:
            raise NeedsReconciliation(f"rewritten upstream fails nginx -t: {err}")
        actions.append(f"upstream file restored to {real}")
    if real != active:
        if not fix:
            raise NeedsReconciliation(f"state says {active}, nginx serves {real}")
        c = containers[real]
        previous = slot_record(state)
        state.update({"active_slot": real, "source_sha": state.get("previous_source_sha") if c.get("legacy") else c.get("revision"),
                      "image_digest": None if c.get("legacy") else c.get("digest"), "bootstrap": bool(c.get("legacy")),
                      "previous_slot": previous["slot"], "previous_source_sha": previous["sha"],
                      "previous_image_digest": previous["digest"], "previous_bootstrap": previous["bootstrap"],
                      "pending_stop": None})
        if not state["source_sha"] or validate_state(state):
            raise NeedsReconciliation(f"nginx serves {real} but its release cannot be identified safely")
        write_json(paths.state, state)
        write_active_revision(paths, state["source_sha"])
        actions.append(f"state adopted serving slot {real}")
    return {"serving_slot": real, "public_revision": served, "upstream_file_slot": file_slot,
            "containers": containers, "actions": actions}


# --- operations --------------------------------------------------------------------------------
def _ensure_slot_free(sysm, slot, keep_digest=None):
    """Prepare the inactive slot. Returns True if a matching healthy container can be reused."""
    for name in (SLOTS[slot]["name"], LEGACY_NAME if slot == "blue" else None):
        if name is None:
            continue
        info = sysm.docker_inspect(name)
        if info is None:
            continue
        if name == LEGACY_NAME and _host_port(info) != SLOTS["blue"]["port"]:
            continue
        labels = (info.get("Config") or {}).get("Labels") or {}
        state = info.get("State") or {}
        if keep_digest and labels.get("amnezia.deploy.digest") == keep_digest and state.get("Running") \
                and (state.get("Health") or {}).get("Status") == "healthy" and not constraint_problems(info, slot):
            return True
        sysm.docker("rm", "-f", name)
    return False


def _bring_up(sysm, op, slot, cand, legacy_name=None):
    """Start (or reuse) the target container, verify constraints, wait for health, smoke it."""
    if legacy_name:
        name = legacy_name
        info = sysm.docker_inspect(name)
        if info is None:
            raise DeployError("START_CANDIDATE", "missing_container", f"{name} no longer exists")
        op.stage("START_CANDIDATE")
        if not (info.get("State") or {}).get("Running"):
            sysm.docker("start", name)
    else:
        op.stage("PREPARE_SLOT")
        reuse = _ensure_slot_free(sysm, slot, keep_digest=cand.digest)
        op.stage("START_CANDIDATE")
        name = SLOTS[slot]["name"]
        if not reuse:
            sysm.docker(*run_args(slot, cand))
        info = sysm.docker_inspect(name)
        problems = constraint_problems(info or {}, slot)
        if problems:
            raise DeployError("START_CANDIDATE", "constraints", "; ".join(problems))
    op.stage("WAIT_HEALTH")
    wait_healthy(sysm, name)
    op.stage("CANDIDATE_SMOKE")
    port = SLOTS[slot]["port"]
    return name, smoke(sysm, "CANDIDATE_SMOKE", lambda p: sysm.http_get(port, p), cand.sha if cand else None,
                       legacy=bool(legacy_name))


def _switch_and_prove(sysm, paths, op, slot, sha, digest, legacy, old):
    switch_upstream(sysm, paths, slot, sha, digest, op)
    op.stage("PUBLIC_SMOKE")
    try:
        return public_smoke(sysm, sha, legacy=legacy)
    except DeployError as err:
        # Automatic rollback of the switch; the old slot is still running.
        _restore_upstream(sysm, paths, upstream_text(old["slot"], old["sha"], old["digest"], now_iso(sysm.time())), reload=True)
        public_smoke(sysm, old["sha"], legacy=old["bootstrap"])
        raise DeployError("PUBLIC_SMOKE", err.category, f"{err} — switched back to {old['slot']}") from None


def _commit(paths, sysm, state, slot, sha, digest, bootstrap, old):
    t = sysm.time()
    known = [k for k in state.get("known_good", []) if k.get("digest") != digest]
    if digest:
        known.insert(0, {"source_sha": sha, "image_digest": digest, "at": now_iso(t)})
    new_state = {
        "schema_version": 1, "active_slot": slot, "source_sha": sha, "image_digest": digest,
        "bootstrap": bootstrap,
        "previous_slot": old["slot"], "previous_source_sha": old["sha"],
        "previous_image_digest": old["digest"], "previous_bootstrap": old["bootstrap"],
        "deployed_at": now_iso(t), "last_success": now_iso(t),
        "pending_stop": {"slot": old["slot"], "after": t + GRACE_S, "after_iso": now_iso(t + GRACE_S)},
        "known_good": known[:KNOWN_GOOD_KEEP],
        # Kept only while the bootstrap release is active or the rollback target.
        "bootstrap_image": state.get("bootstrap_image") if (bootstrap or old["bootstrap"]) else None,
    }
    write_json(paths.state, new_state)
    write_active_revision(paths, sha)
    return new_state


def op_deploy(sysm, paths, sha=None, force=False, automatic=False):
    if os.path.exists(paths.paused) and (automatic or not force):
        Operation(sysm, paths, "deploy").finish("paused", record_event=False)
        print("paused: no deployment (use `deploy --force` to override manually)")
        return 0
    op = Operation(sysm, paths, "deploy")
    state = None
    try:
        state = load_state(paths)
        reconcile(sysm, paths, state)
        state = load_state(paths)
        op_finalize(sysm, paths, quiet=True)
        state = load_state(paths)
        op.stage("DISCOVER")
        cand = discover(sysm, sha)
        target = OTHER[state["active_slot"]]
        op.target = {"sha": cand.sha, "digest": cand.digest, "slot": target}
        if cand.digest == state.get("image_digest"):
            op.finish("noop", record_event=False)
            print(f"no-op: {cand.digest} is already active in {state['active_slot']}")
            return 0
        failed = read_json(paths.failed) or {}
        if automatic and cand.digest in failed:
            # Do not retry a digest that already failed every timer tick (and do not spam events):
            # wait for a new release, or an explicit manual `amnezia-deploy deploy`.
            op.finish("skipped_failed", record_event=False)
            print(f"skipped: {cand.digest} failed at {failed[cand.digest].get('stage')}; waiting for a new release")
            return 0
        op.stage("PULL")
        sysm.docker("pull", cand.ref, timeout=600)
        op.stage("VERIFY")
        img = sysm.image_inspect(cand.ref) or {}
        labels = (img.get("Config") or {}).get("Labels") or {}
        if labels.get("org.opencontainers.image.revision") != cand.sha or cand.ref not in (img.get("RepoDigests") or []):
            raise DeployError("VERIFY", "local_image_mismatch", "pulled image does not carry the expected digest/revision")
        old = slot_record(state)
        _bring_up(sysm, op, target, cand)
        _switch_and_prove(sysm, paths, op, target, cand.sha, cand.digest, False, old)
        op.stage("COMMIT_STATE")
        new_state = _commit(paths, sysm, state, target, cand.sha, cand.digest, False, old)
        op.stage("GRACE")
        scheduled = sysm.schedule_finalize(GRACE_S + 30, op.id)
        op.log(result="running", note=f"{old['slot']} kept running until {new_state['pending_stop']['after_iso']}", finalize_scheduled=scheduled)
        op.stage("SUCCESS")
        op.finish("success", previous_sha=old["sha"])
        print(f"deployed {cand.sha} ({cand.digest}) to {target}; previous {old['sha']} stays up until "
              f"{new_state['pending_stop']['after_iso']}")
        return 0
    except NeedsReconciliation as err:
        op.current = "DISCOVER" if op.current is None else op.current
        op.finish("needs_reconciliation", DeployError(op.current, "needs_reconciliation", str(err)))
        print(f"NEEDS_RECONCILIATION: {err}", file=sys.stderr)
        return 2
    except DeployError as err:
        op.current = err.stage
        if op.target.get("digest"):
            failed = read_json(paths.failed) or {}
            failed[op.target["digest"]] = {"stage": err.stage, "at": now_iso(sysm.time()), "sha": op.target.get("sha")}
            write_json(paths.failed, dict(list(failed.items())[-10:]))
        op.finish("failed", err, previous_sha=(state or {}).get("source_sha"))
        print(f"FAILED at {err.stage}: {err}", file=sys.stderr)
        return 1


def op_rollback(sysm, paths, force=False):
    if os.path.exists(paths.paused) and not force:
        print("paused: no rollback (use `rollback --force`)")
        return 0
    op = Operation(sysm, paths, "rollback")
    try:
        state = load_state(paths)
        reconcile(sysm, paths, state)
        state = load_state(paths)
        prev = slot_record(state, "previous_")
        if prev["slot"] is None or prev["sha"] is None:
            raise DeployError("DISCOVER", "no_previous", "no previous known-good release recorded")
        op.target = {"sha": prev["sha"], "digest": prev["digest"], "slot": prev["slot"]}
        old = slot_record(state)
        if prev["bootstrap"]:
            legacy = sysm.docker_inspect(LEGACY_NAME)
            if legacy is None:
                raise DeployError("START_CANDIDATE", "missing_container", "bootstrap container is gone")
            _bring_up(sysm, op, prev["slot"], None, legacy_name=LEGACY_NAME)
        else:
            cand = Candidate(prev["sha"], prev["digest"], None)
            if sysm.image_inspect(cand.ref) is None:
                op.stage("PULL")
                sysm.docker("pull", cand.ref, timeout=600)
            name = SLOTS[prev["slot"]]["name"]
            info = sysm.docker_inspect(name)
            labels = ((info or {}).get("Config") or {}).get("Labels") or {}
            if info is not None and labels.get("amnezia.deploy.digest") == prev["digest"] and not constraint_problems(info, prev["slot"]):
                op.stage("START_CANDIDATE")
                if not (info.get("State") or {}).get("Running"):
                    sysm.docker("start", name)
                op.stage("WAIT_HEALTH")
                wait_healthy(sysm, name)
                op.stage("CANDIDATE_SMOKE")
                smoke(sysm, "CANDIDATE_SMOKE", lambda p: sysm.http_get(SLOTS[prev["slot"]]["port"], p), prev["sha"])
            else:
                _bring_up(sysm, op, prev["slot"], cand)
        _switch_and_prove(sysm, paths, op, prev["slot"], prev["sha"], prev["digest"], prev["bootstrap"], old)
        op.stage("COMMIT_STATE")
        new_state = _commit(paths, sysm, state, prev["slot"], prev["sha"], prev["digest"], prev["bootstrap"], old)
        op.stage("GRACE")
        sysm.schedule_finalize(GRACE_S + 30, op.id)
        op.stage("SUCCESS")
        op.finish("success", previous_sha=old["sha"])
        print(f"rolled back to {prev['sha']} in {prev['slot']}; {old['sha']} stays up until {new_state['pending_stop']['after_iso']}")
        return 0
    except NeedsReconciliation as err:
        op.finish("needs_reconciliation", DeployError(op.current or "DISCOVER", "needs_reconciliation", str(err)))
        print(f"NEEDS_RECONCILIATION: {err}", file=sys.stderr)
        return 2
    except DeployError as err:
        op.current = err.stage
        op.finish("failed", err)
        print(f"FAILED at {err.stage}: {err}", file=sys.stderr)
        return 1


DRILL_IMAGE = "amnezia-deploy-drill:broken"  # local fixture only; never published


def _candidate_only(sysm, paths, kind, cand):
    """Bring a candidate up in the inactive slot, smoke it, then remove it. No nginx/state change."""
    op = Operation(sysm, paths, kind)
    state = None
    try:
        state = load_state(paths)
        reconcile(sysm, paths, state)
        state = load_state(paths)
        target = OTHER[state["active_slot"]]
        if cand is None:
            op.stage("DISCOVER")
            cand = discover(sysm)
        op.target = {"sha": cand.sha, "digest": cand.digest, "slot": target}
        if kind != "drill":
            op.stage("PULL")
            sysm.docker("pull", cand.ref, timeout=600)
        before = describe_container(sysm, state["active_slot"])
        _, latency = _bring_up(sysm, op, target, cand)
        op.log(result="running", latency_ms=latency)
        return_code, result, error = 0, "success", None
    except NeedsReconciliation as err:
        op.finish("needs_reconciliation", DeployError(op.current or "DISCOVER", "needs_reconciliation", str(err)))
        print(f"NEEDS_RECONCILIATION: {err}", file=sys.stderr)
        return 2
    except DeployError as err:
        op.current = err.stage
        return_code, result, error = 1, "failed", err
    finally:
        if op.target.get("slot"):
            name = SLOTS[op.target["slot"]]["name"]
            if sysm.docker_inspect(name) is not None:
                sysm.docker("rm", "-f", name)
    after_upstream = upstream_slot(read_text(paths.upstream_file))
    op.finish(result, error, previous_sha=state["source_sha"])
    print(json.dumps({"result": result, "stage": op.current, "error": str(error) if error else None,
                      "upstream_slot": after_upstream, "active_slot": state["active_slot"],
                      "active_container_unchanged": describe_container(sysm, state["active_slot"]) == before}, indent=2))
    return return_code


def op_candidate(sysm, paths, sha=None):
    cand = discover(sysm, sha) if sha else None
    return _candidate_only(sysm, paths, "candidate", cand)


def op_drill(sysm, paths):
    """Broken-candidate drill with the local fixture image (fails health by construction)."""
    if sysm.image_inspect(DRILL_IMAGE) is None:
        raise SystemExit(f"build the fixture first: {DRILL_IMAGE}")
    return _candidate_only(sysm, paths, "drill", _DrillCandidate())


class _DrillCandidate(Candidate):
    def __init__(self):
        super().__init__("0" * 40, "sha256:" + "0" * 64, None)

    @property
    def ref(self):
        return DRILL_IMAGE


def op_finalize(sysm, paths, quiet=False):
    """After the grace period: stop the old slot if production is still healthy; prune images."""
    state = load_state(paths)
    pending = (state or {}).get("pending_stop")
    if not pending or sysm.time() < pending["after"]:
        if not quiet:
            print("nothing to finalize" if not pending else f"grace period until {pending['after_iso']}")
        return 0
    op = Operation(sysm, paths, "finalize")
    op.target = {"sha": state["source_sha"], "digest": state.get("image_digest"), "slot": state["active_slot"]}
    op.stage("STOP_OLD")
    active = describe_container(sysm, state["active_slot"])
    if not (active.get("running") and active.get("health") == "healthy"):
        op.log(result="skipped", note="active slot not healthy; keeping the old slot")
        return 0
    public_smoke(sysm, state["source_sha"], legacy=bool(state.get("bootstrap")))
    old_name = container_name(sysm, pending["slot"])
    keep = os.path.exists(paths.keep_old)
    if keep:
        # Monitoring still expects fixed container names; a stopped slot would alert falsely.
        op.log(result="running", note=f"{old_name} kept running ({paths.keep_old})")
    elif old_name != container_name(sysm, state["active_slot"]) and sysm.docker_inspect(old_name):
        sysm.docker("stop", old_name)
    state["pending_stop"] = None
    write_json(paths.state, state)
    prune_images(sysm, state)
    op.finish("success", record_attempt=False)
    if not quiet:
        print(f"kept {old_name} running" if keep else f"stopped {old_name}")
    return 0


def prune_images(sysm, state):
    keep = {state.get("image_digest"), state.get("previous_image_digest")}
    keep |= {k.get("image_digest") for k in state.get("known_good", [])}
    for slot in SLOTS:
        info = sysm.docker_inspect(SLOTS[slot]["name"])
        if info is not None:
            keep.add(((info.get("Config") or {}).get("Labels") or {}).get("amnezia.deploy.digest"))
    for ref in sysm.image_refs():
        if ref.split("@")[-1] not in keep:
            sysm.run(["docker", "image", "rm", ref], check=False)


def op_status(sysm, paths):
    try:
        state = load_state(paths)
    except NeedsReconciliation as err:
        print(json.dumps({"verdict": "NEEDS_RECONCILIATION", "reason": str(err)}, indent=2))
        return 2
    out = {"paused": os.path.exists(paths.paused), "state": state,
           "last_attempt": read_json(paths.attempt), "last_event": read_json(paths.event)}
    try:
        out["evidence"] = reconcile(sysm, paths, state, fix=False) if state else None
        out["verdict"] = "CONSISTENT" if state else "UNINITIALIZED"
    except NeedsReconciliation as err:
        out["verdict"], out["reason"] = "NEEDS_RECONCILIATION", str(err)
    print(json.dumps(out, indent=2, sort_keys=True, default=str))
    return 0 if out["verdict"] == "CONSISTENT" else 2


def op_check(sysm, paths):
    state = load_state(paths)
    cand = discover(sysm)
    active = (state or {}).get("image_digest")
    out = {"channel": f"{IMAGE}:{CHANNEL_TAG}", **cand.as_dict(), "active_digest": active,
           "action": "none" if cand.digest == active else "deploy", "paused": os.path.exists(paths.paused)}
    print(json.dumps(out, indent=2))
    return 0


def op_reconcile(sysm, paths):
    state = load_state(paths)
    evidence = reconcile(sysm, paths, state, fix=True)
    write_active_revision(paths, load_state(paths)["source_sha"])
    Operation(sysm, paths, "reconcile").finish("consistent", record_event=False)
    sysm.log({"ts": now_iso(sysm.time()), "op": "reconcile", "result": "consistent", **{k: evidence[k] for k in ("serving_slot", "public_revision", "actions")}})
    print(json.dumps({k: evidence[k] for k in ("serving_slot", "public_revision", "upstream_file_slot", "actions")}, indent=2))
    return 0


def op_bootstrap(sysm, paths, legacy_sha):
    """Record the running deploy.sh-era container as the blue slot (bootstrap exception: it has
    no GHCR digest and must not be described as a CI-tested GHCR artifact)."""
    if not SHA_RE.match(legacy_sha or ""):
        raise SystemExit("--legacy-sha must be the full 40-character SHA of the running release")
    if read_json(paths.state) is not None:
        raise SystemExit("already bootstrapped")
    info = sysm.docker_inspect(LEGACY_NAME)
    if info is None or _host_port(info) != SLOTS["blue"]["port"]:
        raise SystemExit(f"{LEGACY_NAME} on 127.0.0.1:{SLOTS['blue']['port']} not found")
    label = container_revision(info) or ""
    if not legacy_sha.startswith(label) or len(label) < 7:
        raise SystemExit(f"running container revision {label!r} is not a prefix of {legacy_sha}")
    problems = constraint_problems(info, "blue")
    if problems:
        raise SystemExit("legacy container lacks hardening: " + "; ".join(problems))
    t = sysm.time()
    write_atomic(paths.upstream_file, upstream_text("blue", legacy_sha, None, now_iso(t)))
    write_json(paths.state, {
        "schema_version": 1, "active_slot": "blue", "source_sha": legacy_sha, "image_digest": None,
        "bootstrap": True, "previous_slot": None, "previous_source_sha": None,
        "previous_image_digest": None, "previous_bootstrap": False,
        "deployed_at": now_iso(t), "last_success": now_iso(t), "pending_stop": None, "known_good": [],
        "bootstrap_image": (info.get("Config") or {}).get("Image"),
    })
    write_active_revision(paths, legacy_sha)
    print(f"bootstrapped: blue = {LEGACY_NAME} ({legacy_sha}); upstream file written (not reloaded)")
    return 0


def main(argv=None, sysm=None, paths=None):
    parser = argparse.ArgumentParser(prog="amnezia-deploy", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    p = sub.add_parser("deploy")
    p.add_argument("sha", nargs="?")
    p.add_argument("--force", action="store_true", help="deploy even while paused")
    p.add_argument("--automatic", action="store_true", help="timer mode: never overrides pause")
    p = sub.add_parser("candidate", help="pull + start + health + smoke in the inactive slot, then remove; no switch")
    p.add_argument("sha", nargs="?")
    sub.add_parser("drill", help=f"broken-candidate drill with the local fixture {DRILL_IMAGE}")
    p = sub.add_parser("rollback")
    p.add_argument("--force", action="store_true")
    sub.add_parser("finalize")
    sub.add_parser("reconcile")
    p = sub.add_parser("pause")
    p.add_argument("reason", nargs="?", default="")
    sub.add_parser("resume")
    p = sub.add_parser("bootstrap")
    p.add_argument("--legacy-sha", required=True)
    args = parser.parse_args(argv)
    sysm = sysm or System()
    paths = paths or Paths()

    if args.cmd == "status":
        return op_status(sysm, paths)
    if args.cmd == "pause":
        write_json(paths.paused, {"paused_at": now_iso(sysm.time()), "reason": args.reason})
        print("paused")
        return 0
    if args.cmd == "resume":
        if os.path.exists(paths.paused):
            os.remove(paths.paused)
        print("resumed")
        return 0

    os.makedirs(paths.state_dir, mode=0o750, exist_ok=True)
    with open(paths.lock, "a+") as lock:
        try:
            if fcntl is None:
                raise SystemExit("amnezia-deploy needs fcntl (Linux)")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another amnezia-deploy operation is running; nothing done")
            return 0
        try:
            if args.cmd == "check":
                return op_check(sysm, paths)
            if args.cmd == "deploy":
                return op_deploy(sysm, paths, sha=args.sha, force=args.force, automatic=args.automatic)
            if args.cmd == "rollback":
                return op_rollback(sysm, paths, force=args.force)
            if args.cmd == "candidate":
                return op_candidate(sysm, paths, sha=args.sha)
            if args.cmd == "drill":
                return op_drill(sysm, paths)
            if args.cmd == "finalize":
                return op_finalize(sysm, paths)
            if args.cmd == "reconcile":
                return op_reconcile(sysm, paths)
            if args.cmd == "bootstrap":
                return op_bootstrap(sysm, paths, args.legacy_sha)
        except NeedsReconciliation as err:
            sysm.log({"ts": now_iso(sysm.time()), "op": args.cmd, "result": "needs_reconciliation", "error": str(err)})
            print(f"NEEDS_RECONCILIATION: {err}", file=sys.stderr)
            return 2
        except DeployError as err:
            print(f"FAILED at {err.stage}: {err}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
