#!/usr/bin/env python3
"""endpoint-lab — verifies Cloudflare WARP WireGuard endpoints from the VPS (Endpoint Lab, Phase A).

A candidate ``IP:UDP-port`` is ACTIVE only after a real stock WireGuard handshake with the Lab's own
WARP identity *and* a TLS-verified HTTPS request that went through that tunnel. Each probe runs in a
throw-away network namespace: the WireGuard interface is created in the host namespace (its encrypted
UDP socket stays there) and then moved into the namespace, which has nothing but ``lo`` and that
interface. Host routes and rules are never touched. Results go to SQLite; eligible endpoints are
published as an atomic, secret-free ``active-pool.json``.

Phase A is manual: no timers, no discovery, no generator integration. Commands:
status | list | import-candidates FILE | register-probe-identity | probe ID | verify ID |
verify-all | snapshot | cleanup. Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
try:
    import fcntl  # Linux only (the VPS); absent on Windows dev machines
except ImportError:  # pragma: no cover
    fcntl = None
import ipaddress
import json
import os
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# --- fixed paths (never taken from input) --------------------------------------------------------
CONF_DIR = "/etc/amnezia-endpoint-lab"            # 0700 root: registration metadata, operator candidates
# Ubuntu's AppArmor profile for /usr/bin/wg only lets it read files under /etc/wireguard/**.
KEY_DIR = "/etc/wireguard/amnezia-endpoint-lab"   # 0700 root
KEY_FILE = "wg.key"                               # 0600: WireGuard private key only
IDENTITY_FILE = "identity.json"                   # 0600: public addressing + registration metadata
STATE_DIR = "/var/lib/amnezia-endpoint-lab"       # 0700 root: lab.db
PUBLIC_DIR = "/var/lib/amnezia-endpoint-lab/public"  # 0755: active-pool.json (0644), future ro mount
DB_FILE = "lab.db"
SNAPSHOT_FILE = "active-pool.json"
LOCK_FILE = "/run/amnezia-endpoint-lab.lock"

# --- protocol and policy --------------------------------------------------------------------------
OFFICIAL_PORTS = (2408, 500, 1701, 4500)  # Cloudflare WARP WireGuard ports (developers.cloudflare.com)
# Candidates must sit in these prefixes: the Lab researches WARP ingress, it is not a general scanner.
ALLOWED_PREFIXES = tuple(ipaddress.ip_network(p) for p in (
    "162.159.192.0/24",  # consumer WARP (official)
    "162.159.193.0/24",  # Cloudflare One WireGuard ingress (official; must prove itself for consumer)
    "162.159.195.0/24",  # community-observed WARP
    "162.159.204.0/24",  # community-observed WARP
    "188.114.96.0/22",   # community-observed WARP
    "192.0.2.0/24",      # RFC 5737 TEST-NET-1: negative controls only
))
NEGATIVE_CONTROL_PREFIX = ipaddress.ip_network("192.0.2.0/24")
MAX_CANDIDATES = 64

WARP_API_HOST = "api.cloudflareclient.com"
WARP_API_PREFIX = "/v0i1909051800"  # same API version api/warp.js uses in production
WARP_API_TIMEOUT_S = 20
WARP_API_MAX_ATTEMPTS = 2           # bounded: never a registration loop
MAX_API_RESPONSE = 256 * 1024

MTU = 1280
HANDSHAKE_TIMEOUT_S = 8.0           # one WireGuard initiation plus slack (REKEY_TIMEOUT is 5 s)
POLL_INTERVAL_S = 0.1
TRIGGER_INTERVAL_S = 1.0
HTTPS_URL = "https://1.1.1.1/cdn-cgi/trace"  # Cloudflare-operated; certificate carries IP SAN 1.1.1.1
DNS_URL = "https://www.cloudflare.com/cdn-cgi/trace"
DOH_URL = "https://1.1.1.1/dns-query"        # DNS check through the tunnel without resolv.conf
TRIGGER_TARGET = "1.1.1.1"
HTTPS_MAX_TIME_S = 10
HTTPS_MAX_BYTES = 8192
COMMAND_TIMEOUT_S = 20

ACTIVE_TTL_S = 7 * 60               # ACTIVE expires 7 min after the last successful deep verify
SUSPECT_TO_QUARANTINE_FAILURES = 3
QUARANTINE_S = 30 * 60
QUARANTINE_TO_DEAD_FAILURES = 10   # further consecutive failures after entering QUARANTINE
OBSERVATION_RETENTION_S = 30 * 24 * 3600
STALE_RESOURCE_AGE_S = 600
GLOBAL_GUARD_MIN_BATCH = 3

SCHEMA_VERSION = 1
SNAPSHOT_SCHEMA_VERSION = 1

NS_PREFIX = "ael-"
IF_PREFIX = "ael"
NS_RE = re.compile(r"^ael-[0-9a-f]{6}$")
IF_RE = re.compile(r"^ael[0-9a-f]{6}$")
KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")  # base64 of exactly 32 bytes
SECRET_LIKE_RE = re.compile(r"[A-Za-z0-9+/]{42,43}=")

# --- states and error taxonomy ----------------------------------------------------------------------
DISCOVERED, PROBING, HANDSHAKE_OK, VERIFYING, VERIFIED, ACTIVE = (
    "DISCOVERED", "PROBING", "HANDSHAKE_OK", "VERIFYING", "VERIFIED", "ACTIVE")
SUSPECT, QUARANTINE, DEAD = "SUSPECT", "QUARANTINE", "DEAD"
STATES = (DISCOVERED, PROBING, HANDSHAKE_OK, VERIFYING, VERIFIED, ACTIVE, SUSPECT, QUARANTINE, DEAD)

TIMEOUT = "TIMEOUT"
HANDSHAKE_NO_RESPONSE = "HANDSHAKE_NO_RESPONSE"
HANDSHAKE_INVALID_OR_UNEXPECTED = "HANDSHAKE_INVALID_OR_UNEXPECTED"  # raw engines only; kernel drops bad replies
TUNNEL_SETUP_FAILED = "TUNNEL_SETUP_FAILED"
ROUTE_SETUP_FAILED = "ROUTE_SETUP_FAILED"
DNS_FAILED = "DNS_FAILED"
HTTPS_TIMEOUT = "HTTPS_TIMEOUT"
HTTPS_TLS_FAILED = "HTTPS_TLS_FAILED"
TRAFFIC_FAILED = "TRAFFIC_FAILED"
PROBE_IDENTITY_INVALID = "PROBE_IDENTITY_INVALID"
LOCAL_RESOURCE_ERROR = "LOCAL_RESOURCE_ERROR"
RATE_LIMITED = "RATE_LIMITED"
CANCELLED = "CANCELLED"
UNKNOWN = "UNKNOWN"
ERROR_CODES = (TIMEOUT, HANDSHAKE_NO_RESPONSE, HANDSHAKE_INVALID_OR_UNEXPECTED, TUNNEL_SETUP_FAILED,
               ROUTE_SETUP_FAILED, DNS_FAILED, HTTPS_TIMEOUT, HTTPS_TLS_FAILED, TRAFFIC_FAILED,
               PROBE_IDENTITY_INVALID, LOCAL_RESOURCE_ERROR, RATE_LIMITED, CANCELLED, UNKNOWN)
# Failures of the Lab itself: they never penalise an endpoint. UNKNOWN is treated as ours too.
LAB_FAILURE_CODES = frozenset({TUNNEL_SETUP_FAILED, ROUTE_SETUP_FAILED, PROBE_IDENTITY_INVALID,
                               LOCAL_RESOURCE_ERROR, RATE_LIMITED, CANCELLED, UNKNOWN})


class LabError(Exception):
    """A failure with a taxonomy code. Messages are redacted before they are stored or printed."""

    def __init__(self, code: str, message: str):
        super().__init__(redact(message))
        self.code = code


def redact(text: object) -> str:
    """Replace anything shaped like a WireGuard key (base64 of 32 bytes) with a marker."""
    return SECRET_LIKE_RE.sub("<redacted-key>", str(text))


def now_s() -> int:
    return int(time.time())


def iso(ts: int | None) -> str | None:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(message: str) -> None:
    print(redact(message), file=sys.stderr, flush=True)


# --- endpoints ---------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Endpoint:
    ip: str
    port: int
    family: int

    @property
    def endpoint_id(self) -> str:
        return f"[{self.ip}]:{self.port}" if self.family == 6 else f"{self.ip}:{self.port}"

    @property
    def wg_endpoint(self) -> str:
        return self.endpoint_id


def parse_endpoint(ip: object, port: object) -> Endpoint:
    """Strictly validate a candidate. IPv4 only on this node (IPv6 is disabled on the VPS)."""
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        raise LabError(UNKNOWN, f"invalid IP address: {str(ip)[:64]!r}") from None
    if addr.version != 4:
        raise LabError(LOCAL_RESOURCE_ERROR, "IPv6 probing is unsupported on this Lab node")
    if isinstance(port, bool) or not isinstance(port, int):
        raise LabError(UNKNOWN, f"port must be an integer, got {str(port)[:16]!r}")
    if port not in OFFICIAL_PORTS:
        raise LabError(UNKNOWN, f"port {port} is not an official WARP WireGuard port")
    if not any(addr in net for net in ALLOWED_PREFIXES):
        raise LabError(UNKNOWN, f"{addr} is outside the WARP research prefixes")
    return Endpoint(str(addr), port, 4)


def parse_endpoint_id(endpoint_id: str) -> Endpoint:
    m = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})", str(endpoint_id).strip())
    if not m:
        raise LabError(UNKNOWN, f"invalid endpoint id: {str(endpoint_id)[:64]!r}")
    return parse_endpoint(m.group(1), int(m.group(2)))


def load_candidates(path: str) -> list[tuple[Endpoint, str]]:
    """Read the operator-controlled candidate file: individual IPs × official ports, no ranges."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise LabError(UNKNOWN, "candidates file: schema_version 1 expected")
    out: list[tuple[Endpoint, str]] = []
    seen: set[str] = set()
    for item in data.get("candidates", []):
        if not isinstance(item, dict):
            raise LabError(UNKNOWN, "candidates file: each candidate must be an object")
        source = str(item.get("source", "manual"))
        if not re.fullmatch(r"[a-z0-9_]{1,32}", source):
            raise LabError(UNKNOWN, f"candidates file: bad source label {source[:40]!r}")
        for port in item.get("ports", list(OFFICIAL_PORTS)):
            ep = parse_endpoint(item.get("ip"), port)
            if ep.endpoint_id not in seen:
                seen.add(ep.endpoint_id)
                out.append((ep, source))
    if len(out) > MAX_CANDIDATES:
        raise LabError(UNKNOWN, f"candidates file: {len(out)} endpoints exceed the cap {MAX_CANDIDATES}")
    return out


# --- probe identity -------------------------------------------------------------------------------
@dataclass
class Identity:
    key_path: str
    public_key: str
    peer_public_key: str
    address_v4: str
    address_v6: str | None
    registration_id: str
    warp_enabled: bool
    created_at: str


def _atomic_write(path: str, data: bytes, mode: int) -> None:
    """temp file in the same directory → write → fsync → chmod → os.replace → fsync directory."""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as fh:  # mkstemp already created it 0600
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise
    if hasattr(os, "O_DIRECTORY"):
        dfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


def load_identity(conf_dir: str = CONF_DIR, key_dir: str = KEY_DIR) -> Identity:
    key_path = os.path.join(key_dir, KEY_FILE)
    try:
        with open(os.path.join(conf_dir, IDENTITY_FILE), encoding="utf-8") as fh:
            meta = json.load(fh)
        if not os.path.isfile(key_path):
            raise FileNotFoundError(key_path)
        if os.name == "posix" and os.stat(key_path).st_mode & 0o077:
            raise LabError(PROBE_IDENTITY_INVALID, "private key file is readable by group/others")
        ident = Identity(
            key_path=key_path,
            public_key=meta["public_key"],
            peer_public_key=meta["peer_public_key"],
            address_v4=meta["address_v4"],
            address_v6=meta.get("address_v6"),
            registration_id=meta["registration"]["id"],
            warp_enabled=bool(meta.get("warp_enabled")),
            created_at=meta.get("created_at", ""),
        )
    except LabError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise LabError(PROBE_IDENTITY_INVALID, f"probe identity unavailable: {type(exc).__name__}") from None
    if not (KEY_RE.match(ident.public_key) and KEY_RE.match(ident.peer_public_key)):
        raise LabError(PROBE_IDENTITY_INVALID, "probe identity has malformed keys")
    try:
        ipaddress.IPv4Address(ident.address_v4)
    except ValueError:
        raise LabError(PROBE_IDENTITY_INVALID, "probe identity has a malformed IPv4 address") from None
    if not ident.warp_enabled:
        raise LabError(PROBE_IDENTITY_INVALID, "probe identity is registered but WARP is not enabled yet")
    return ident


def _validate_registration(result: object) -> dict:
    if not isinstance(result, dict):
        raise LabError(UNKNOWN, "registration response is not an object")
    reg_id, token, cfg = result.get("id"), result.get("token"), result.get("config")
    if not (isinstance(reg_id, str) and reg_id and isinstance(token, str) and token):
        raise LabError(UNKNOWN, "registration response lacks id/token")
    peers = (cfg or {}).get("peers") or []
    peer_key = peers[0].get("public_key") if peers and isinstance(peers[0], dict) else None
    if not (isinstance(peer_key, str) and KEY_RE.match(peer_key)):
        raise LabError(UNKNOWN, "registration response lacks a valid peer public key")
    addresses = ((cfg or {}).get("interface") or {}).get("addresses") or {}
    try:
        v4 = str(ipaddress.IPv4Address(addresses.get("v4")))
    except (ValueError, TypeError):
        raise LabError(UNKNOWN, "registration response lacks a valid IPv4 client address") from None
    v6 = addresses.get("v6")
    try:
        v6 = str(ipaddress.IPv6Address(v6)) if v6 else None
    except ValueError:
        v6 = None
    endpoint = peers[0].get("endpoint") or {}
    return {"id": reg_id, "token": token, "peer_public_key": peer_key, "address_v4": v4,
            "address_v6": v6, "peer_endpoint_v4": endpoint.get("v4"), "peer_endpoint_host": endpoint.get("host")}


class WarpApi:
    """Minimal consumer-WARP registration client. ``transport`` is injectable for tests."""

    def __init__(self, transport=None):
        self.transport = transport or self._urllib_transport

    @staticmethod
    def _urllib_transport(method: str, path: str, body: dict | None, token: str | None) -> tuple[int, bytes]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"https://{WARP_API_HOST}{WARP_API_PREFIX}/{path}", data=data,
                                     method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", "okhttp/3.12.1")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=WARP_API_TIMEOUT_S) as resp:
                return resp.status, resp.read(MAX_API_RESPONSE + 1)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(MAX_API_RESPONSE + 1)

    def call(self, method: str, path: str, body: dict | None = None, token: str | None = None) -> dict:
        last = "no attempt"
        for attempt in range(WARP_API_MAX_ATTEMPTS):
            try:
                status, raw = self.transport(method, path, body, token)
            except (OSError, TimeoutError) as exc:
                last = f"network error: {type(exc).__name__}"
            else:
                if len(raw) > MAX_API_RESPONSE:
                    raise LabError(UNKNOWN, "WARP API response too large")
                if 200 <= status < 300:
                    try:
                        return json.loads(raw or b"{}")
                    except ValueError:
                        raise LabError(UNKNOWN, "WARP API returned invalid JSON") from None
                if status == 429:
                    raise LabError(RATE_LIMITED, "WARP API rate limited the registration")
                if status < 500:
                    raise LabError(UNKNOWN, f"WARP API rejected {method} {path.split('/')[0]}: HTTP {status}")
                last = f"HTTP {status}"
            if attempt + 1 < WARP_API_MAX_ATTEMPTS:
                time.sleep(2)
        raise LabError(LOCAL_RESOURCE_ERROR, f"WARP API unavailable after {WARP_API_MAX_ATTEMPTS} attempts ({last})")


def register_probe_identity(runner: "CommandRunner", api: WarpApi, conf_dir: str = CONF_DIR,
                            key_dir: str = KEY_DIR, clock=now_s) -> str:
    """Create the single Lab identity, or finish enabling an existing one. Never registers twice."""
    meta_path = os.path.join(conf_dir, IDENTITY_FILE)
    key_path = os.path.join(key_dir, KEY_FILE)
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
        if meta.get("warp_enabled"):
            return "exists"
        reg = meta["registration"]
        api.call("PATCH", f"reg/{reg['id']}", {"warp_enabled": True}, reg["token"])
        meta["warp_enabled"] = True
        _atomic_write(meta_path, json.dumps(meta, indent=2).encode(), 0o600)
        return "enabled"
    if os.path.exists(key_path):
        raise LabError(PROBE_IDENTITY_INVALID, "a private key exists without identity metadata; refusing to overwrite")

    # Keys are produced by wg itself; the private key travels only through pipes and a 0600 file.
    private_key = runner.run(["wg", "genkey"]).stdout.strip()
    public_key = runner.run(["wg", "pubkey"], input_text=private_key + "\n").stdout.strip()
    if not (KEY_RE.match(private_key) and KEY_RE.match(public_key)):
        raise LabError(LOCAL_RESOURCE_ERROR, "wg produced a malformed key pair")
    tos = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")  # as api/warp.js sends it
    body = {"install_id": "", "tos": tos, "key": public_key,
            "fcm_token": "", "type": "ios", "locale": "en_US"}
    response = api.call("POST", "reg", body)
    reg = _validate_registration(response.get("result"))
    # Persist before enabling: a crash after this point resumes with PATCH instead of a new registration.
    _atomic_write(key_path, (private_key + "\n").encode(), 0o600)
    del private_key
    meta = {"public_key": public_key, "peer_public_key": reg["peer_public_key"],
            "address_v4": reg["address_v4"], "address_v6": reg["address_v6"],
            "peer_endpoint_v4": reg["peer_endpoint_v4"], "peer_endpoint_host": reg["peer_endpoint_host"],
            "registration": {"id": reg["id"], "token": reg["token"], "api": WARP_API_PREFIX},
            "warp_enabled": False, "created_at": iso(clock())}
    _atomic_write(meta_path, json.dumps(meta, indent=2).encode(), 0o600)
    api.call("PATCH", f"reg/{reg['id']}", {"warp_enabled": True}, reg["token"])
    meta["warp_enabled"] = True
    _atomic_write(meta_path, json.dumps(meta, indent=2).encode(), 0o600)
    return "created"


# --- commands --------------------------------------------------------------------------------------
@dataclass
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class CommandRunner:
    """The only place subprocesses start: argv lists, never a shell, bounded time."""

    def run(self, argv: list[str], input_text: str | None = None, check: bool = True,
            timeout: float = COMMAND_TIMEOUT_S) -> CommandResult:
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise LabError(UNKNOWN, "command must be a non-empty list of strings")
        try:
            proc = subprocess.run(argv, input=input_text, capture_output=True, text=True,
                                  timeout=timeout, shell=False, check=False)
        except FileNotFoundError:
            raise LabError(LOCAL_RESOURCE_ERROR, f"command not found: {argv[0]}") from None
        except subprocess.TimeoutExpired:
            raise LabError(TIMEOUT, f"command timed out: {argv[0]}") from None
        result = CommandResult(proc.returncode, proc.stdout, proc.stderr)
        if check and proc.returncode != 0:
            raise LabError(LOCAL_RESOURCE_ERROR,
                           f"{' '.join(argv[:4])} failed ({proc.returncode}): {proc.stderr.strip()[:200]}")
        return result


# --- probe engines -----------------------------------------------------------------------------------
@dataclass
class ProbeResult:
    handshake_ok: bool
    traffic_ok: bool = False
    error_code: str | None = None
    message: str = ""
    handshake_observed_at: int | None = None
    probe_completion_ms: int | None = None   # trigger → Lab saw a fresh handshake (NOT protocol RTT)
    traffic_total_ms: int | None = None      # curl time_total over the tunnel (TLS + HTTP included)
    evidence: dict = field(default_factory=dict)

    @property
    def lab_failure(self) -> bool:
        return self.error_code in LAB_FAILURE_CODES


class ProbeEngine:
    """Network side of the Lab. Business logic depends only on this interface."""

    def probe_handshake(self, endpoint: Endpoint, identity: Identity) -> ProbeResult:
        raise NotImplementedError

    def deep_verify(self, endpoint: Endpoint, identity: Identity) -> ProbeResult:
        raise NotImplementedError


CURL_TIMEOUT_CODES = {28}
CURL_TLS_CODES = {35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91}
CURL_DNS_CODES = {6}


class LinuxWireGuardProbeEngine(ProbeEngine):
    """Kernel WireGuard in a namespace. Topology per probe:

        host netns:  ens3, default route, production — untouched; owns the encrypted UDP socket
        ael-XXXXXX:  lo + aelXXXXXX (WARP client address/32, MTU 1280, default dev aelXXXXXX)

    The probe namespace has no other interface, so cleartext can only leave through the tunnel.
    """

    def __init__(self, runner: CommandRunner | None = None, sleep=time.sleep, monotonic=time.monotonic,
                 clock=now_s):
        self.runner = runner or CommandRunner()
        self.sleep, self.monotonic, self.clock = sleep, monotonic, clock

    # names are generated here, never derived from input
    @staticmethod
    def new_names() -> tuple[str, str]:
        token = secrets.token_hex(3)
        return f"{NS_PREFIX}{token}", f"{IF_PREFIX}{token}"

    def preflight(self) -> None:
        self.runner.run(["wg", "--version"])
        self.runner.run(["modprobe", "wireguard"])

    def _setup(self, ns: str, ifname: str, endpoint: Endpoint, identity: Identity) -> None:
        r = self.runner.run
        try:
            r(["ip", "netns", "add", ns])
            r(["ip", "link", "add", "dev", ifname, "type", "wireguard"])
        except LabError as exc:
            raise LabError(LOCAL_RESOURCE_ERROR, str(exc)) from None
        try:
            # private-key is a path: wg reads the file, the key never appears in argv
            r(["wg", "set", ifname, "private-key", identity.key_path,
               "peer", identity.peer_public_key, "endpoint", endpoint.wg_endpoint,
               "allowed-ips", "0.0.0.0/0"])
            r(["ip", "link", "set", "dev", ifname, "netns", ns])
            r(["ip", "-n", ns, "link", "set", "dev", "lo", "up"])
            r(["ip", "-n", ns, "address", "add", f"{identity.address_v4}/32", "dev", ifname])
            r(["ip", "-n", ns, "link", "set", "dev", ifname, "mtu", str(MTU), "up"])
        except LabError as exc:
            raise LabError(TUNNEL_SETUP_FAILED, str(exc)) from None
        try:
            r(["ip", "-n", ns, "route", "add", "default", "dev", ifname])
        except LabError as exc:
            raise LabError(ROUTE_SETUP_FAILED, str(exc)) from None
        self._assert_isolated(ns, ifname)

    def _assert_isolated(self, ns: str, ifname: str) -> None:
        links = self.runner.run(["ip", "-n", ns, "-o", "link", "show"]).stdout
        names = sorted(m.group(1) for m in re.finditer(r"^\d+:\s+([^:@\s]+)", links, re.M))
        routes = [line.split() for line in self.runner.run(["ip", "-n", ns, "-4", "route", "show"]).stdout.splitlines()
                  if line.strip()]
        defaults = [r for r in routes if r and r[0] == "default"]
        if names != sorted(["lo", ifname]) or len(defaults) != 1 or defaults[0][:3] != ["default", "dev", ifname]:
            raise LabError(ROUTE_SETUP_FAILED, f"probe namespace not isolated: links={names} routes={routes}")

    def _wg_counters(self, ns: str, ifname: str) -> tuple[int, int, int]:
        """(latest_handshake_s, rx_bytes, tx_bytes). Uses subcommands that never print the private key."""
        hs = self.runner.run(["ip", "netns", "exec", ns, "wg", "show", ifname, "latest-handshakes"]).stdout.split()
        tr = self.runner.run(["ip", "netns", "exec", ns, "wg", "show", ifname, "transfer"]).stdout.split()
        try:
            return int(hs[1]), int(tr[1]), int(tr[2])
        except (IndexError, ValueError):
            raise LabError(LOCAL_RESOURCE_ERROR, "unexpected wg show output") from None

    def _trigger(self, ns: str) -> None:
        self.runner.run(["ip", "netns", "exec", ns, "ping", "-c", "1", "-W", "1", "-q", TRIGGER_TARGET],
                        check=False, timeout=5)

    def _await_handshake(self, ns: str, ifname: str) -> tuple[int | None, int]:
        start = self.monotonic()
        next_trigger = start
        while True:
            elapsed = self.monotonic() - start
            if elapsed >= HANDSHAKE_TIMEOUT_S:
                return None, int(elapsed * 1000)
            if self.monotonic() >= next_trigger:
                self._trigger(ns)
                next_trigger = self.monotonic() + TRIGGER_INTERVAL_S
            latest, _, _ = self._wg_counters(ns, ifname)
            if latest > 0:  # fresh interface: any handshake timestamp is from this probe
                return latest, int((self.monotonic() - start) * 1000)
            self.sleep(POLL_INTERVAL_S)

    def _curl(self, ns: str, url: str, extra: list[str]) -> tuple[int, str, dict]:
        marker = "\n__AEL__"
        argv = ["ip", "netns", "exec", ns, "curl", "--silent", "--show-error", "--proto", "=https",
                "--tlsv1.2", "--max-time", str(HTTPS_MAX_TIME_S), "--max-filesize", str(HTTPS_MAX_BYTES),
                "--output", "-", "--write-out",
                marker + " %{http_code} %{ssl_verify_result} %{time_appconnect} %{time_total}",
                *extra, url]
        res = self.runner.run(argv, check=False, timeout=HTTPS_MAX_TIME_S + 5)
        body, _, tail = res.stdout.rpartition(marker)
        parts = tail.split()
        info = {}
        with contextlib.suppress(ValueError):
            if len(parts) == 4:
                info = {"http_code": int(parts[0]), "ssl_verify_result": parts[1],
                        "time_appconnect_s": float(parts[2]), "time_total_s": float(parts[3])}
        return res.returncode, body[:HTTPS_MAX_BYTES], info

    def _teardown(self, ns: str, ifname: str) -> None:
        self.runner.run(["ip", "netns", "delete", ns], check=False)       # destroys the moved interface
        self.runner.run(["ip", "link", "delete", "dev", ifname], check=False)  # if it never moved

    def _run(self, endpoint: Endpoint, identity: Identity, deep: bool) -> ProbeResult:
        ns, ifname = self.new_names()
        evidence: dict = {"namespace": ns}
        try:
            self.preflight()
            self._setup(ns, ifname, endpoint, identity)
            evidence["namespace_isolated"] = True
            _, rx0, tx0 = self._wg_counters(ns, ifname)
            latest, waited_ms = self._await_handshake(ns, ifname)
            if latest is None:
                _, rx1, tx1 = self._wg_counters(ns, ifname)
                evidence.update(rx_before=rx0, tx_before=tx0, rx_after=rx1, tx_after=tx1)
                return ProbeResult(False, error_code=HANDSHAKE_NO_RESPONSE,
                                   message=f"no handshake within {HANDSHAKE_TIMEOUT_S:g}s",
                                   probe_completion_ms=waited_ms, evidence=evidence)
            result = ProbeResult(True, handshake_observed_at=latest, probe_completion_ms=waited_ms)
            if deep:
                code, body, info = self._curl(ns, HTTPS_URL, [])
                _, rx1, tx1 = self._wg_counters(ns, ifname)
                trace = dict(line.split("=", 1) for line in body.splitlines() if "=" in line)
                evidence.update(rx_before=rx0, tx_before=tx0, rx_after=rx1, tx_after=tx1, https=info,
                                trace_warp=trace.get("warp"), trace_colo=trace.get("colo"))
                if code in CURL_TIMEOUT_CODES:
                    result.error_code = HTTPS_TIMEOUT
                elif code in CURL_TLS_CODES:
                    result.error_code = HTTPS_TLS_FAILED
                elif code != 0 or info.get("http_code") != 200 or info.get("ssl_verify_result") != "0":
                    result.error_code = TRAFFIC_FAILED
                elif not (rx1 > rx0 and tx1 > tx0):
                    result.error_code = TRAFFIC_FAILED  # HTTPS cannot succeed without tunnel bytes
                else:
                    result.traffic_ok = True
                    result.traffic_total_ms = int(info["time_total_s"] * 1000)
                if result.error_code:
                    result.message = f"curl exit {code}, https={info}"
                dns_code, _, dns_info = self._curl(ns, DNS_URL, ["--doh-url", DOH_URL])
                evidence["dns_ok"] = dns_code == 0 and dns_info.get("http_code") == 200
                evidence["dns_error"] = None if evidence["dns_ok"] else (
                    DNS_FAILED if dns_code in CURL_DNS_CODES else f"curl exit {dns_code}")
            result.evidence = evidence
            return result
        except LabError as exc:
            return ProbeResult(False, error_code=exc.code, message=str(exc), evidence=evidence)
        finally:  # also on KeyboardInterrupt / SIGTERM: tear down, then let the run abort unrecorded
            self._teardown(ns, ifname)

    def probe_handshake(self, endpoint: Endpoint, identity: Identity) -> ProbeResult:
        return self._run(endpoint, identity, deep=False)

    def deep_verify(self, endpoint: Endpoint, identity: Identity) -> ProbeResult:
        return self._run(endpoint, identity, deep=True)


def find_stale_resources(netns_list: str, link_list: str) -> tuple[list[str], list[str]]:
    """Lab-owned names only (strict pattern); everything else is somebody else's and stays."""
    namespaces = [line.split()[0] for line in netns_list.splitlines() if line.split() and NS_RE.match(line.split()[0])]
    links = [m.group(1) for m in re.finditer(r"^\d+:\s+([^:@\s]+)", link_list, re.M) if IF_RE.match(m.group(1))]
    return namespaces, links


def cleanup_stale(runner: CommandRunner, min_age_s: int = 0, netns_dir: str = "/run/netns") -> dict:
    namespaces, links = find_stale_resources(runner.run(["ip", "netns", "list"]).stdout,
                                             runner.run(["ip", "-o", "link", "show"]).stdout)
    removed = {"namespaces": [], "links": []}
    for ns in namespaces:
        with contextlib.suppress(OSError):
            if min_age_s and time.time() - os.stat(os.path.join(netns_dir, ns)).st_mtime < min_age_s:
                continue
        runner.run(["ip", "netns", "delete", ns], check=False)
        removed["namespaces"].append(ns)
    for link in links:
        runner.run(["ip", "link", "delete", "dev", link], check=False)
        removed["links"].append(link)
    return removed


# --- state machine -------------------------------------------------------------------------------------
@dataclass
class EndpointRow:
    endpoint_id: str
    state: str = DISCOVERED
    consecutive_successes: int = 0
    consecutive_failures: int = 0
    last_handshake_ok_at: int | None = None
    last_traffic_ok_at: int | None = None
    expires_at: int | None = None
    last_error_code: str | None = None
    last_error_at: int | None = None
    quarantine_until: int | None = None
    manual_blacklist: int = 0


def apply_outcome(row: EndpointRow, result: ProbeResult, deep: bool, now: int) -> EndpointRow:
    """Pure transition. Lab failures leave the endpoint untouched (no penalty, no credit)."""
    if result.lab_failure:
        return row
    nxt = EndpointRow(**vars(row))
    if result.handshake_ok:
        nxt.last_handshake_ok_at = now
    if deep and result.handshake_ok and result.traffic_ok:
        nxt.consecutive_successes += 1
        nxt.consecutive_failures = 0
        nxt.last_traffic_ok_at = now
        nxt.quarantine_until = None
        if nxt.manual_blacklist:
            nxt.state, nxt.expires_at = VERIFIED, None  # blacklist outranks every automatic state
        else:
            nxt.state, nxt.expires_at = ACTIVE, now + ACTIVE_TTL_S
        return nxt
    if not deep and result.handshake_ok:
        # A handshake alone never creates ACTIVE and only advances fresh candidates. SUSPECT, QUARANTINE
        # and DEAD keep their state and failure count: they recover through a deep verify (or re-import).
        if nxt.state in (DISCOVERED, PROBING):
            nxt.state = HANDSHAKE_OK
            nxt.consecutive_failures = 0
        return nxt
    # endpoint failure
    nxt.consecutive_successes = 0
    nxt.consecutive_failures += 1
    nxt.last_error_code = result.error_code or UNKNOWN
    nxt.last_error_at = now
    nxt.expires_at = None  # leaves generator eligibility immediately
    if row.state == ACTIVE:
        nxt.state = SUSPECT  # first meaningful failure: out of the pool, quick recheck next
    elif row.state == QUARANTINE:
        if nxt.consecutive_failures >= SUSPECT_TO_QUARANTINE_FAILURES + QUARANTINE_TO_DEAD_FAILURES:
            nxt.state = DEAD
    elif row.state != DEAD and nxt.consecutive_failures >= SUSPECT_TO_QUARANTINE_FAILURES:
        nxt.state, nxt.quarantine_until = QUARANTINE, now + QUARANTINE_S
    return nxt


def is_eligible(row: EndpointRow, now: int) -> bool:
    return (row.state == ACTIVE and not row.manual_blacklist and row.expires_at is not None
            and row.expires_at > now and row.last_traffic_ok_at is not None
            and row.last_traffic_ok_at > now - ACTIVE_TTL_S)


def due_for_batch(row: EndpointRow, now: int) -> bool:
    """verify-all skips blacklisted, DEAD and still-cooling QUARANTINE endpoints (an explicit verify may not)."""
    if row.manual_blacklist or row.state == DEAD:
        return False
    return not (row.state == QUARANTINE and row.quarantine_until is not None and row.quarantine_until > now)


def global_failure_suspected(results: list[ProbeResult]) -> bool:
    """Every endpoint in a sizeable batch silent at once points at the Lab or the VPS uplink."""
    endpoint_results = [r for r in results if not r.lab_failure]
    return (len(endpoint_results) >= GLOBAL_GUARD_MIN_BATCH
            and all(not r.handshake_ok and r.error_code == HANDSHAKE_NO_RESPONSE for r in endpoint_results))


# --- storage ---------------------------------------------------------------------------------------------
SCHEMA_V1 = """
CREATE TABLE endpoint (
  endpoint_id TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  address_family INTEGER NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_probe_at INTEGER,
  last_handshake_ok_at INTEGER,
  last_traffic_ok_at INTEGER,
  expires_at INTEGER,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_at INTEGER,
  quarantine_until INTEGER,
  manual_blacklist INTEGER NOT NULL DEFAULT 0,
  probe_completion_ms INTEGER,
  traffic_total_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL REFERENCES endpoint(endpoint_id),
  timestamp INTEGER NOT NULL,
  probe_type TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER,
  error_code TEXT,
  operation_id TEXT NOT NULL
);
CREATE INDEX observation_endpoint_ts ON observation(endpoint_id, timestamp);
CREATE TABLE lab_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

ROW_FIELDS = tuple(EndpointRow.__dataclass_fields__)


class Store:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.migrate()

    def migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise LabError(LOCAL_RESOURCE_ERROR, f"database schema {version} is newer than this Lab ({SCHEMA_VERSION})")
        if version == 0:
            with self.transaction():
                for stmt in filter(str.strip, SCHEMA_V1.split(";")):
                    self.conn.execute(stmt)
                self.conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextlib.contextmanager
    def transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield self.conn
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")

    def upsert_candidate(self, ep: Endpoint, source: str, now: int) -> bool:
        """Insert as DISCOVERED or refresh last_seen_at; returns True for a new endpoint.
        A DEAD endpoint found again after the quarantine cooldown restarts as DISCOVERED."""
        existing = self.get(ep.endpoint_id)
        is_new = existing is None
        if existing is not None and existing["state"] == DEAD and (existing["last_error_at"] or 0) <= now - QUARANTINE_S:
            self.conn.execute("UPDATE endpoint SET state=?, consecutive_failures=0, quarantine_until=NULL,"
                              " updated_at=? WHERE endpoint_id=?", (DISCOVERED, now, ep.endpoint_id))
        self.conn.execute(
            "INSERT INTO endpoint (endpoint_id, ip, port, address_family, state, source, first_seen_at,"
            " last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(endpoint_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, source=excluded.source,"
            " updated_at=excluded.updated_at",
            (ep.endpoint_id, ep.ip, ep.port, ep.family, DISCOVERED, source, now, now, now, now))
        return is_new

    def get(self, endpoint_id: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM endpoint WHERE endpoint_id=?", (endpoint_id,)).fetchone()

    def all(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM endpoint ORDER BY ip, port").fetchall()

    @staticmethod
    def to_row(rec: sqlite3.Row) -> EndpointRow:
        return EndpointRow(**{k: rec[k] for k in ROW_FIELDS})

    def record(self, endpoint_id: str, result: ProbeResult, deep: bool, now: int, operation_id: str,
               apply_transition: bool = True) -> EndpointRow:
        rec = self.get(endpoint_id)
        if rec is None:
            raise LabError(UNKNOWN, f"unknown endpoint {endpoint_id}; import it from the candidates file first")
        old = self.to_row(rec)
        new = apply_outcome(old, result, deep, now) if apply_transition else old
        outcome = ("lab_failure" if result.lab_failure else "suppressed" if not apply_transition
                   else "ok" if result.handshake_ok else "fail")
        self.conn.execute(
            "INSERT INTO observation (endpoint_id, timestamp, probe_type, result, duration_ms, error_code,"
            " operation_id) VALUES (?,?,?,?,?,?,?)",
            (endpoint_id, now, "handshake", outcome, result.probe_completion_ms,
             None if result.handshake_ok else result.error_code, operation_id))
        if deep and result.handshake_ok:
            t_outcome = "lab_failure" if result.lab_failure else ("ok" if result.traffic_ok else "fail")
            self.conn.execute(
                "INSERT INTO observation (endpoint_id, timestamp, probe_type, result, duration_ms, error_code,"
                " operation_id) VALUES (?,?,?,?,?,?,?)",
                (endpoint_id, now, "traffic", t_outcome, result.traffic_total_ms,
                 None if result.traffic_ok else result.error_code, operation_id))
        sets = ", ".join(f"{k}=?" for k in ROW_FIELDS if k != "endpoint_id")
        values = [getattr(new, k) for k in ROW_FIELDS if k != "endpoint_id"]
        self.conn.execute(
            f"UPDATE endpoint SET {sets}, last_probe_at=?, updated_at=?,"
            " probe_completion_ms=COALESCE(?, probe_completion_ms), traffic_total_ms=COALESCE(?, traffic_total_ms)"
            " WHERE endpoint_id=?",
            (*values, now, now, result.probe_completion_ms if result.handshake_ok else None,
             result.traffic_total_ms, endpoint_id))
        return new

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT INTO lab_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET"
                          " value=excluded.value", (key, value))

    def meta(self) -> dict:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT key, value FROM lab_meta")}

    def prune(self, now: int) -> int:
        return self.conn.execute("DELETE FROM observation WHERE timestamp < ?",
                                 (now - OBSERVATION_RETENTION_S,)).rowcount


# --- snapshot ------------------------------------------------------------------------------------------------
SNAPSHOT_TOP_KEYS = ("schema_version", "generated_at", "expires_at", "lab_status", "endpoints")
SNAPSHOT_LAB_STATUSES = ("ok", "empty", "degraded")
SNAPSHOT_ENDPOINT_KEYS = ("ip", "port", "family", "state", "lab_verified_at", "expires_at", "source_class",
                          "probe_completion_ms", "traffic_total_ms")


def build_snapshot(rows: list[sqlite3.Row], lab_status: str, now: int) -> dict:
    endpoints = []
    for rec in rows:
        if rec["source"] == "negative_control" or not is_eligible(Store.to_row(rec), now):
            continue
        endpoints.append({"ip": rec["ip"], "port": rec["port"], "family": rec["address_family"],
                          "state": "active", "lab_verified_at": iso(rec["last_traffic_ok_at"]),
                          "expires_at": iso(rec["expires_at"]), "source_class": rec["source"],
                          "probe_completion_ms": rec["probe_completion_ms"],
                          "traffic_total_ms": rec["traffic_total_ms"]})
    expires = min((rec["expires_at"] for rec in rows if rec["source"] != "negative_control"
                   and is_eligible(Store.to_row(rec), now)), default=now)
    if lab_status == "ok" and not endpoints:
        lab_status = "empty"
    return {"schema_version": SNAPSHOT_SCHEMA_VERSION, "generated_at": iso(now), "expires_at": iso(expires),
            "lab_status": lab_status, "endpoints": endpoints}


def validate_snapshot(doc: object, now: int) -> list[dict]:
    """What a consumer must check before trusting the file; raises on anything unexpected (fail closed)."""
    def parse(ts: object) -> int:
        return int(dt.datetime.strptime(str(ts), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp())

    if not isinstance(doc, dict) or doc.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        raise ValueError("unsupported snapshot schema")
    if set(doc) != set(SNAPSHOT_TOP_KEYS) or doc["lab_status"] not in SNAPSHOT_LAB_STATUSES:
        raise ValueError("unexpected snapshot fields or lab_status")
    if parse(doc["generated_at"]) > now + 60:
        raise ValueError("snapshot generated in the future")
    if parse(doc["expires_at"]) <= now:
        return []
    fresh = []
    for ep in doc.get("endpoints", []):
        if set(ep) != set(SNAPSHOT_ENDPOINT_KEYS):
            raise ValueError("unexpected endpoint fields")
        checked = parse_endpoint(ep["ip"], ep["port"])
        if ep["state"] == "active" and parse(ep["expires_at"]) > now:
            fresh.append({**ep, "ip": checked.ip})
    return fresh


def write_snapshot(public_dir: str, snapshot: dict) -> str:
    path = os.path.join(public_dir, SNAPSHOT_FILE)
    _atomic_write(path, (json.dumps(snapshot, indent=2) + "\n").encode(), 0o644)
    return path


# --- orchestration -----------------------------------------------------------------------------------------------
class Lab:
    def __init__(self, store: Store, engine: ProbeEngine, identity_loader=load_identity, clock=now_s,
                 public_dir: str = PUBLIC_DIR):
        self.store, self.engine, self.identity_loader = store, engine, identity_loader
        self.clock, self.public_dir = clock, public_dir

    def _probe_many(self, endpoint_ids: list[str], deep: bool) -> list[tuple[str, ProbeResult, int]]:
        """(endpoint_id, result, finished_at): each result keeps its own time, never the batch end."""
        try:
            identity = self.identity_loader()
        except LabError as exc:
            fail = ProbeResult(False, error_code=exc.code, message=str(exc))
            now = self.clock()
            return [(eid, fail, now) for eid in endpoint_ids]
        results = []
        for eid in endpoint_ids:  # sequential by design (Phase A: deep concurrency 1)
            ep = parse_endpoint_id(eid)
            res = self.engine.deep_verify(ep, identity) if deep else self.engine.probe_handshake(ep, identity)
            results.append((eid, res, self.clock()))
        return results

    def run(self, endpoint_ids: list[str], deep: bool) -> list[tuple[str, ProbeResult]]:
        for eid in endpoint_ids:
            if self.store.get(eid) is None:
                raise LabError(UNKNOWN, f"unknown endpoint {eid}; import it from the candidates file first")
            if self.store.get(eid)["manual_blacklist"]:
                raise LabError(UNKNOWN, f"{eid} is blacklisted")
        operation_id = secrets.token_hex(8)
        results = self._probe_many(endpoint_ids, deep)
        guard = global_failure_suspected([r for _, r, _ in results])
        lab_failures = [r for _, r, _ in results if r.lab_failure]
        now = self.clock()
        with self.store.transaction():
            for eid, res, finished_at in results:
                self.store.record(eid, res, deep, finished_at, operation_id, apply_transition=not guard)
            status = ("lab_failure" if lab_failures and len(lab_failures) == len(results)
                      else "suspect_global" if guard else "degraded" if lab_failures else "ok")
            self.store.set_meta("last_run_at", str(now))
            self.store.set_meta("last_run_status", status)
            self.store.set_meta("last_operation_id", operation_id)
            if lab_failures:
                self.store.set_meta("last_lab_failure", lab_failures[0].error_code or UNKNOWN)
            self.store.prune(now)
        self.publish()
        return [(eid, res) for eid, res, _ in results]

    def publish(self) -> dict:
        now = self.clock()
        status = self.store.meta().get("last_run_status", "ok")
        snapshot = build_snapshot(self.store.all(), "ok" if status == "ok" else "degraded", now)
        write_snapshot(self.public_dir, snapshot)
        return snapshot


# --- CLI ---------------------------------------------------------------------------------------------------------
@contextlib.contextmanager
def global_lock(path: str = LOCK_FILE):
    if fcntl is None:
        raise LabError(LOCAL_RESOURCE_ERROR, "endpoint-lab runs on Linux only")
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LabError(LOCAL_RESOURCE_ERROR, "another endpoint-lab run holds the lock") from None
        yield
    finally:
        os.close(fd)


def ensure_dirs() -> None:
    for path, mode in ((CONF_DIR, 0o700), (KEY_DIR, 0o700), (STATE_DIR, 0o700), (PUBLIC_DIR, 0o755)):
        os.makedirs(path, mode=mode, exist_ok=True)
        os.chmod(path, mode)


def format_result(eid: str, res: ProbeResult) -> str:
    ev = res.evidence
    parts = [f"{eid:<22}", f"handshake={'yes' if res.handshake_ok else 'no':<3}",
             f"traffic={'yes' if res.traffic_ok else 'no':<3}",
             f"completion_ms={res.probe_completion_ms}", f"https_total_ms={res.traffic_total_ms}",
             f"error={res.error_code or '-'}"]
    if "rx_before" in ev:
        parts.append(f"rx {ev['rx_before']}->{ev['rx_after']} tx {ev['tx_before']}->{ev['tx_after']}")
    if ev.get("https"):
        parts.append(f"http={ev['https'].get('http_code')} tls_verify={ev['https'].get('ssl_verify_result')}")
    if "trace_warp" in ev:
        parts.append(f"warp={ev.get('trace_warp')} colo={ev.get('trace_colo')} dns_ok={ev.get('dns_ok')}")
    if res.message and res.error_code:
        parts.append(f"({res.message})")
    return redact("  ".join(parts))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="endpoint-lab", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("list")
    imp = sub.add_parser("import-candidates")
    imp.add_argument("file")
    sub.add_parser("register-probe-identity")
    for name in ("probe", "verify"):
        sub.add_parser(name).add_argument("endpoint_id")
    sub.add_parser("verify-all")
    sub.add_parser("snapshot")
    sub.add_parser("cleanup")
    args = parser.parse_args(argv)

    try:
        if os.name != "posix" or os.geteuid() != 0:
            raise LabError(LOCAL_RESOURCE_ERROR, "endpoint-lab must run as root on the Lab host")
        os.umask(0o077)  # lab.db and its WAL files root-only; the snapshot is chmod-ed 0644 explicitly
        ensure_dirs()
        with contextlib.suppress(FileNotFoundError):
            os.chmod(os.path.join(STATE_DIR, DB_FILE), 0o600)
        with global_lock():
            runner = CommandRunner()
            cleanup_stale(runner, min_age_s=STALE_RESOURCE_AGE_S)
            store = Store(os.path.join(STATE_DIR, DB_FILE))
            lab = Lab(store, LinuxWireGuardProbeEngine(runner))
            if args.cmd == "register-probe-identity":
                print(register_probe_identity(runner, WarpApi()))
            elif args.cmd == "import-candidates":
                now = now_s()
                with store.transaction():
                    added = sum(store.upsert_candidate(ep, src, now) for ep, src in load_candidates(args.file))
                print(f"imported; new endpoints: {added}")
            elif args.cmd in ("probe", "verify"):
                eid = parse_endpoint_id(args.endpoint_id).endpoint_id
                for e, res in lab.run([eid], deep=args.cmd == "verify"):
                    print(format_result(e, res))
            elif args.cmd == "verify-all":
                ids = [r["endpoint_id"] for r in store.all() if due_for_batch(store.to_row(r), now_s())]
                for e, res in lab.run(ids, deep=True):
                    print(format_result(e, res))
                print(f"run status: {store.meta().get('last_run_status')}")
            elif args.cmd == "snapshot":
                print(json.dumps(lab.publish(), indent=2))
            elif args.cmd == "cleanup":
                print(json.dumps(cleanup_stale(runner, min_age_s=0)))
            elif args.cmd == "list":
                for r in store.all():
                    print(f"{r['endpoint_id']:<22} {r['state']:<12} src={r['source']:<16} ok={r['consecutive_successes']}"
                          f" fail={r['consecutive_failures']} traffic_ok_at={iso(r['last_traffic_ok_at'])}"
                          f" expires={iso(r['expires_at'])} err={r['last_error_code'] or '-'}")
            elif args.cmd == "status":
                rows = store.all()
                counts: dict[str, int] = {}
                for r in rows:
                    counts[r["state"]] = counts.get(r["state"], 0) + 1
                eligible = sum(is_eligible(store.to_row(r), now_s()) for r in rows)
                try:
                    ident = load_identity()
                    ident_status = f"ok (created {ident.created_at})"
                except LabError as exc:
                    ident_status = f"{exc.code}: {exc}"
                meta = store.meta()
                print(json.dumps({"probe_identity": ident_status, "endpoints": len(rows), "states": counts,
                                  "eligible_active": eligible, "last_run_at": iso(int(meta["last_run_at"]))
                                  if "last_run_at" in meta else None,
                                  "last_run_status": meta.get("last_run_status")}, indent=2))
        return 0
    except LabError as exc:
        log(f"endpoint-lab: {exc.code}: {exc}")
        return 2
    except KeyboardInterrupt:
        log(f"endpoint-lab: {CANCELLED}: interrupted; probe resources torn down, nothing recorded")
        return 130


def _sigterm_to_interrupt(signum, frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _sigterm_to_interrupt)
    sys.exit(main())
