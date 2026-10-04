#!/usr/bin/env python3
"""endpoint-lab — keeps a fresh pool of verified Cloudflare WARP WireGuard endpoints (Endpoint Lab).

A candidate ``IP:UDP-port`` is ACTIVE only after a real stock WireGuard handshake with the Lab's own
WARP identity *and* a TLS-verified HTTPS request through that tunnel to one of several Cloudflare
verification targets. Each probe runs in a throw-away network namespace: the WireGuard interface is
created in the host namespace (its encrypted UDP socket stays there) and then moved into the
namespace, which has nothing but ``lo`` and that interface. Host routes and rules are never touched.

Phase B adds continuous operation: ``refresh`` (re-verify the pool) and ``discovery`` (small,
incremental, bounded candidate checks) run from systemd timers. A circuit breaker with control
endpoints keeps a failure of the Lab itself (verification targets down, uplink, identity, local
tooling) from being booked against endpoints. Results go to SQLite; eligible endpoints are published
as an atomic, secret-free ``active-pool.json``. Nothing here is read by the web generator yet.

Run ``endpoint-lab -h``. Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
try:
    import fcntl  # Linux only (the VPS); absent on Windows dev machines
except ImportError:  # pragma: no cover
    fcntl = None
import hashlib
import http.client
import ipaddress
import json
import math
import os
import re
try:
    import resource  # POSIX only
except ImportError:  # pragma: no cover
    resource = None
import secrets
import signal
import sqlite3
import ssl
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, replace

# --- fixed paths (never taken from input) --------------------------------------------------------
CONF_DIR = "/etc/amnezia-endpoint-lab"            # 0700 root: registration metadata, candidates, config
# Ubuntu's AppArmor profile for /usr/bin/wg only lets it read files under /etc/wireguard/**.
KEY_DIR = "/etc/wireguard/amnezia-endpoint-lab"   # 0700 root
KEY_FILE = "wg.key"                               # 0600: WireGuard private key only
IDENTITY_FILE = "identity.json"                   # 0600: public addressing + registration metadata
CONFIG_FILE = "config.json"                       # optional operator config (test knobs only)
STATE_DIR = "/var/lib/amnezia-endpoint-lab"       # 0700 root: lab.db
PUBLIC_DIR = "/var/lib/amnezia-endpoint-lab/public"  # 0755: active-pool.json (0644), future ro mount
DB_FILE = "lab.db"
DB_BACKUP_DIR = "backups"                         # inside STATE_DIR: copies taken before migrations
SNAPSHOT_FILE = "active-pool.json"
STATUS_FILE = "lab-status.json"                   # public, secret-free, IP-free status for monitoring (0644)
STATUS_SCHEMA_VERSION = 1
LOCK_FILE = "/run/amnezia-endpoint-lab.lock"
REVISION_FILE = "/usr/local/share/amnezia-endpoint-lab/REVISION"  # written by install.sh

# --- protocol and policy --------------------------------------------------------------------------
OFFICIAL_PORTS = (2408, 500, 1701, 4500)  # Cloudflare WARP WireGuard ports (developers.cloudflare.com)
CONSUMER_PREFIX = ipaddress.ip_network("162.159.192.0/24")   # documented consumer WARP range
CLOUDFLARE_ONE_PREFIX = ipaddress.ip_network("162.159.193.0/24")
NEGATIVE_CONTROL_PREFIX = ipaddress.ip_network("192.0.2.0/24")  # RFC 5737 TEST-NET-1
# Candidates must sit in these prefixes: the Lab researches WARP ingress, it is not a general scanner.
ALLOWED_PREFIXES = (CONSUMER_PREFIX, CLOUDFLARE_ONE_PREFIX,
                    ipaddress.ip_network("162.159.195.0/24"),   # legacy/community-observed WARP
                    ipaddress.ip_network("162.159.204.0/24"),   # legacy/community-observed WARP
                    ipaddress.ip_network("188.114.96.0/22"),    # legacy/community-observed WARP
                    NEGATIVE_CONTROL_PREFIX)
MAX_CANDIDATES = 64
# Mirror of src/server/endpointCache.js HARDCODED_FALLBACK (a unit test keeps them equal).
LEGACY_BUILTIN_IPS = ("162.159.192.1", "162.159.192.8", "162.159.193.1", "162.159.193.8", "162.159.195.1",
                      "162.159.195.8", "188.114.96.1", "188.114.96.8", "188.114.97.1", "188.114.97.66",
                      "188.114.99.1")

# Source = provenance, never health.
SRC_PHASE_A = "phase_a_verified"
SRC_CONSUMER = "consumer_official_seed"
SRC_LEGACY = "legacy_builtin"
SRC_CF_ONE = "cloudflare_one_observation"
SRC_COMMUNITY = "community"
SRC_EXPERIMENTAL = "experimental"
SRC_NEGATIVE = "negative_control"
SOURCE_CLASSES = (SRC_PHASE_A, SRC_CONSUMER, SRC_LEGACY, SRC_CF_ONE, SRC_COMMUNITY, SRC_EXPERIMENTAL, SRC_NEGATIVE)

WARP_API_HOST = "api.cloudflareclient.com"
WARP_API_PREFIX = "/v0i1909051800"  # same API version api/warp.js uses in production
WARP_API_TIMEOUT_S = 20
WARP_API_MAX_ATTEMPTS = 2           # PATCH/GET only; POST reg is sent at most once, ever
MAX_API_RESPONSE = 256 * 1024
IDENTITY_API_CHECK_INTERVAL_S = 30 * 60

MTU = 1280
# Host benchmark 2026-10-04 (Phase B): detection median ~80 ms, max ~1.07 s at every polling interval;
# 250 ms halves the CPU of a silent probe vs 100 ms. Refresh waits past WireGuard's 5 s REKEY_TIMEOUT
# so a lost initiation is retried; discovery accepts one initiation (a miss only delays discovery).
POLL_INTERVAL_S = 0.25
TRIGGER_INTERVAL_S = 1.0
REFRESH_HANDSHAKE_TIMEOUT_S = 8.0
DISCOVERY_HANDSHAKE_TIMEOUT_S = 3.0
TRIGGER_TARGET = "1.1.1.1"
TARGET_MAX_TIME_S = 4   # healthy sessions answer in 30-100 ms; 4 s bounds the cost of a dead session
# Host data 2026-10-04 evening: ~30% of tunnel sessions handshook (often only after ~1 s) yet carried no
# traffic to any target, while a fresh session to the same endpoint worked. A deep probe therefore uses up
# to two sessions; the second one only when the first handshook but carried nothing. A first session whose
# handshake was slow and whose first target timed out is abandoned at once (the rest would time out too).
MAX_SESSIONS_PER_PROBE = 2
SLOW_HANDSHAKE_MS = 900
HTTPS_MAX_BYTES = 8192
COMMAND_TIMEOUT_S = 20


@dataclass(frozen=True)
class Target:
    name: str
    url: str
    extra: tuple = ()


# Verified through a real tunnel on 2026-10-04 (HTTP 200, ssl_verify_result=0). Two are DNS-free IP
# literals (certificates carry IP SANs); the third is a different Cloudflare service resolved by DoH.
VERIFICATION_TARGETS = (
    Target("cf-1111", "https://1.1.1.1/cdn-cgi/trace"),
    Target("cf-1001", "https://1.0.0.1/cdn-cgi/trace"),
    Target("cf-www", "https://www.cloudflare.com/cdn-cgi/trace", ("--doh-url", "https://1.0.0.1/dns-query")),
)
UNREACHABLE_TARGET = Target("simulated-unreachable", "https://192.0.2.1/cdn-cgi/trace")  # config test knob

ACTIVE_TTL_S = 7 * 60               # ACTIVE expires 7 min after the last successful deep verify
# B1b (2026-10-04): rolling refresh. The B1a monolithic 3-min batch over ~48 endpoints took 108-162 s of every
# 180 s; a 60 s timer verifying the least-recently verified third of the pool spreads the same probe rate evenly.
REFRESH_INTERVAL_S = 60             # timer cadence (documentation + snapshot TTL)
ROLLING_SLICE_MIN, ROLLING_SLICE_MAX = 4, 12   # ACTIVE endpoints per run: ceil(ACTIVE / 3) within these bounds
REFRESH_SUSPECT_MAX, REFRESH_VERIFYING_MAX, REFRESH_QUARANTINE_MAX, REFRESH_PROMOTE_MAX = 8, 4, 4, 8
SNAPSHOT_TTL_S = 180                # top-level expiry: shortly after the next expected refresh
QUARANTINE_BACKOFF_S = (15 * 60, 30 * 60, 60 * 60)   # bounded, never unbounded exponential
QUARANTINE_TO_DEAD_FAILURES = 10    # further consecutive failures after entering QUARANTINE (unchanged)
DEAD_RESURRECT_AFTER_S = 6 * 3600
MANUAL_QUARANTINE_DEFAULT_S = 3600
MANUAL_QUARANTINE_MAX_S = 7 * 24 * 3600
TARGET_ACTIVE, SOFT_FLOOR, MAX_ACTIVE = 24, 12, 48
ACTIVE_HIGH = 28                    # hot working set: above this, park down to TARGET_ACTIVE (VERIFIED reserve)
MAX_REFRESH_ENDPOINTS = 32
REFRESH_WALL_S = 45
# Lock timing invariants (a unit test checks them, including the unit file's TimeoutStartSec):
#   discovery holds the lock at most max(DISCOVERY_WALL_S) + worst_case_probe_s(discovery) + slack
#   < REFRESH_LOCK_WAIT_S, and REFRESH_LOCK_WAIT_S + REFRESH_WALL_S + worst_case_probe_s(refresh) + slack
#   < the refresh unit's TimeoutStartSec. The wall budget is checked before each probe, so the last probe
#   may overrun it by up to one worst-case probe.
REFRESH_LOCK_WAIT_S = 90
JOB_SLACK_S = 10                    # startup, cleanup sweep, commit, snapshot
# Rolling refresh holds the lock ~15-25% of the time; without waiting, discovery lost whole 30-min slots
# (host, 2026-10-04 18:32Z). It waits briefly; refresh still wins (it waits longer than discovery's wall budget).
DISCOVERY_LOCK_WAIT_S = 40
DISCOVERY_WALL_S = (40, 45)         # normal, elevated; both below REFRESH_LOCK_WAIT_S so refresh always wins
DISCOVERY_MAX_FAILURES = 24
DEAD_RESURRECT_PER_RUN = 2
CF_ONE_EVERY_N_RUNS = 4             # one Cloudflare One observation per N discovery runs
CURSOR_MULT, CURSOR_ADD = 167, 89   # deterministic permutation of a /24: (167*i + 89) mod 256
EARLY_CONTROL_STREAK = 3
ANOMALY_MIN, ANOMALY_SHARE = 3, 0.5
OBSERVATION_RETENTION_S = 14 * 24 * 3600
HISTORY_RETENTION_S = 90 * 24 * 3600   # transitions, runs, operator events
PRUNE_INTERVAL_S = 3600
QUICK_CHECK_INTERVAL_S = 24 * 3600
WAL_TRUNCATE_INTERVAL_S = 24 * 3600
STALE_RESOURCE_AGE_S = 600
# Resource guards (MemAvailable kB, load per CPU, free disk bytes)
DISCOVERY_MIN_MEM_KB, REFRESH_MIN_MEM_KB = 200 * 1024, 100 * 1024
DISCOVERY_MAX_LOAD_PER_CPU = 2.0
MIN_DISK_FREE = 512 * 1024 * 1024

SCHEMA_VERSION = 3
SNAPSHOT_SCHEMA_VERSION = 2

NS_PREFIX = "ael-"
IF_PREFIX = "ael"
NS_RE = re.compile(r"^ael-[0-9a-f]{6}$")
IF_RE = re.compile(r"^ael[0-9a-f]{6}$")
KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")  # base64 of exactly 32 bytes
SECRET_LIKE_RE = re.compile(r"[A-Za-z0-9+/]{42,43}=")
REASON_RE = re.compile(r"^[\w .,:;()/#+\-]{1,200}$")

# --- states and error taxonomy ----------------------------------------------------------------------
DISCOVERED, PROBING, HANDSHAKE_OK, VERIFYING, VERIFIED, ACTIVE = (
    "DISCOVERED", "PROBING", "HANDSHAKE_OK", "VERIFYING", "VERIFIED", "ACTIVE")
SUSPECT, QUARANTINE, DEAD = "SUSPECT", "QUARANTINE", "DEAD"
STATES = (DISCOVERED, PROBING, HANDSHAKE_OK, VERIFYING, VERIFIED, ACTIVE, SUSPECT, QUARANTINE, DEAD)

LAB_OK, LAB_DEGRADED, LAB_UNAVAILABLE = "OK", "DEGRADED", "UNAVAILABLE"

TIMEOUT = "TIMEOUT"
HANDSHAKE_NO_RESPONSE = "HANDSHAKE_NO_RESPONSE"
HANDSHAKE_INVALID_OR_UNEXPECTED = "HANDSHAKE_INVALID_OR_UNEXPECTED"  # raw engines only; kernel drops bad replies
TUNNEL_SETUP_FAILED = "TUNNEL_SETUP_FAILED"
ROUTE_SETUP_FAILED = "ROUTE_SETUP_FAILED"
DNS_FAILED = "DNS_FAILED"
HTTPS_TIMEOUT = "HTTPS_TIMEOUT"
HTTPS_TLS_FAILED = "HTTPS_TLS_FAILED"
TRAFFIC_FAILED = "TRAFFIC_FAILED"
TARGETS_UNREACHABLE = "TARGETS_UNREACHABLE"     # handshake ok, every target failed: inconclusive on its own
PROBE_IDENTITY_INVALID = "PROBE_IDENTITY_INVALID"
PROBE_IDENTITY_AMBIGUOUS = "PROBE_IDENTITY_AMBIGUOUS"
LOCAL_RESOURCE_ERROR = "LOCAL_RESOURCE_ERROR"
RATE_LIMITED = "RATE_LIMITED"
CANCELLED = "CANCELLED"
UNKNOWN = "UNKNOWN"
ERROR_CODES = (TIMEOUT, HANDSHAKE_NO_RESPONSE, HANDSHAKE_INVALID_OR_UNEXPECTED, TUNNEL_SETUP_FAILED,
               ROUTE_SETUP_FAILED, DNS_FAILED, HTTPS_TIMEOUT, HTTPS_TLS_FAILED, TRAFFIC_FAILED,
               TARGETS_UNREACHABLE, PROBE_IDENTITY_INVALID, PROBE_IDENTITY_AMBIGUOUS, LOCAL_RESOURCE_ERROR,
               RATE_LIMITED, CANCELLED, UNKNOWN)
# Failures of the Lab itself: they never penalise an endpoint. UNKNOWN is treated as ours too.
LAB_FAILURE_CODES = frozenset({TUNNEL_SETUP_FAILED, ROUTE_SETUP_FAILED, PROBE_IDENTITY_INVALID,
                               PROBE_IDENTITY_AMBIGUOUS, LOCAL_RESOURCE_ERROR, RATE_LIMITED, CANCELLED, UNKNOWN})

# Registration lifecycle of the single probe identity
REG_ABSENT, REG_PENDING, REG_READY, REG_AMBIGUOUS, REG_INVALID = "ABSENT", "PENDING", "READY", "AMBIGUOUS", "INVALID"


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


def parse_iso(ts: object) -> int:
    return int(dt.datetime.strptime(str(ts), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).timestamp())


def age_s(ts: int | None, now: int) -> int | None:
    """Age that never goes negative when the wall clock steps back."""
    return None if ts is None else max(0, now - ts)


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


def classify_source(ip: str) -> str:
    """Default provenance by address (used for seeds and the v1 -> v2 migration)."""
    addr = ipaddress.ip_address(ip)
    if addr in NEGATIVE_CONTROL_PREFIX:
        return SRC_NEGATIVE
    if addr in CONSUMER_PREFIX:
        return SRC_CONSUMER
    if addr in CLOUDFLARE_ONE_PREFIX:
        return SRC_CF_ONE
    return SRC_LEGACY


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


def cursor_ip(network: ipaddress.IPv4Network, position: int) -> str:
    """Deterministic shuffled walk over a /24 (all 256 addresses: anycast, no LAN semantics)."""
    return str(network.network_address + ((CURSOR_MULT * (position % 256) + CURSOR_ADD) % 256))


# --- operator config (test knobs only) --------------------------------------------------------------
@dataclass(frozen=True)
class LabConfig:
    disabled_targets: tuple = ()
    simulate_targets_unreachable: bool = False
    simulate_failing_targets: tuple = ()   # these targets point to an unreachable TEST-NET address


def load_config(conf_dir: str = CONF_DIR) -> LabConfig:
    path = os.path.join(conf_dir, CONFIG_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return LabConfig()
    except (OSError, ValueError) as exc:
        raise LabError(LOCAL_RESOURCE_ERROR, f"config.json unreadable: {type(exc).__name__}") from None
    names = {t.name for t in VERIFICATION_TARGETS}
    disabled = tuple(str(n) for n in data.get("disabled_targets", []))
    failing = tuple(str(n) for n in data.get("simulate_failing_targets", []))
    if not (set(disabled) | set(failing)) <= names:
        raise LabError(LOCAL_RESOURCE_ERROR, "config.json: unknown target name")
    return LabConfig(disabled, bool(data.get("simulate_targets_unreachable", False)), failing)


def active_targets(config: LabConfig) -> list[Target]:
    if config.simulate_targets_unreachable:
        return [UNREACHABLE_TARGET]
    return [Target(t.name, UNREACHABLE_TARGET.url) if t.name in config.simulate_failing_targets else t
            for t in VERIFICATION_TARGETS if t.name not in config.disabled_targets]


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


def _read_meta(conf_dir: str) -> dict | None:
    try:
        with open(os.path.join(conf_dir, IDENTITY_FILE), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def registration_state(meta: dict | None) -> str:
    """ABSENT / PENDING / READY / AMBIGUOUS / INVALID. Phase A files (no state field) are READY."""
    if meta is None:
        return REG_ABSENT
    state = meta.get("registration_state")
    if state is None:
        return REG_READY if meta.get("warp_enabled") else REG_PENDING
    if state == REG_PENDING and not (meta.get("registration") or {}).get("id"):
        return REG_AMBIGUOUS  # crashed between "POST may have been sent" and "response stored"
    return state


def _write_meta(conf_dir: str, meta: dict) -> None:
    _atomic_write(os.path.join(conf_dir, IDENTITY_FILE), json.dumps(meta, indent=2).encode(), 0o600)


def load_identity(conf_dir: str = CONF_DIR, key_dir: str = KEY_DIR) -> Identity:
    key_path = os.path.join(key_dir, KEY_FILE)
    try:
        meta = _read_meta(conf_dir)
    except (OSError, ValueError) as exc:
        raise LabError(PROBE_IDENTITY_INVALID, f"probe identity unreadable: {type(exc).__name__}") from None
    state = registration_state(meta)
    if state == REG_AMBIGUOUS:
        raise LabError(PROBE_IDENTITY_AMBIGUOUS, "registration outcome unknown; operator must resolve "
                                                 "(see ENDPOINT_LAB.md, identity recovery)")
    if state != REG_READY:
        raise LabError(PROBE_IDENTITY_INVALID, f"probe identity is {state}")
    try:
        if not os.path.isfile(key_path):
            raise FileNotFoundError(key_path)
        if os.name == "posix" and os.stat(key_path).st_mode & 0o077:
            raise LabError(PROBE_IDENTITY_INVALID, "private key file is readable by group/others")
        ident = Identity(key_path=key_path, public_key=meta["public_key"], peer_public_key=meta["peer_public_key"],
                         address_v4=meta["address_v4"], address_v6=meta.get("address_v6"),
                         registration_id=meta["registration"]["id"], warp_enabled=bool(meta.get("warp_enabled")),
                         created_at=meta.get("created_at", ""))
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


class ApiNotSent(Exception):
    """The request provably never left: nothing can have been created."""


class ApiResponseLost(Exception):
    """The request may have reached the API, but no complete response arrived."""


class WarpApi:
    """Minimal consumer-WARP client. ``transport(method, path, body, token) -> (status, bytes)`` may raise
    ApiNotSent / ApiResponseLost; it is injectable for tests."""

    def __init__(self, transport=None):
        self.transport = transport or self._http_transport

    @staticmethod
    def _http_transport(method: str, path: str, body: dict | None, token: str | None) -> tuple[int, bytes]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "User-Agent": "okhttp/3.12.1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        conn = http.client.HTTPSConnection(WARP_API_HOST, 443, timeout=WARP_API_TIMEOUT_S,
                                           context=ssl.create_default_context())
        try:
            try:
                conn.connect()  # DNS, TCP and TLS: a failure here means nothing was sent
            except (OSError, http.client.HTTPException) as exc:
                raise ApiNotSent(type(exc).__name__) from None
            try:
                conn.request(method, f"{WARP_API_PREFIX}/{path}", body=data, headers=headers)
                resp = conn.getresponse()
                return resp.status, resp.read(MAX_API_RESPONSE + 1)
            except (OSError, http.client.HTTPException) as exc:
                raise ApiResponseLost(type(exc).__name__) from None
        finally:
            conn.close()

    def once(self, method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
        status, raw = self.transport(method, path, body, token)
        if len(raw) > MAX_API_RESPONSE:
            raise LabError(UNKNOWN, "WARP API response too large")
        try:
            return status, (json.loads(raw) if raw else {})
        except ValueError:
            return status, {"_invalid_json": True}

    def call(self, method: str, path: str, body: dict | None = None, token: str | None = None,
             attempts: int = WARP_API_MAX_ATTEMPTS) -> dict:
        """Bounded retries for idempotent calls (never used for POST reg)."""
        if method == "POST":
            raise LabError(UNKNOWN, "POST must go through WarpApi.once")
        last = "no attempt"
        for attempt in range(attempts):
            try:
                status, payload = self.once(method, path, body, token)
            except (ApiNotSent, ApiResponseLost) as exc:
                last = f"network: {exc}"
            else:
                if 200 <= status < 300 and not payload.get("_invalid_json"):
                    return payload
                if status == 429:
                    raise LabError(RATE_LIMITED, "WARP API rate limited the request")
                if 400 <= status < 500:
                    raise LabError(PROBE_IDENTITY_INVALID if status in (401, 403, 404) else UNKNOWN,
                                   f"WARP API rejected {method} {path.split('/')[0]}: HTTP {status}")
                last = f"HTTP {status}"
            if attempt + 1 < attempts:
                time.sleep(2)
        raise LabError(LOCAL_RESOURCE_ERROR, f"WARP API unavailable after {attempts} attempt(s) ({last})")


def register_probe_identity(runner: "CommandRunner", api: WarpApi, conf_dir: str = CONF_DIR,
                            key_dir: str = KEY_DIR, clock=now_s) -> str:
    """ABSENT → PENDING (key + operation persisted) → exactly one POST → READY, or AMBIGUOUS when the
    outcome cannot be known. Never POSTs twice; PENDING with a stored registration only resumes PATCH."""
    meta_path = os.path.join(conf_dir, IDENTITY_FILE)
    key_path = os.path.join(key_dir, KEY_FILE)
    meta = _read_meta(conf_dir)
    state = registration_state(meta)
    if state == REG_READY:
        return "exists"
    if state == REG_AMBIGUOUS:
        if meta.get("registration_state") != REG_AMBIGUOUS:
            meta["registration_state"] = REG_AMBIGUOUS
            _write_meta(conf_dir, meta)
        raise LabError(PROBE_IDENTITY_AMBIGUOUS, "previous registration attempt has an unknown outcome; "
                                                 "resolve manually (identity-reset) before registering again")
    if state == REG_INVALID:
        raise LabError(PROBE_IDENTITY_INVALID, "identity is INVALID; rotate it manually (identity-reset)")
    if state == REG_PENDING:  # POST answered and stored, PATCH not done yet
        reg = meta["registration"]
        api.call("PATCH", f"reg/{reg['id']}", {"warp_enabled": True}, reg["token"])
        meta.update(warp_enabled=True, registration_state=REG_READY)
        _write_meta(conf_dir, meta)
        return "enabled"
    if os.path.exists(key_path):
        raise LabError(PROBE_IDENTITY_INVALID, "a private key exists without identity metadata; refusing to overwrite")

    # Keys are produced by wg itself; the private key travels only through pipes and a 0600 file.
    private_key = runner.run(["wg", "genkey"]).stdout.strip()
    public_key = runner.run(["wg", "pubkey"], input_text=private_key + "\n").stdout.strip()
    if not (KEY_RE.match(private_key) and KEY_RE.match(public_key)):
        raise LabError(LOCAL_RESOURCE_ERROR, "wg produced a malformed key pair")
    _atomic_write(key_path, (private_key + "\n").encode(), 0o600)
    del private_key
    meta = {"registration_state": REG_PENDING, "operation_id": secrets.token_hex(8), "started_at": iso(clock()),
            "public_key": public_key, "registration": None, "warp_enabled": False}
    _write_meta(conf_dir, meta)  # from here on a crash reads as AMBIGUOUS, never as "try again"

    def abandon() -> None:  # proven: nothing was registered with this key
        for path in (meta_path, key_path):
            with contextlib.suppress(FileNotFoundError):
                os.unlink(path)

    def ambiguous(why: str) -> LabError:
        meta.update(registration_state=REG_AMBIGUOUS, ambiguous_reason=why, ambiguous_at=iso(clock()))
        _write_meta(conf_dir, meta)
        return LabError(PROBE_IDENTITY_AMBIGUOUS, f"registration outcome unknown ({why}); no retry")

    tos = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")  # as api/warp.js sends it
    body = {"install_id": "", "tos": tos, "key": public_key, "fcm_token": "", "type": "ios", "locale": "en_US"}
    try:
        status, payload = api.once("POST", "reg", body)
    except ApiNotSent as exc:
        abandon()
        raise LabError(LOCAL_RESOURCE_ERROR, f"registration request not sent ({exc}); nothing registered") from None
    except ApiResponseLost as exc:
        raise ambiguous(f"response lost: {exc}") from None
    if 200 <= status < 300:
        try:
            reg = _validate_registration(payload.get("result"))
        except LabError as exc:
            raise ambiguous(f"HTTP {status} with unusable body: {exc}") from None
    elif 400 <= status < 500:  # rejected: no registration exists
        abandon()
        raise LabError(RATE_LIMITED if status == 429 else UNKNOWN, f"registration rejected: HTTP {status}")
    else:  # 5xx may come after the server created the device
        raise ambiguous(f"HTTP {status}")
    meta.update(peer_public_key=reg["peer_public_key"], address_v4=reg["address_v4"], address_v6=reg["address_v6"],
                peer_endpoint_v4=reg["peer_endpoint_v4"], peer_endpoint_host=reg["peer_endpoint_host"],
                registration={"id": reg["id"], "token": reg["token"], "api": WARP_API_PREFIX},
                created_at=iso(clock()))
    _write_meta(conf_dir, meta)  # PENDING with a registration: a rerun only PATCHes
    api.call("PATCH", f"reg/{reg['id']}", {"warp_enabled": True}, reg["token"])
    meta.update(warp_enabled=True, registration_state=REG_READY)
    _write_meta(conf_dir, meta)
    return "created"


def identity_reset(conf_dir: str = CONF_DIR, key_dir: str = KEY_DIR, clock=now_s) -> str:
    """Operator recovery for AMBIGUOUS/INVALID/PENDING: files are retired (renamed), never deleted.
    A READY identity is refused: the working identity is never removed by this tool."""
    meta = _read_meta(conf_dir)
    state = registration_state(meta)
    if state in (REG_READY, REG_ABSENT):
        raise LabError(UNKNOWN, f"identity is {state}; nothing to reset")
    suffix = f".retired-{dt.datetime.fromtimestamp(clock(), dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    for path in (os.path.join(conf_dir, IDENTITY_FILE), os.path.join(key_dir, KEY_FILE)):
        if os.path.exists(path):
            os.replace(path, path + suffix)
    return f"retired {state} identity with suffix {suffix}"


def identity_api_check(api: WarpApi, conf_dir: str = CONF_DIR) -> str:
    """valid | invalid | unknown — GET reg/{id} with the stored token (read-only, bounded)."""
    meta = _read_meta(conf_dir) or {}
    reg = meta.get("registration") or {}
    if not reg.get("id"):
        return "unknown"
    try:
        api.call("GET", f"reg/{reg['id']}", None, reg.get("token"))
        return "valid"
    except LabError as exc:
        return "invalid" if exc.code == PROBE_IDENTITY_INVALID else "unknown"


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
    traffic_total_ms: int | None = None      # curl time_total of the target that answered (TLS + HTTP)
    traffic_bytes: int | None = None         # WireGuard rx+tx bytes during the probe
    target_results: list = field(default_factory=list)  # [(target name, ok, error code)]
    evidence: dict = field(default_factory=dict)
    sessions: int = 1                        # tunnel sessions this probe needed

    @property
    def ok(self) -> bool:
        return self.handshake_ok and self.traffic_ok

    @property
    def lab_failure(self) -> bool:
        return self.error_code in LAB_FAILURE_CODES

    @property
    def inconclusive(self) -> bool:
        return self.handshake_ok and self.error_code == TARGETS_UNREACHABLE

    @property
    def endpoint_failure(self) -> bool:
        return not self.ok and not self.lab_failure and not self.inconclusive


class ProbeEngine:
    """Network side of the Lab. Business logic depends only on this interface."""

    def probe_handshake(self, endpoint: Endpoint, identity: Identity, timeout_s: float | None = None) -> ProbeResult:
        raise NotImplementedError

    def deep_verify(self, endpoint: Endpoint, identity: Identity, timeout_s: float | None = None,
                    targets: list | None = None) -> ProbeResult:
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

    def _await_handshake(self, ns: str, ifname: str, timeout_s: float) -> tuple[int | None, int]:
        start = self.monotonic()
        next_trigger = start
        while True:
            elapsed = self.monotonic() - start
            if elapsed >= timeout_s:
                return None, int(elapsed * 1000)
            if self.monotonic() >= next_trigger:
                self._trigger(ns)
                next_trigger = self.monotonic() + TRIGGER_INTERVAL_S
            latest, _, _ = self._wg_counters(ns, ifname)
            if latest > 0:  # fresh interface: any handshake timestamp is from this probe
                return latest, int((self.monotonic() - start) * 1000)
            self.sleep(POLL_INTERVAL_S)

    def _curl(self, ns: str, url: str, extra: list) -> tuple[int, str, dict]:
        marker = "\n__AEL__"
        argv = ["ip", "netns", "exec", ns, "curl", "--silent", "--show-error", "--proto", "=https",
                "--tlsv1.2", "--max-time", str(TARGET_MAX_TIME_S), "--max-filesize", str(HTTPS_MAX_BYTES),
                "--output", "-", "--write-out",
                marker + " %{http_code} %{ssl_verify_result} %{time_appconnect} %{time_total}",
                *extra, url]
        res = self.runner.run(argv, check=False, timeout=TARGET_MAX_TIME_S + 5)
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

    def _verify_traffic(self, ns: str, ifname: str, targets: list, result: ProbeResult,
                        give_up_on_timeout: bool = False) -> None:
        """Any-one quorum over the verification targets; each target is tried at most once."""
        for target in targets:
            _, rx0, tx0 = self._wg_counters(ns, ifname)
            code, body, info = self._curl(ns, target.url, list(target.extra))
            _, rx1, tx1 = self._wg_counters(ns, ifname)
            if code in CURL_TIMEOUT_CODES:
                err = HTTPS_TIMEOUT
            elif code in CURL_TLS_CODES:
                err = HTTPS_TLS_FAILED
            elif code in CURL_DNS_CODES:
                err = DNS_FAILED
            elif code != 0 or info.get("http_code") != 200 or info.get("ssl_verify_result") != "0":
                err = TRAFFIC_FAILED
            elif not (rx1 > rx0 and tx1 > tx0):
                err = TRAFFIC_FAILED  # HTTPS cannot succeed without tunnel bytes
            else:
                err = None
            result.target_results.append((target.name, err is None, err))
            if err == HTTPS_TIMEOUT and give_up_on_timeout:
                break  # a slow-handshake session that times out is dead: let a fresh session decide
            if err is None:
                trace = dict(line.split("=", 1) for line in body.splitlines() if "=" in line)
                result.traffic_ok = True
                result.traffic_total_ms = int(info["time_total_s"] * 1000)
                result.evidence.update(https=info, target=target.name, trace_warp=trace.get("warp"),
                                       trace_colo=trace.get("colo"))
                return
        result.error_code = TARGETS_UNREACHABLE
        result.message = "every verification target failed: " + ", ".join(
            f"{n}={e}" for n, _, e in result.target_results)

    def _run(self, endpoint: Endpoint, identity: Identity, deep: bool, timeout_s: float,
             targets: list | None) -> ProbeResult:
        """A deep probe gets a second, fresh session only when the first one handshook but no target
        answered; a real endpoint fault fails both. Handshake failures are never retried here."""
        earlier: list = []
        last = MAX_SESSIONS_PER_PROBE if deep else 1
        for session in range(1, last + 1):
            result = self._session(endpoint, identity, deep, timeout_s, targets, may_give_up=session < last)
            result.sessions = session
            result.target_results = earlier + result.target_results
            if not result.inconclusive:
                return result
            earlier = result.target_results
        return result

    def _session(self, endpoint: Endpoint, identity: Identity, deep: bool, timeout_s: float,
                 targets: list | None, may_give_up: bool = False) -> ProbeResult:
        ns, ifname = self.new_names()
        evidence: dict = {"namespace": ns}
        try:
            self.preflight()
            self._setup(ns, ifname, endpoint, identity)
            evidence["namespace_isolated"] = True
            _, rx0, tx0 = self._wg_counters(ns, ifname)
            latest, waited_ms = self._await_handshake(ns, ifname, timeout_s)
            if latest is None:
                _, rx1, tx1 = self._wg_counters(ns, ifname)
                evidence.update(rx_before=rx0, tx_before=tx0, rx_after=rx1, tx_after=tx1)
                if tx1 == tx0:
                    # Not a single initiation left the host (e.g. the trigger could not send): our fault.
                    return ProbeResult(False, error_code=LOCAL_RESOURCE_ERROR,
                                       message="trigger produced no tunnel traffic; no handshake initiation sent",
                                       probe_completion_ms=waited_ms, evidence=evidence)
                return ProbeResult(False, error_code=HANDSHAKE_NO_RESPONSE,
                                   message=f"no handshake within {timeout_s:g}s", probe_completion_ms=waited_ms,
                                   traffic_bytes=(rx1 - rx0) + (tx1 - tx0), evidence=evidence)
            result = ProbeResult(True, handshake_observed_at=latest, probe_completion_ms=waited_ms, evidence=evidence)
            if deep:
                self._verify_traffic(ns, ifname, list(targets or VERIFICATION_TARGETS), result,
                                     give_up_on_timeout=may_give_up and waited_ms >= SLOW_HANDSHAKE_MS)
            _, rx1, tx1 = self._wg_counters(ns, ifname)
            evidence.update(rx_before=rx0, tx_before=tx0, rx_after=rx1, tx_after=tx1)
            result.traffic_bytes = (rx1 - rx0) + (tx1 - tx0)
            return result
        except LabError as exc:
            return ProbeResult(False, error_code=exc.code, message=str(exc), evidence=evidence)
        finally:  # also on KeyboardInterrupt / SIGTERM: tear down, then let the run abort unrecorded
            self._teardown(ns, ifname)

    def probe_handshake(self, endpoint: Endpoint, identity: Identity, timeout_s: float | None = None) -> ProbeResult:
        return self._run(endpoint, identity, False, timeout_s or REFRESH_HANDSHAKE_TIMEOUT_S, None)

    def deep_verify(self, endpoint: Endpoint, identity: Identity, timeout_s: float | None = None,
                    targets: list | None = None) -> ProbeResult:
        return self._run(endpoint, identity, True, timeout_s or REFRESH_HANDSHAKE_TIMEOUT_S, targets)


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
    quarantine_kind: str | None = None      # 'auto' | 'manual'
    quarantine_level: int = 0               # index into QUARANTINE_BACKOFF_S
    quarantine_failures: int = 0            # failures since entering QUARANTINE (DEAD rule)
    active_since: int | None = None
    first_active_at: int | None = None


def worst_case_probe_s(handshake_timeout_s: float, targets: int = len(VERIFICATION_TARGETS)) -> float:
    """Upper bound of one deep probe: a silent handshake costs at most the timeout; a second session only
    follows a handshake, and every session tries each target once (TARGET_MAX_TIME_S), plus setup/teardown."""
    setup_s = 2.0
    return handshake_timeout_s + MAX_SESSIONS_PER_PROBE * (setup_s + targets * TARGET_MAX_TIME_S) + TRIGGER_INTERVAL_S


def manual_quarantine_active(row: EndpointRow, now: int) -> bool:
    return (row.state == QUARANTINE and row.quarantine_kind == "manual"
            and row.quarantine_until is not None and row.quarantine_until > now)


def apply_outcome(row: EndpointRow, result: ProbeResult, deep: bool, now: int) -> EndpointRow:
    """Pure transition. Lab failures and inconclusive results leave the endpoint untouched.

    First endpoint-specific failure: ACTIVE → SUSPECT (out of the pool at once). A second one
    (SUSPECT, or a re-verification that failed) → QUARANTINE with bounded backoff; ten failures after
    entering QUARANTINE → DEAD. Never-verified candidates just count failures. A deep success always
    leads to ACTIVE unless a blacklist (→ VERIFIED) or an operator quarantine is in force."""
    if result.lab_failure or result.inconclusive:
        return row
    nxt = replace(row)
    if result.handshake_ok:
        nxt.last_handshake_ok_at = now
    if not deep:
        # A handshake alone never creates ACTIVE and only advances fresh candidates.
        if result.handshake_ok and nxt.state in (DISCOVERED, PROBING):
            nxt.state, nxt.consecutive_failures = HANDSHAKE_OK, 0
        return nxt
    if result.ok:
        nxt.consecutive_successes += 1
        nxt.consecutive_failures = 0
        nxt.last_traffic_ok_at = now
        if manual_quarantine_active(row, now):
            return nxt  # an operator quarantine outranks automatic recovery
        nxt.quarantine_until = nxt.quarantine_kind = None
        nxt.quarantine_level = nxt.quarantine_failures = 0
        if nxt.manual_blacklist:
            nxt.state, nxt.expires_at, nxt.active_since = VERIFIED, None, None
        else:
            nxt.active_since = row.active_since if row.state == ACTIVE and row.active_since else now
            nxt.first_active_at = row.first_active_at or now
            nxt.state, nxt.expires_at = ACTIVE, now + ACTIVE_TTL_S
        return nxt
    # endpoint-specific failure
    nxt.consecutive_successes = 0
    nxt.consecutive_failures += 1
    nxt.last_error_code = result.error_code or UNKNOWN
    nxt.last_error_at = now
    nxt.expires_at = nxt.active_since = None  # leaves generator eligibility immediately
    if manual_quarantine_active(row, now):
        return nxt
    if row.state in (ACTIVE, VERIFYING, VERIFIED):
        nxt.state = SUSPECT  # first meaningful failure (or a re-verification that failed)
    elif row.state == SUSPECT:
        nxt.state, nxt.quarantine_kind = QUARANTINE, "auto"
        nxt.quarantine_level, nxt.quarantine_failures = 0, 0
        nxt.quarantine_until = now + QUARANTINE_BACKOFF_S[0]
    elif row.state == QUARANTINE:
        nxt.quarantine_failures += 1
        if nxt.quarantine_failures >= QUARANTINE_TO_DEAD_FAILURES:
            nxt.state, nxt.quarantine_until, nxt.quarantine_kind = DEAD, None, None
        else:
            nxt.quarantine_kind = "auto"
            nxt.quarantine_level = min(row.quarantine_level + 1, len(QUARANTINE_BACKOFF_S) - 1)
            nxt.quarantine_until = now + QUARANTINE_BACKOFF_S[nxt.quarantine_level]
    # DISCOVERED / PROBING / HANDSHAKE_OK (never verified) and DEAD keep their state
    return nxt


def is_eligible(row: EndpointRow, now: int) -> bool:
    return (row.state == ACTIVE and not row.manual_blacklist and row.expires_at is not None
            and row.expires_at > now)


def due_for_refresh(row: EndpointRow, source: str, now: int) -> bool:
    """Refresh re-verifies the pool: ACTIVE, SUSPECT (accelerated recheck), VERIFYING and automatic
    QUARANTINE whose cooldown expired. Blacklist, operator quarantine and negative controls never."""
    if row.manual_blacklist or source == SRC_NEGATIVE:
        return False
    if row.state in (ACTIVE, SUSPECT, VERIFYING):
        return True
    return (row.state == QUARANTINE and row.quarantine_kind != "manual"
            and (row.quarantine_until is None or row.quarantine_until <= now))


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
CREATE TABLE lab_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
"""

# v2: Phase B. Phase A rows are kept; previously verified endpoints must prove themselves again.
SCHEMA_V2 = f"""
ALTER TABLE endpoint ADD COLUMN source_first TEXT;
ALTER TABLE endpoint ADD COLUMN quarantine_kind TEXT;
ALTER TABLE endpoint ADD COLUMN quarantine_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE endpoint ADD COLUMN quarantine_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE endpoint ADD COLUMN blacklist_reason TEXT;
ALTER TABLE endpoint ADD COLUMN blacklist_at INTEGER;
ALTER TABLE endpoint ADD COLUMN active_since INTEGER;
ALTER TABLE endpoint ADD COLUMN first_active_at INTEGER;
ALTER TABLE observation ADD COLUMN bytes INTEGER;
ALTER TABLE observation ADD COLUMN run_kind TEXT;
CREATE INDEX observation_ts ON observation(timestamp);
CREATE TABLE transition (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, endpoint_id TEXT NOT NULL,
  from_state TEXT NOT NULL, to_state TEXT NOT NULL, cause TEXT, operation_id TEXT);
CREATE INDEX transition_ts ON transition(ts);
CREATE TABLE operator_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, endpoint_id TEXT, action TEXT NOT NULL,
  reason TEXT, operation_id TEXT NOT NULL);
CREATE TABLE target_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, endpoint_id TEXT NOT NULL, target TEXT NOT NULL,
  ok INTEGER NOT NULL, error_code TEXT, operation_id TEXT NOT NULL);
CREATE INDEX target_result_ts ON target_result(ts);
CREATE TABLE run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER, status TEXT NOT NULL,
  lab_health TEXT, lab_reason TEXT, probes INTEGER NOT NULL DEFAULT 0, endpoint_failures INTEGER NOT NULL DEFAULT 0,
  lab_failures INTEGER NOT NULL DEFAULT 0, inconclusive INTEGER NOT NULL DEFAULT 0,
  active_after INTEGER, cpu_ms INTEGER, maxrss_kb INTEGER, mem_available_kb INTEGER, swap_used_kb INTEGER,
  bytes INTEGER, note TEXT);
CREATE INDEX run_kind_started ON run(kind, started_at);
UPDATE endpoint SET source_first = source;
UPDATE endpoint SET first_active_at = last_traffic_ok_at WHERE last_traffic_ok_at IS NOT NULL;
UPDATE endpoint SET source = CASE
  WHEN source = '{SRC_NEGATIVE}' THEN '{SRC_NEGATIVE}'
  WHEN last_traffic_ok_at IS NOT NULL THEN '{SRC_PHASE_A}'
  WHEN ip LIKE '162.159.193.%' THEN '{SRC_CF_ONE}'
  WHEN ip LIKE '162.159.192.%' THEN '{SRC_CONSUMER}'
  ELSE '{SRC_LEGACY}' END;
UPDATE endpoint SET state = '{VERIFYING}', expires_at = NULL
  WHERE state IN ('{ACTIVE}', '{SUSPECT}', '{VERIFIED}') AND source <> '{SRC_NEGATIVE}';
UPDATE endpoint SET quarantine_kind = 'auto' WHERE state = '{QUARANTINE}'
"""
# v3: how many tunnel sessions a probe needed (second-chance session statistics)
SCHEMA_V3 = "ALTER TABLE observation ADD COLUMN sessions INTEGER"
MIGRATIONS = {1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V3}

ROW_FIELDS = tuple(EndpointRow.__dataclass_fields__)


class Store:
    def __init__(self, path: str, clock=now_s, read_only: bool = False):
        self.path, self.clock = path, clock
        if read_only:  # status/list/stats/report: no lock, no migration, no writes (WAL allows concurrent readers)
            try:
                self.conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10, isolation_level=None)
                self.conn.row_factory = sqlite3.Row
                version = self.conn.execute("PRAGMA user_version").fetchone()[0]
            except sqlite3.Error as exc:  # e.g. WAL without -shm on a read-only filesystem
                raise LabError(LOCAL_RESOURCE_ERROR, f"database not readable read-only: {exc}; "
                                                     f"monitoring should read {STATUS_FILE} instead") from None
            if version != SCHEMA_VERSION:
                self.conn.close()
                raise LabError(LOCAL_RESOURCE_ERROR, f"database schema {version} != {SCHEMA_VERSION}: let a job migrate it first")
            return
        self.conn = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_size_limit=4194304")
        try:
            self.migrate()
        except BaseException:
            self.conn.close()  # a refused or failed migration leaves no open handle behind
            raise

    def migrate(self) -> None:
        """Versioned, transactional; a copy of an existing DB is taken first. Failure = the Lab does not run."""
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise LabError(LOCAL_RESOURCE_ERROR, f"database schema {version} is newer than this Lab ({SCHEMA_VERSION})")
        if version == SCHEMA_VERSION:
            return
        if version > 0 and self.path != ":memory:":
            backup_dir = os.path.join(os.path.dirname(self.path), DB_BACKUP_DIR)
            os.makedirs(backup_dir, mode=0o700, exist_ok=True)
            dest = sqlite3.connect(os.path.join(backup_dir, f"lab-v{version}-{self.clock()}.db"))
            with dest:
                self.conn.backup(dest)
            dest.close()
        try:
            with self.transaction():
                for target in range(version + 1, SCHEMA_VERSION + 1):
                    for stmt in filter(str.strip, MIGRATIONS[target].split(";")):
                        self.conn.execute(stmt)
                self.conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        except sqlite3.Error as exc:
            raise LabError(LOCAL_RESOURCE_ERROR, f"database migration {version}->{SCHEMA_VERSION} failed: {exc}") from None

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
        A DEAD endpoint found again after the resurrection delay restarts as DISCOVERED."""
        existing = self.get(ep.endpoint_id)
        is_new = existing is None
        if existing is not None and existing["state"] == DEAD and (existing["last_error_at"] or 0) <= now - DEAD_RESURRECT_AFTER_S:
            self.set_state(ep.endpoint_id, DISCOVERED, "reimported", None, now, consecutive_failures=0,
                           quarantine_until=None, quarantine_kind=None, quarantine_level=0, quarantine_failures=0)
        self.conn.execute(
            "INSERT INTO endpoint (endpoint_id, ip, port, address_family, state, source, source_first, first_seen_at,"
            " last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(endpoint_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at",
            (ep.endpoint_id, ep.ip, ep.port, ep.family, DISCOVERED, source, source, now, now, now, now))
        return is_new

    def get(self, endpoint_id: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM endpoint WHERE endpoint_id=?", (endpoint_id,)).fetchone()

    def all(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM endpoint ORDER BY ip, port").fetchall()

    @staticmethod
    def to_row(rec: sqlite3.Row) -> EndpointRow:
        return EndpointRow(**{k: rec[k] for k in ROW_FIELDS})

    def set_state(self, endpoint_id: str, state: str, cause: str, operation_id: str | None, now: int, **cols) -> None:
        old = self.get(endpoint_id)
        if old is None:
            raise LabError(UNKNOWN, f"unknown endpoint {endpoint_id}")
        sets = ", ".join(["state=?", "updated_at=?"] + [f"{k}=?" for k in cols])
        self.conn.execute(f"UPDATE endpoint SET {sets} WHERE endpoint_id=?", (state, now, *cols.values(), endpoint_id))
        if old["state"] != state:
            self.conn.execute("INSERT INTO transition (ts, endpoint_id, from_state, to_state, cause, operation_id)"
                              " VALUES (?,?,?,?,?,?)", (now, endpoint_id, old["state"], state, cause, operation_id))

    def record(self, endpoint_id: str, result: ProbeResult, deep: bool, now: int, operation_id: str,
               apply_transition: bool = True, run_kind: str = "manual") -> EndpointRow:
        rec = self.get(endpoint_id)
        if rec is None:
            raise LabError(UNKNOWN, f"unknown endpoint {endpoint_id}; import it first")
        old = self.to_row(rec)
        new = apply_outcome(old, result, deep, now) if apply_transition else old
        if result.lab_failure:
            hs_outcome = "lab_failure"
        elif not apply_transition:
            hs_outcome = "suppressed"
        else:
            hs_outcome = "ok" if result.handshake_ok else "fail"
        self.conn.execute(
            "INSERT INTO observation (endpoint_id, timestamp, probe_type, result, duration_ms, error_code, operation_id,"
            " bytes, run_kind, sessions) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (endpoint_id, now, "handshake", hs_outcome, result.probe_completion_ms,
             None if result.handshake_ok else result.error_code, operation_id, result.traffic_bytes, run_kind,
             result.sessions))
        if deep and result.handshake_ok:
            if result.inconclusive:
                t_outcome = "inconclusive" if apply_transition else "suppressed"
            elif not apply_transition:
                t_outcome = "suppressed"
            else:
                t_outcome = "ok" if result.traffic_ok else "fail"
            self.conn.execute(
                "INSERT INTO observation (endpoint_id, timestamp, probe_type, result, duration_ms, error_code, operation_id,"
                " run_kind, sessions) VALUES (?,?,?,?,?,?,?,?,?)",
                (endpoint_id, now, "traffic", t_outcome, result.traffic_total_ms,
                 None if result.traffic_ok else result.error_code, operation_id, run_kind, result.sessions))
        for name, ok, err in result.target_results:
            self.conn.execute("INSERT INTO target_result (ts, endpoint_id, target, ok, error_code, operation_id)"
                              " VALUES (?,?,?,?,?,?)", (now, endpoint_id, name, int(ok), err, operation_id))
        cols = {k: getattr(new, k) for k in ROW_FIELDS if k not in ("endpoint_id", "state")}
        cols.update(last_probe_at=now)
        if result.handshake_ok and result.probe_completion_ms is not None:
            cols["probe_completion_ms"] = result.probe_completion_ms
        if result.traffic_total_ms is not None:
            cols["traffic_total_ms"] = result.traffic_total_ms
        cause = "lab_failure" if result.lab_failure else (result.error_code or "verified")
        self.set_state(endpoint_id, new.state, cause, operation_id, now, **cols)
        return new

    def set_meta(self, key: str, value: object) -> None:
        self.conn.execute("INSERT INTO lab_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET"
                          " value=excluded.value", (key, str(value)))

    def meta(self) -> dict:
        return {r["key"]: r["value"] for r in self.conn.execute("SELECT key, value FROM lab_meta")}

    def operator_event(self, endpoint_id: str | None, action: str, reason: str | None, now: int) -> None:
        self.conn.execute("INSERT INTO operator_event (ts, endpoint_id, action, reason, operation_id) VALUES (?,?,?,?,?)",
                          (now, endpoint_id, action, reason, secrets.token_hex(8)))

    def prune(self, now: int) -> int:
        n = self.conn.execute("DELETE FROM observation WHERE timestamp < ?", (now - OBSERVATION_RETENTION_S,)).rowcount
        n += self.conn.execute("DELETE FROM target_result WHERE ts < ?", (now - OBSERVATION_RETENTION_S,)).rowcount
        for table, col in (("transition", "ts"), ("run", "started_at"), ("operator_event", "ts")):
            n += self.conn.execute(f"DELETE FROM {table} WHERE {col} < ?", (now - HISTORY_RETENTION_S,)).rowcount
        return n

    def db_bytes(self) -> int:
        return sum(os.path.getsize(self.path + suffix) for suffix in ("", "-wal", "-shm")
                   if os.path.exists(self.path + suffix))

    def quick_check(self) -> bool:
        return self.conn.execute("PRAGMA quick_check(1)").fetchone()[0] == "ok"


# --- snapshot ------------------------------------------------------------------------------------------------
SNAPSHOT_TOP_KEYS = ("schema_version", "generated_at", "expires_at", "lab_status", "active_count", "endpoints")
SNAPSHOT_LAB_STATUSES = ("ok", "degraded", "unavailable")
SNAPSHOT_ENDPOINT_KEYS = ("ip", "port", "family", "state", "lab_verified_at", "expires_at", "source_class",
                          "probe_completion_ms", "traffic_total_ms")


def build_snapshot(rows: list[sqlite3.Row], lab_health: str, now: int) -> dict:
    """Only fresh eligible endpoints. Top-level expiry follows the next expected refresh, so a stopped
    timer makes the whole file stale even before individual endpoints expire."""
    endpoints = []
    for rec in rows:
        if rec["source"] == SRC_NEGATIVE or not is_eligible(Store.to_row(rec), now):
            continue
        endpoints.append({"ip": rec["ip"], "port": rec["port"], "family": rec["address_family"],
                          "state": "active", "lab_verified_at": iso(rec["last_traffic_ok_at"]),
                          "expires_at": iso(rec["expires_at"]), "source_class": rec["source"],
                          "probe_completion_ms": rec["probe_completion_ms"],
                          "traffic_total_ms": rec["traffic_total_ms"]})
    expires = now + SNAPSHOT_TTL_S
    if endpoints:
        expires = min(expires, min(parse_iso(e["expires_at"]) for e in endpoints))
    return {"schema_version": SNAPSHOT_SCHEMA_VERSION, "generated_at": iso(now), "expires_at": iso(expires),
            "lab_status": lab_health.lower(), "active_count": len(endpoints), "endpoints": endpoints}


def validate_snapshot(doc: object, now: int) -> list[dict]:
    """What a consumer must check before trusting the file; raises on anything unexpected (fail closed)."""
    if not isinstance(doc, dict) or doc.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        raise ValueError("unsupported snapshot schema")
    if set(doc) != set(SNAPSHOT_TOP_KEYS) or doc["lab_status"] not in SNAPSHOT_LAB_STATUSES:
        raise ValueError("unexpected snapshot fields or lab_status")
    if parse_iso(doc["generated_at"]) > now + 60:
        raise ValueError("snapshot generated in the future")
    if not isinstance(doc["endpoints"], list) or doc["active_count"] != len(doc["endpoints"]):
        raise ValueError("active_count does not match endpoints")
    if parse_iso(doc["expires_at"]) <= now:
        return []
    fresh = []
    for ep in doc["endpoints"]:
        if set(ep) != set(SNAPSHOT_ENDPOINT_KEYS):
            raise ValueError("unexpected endpoint fields")
        checked = parse_endpoint(ep["ip"], ep["port"])
        if ep["state"] == "active" and parse_iso(ep["expires_at"]) > now:
            fresh.append({**ep, "ip": checked.ip})
    return fresh


def write_snapshot(public_dir: str, snapshot: dict) -> str:
    path = os.path.join(public_dir, SNAPSHOT_FILE)
    _atomic_write(path, (json.dumps(snapshot, indent=2) + "\n").encode(), 0o644)
    return path


# --- host resources ------------------------------------------------------------------------------------------
@dataclass
class Resources:
    mem_available_kb: int | None
    swap_used_kb: int | None
    load1: float | None
    cpus: int
    disk_free: int | None


def read_resources(state_dir: str = STATE_DIR) -> Resources:
    mem, swap_total, swap_free = None, None, None
    with contextlib.suppress(OSError, ValueError):
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                key, value = line.split(":", 1)
                if key == "MemAvailable":
                    mem = int(value.split()[0])
                elif key == "SwapTotal":
                    swap_total = int(value.split()[0])
                elif key == "SwapFree":
                    swap_free = int(value.split()[0])
    load = None
    with contextlib.suppress(OSError, ValueError, AttributeError):
        load = os.getloadavg()[0]
    disk = None
    with contextlib.suppress(OSError, AttributeError):
        st = os.statvfs(state_dir)
        disk = st.f_bavail * st.f_frsize
    swap = swap_total - swap_free if swap_total is not None and swap_free is not None else None
    return Resources(mem, swap, load, os.cpu_count() or 1, disk)


def discovery_blocked_by(res: Resources) -> str | None:
    if res.mem_available_kb is not None and res.mem_available_kb < DISCOVERY_MIN_MEM_KB:
        return "memory"
    if res.load1 is not None and res.load1 > DISCOVERY_MAX_LOAD_PER_CPU * res.cpus:
        return "load"
    if res.disk_free is not None and res.disk_free < MIN_DISK_FREE:
        return "disk"
    return None


def refresh_reduced(res: Resources) -> bool:
    return ((res.mem_available_kb is not None and res.mem_available_kb < REFRESH_MIN_MEM_KB)
            or (res.disk_free is not None and res.disk_free < MIN_DISK_FREE // 4))


def usage_snapshot() -> tuple[float, int]:
    """(cpu seconds of this process + reaped children, peak RSS kB of the larger of the two)."""
    if resource is None:
        return 0.0, 0
    s, c = resource.getrusage(resource.RUSAGE_SELF), resource.getrusage(resource.RUSAGE_CHILDREN)
    return s.ru_utime + s.ru_stime + c.ru_utime + c.ru_stime, max(s.ru_maxrss, c.ru_maxrss)


# --- orchestration -----------------------------------------------------------------------------------------------
@dataclass
class ControlVerdict:
    global_ok: bool | None          # True: a control passed; False: all controls failed; None: no controls
    results: dict                   # endpoint_id -> (ProbeResult, finished_at)
    reason: str


@dataclass
class BatchOutcome:
    results: list                   # [(endpoint_id, ProbeResult)] as recorded
    lab_health: str
    lab_reason: str
    control: ControlVerdict | None
    aborted: bool = False
    snapshot_ok: bool = True


class Lab:
    def __init__(self, store: Store, engine: ProbeEngine, identity_loader=load_identity, clock=now_s,
                 public_dir: str = PUBLIC_DIR, config: LabConfig | None = None, api: WarpApi | None = None,
                 monotonic=time.monotonic):
        self.store, self.engine, self.identity_loader = store, engine, identity_loader
        self.clock, self.public_dir, self.monotonic = clock, public_dir, monotonic
        self.config = config or LabConfig()
        self.api = api
        self.targets = active_targets(self.config)

    # -- target ordering: the first target that answered stays first for the rest of the run
    def _note_targets(self, res: ProbeResult) -> None:
        winner = next((name for name, ok, _ in res.target_results if ok), None)
        if winner and self.targets and self.targets[0].name != winner:
            self.targets.sort(key=lambda t: t.name != winner)

    # -- controls
    def select_controls(self, now: int) -> list[str]:
        """Two recent known-good endpoints (different IPs, preferably different ports). Kept while they
        stay ACTIVE; otherwise replaced from the healthiest ACTIVE endpoints. Never hardcoded."""
        rows = {r["endpoint_id"]: r for r in self.store.all()}

        def usable(eid: str) -> bool:
            r = rows.get(eid)
            return r is not None and r["source"] != SRC_NEGATIVE and is_eligible(Store.to_row(r), now)

        meta = self.store.meta()
        current = [c for c in json.loads(meta.get("controls", "[]")) if usable(c)][:2]
        ranked = sorted((r for r in rows.values() if usable(r["endpoint_id"])),
                        key=lambda r: (-r["consecutive_successes"], -(r["last_traffic_ok_at"] or 0), r["endpoint_id"]))
        chosen = list(current)
        while len(chosen) < 2:
            taken_ips = {rows[c]["ip"] for c in chosen}
            taken_ports = {rows[c]["port"] for c in chosen}
            pool = [r for r in ranked if r["endpoint_id"] not in chosen and r["ip"] not in taken_ips]
            pick = next((r for r in pool if r["port"] not in taken_ports), pool[0] if pool else None)
            if pick is None:
                break
            chosen.append(pick["endpoint_id"])
        if chosen != json.loads(meta.get("controls", "[]")):
            self.store.set_meta("controls", json.dumps(chosen))
            self.store.set_meta("control_selected_at", now)
            self.store.set_meta("control_reason", "highest consecutive successes among ACTIVE, distinct IPs"
                                if chosen else "no ACTIVE endpoint available")
        return chosen

    def control_check(self, identity: Identity, now: int) -> ControlVerdict:
        controls = self.select_controls(now)
        if not controls:
            return ControlVerdict(None, {}, "NO_CONTROLS")
        results: dict = {}
        for cid in controls:
            res = self.engine.deep_verify(parse_endpoint_id(cid), identity, REFRESH_HANDSHAKE_TIMEOUT_S, self.targets)
            results[cid] = (res, self.clock())
            self._note_targets(res)
            if res.ok:
                return ControlVerdict(True, results, f"control {cid} verified")
        rs = [r for r, _ in results.values()]
        if all(r.lab_failure for r in rs):
            reason = rs[0].error_code or UNKNOWN
        elif all(r.inconclusive for r in rs):
            reason = "VERIFICATION_TARGETS_UNAVAILABLE"
        else:
            reason = "CONTROLS_SILENT"
            if self.api is not None:
                last = int(self.store.meta().get("identity_api_checked_at", "0") or 0)
                if now - last >= IDENTITY_API_CHECK_INTERVAL_S:
                    status = identity_api_check(self.api)
                    self.store.set_meta("identity_api_status", status)
                    self.store.set_meta("identity_api_checked_at", now)
                    reason = {"invalid": PROBE_IDENTITY_INVALID, "valid": "WARP_UDP_UNREACHABLE",
                              "unknown": "VPS_NETWORK_OR_API_UNREACHABLE"}[status]
        return ControlVerdict(False, results, reason)

    # -- the batch with its circuit breaker
    def run_batch(self, endpoint_ids: list[str], kind: str = "manual", timeout_s: float = REFRESH_HANDSHAKE_TIMEOUT_S,
                  wall_s: float | None = None, breaker: bool = True) -> BatchOutcome:
        for eid in endpoint_ids:
            rec = self.store.get(eid)
            if rec is None:
                raise LabError(UNKNOWN, f"unknown endpoint {eid}; import it first")
            if rec["manual_blacklist"]:
                raise LabError(UNKNOWN, f"{eid} is blacklisted")
        operation_id = secrets.token_hex(8)
        started, start_mono = self.clock(), self.monotonic()
        cpu0, _ = usage_snapshot()
        before = {eid: Store.to_row(self.store.get(eid)) for eid in endpoint_ids}
        results: list = []          # [(eid, result, finished_at)]
        verdict: ControlVerdict | None = None   # the latest, decisive control check
        control_runs: list = []                 # every control check of this batch, in order
        verdict_at = -1                         # len(results) when `verdict` was taken
        aborted = False
        try:
            identity = self.identity_loader()
        except LabError as exc:
            fail = ProbeResult(False, error_code=exc.code, message=str(exc))
            results = [(eid, fail, self.clock()) for eid in endpoint_ids]
            identity = None

        def check() -> None:
            nonlocal verdict, verdict_at
            verdict = self.control_check(identity, self.clock())
            verdict_at = len(results)
            control_runs.append(verdict)
        if identity is not None:
            bad_streak = 0
            for eid in endpoint_ids:
                if wall_s is not None and self.monotonic() - start_mono > wall_s:
                    aborted = True  # budget spent: the rest simply ages
                    break
                res = self.engine.deep_verify(parse_endpoint_id(eid), identity, timeout_s, self.targets)
                results.append((eid, res, self.clock()))
                self._note_targets(res)
                was_active = before[eid].state == ACTIVE
                if res.ok:
                    bad_streak = 0
                elif was_active and (res.endpoint_failure or res.inconclusive):
                    bad_streak += 1
                if breaker and verdict is None and (res.inconclusive or bad_streak >= EARLY_CONTROL_STREAK):
                    check()
                    if verdict.global_ok is False:
                        aborted = True  # the Lab cannot prove anything right now: stop spending probes
                        break
        prev_active = [(e, r) for e, r, _ in results if before[e].state == ACTIVE]
        failed_prev = [e for e, r in prev_active if r.endpoint_failure or r.inconclusive]
        anomaly = len(prev_active) >= ANOMALY_MIN and len(failed_prev) >= max(ANOMALY_MIN,
                                                                               math.ceil(ANOMALY_SHARE * len(prev_active)))
        any_inconclusive = any(r.inconclusive for _, r, _ in results)
        mass_failure = (len(results) >= ANOMALY_MIN and all(r.endpoint_failure or r.inconclusive
                                                             for _, r, _ in results))
        if breaker and identity is not None and (anomaly or any_inconclusive or mass_failure):
            # A verdict is valid only for results obtained before it: anything bad that came later
            # (e.g. targets dying mid-batch) needs a fresh control check before it can be booked.
            bad_after = any(i >= verdict_at and (r.inconclusive or (before[e].state == ACTIVE and r.endpoint_failure))
                            for i, (e, r, _) in enumerate(results))
            if verdict is None or (verdict.global_ok is not False and bad_after):
                check()
        global_ok = verdict.global_ok if verdict else True
        if breaker and identity is not None and verdict and global_ok is True and anomaly:
            # The path works again: re-verify the mass failure once instead of booking a transient blip.
            controlled = {c for run in control_runs for c in run.results}
            redo = [e for e in failed_prev if e not in controlled]
            index = {e: i for i, (e, _, _) in enumerate(results)}
            for eid in redo:
                res = self.engine.deep_verify(parse_endpoint_id(eid), identity, timeout_s, self.targets)
                results[index[eid]] = (eid, res, self.clock())
            if any(results[index[e]][1].inconclusive for e in redo):
                check()  # the re-check itself may have hit a fresh outage
                global_ok = verdict.global_ok
        lab_failures = [r for _, r, _ in results if r.lab_failure]
        no_controls_mass = breaker and mass_failure and verdict is not None and verdict.global_ok is None
        recorded = []
        now = self.clock()
        try:
            with self.store.transaction():
                controlled = {c for run in control_runs for c in run.results}
                for eid, res, ts in results:
                    apply = True
                    if eid in controlled:
                        apply = False                       # its later control probe decides, never twice
                    elif res.ok or res.lab_failure:
                        pass
                    elif global_ok is False or no_controls_mass:
                        apply = False                       # Lab/global failure: no endpoint penalty
                    elif res.inconclusive:
                        if breaker and global_ok is True:
                            res = replace(res, error_code=TRAFFIC_FAILED,
                                          message="targets failed here while a control endpoint passed")
                        else:
                            apply = False                   # nobody proved the targets work (or discovery)
                    self.store.record(eid, res, True, ts, operation_id, apply_transition=apply, run_kind=kind)
                    recorded.append((eid, res))
                last_check = {cid: n for n, run in enumerate(control_runs) for cid in run.results}
                for n, run in enumerate(control_runs):
                    for cid, (res, ts) in run.results.items():
                        apply = last_check[cid] == n        # one transition per control endpoint per batch
                        if res.lab_failure:
                            apply = False
                        elif not res.ok:
                            if run.global_ok is True:       # another control passed in that same check
                                if res.inconclusive:
                                    res = replace(res, error_code=TRAFFIC_FAILED,
                                                  message="control: targets failed here while the other control passed")
                            else:
                                apply = False
                        self.store.record(cid, res, True, ts, operation_id, apply_transition=apply, run_kind="control")
                health, reason = self._classify(results, verdict, anomaly, no_controls_mass, lab_failures)
                if breaker or (results and len(lab_failures) == len(results)):
                    self._set_health(health, reason, now)  # pool refreshes own the Lab health; discovery reports only
                self._enforce_cap(now, operation_id)
                cpu1, rss = usage_snapshot()
                res_now = read_resources(os.path.dirname(self.store.path) or ".")
                active_after = sum(is_eligible(Store.to_row(r), now) for r in self.store.all()
                                   if r["source"] != SRC_NEGATIVE)
                self.store.conn.execute(
                    "INSERT INTO run (operation_id, kind, started_at, finished_at, duration_ms, status, lab_health,"
                    " lab_reason, probes, endpoint_failures, lab_failures, inconclusive, active_after, cpu_ms, maxrss_kb,"
                    " mem_available_kb, swap_used_kb, bytes, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (operation_id, kind, started, now, int((self.monotonic() - start_mono) * 1000),
                     "aborted" if aborted else "completed", health, reason, len(results),
                     sum(r.endpoint_failure for _, r in recorded), len(lab_failures),
                     sum(r.inconclusive for _, r, _ in results), active_after, int((cpu1 - cpu0) * 1000), rss,
                     res_now.mem_available_kb, res_now.swap_used_kb,
                     sum((r.traffic_bytes or 0) for _, r, _ in results), None))
                self.store.set_meta(f"last_{kind}_at", now)
                self.store.set_meta("last_run_status", health)
                self.store.set_meta("last_operation_id", operation_id)
        except sqlite3.Error as exc:
            raise LabError(LOCAL_RESOURCE_ERROR, f"DB_WRITE_FAILED: {exc}") from None
        snapshot_ok = self.publish()
        return BatchOutcome(recorded, health, reason, verdict, aborted, snapshot_ok)

    def _enforce_cap(self, now: int, operation_id: str) -> int:
        """Hot working set: above ACTIVE_HIGH the least stable eligible endpoints are parked as VERIFIED
        (verified, waiting for a slot) down to TARGET_ACTIVE: not refreshed, not published. Controls are never
        parked. MAX_ACTIVE stays the absolute ceiling for discovery."""
        controls = set(json.loads(self.store.meta().get("controls", "[]")))
        eligible = [r for r in self.store.all() if r["source"] != SRC_NEGATIVE and is_eligible(Store.to_row(r), now)]
        if len(eligible) <= ACTIVE_HIGH:
            return 0
        excess = len(eligible) - TARGET_ACTIVE
        ranked = sorted((r for r in eligible if r["endpoint_id"] not in controls),
                        key=lambda r: (r["consecutive_successes"], -(r["active_since"] or now), r["endpoint_id"]))
        for r in ranked[:excess]:
            self.store.set_state(r["endpoint_id"], VERIFIED, "pool_cap", operation_id, now,
                                 expires_at=None, active_since=None)
        return min(excess, len(ranked))

    def _classify(self, results, verdict, anomaly, no_controls_mass, lab_failures) -> tuple[str, str]:
        if results and len(lab_failures) == len(results):
            return LAB_UNAVAILABLE, lab_failures[0].error_code or UNKNOWN
        if verdict is not None and verdict.global_ok is False:
            return LAB_UNAVAILABLE, verdict.reason
        if no_controls_mass:
            return LAB_UNAVAILABLE, "NO_CONTROLS_ALL_FAILED"
        if verdict is not None and verdict.global_ok is True and anomaly:
            return LAB_DEGRADED, "TRANSIENT_ANOMALY_RECHECKED"
        if lab_failures:
            return LAB_DEGRADED, lab_failures[0].error_code or UNKNOWN
        if verdict is not None and verdict.global_ok is None and any(r.inconclusive for _, r, _ in results):
            return LAB_DEGRADED, "NO_CONTROLS"
        failed_targets: dict = {}
        probed = [r for _, r, _ in results if r.target_results]
        for r in probed:
            for name, ok, _ in r.target_results:
                if not ok:
                    failed_targets[name] = failed_targets.get(name, 0) + 1
        bad = sorted(n for n, c in failed_targets.items() if probed and c * 2 >= len(probed))
        if bad:
            return LAB_DEGRADED, "TARGET_FAILING:" + ",".join(bad)
        return LAB_OK, "ok"

    def _set_health(self, health: str, reason: str, now: int) -> None:
        meta = self.store.meta()
        if meta.get("lab_health") != health:
            self.store.set_meta("lab_health_since", now)
        self.store.set_meta("lab_health", health)
        self.store.set_meta("lab_health_reason", reason)

    def publish(self) -> bool:
        """Snapshot from committed state only. A write failure is recorded, the old file ages out."""
        now = self.clock()
        meta = self.store.meta()
        snapshot = build_snapshot(self.store.all(), meta.get("lab_health", LAB_OK), now)
        try:
            write_snapshot(self.public_dir, snapshot)
        except OSError as exc:
            with contextlib.suppress(sqlite3.Error):
                with self.store.transaction():
                    self.store.set_meta("last_snapshot_error", f"SNAPSHOT_WRITE_FAILED: {type(exc).__name__}")
                    self.store.set_meta("last_snapshot_error_at", now)
                    self._set_health(LAB_DEGRADED, "SNAPSHOT_WRITE_FAILED", now)
            return False
        with contextlib.suppress(sqlite3.Error):
            with self.store.transaction():
                self.store.set_meta("snapshot_generated_at", now)
                self.store.set_meta("snapshot_expires_at", parse_iso(snapshot["expires_at"]))
                self.store.set_meta("snapshot_active_count", snapshot["active_count"])
        try:  # monitoring reads this file, never the DB; a failure here never fails the job
            _atomic_write(os.path.join(self.public_dir, STATUS_FILE),
                          (json.dumps(public_status(self.store), indent=2) + "\n").encode(), 0o644)
        except (OSError, sqlite3.Error, LabError) as exc:
            log(f"endpoint-lab: {STATUS_FILE} not written: {type(exc).__name__}")
        return True

    # -- scheduled runs
    def refresh_plan(self, now: int, res: Resources) -> list[str]:
        """Rolling slice: the ceil(ACTIVE/3) least-recently verified ACTIVE endpoints (controls included,
        no extra probes for them), every SUSPECT (accelerated recheck), a few VERIFYING and due QUARANTINE,
        and parked VERIFIED endpoints when the pool is below target. Each ACTIVE is re-verified about every
        3 timer ticks, well inside its 7-minute TTL."""
        rows = [r for r in self.store.all() if due_for_refresh(Store.to_row(r), r["source"], now)]
        by_state: dict = {}
        for r in rows:
            by_state.setdefault(r["state"], []).append(r)
        oldest = lambda r: (r["last_traffic_ok_at"] or 0, r["endpoint_id"])  # noqa: E731
        active = sorted(by_state.get(ACTIVE, []), key=oldest)
        slice_n = max(ROLLING_SLICE_MIN, min(ROLLING_SLICE_MAX, math.ceil(len(active) / 3)))
        plan = active[:slice_n]
        if not refresh_reduced(res):
            plan += sorted(by_state.get(SUSPECT, []), key=oldest)[:REFRESH_SUSPECT_MAX]
            eligible = sum(is_eligible(Store.to_row(r), now) for r in self.store.all() if r["source"] != SRC_NEGATIVE)
            if eligible < TARGET_ACTIVE:
                parked = [r for r in self.store.all() if r["state"] == VERIFIED and not r["manual_blacklist"]
                          and r["source"] != SRC_NEGATIVE]
                parked.sort(key=lambda r: (-r["consecutive_successes"], -(r["last_traffic_ok_at"] or 0), r["endpoint_id"]))
                plan += parked[:min(REFRESH_PROMOTE_MAX, TARGET_ACTIVE - eligible)]
            plan += sorted(by_state.get(VERIFYING, []), key=oldest)[:REFRESH_VERIFYING_MAX]
            plan += sorted(by_state.get(QUARANTINE, []), key=lambda r: (r["quarantine_until"] or 0, r["endpoint_id"]))[
                :REFRESH_QUARANTINE_MAX]
        return [r["endpoint_id"] for r in plan[:MAX_REFRESH_ENDPOINTS]]

    def refresh(self, resources: Resources | None = None) -> BatchOutcome:
        now = self.clock()
        res = resources or read_resources(os.path.dirname(self.store.path) or ".")
        return self.run_batch(self.refresh_plan(now, res), "refresh", REFRESH_HANDSHAKE_TIMEOUT_S, REFRESH_WALL_S,
                              breaker=True)

    def discovery_plan(self, now: int) -> tuple[list[str], dict]:
        """Seeds first, then DEAD resurrection, then the next /24 cursor slice; budget follows the pool."""
        meta = self.store.meta()
        active = sum(is_eligible(Store.to_row(r), now) for r in self.store.all() if r["source"] != SRC_NEGATIVE)
        if active >= MAX_ACTIVE:
            return [], {"reason": "pool at cap", "active": active}
        budget = 4 if active >= TARGET_ACTIVE else (16 if active >= SOFT_FLOOR else 32)
        plan: list[str] = []
        rows = self.store.all()
        for r in rows:  # never-probed seeds (imported, legacy, community)
            if len(plan) >= budget:
                break
            if (r["state"] == DISCOVERED and r["last_probe_at"] is None and not r["manual_blacklist"]
                    and r["source"] not in (SRC_NEGATIVE, SRC_CF_ONE)):  # Cloudflare One: trickle budget only
                plan.append(r["endpoint_id"])
        dead = [r for r in rows if r["state"] == DEAD and not r["manual_blacklist"]
                and (r["last_probe_at"] or 0) <= now - DEAD_RESURRECT_AFTER_S]
        for r in sorted(dead, key=lambda r: r["last_probe_at"] or 0)[:DEAD_RESURRECT_PER_RUN]:
            if len(plan) < budget:
                plan.append(r["endpoint_id"])
        cursor = int(meta.get("discovery_cursor", "0"))
        runs = int(meta.get("discovery_runs", "0"))
        new_cursor = cursor
        while len(plan) + len(OFFICIAL_PORTS) <= budget and new_cursor - cursor < 256:
            ip = cursor_ip(CONSUMER_PREFIX, new_cursor)
            new_cursor += 1
            for port in OFFICIAL_PORTS:
                eid = f"{ip}:{port}"
                rec = self.store.get(eid)
                if eid in plan:
                    continue
                if rec is None or (rec["state"] == DISCOVERED and not rec["manual_blacklist"]
                                   and (rec["last_probe_at"] or 0) <= now - DEAD_RESURRECT_AFTER_S):
                    plan.append(eid)
        cf_one = None
        if runs % CF_ONE_EVERY_N_RUNS == 0 and len(plan) < budget + 1:
            pos = int(meta.get("cf_one_cursor", "0"))
            cf_one = f"{cursor_ip(CLOUDFLARE_ONE_PREFIX, pos)}:{OFFICIAL_PORTS[pos % len(OFFICIAL_PORTS)]}"
            rec = self.store.get(cf_one)
            if cf_one not in plan and (rec is None or rec["state"] in (DISCOVERED, DEAD)):
                plan.append(cf_one)
        return plan, {"active": active, "budget": budget, "cursor": cursor, "new_cursor": new_cursor,
                      "runs": runs, "cf_one": cf_one}

    def discovery(self, resources: Resources | None = None) -> BatchOutcome | str:
        now = self.clock()
        meta = self.store.meta()
        if meta.get("lab_health") == LAB_UNAVAILABLE:
            return "skipped: Lab UNAVAILABLE"
        res = resources or read_resources(os.path.dirname(self.store.path) or ".")
        blocked = discovery_blocked_by(res)
        if blocked:
            self._record_skip("discovery", f"resource guard: {blocked}", now)
            return f"skipped: resource guard ({blocked})"
        plan, info = self.discovery_plan(now)
        if not plan:
            self._record_skip("discovery", info.get("reason", "nothing to do"), now)
            return f"skipped: {info.get('reason', 'nothing to do')}"
        with self.store.transaction():
            for eid in plan:
                if self.store.get(eid) is None:
                    ip = eid.rsplit(":", 1)[0]
                    self.store.upsert_candidate(parse_endpoint_id(eid), classify_source(ip), now)
        wall = DISCOVERY_WALL_S[1] if info["active"] < SOFT_FLOOR else DISCOVERY_WALL_S[0]
        outcome = self.run_batch(plan, "discovery", DISCOVERY_HANDSHAKE_TIMEOUT_S, wall, breaker=False)
        probed = {e for e, _ in outcome.results}
        with self.store.transaction():  # the cursor advances only for a fully probed slice, after commit
            slice_ids = [f"{cursor_ip(CONSUMER_PREFIX, p)}:{port}" for p in range(info["cursor"], info["new_cursor"])
                         for port in OFFICIAL_PORTS]
            if all(e in probed or e not in plan for e in slice_ids):
                self.store.set_meta("discovery_cursor", info["new_cursor"])
            self.store.set_meta("discovery_runs", info["runs"] + 1)
            if info["cf_one"] and info["cf_one"] in probed:
                self.store.set_meta("cf_one_cursor", int(self.store.meta().get("cf_one_cursor", "0")) + 1)
        return outcome

    def _record_skip(self, kind: str, note: str, now: int) -> None:
        with self.store.transaction():
            self.store.conn.execute("INSERT INTO run (operation_id, kind, started_at, finished_at, duration_ms, status,"
                                    " note) VALUES (?,?,?,?,0,'skipped',?)", (secrets.token_hex(8), kind, now, now, note))

    # -- maintenance (cheap; the expensive parts are rate-limited through lab_meta)
    def maintenance(self) -> dict:
        now = self.clock()
        meta = self.store.meta()
        done: dict = {}
        if now - int(meta.get("last_prune_at", "0")) >= PRUNE_INTERVAL_S:
            with self.store.transaction():
                done["pruned"] = self.store.prune(now)
                self.store.set_meta("last_prune_at", now)
        mode = "TRUNCATE" if now - int(meta.get("last_wal_truncate_at", "0")) >= WAL_TRUNCATE_INTERVAL_S else "PASSIVE"
        self.store.conn.execute(f"PRAGMA wal_checkpoint({mode})")
        if mode == "TRUNCATE":
            with self.store.transaction():
                self.store.set_meta("last_wal_truncate_at", now)
        done["checkpoint"] = mode
        return done


# --- statistics ----------------------------------------------------------------------------------------------------
def _pct(ok: int, n: int) -> str:
    return f"{100.0 * ok / n:.1f}% (n={n})" if n else "n/a (n=0)"


def window_stats(store: Store, since: int) -> dict:
    c = store.conn
    hs = c.execute("SELECT result, count(*) FROM observation WHERE probe_type='handshake' AND timestamp>=? GROUP BY result",
                   (since,)).fetchall()
    tr = c.execute("SELECT result, count(*) FROM observation WHERE probe_type='traffic' AND timestamp>=? GROUP BY result",
                   (since,)).fetchall()
    hsd, trd = {r[0]: r[1] for r in hs}, {r[0]: r[1] for r in tr}
    hs_n = hsd.get("ok", 0) + hsd.get("fail", 0)
    tr_n = trd.get("ok", 0) + trd.get("fail", 0)
    transitions = c.execute("SELECT from_state, to_state, count(*) FROM transition WHERE ts>=? GROUP BY 1,2 ORDER BY 3 DESC",
                            (since,)).fetchall()
    return {"probes": sum(hsd.values()), "handshake_success": _pct(hsd.get("ok", 0), hs_n),
            "traffic_success": _pct(trd.get("ok", 0), tr_n), "endpoint_failures": hsd.get("fail", 0) + trd.get("fail", 0),
            "lab_failures": hsd.get("lab_failure", 0), "suppressed": hsd.get("suppressed", 0) + trd.get("suppressed", 0),
            "inconclusive": trd.get("inconclusive", 0),
            "transitions": {f"{a}->{b}": n for a, b, n in transitions}}


def session_split(store: Store, since: int) -> dict:
    """Deep probes whose tunnel handshook: first session carried traffic / second session rescued it /
    both sessions failed. A final success never hides a rescue."""
    row = store.conn.execute(
        "SELECT sum(sessions=1 AND result='ok'), sum(sessions=2 AND result='ok'),"
        " sum(sessions=2 AND result!='ok' AND error_code IS NOT NULL) FROM observation"
        " WHERE probe_type='traffic' AND timestamp>=?", (since,)).fetchone()
    return {"first_session_ok": row[0] or 0, "second_session_rescued": row[1] or 0, "both_sessions_failed": row[2] or 0}


def yield_by(store: Store, since: int, column: str) -> dict:
    """Per source class or per port: candidates, probes, handshake/traffic ok, became/currently active."""
    assert column in ("source", "port")
    c = store.conn
    out: dict = {}
    for key, n_ep, active_now in c.execute(
            f"SELECT {column}, count(*), sum(state='ACTIVE' AND expires_at > ?) FROM endpoint GROUP BY {column}",
            (store.clock(),)):
        out[str(key)] = {"candidates": n_ep, "currently_active": active_now or 0}
    for key, ptype, result, n in c.execute(
            f"SELECT e.{column}, o.probe_type, o.result, count(*) FROM observation o JOIN endpoint e USING(endpoint_id)"
            f" WHERE o.timestamp>=? GROUP BY 1,2,3", (since,)):
        d = out.setdefault(str(key), {"candidates": 0, "currently_active": 0})
        d[f"{ptype}_{result}"] = d.get(f"{ptype}_{result}", 0) + n
    for key, n in c.execute(f"SELECT e.{column}, count(*) FROM transition t JOIN endpoint e USING(endpoint_id)"
                            f" WHERE t.ts>=? AND t.to_state='ACTIVE' GROUP BY 1", (since,)):
        out.setdefault(str(key), {})["became_active"] = n
    return out


def baseline_report(store: Store, hours: float) -> dict:
    now = store.clock()
    since = int(now - hours * 3600)
    c = store.conn
    runs = c.execute("SELECT * FROM run WHERE kind='refresh' AND started_at>=? AND status!='skipped' ORDER BY started_at",
                     (since,)).fetchall()
    active = [r["active_after"] for r in runs if r["active_after"] is not None]
    below = 0
    for a, b in zip(runs, list(runs[1:]) + [None]):
        if a["active_after"] is not None and a["active_after"] < SOFT_FLOOR:
            below += ((b["started_at"] if b else now) - a["started_at"])
    def dur(kind: str) -> dict:
        d = [r[0] for r in c.execute("SELECT duration_ms FROM run WHERE kind=? AND started_at>=? AND status!='skipped'",
                                     (kind, since))]
        if not d:
            return {"n": 0}
        d.sort()
        return {"n": len(d), "median_ms": int(statistics.median(d)), "p95_ms": d[min(len(d) - 1, int(0.95 * len(d)))],
                "max_ms": d[-1]}
    health = c.execute("SELECT lab_health, lab_reason, count(*) FROM run WHERE started_at>=? AND lab_health IS NOT NULL"
                       " GROUP BY 1,2", (since,)).fetchall()
    targets = c.execute("SELECT target, ok, count(*) FROM target_result WHERE ts>=? GROUP BY 1,2", (since,)).fetchall()
    stability = {"gt90": 0, "50to90": 0, "lt50": 0}
    for _, ok, n in c.execute("SELECT endpoint_id, sum(result='ok'), count(*) FROM observation WHERE probe_type='traffic'"
                              " AND run_kind='refresh' AND timestamp>=? AND result IN ('ok','fail') GROUP BY 1", (since,)):
        share = ok / n
        stability["gt90" if share > 0.9 else "50to90" if share >= 0.5 else "lt50"] += 1
    res = c.execute("SELECT max(maxrss_kb), sum(cpu_ms), sum(bytes), min(mem_available_kb), min(swap_used_kb),"
                    " max(swap_used_kb) FROM run WHERE started_at>=?", (since,)).fetchone()
    skipped = c.execute("SELECT note, count(*) FROM run WHERE status='skipped' AND started_at>=? GROUP BY 1",
                        (since,)).fetchall()
    sess = c.execute("SELECT count(*), sum(sessions=2), sum(duration_ms>=?) FROM observation WHERE probe_type='handshake'"
                     " AND result IN ('ok','suppressed') AND timestamp>=?", (SLOW_HANDSHAKE_MS, since)).fetchone()
    split = session_split(store, since)
    return {
        "window_hours": hours, "refresh_runs": len(runs),
        "active": ({"min": min(active), "median": statistics.median(active), "max": max(active)} if active else {}),
        "time_below_soft_floor_s": below,
        "transitions": window_stats(store, since)["transitions"],
        "lab_health_runs": {f"{h}:{r}": n for h, r, n in health},
        "targets": {f"{t}:{'ok' if ok else 'fail'}": n for t, ok, n in targets},
        "refresh_duration": dur("refresh"), "discovery_duration": dur("discovery"),
        "stability_distribution": stability,
        "port_yield": yield_by(store, since, "port"), "source_yield": yield_by(store, since, "source"),
        "resources": {"peak_rss_kb": res[0], "cpu_ms_total": res[1], "tunnel_bytes_total": res[2],
                      "min_mem_available_kb": res[3], "swap_used_kb_min": res[4], "swap_used_kb_max": res[5]},
        "skipped_runs": {n or "": k for n, k in skipped},
        "sessions": {"handshaken_probes": sess[0], "needed_second_session": sess[1] or 0,
                     "slow_handshakes": sess[2] or 0, **split},
        "db_bytes": store.db_bytes(),
    }


def ensure_db_healthy(store: Store, now: int) -> bool:
    """Daily PRAGMA quick_check before scheduled jobs. A corrupt DB stops the job: it is left untouched,
    nothing is written and the snapshot ages out. Returns True when a check ran."""
    if now - int(store.meta().get("last_quick_check_at", "0")) < QUICK_CHECK_INTERVAL_S:
        return False
    if not store.quick_check():
        raise LabError(LOCAL_RESOURCE_ERROR, "DB_CORRUPT: quick_check failed; DB left untouched, snapshot ages out")
    with store.transaction():
        store.set_meta("last_quick_check_at", now)
        store.set_meta("last_quick_check", "ok")
    return True


# --- revision -----------------------------------------------------------------------------------------------------
def code_revision() -> dict:
    info: dict = {}
    with contextlib.suppress(OSError, ValueError):
        with open(REVISION_FILE, encoding="utf-8") as fh:
            info = json.load(fh)
    with contextlib.suppress(OSError):
        with open(os.path.abspath(__file__), "rb") as fh:
            actual = hashlib.sha256(fh.read()).hexdigest()
        info["running_sha256"] = actual
        info["matches_install"] = info.get("sha256") == actual
    return info


# --- CLI ---------------------------------------------------------------------------------------------------------
@contextlib.contextmanager
def global_lock(path: str = LOCK_FILE, wait_s: float = 0):
    if fcntl is None:
        raise LabError(LOCAL_RESOURCE_ERROR, "endpoint-lab runs on Linux only")
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise LabError(LOCAL_RESOURCE_ERROR, "another endpoint-lab run holds the lock") from None
                time.sleep(1)
        yield
    finally:
        os.close(fd)


def job_lock(cmd: str, path: str = LOCK_FILE):
    """A held lock (call __exit__ to release), or None when discovery should yield to a running job."""
    wait = {"refresh": REFRESH_LOCK_WAIT_S, "discovery": DISCOVERY_LOCK_WAIT_S}.get(cmd, 0)
    lock = global_lock(path, wait)
    try:
        lock.__enter__()
    except LabError:
        if cmd == "discovery":
            return None
        raise
    return lock


def ensure_dirs() -> None:
    """State dirs are fixed up at runtime; /etc dirs come from install.sh and may be read-only for the
    service (ProtectSystem=strict), so they are only checked."""
    for path, mode in ((STATE_DIR, 0o700), (PUBLIC_DIR, 0o755)):
        os.makedirs(path, mode=mode, exist_ok=True)
        if os.stat(path).st_mode & 0o777 != mode:
            os.chmod(path, mode)
    for path in (CONF_DIR, KEY_DIR):
        if not os.path.isdir(path):
            raise LabError(LOCAL_RESOURCE_ERROR, f"{path} missing: run install.sh")


def format_result(eid: str, res: ProbeResult) -> str:
    ev = res.evidence
    parts = [f"{eid:<22}", f"handshake={'yes' if res.handshake_ok else 'no':<3}",
             f"traffic={'yes' if res.traffic_ok else 'no':<3}",
             f"completion_ms={res.probe_completion_ms}", f"https_total_ms={res.traffic_total_ms}",
             f"error={res.error_code or '-'}"]
    if "rx_before" in ev:
        parts.append(f"rx {ev['rx_before']}->{ev['rx_after']} tx {ev['tx_before']}->{ev['tx_after']}")
    if ev.get("https"):
        parts.append(f"http={ev['https'].get('http_code')} tls_verify={ev['https'].get('ssl_verify_result')}"
                     f" target={ev.get('target')}")
    if "trace_warp" in ev:
        parts.append(f"warp={ev.get('trace_warp')} colo={ev.get('trace_colo')}")
    if res.target_results and (not res.traffic_ok or res.sessions > 1):
        parts.append(f"sessions={res.sessions} targets=" + ",".join(f"{n}:{e or 'ok'}" for n, _, e in res.target_results))
    if res.message and res.error_code:
        parts.append(f"({res.message})")
    return redact("  ".join(parts))


def print_outcome(outcome: BatchOutcome) -> None:
    for eid, res in outcome.results:
        print(format_result(eid, res))
    if outcome.control:
        for cid, (res, _) in outcome.control.results.items():
            print("control " + format_result(cid, res))
        print(f"control verdict: {outcome.control.global_ok} ({outcome.control.reason})")
    print(f"lab health: {outcome.lab_health} ({outcome.lab_reason}); aborted={outcome.aborted};"
          f" snapshot_written={outcome.snapshot_ok}")


def status_report(store: Store) -> dict:
    now = store.clock()
    rows = store.all()
    counts: dict = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    eligible = [r for r in rows if r["source"] != SRC_NEGATIVE and is_eligible(Store.to_row(r), now)]
    try:
        ident = load_identity()
        ident_status = {"state": REG_READY, "created_at": ident.created_at}
    except LabError as exc:
        ident_status = {"state": exc.code, "detail": str(exc)}
    meta = store.meta()
    verified = [r["last_traffic_ok_at"] for r in eligible if r["last_traffic_ok_at"]]

    def ts(key: str) -> str | None:
        return iso(int(meta[key])) if key in meta else None

    def last_run(kind: str) -> dict | None:
        r = store.conn.execute("SELECT * FROM run WHERE kind=? ORDER BY id DESC LIMIT 1", (kind,)).fetchone()
        return None if r is None else {"at": iso(r["started_at"]), "status": r["status"], "duration_ms": r["duration_ms"],
                                       "health": r["lab_health"], "note": r["note"]}
    return {
        "lab": {"health": meta.get("lab_health", "UNKNOWN"), "reason": meta.get("lab_health_reason"),
                "since": ts("lab_health_since")},
        "identity": ident_status | {"api_check": meta.get("identity_api_status"), "api_checked_at": ts("identity_api_checked_at")},
        "pool": {"eligible_active": len(eligible), "states": counts,
                 "blacklisted": sum(r["manual_blacklist"] for r in rows),
                 "target": TARGET_ACTIVE, "soft_floor": SOFT_FLOOR, "cap": MAX_ACTIVE},
        "freshness": {"oldest_active_verified_s": age_s(min(verified), now) if verified else None,
                      "newest_active_verified_s": age_s(max(verified), now) if verified else None,
                      "snapshot_generated_at": ts("snapshot_generated_at"),
                      "snapshot_expires_in_s": (int(meta["snapshot_expires_at"]) - now) if "snapshot_expires_at" in meta else None,
                      "last_snapshot_error": meta.get("last_snapshot_error")},
        "controls": {"ids": json.loads(meta.get("controls", "[]")), "selected_at": ts("control_selected_at"),
                     "reason": meta.get("control_reason")},
        "scheduler": {"refresh": last_run("refresh"), "discovery": last_run("discovery"),
                      "discovery_cursor": meta.get("discovery_cursor", "0")},
        "db": {"bytes_incl_wal": store.db_bytes(), "schema": store.conn.execute("PRAGMA user_version").fetchone()[0],
               "last_quick_check": ts("last_quick_check_at"), "quick_check": meta.get("last_quick_check")},
        "code": code_revision(),
    }


def public_status(store: Store) -> dict:
    """status + 15-minute stats for monitoring: no credentials, no endpoint IPs (control ids dropped)."""
    st = status_report(store)
    now = store.clock()
    return {
        "schema_version": STATUS_SCHEMA_VERSION,
        "generated_at": iso(now),
        "lab": st["lab"],
        "identity": st["identity"],
        "pool": st["pool"],
        "freshness": st["freshness"],
        "controls": {"count": len(st["controls"]["ids"]), "selected_at": st["controls"]["selected_at"]},
        "scheduler": st["scheduler"],
        "db": st["db"],
        "code": {"commit": st["code"].get("commit"), "matches_install": st["code"].get("matches_install")},
        "stats_15m": window_stats(store, now - 900) | {"sessions": session_split(store, now - 900)},
    }


def _reason(text: str | None) -> str | None:
    if text is None:
        return None
    if not REASON_RE.match(text):
        raise LabError(UNKNOWN, "reason: 1-200 plain characters (letters, digits, spaces, .,:;()/#+-)")
    return text


def _known(store: Store, endpoint_id: str) -> str:
    eid = parse_endpoint_id(endpoint_id).endpoint_id
    if store.get(eid) is None:
        raise LabError(UNKNOWN, f"unknown endpoint {eid}")
    return eid


READ_ONLY_COMMANDS = ("status", "list", "stats", "report")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="endpoint-lab", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("status", "list", "register-probe-identity", "verify-all", "snapshot", "cleanup", "seed",
                 "refresh", "discovery", "maintenance"):
        sub.add_parser(name)
    sub.add_parser("identity-reset").add_argument("--confirm", action="store_true", required=True)
    sub.add_parser("import-candidates").add_argument("file")
    for name in ("probe", "verify", "unblacklist", "unquarantine"):
        sub.add_parser(name).add_argument("endpoint_id")
    bl = sub.add_parser("blacklist")
    bl.add_argument("endpoint_id")
    bl.add_argument("reason", nargs="?")
    q = sub.add_parser("quarantine")
    q.add_argument("endpoint_id")
    q.add_argument("duration_min", nargs="?", type=int, default=MANUAL_QUARANTINE_DEFAULT_S // 60)
    q.add_argument("reason", nargs="?")
    st = sub.add_parser("stats")
    st.add_argument("--json", action="store_true")
    rp = sub.add_parser("report")
    rp.add_argument("--hours", type=float, default=24.0)
    bench = sub.add_parser("bench")
    bench.add_argument("endpoint_id")
    bench.add_argument("--repeat", type=int, default=3)
    args = parser.parse_args(argv)

    try:
        if os.name != "posix" or os.geteuid() != 0:
            raise LabError(LOCAL_RESOURCE_ERROR, "endpoint-lab must run as root on the Lab host")
        os.umask(0o077)  # lab.db and its WAL files root-only; the snapshot is chmod-ed 0644 explicitly
        if args.cmd in READ_ONLY_COMMANDS:
            return _dispatch(args, Store(os.path.join(STATE_DIR, DB_FILE), read_only=True), None, None)
        ensure_dirs()
        with contextlib.suppress(FileNotFoundError):
            os.chmod(os.path.join(STATE_DIR, DB_FILE), 0o600)
        lock = job_lock(args.cmd)
        if lock is None:  # refresh has priority: discovery yields after a short wait
            print(f"discovery skipped: another run held the lock for {DISCOVERY_LOCK_WAIT_S} s")
            return 0
        try:
            runner = CommandRunner()
            cleanup_stale(runner, min_age_s=STALE_RESOURCE_AGE_S)
            store = Store(os.path.join(STATE_DIR, DB_FILE))
            if args.cmd in ("refresh", "discovery", "maintenance"):
                ensure_db_healthy(store, store.clock())
            lab = Lab(store, LinuxWireGuardProbeEngine(runner), config=load_config(), api=WarpApi())
            return _dispatch(args, store, lab, runner)
        finally:
            lock.__exit__(None, None, None)
    except LabError as exc:
        log(f"endpoint-lab: {exc.code}: {exc}")
        return 2
    except KeyboardInterrupt:
        log(f"endpoint-lab: {CANCELLED}: interrupted; probe resources torn down, nothing recorded")
        return 130


def _dispatch(args, store: Store, lab: Lab, runner: CommandRunner) -> int:
    now = store.clock()
    if args.cmd == "register-probe-identity":
        print(register_probe_identity(runner, WarpApi()))
    elif args.cmd == "identity-reset":
        print(identity_reset())
    elif args.cmd == "import-candidates":
        with store.transaction():
            added = sum(store.upsert_candidate(ep, src, now) for ep, src in load_candidates(args.file))
        print(f"imported; new endpoints: {added}")
    elif args.cmd == "seed":
        with store.transaction():
            added = sum(store.upsert_candidate(parse_endpoint(ip, port), classify_source(ip), now)
                        for ip in LEGACY_BUILTIN_IPS for port in OFFICIAL_PORTS)
        print(f"seeded legacy builtin candidates; new endpoints: {added}")
    elif args.cmd == "probe":
        eid = _known(store, args.endpoint_id)
        identity = load_identity()
        res = lab.engine.probe_handshake(parse_endpoint_id(eid), identity)
        with store.transaction():
            store.record(eid, res, False, store.clock(), secrets.token_hex(8))
        print(format_result(eid, res))
    elif args.cmd == "verify":
        print_outcome(lab.run_batch([_known(store, args.endpoint_id)], "manual"))
    elif args.cmd == "verify-all":
        ids = [r["endpoint_id"] for r in store.all() if not r["manual_blacklist"]]
        print_outcome(lab.run_batch(ids, "manual"))
    elif args.cmd == "refresh":
        outcome = lab.refresh()
        lab.maintenance()
        print_outcome(outcome)
        if not outcome.snapshot_ok:
            return 4
    elif args.cmd == "discovery":
        outcome = lab.discovery()
        lab.maintenance()
        if isinstance(outcome, str):
            print(f"discovery {outcome}")
        else:
            print_outcome(outcome)
            if not outcome.snapshot_ok:
                return 4
    elif args.cmd == "maintenance":
        print(json.dumps(lab.maintenance()))
    elif args.cmd == "snapshot":
        lab.publish()
        with open(os.path.join(PUBLIC_DIR, SNAPSHOT_FILE), encoding="utf-8") as fh:
            print(fh.read())
    elif args.cmd == "cleanup":
        print(json.dumps(cleanup_stale(runner, min_age_s=0)))
    elif args.cmd in ("blacklist", "unblacklist", "quarantine", "unquarantine"):
        eid = _known(store, args.endpoint_id)
        reason = _reason(getattr(args, "reason", None))
        with store.transaction():
            if args.cmd == "blacklist":
                store.conn.execute("UPDATE endpoint SET manual_blacklist=1, blacklist_reason=?, blacklist_at=?,"
                                   " expires_at=NULL WHERE endpoint_id=?", (reason, now, eid))
            elif args.cmd == "unblacklist":
                store.conn.execute("UPDATE endpoint SET manual_blacklist=0, blacklist_reason=NULL, blacklist_at=NULL"
                                   " WHERE endpoint_id=?", (eid,))
                store.set_state(eid, VERIFYING, "unblacklisted", None, now, expires_at=None)
            elif args.cmd == "quarantine":
                minutes = args.duration_min
                if not 1 <= minutes <= MANUAL_QUARANTINE_MAX_S // 60:
                    raise LabError(UNKNOWN, f"duration: 1..{MANUAL_QUARANTINE_MAX_S // 60} minutes")
                store.set_state(eid, QUARANTINE, "operator", None, now, quarantine_kind="manual",
                                quarantine_until=now + minutes * 60, expires_at=None, active_since=None)
            else:
                rec = store.get(eid)
                if rec["state"] != QUARANTINE:
                    raise LabError(UNKNOWN, f"{eid} is not quarantined")
                store.set_state(eid, VERIFYING, "unquarantined", None, now, quarantine_kind=None,
                                quarantine_until=None, quarantine_level=0, quarantine_failures=0)
            store.operator_event(eid, args.cmd, reason, now)
        lab.publish()
        print(f"{args.cmd}: {eid}")
    elif args.cmd == "list":
        for r in store.all():
            flags = " BLACKLIST" if r["manual_blacklist"] else ""
            print(f"{r['endpoint_id']:<22} {r['state']:<11} src={r['source']:<27} ok={r['consecutive_successes']}"
                  f" fail={r['consecutive_failures']} traffic_ok_at={iso(r['last_traffic_ok_at'])}"
                  f" expires={iso(r['expires_at'])} q_until={iso(r['quarantine_until'])}"
                  f" err={r['last_error_code'] or '-'}{flags}")
    elif args.cmd == "status":
        print(json.dumps(status_report(store), indent=2))
    elif args.cmd == "stats":
        out = {label: window_stats(store, now - secs) | {"sessions": session_split(store, now - secs)}
               for label, secs in (("15m", 900), ("1h", 3600), ("24h", 86400))}
        out["source_yield_24h"] = yield_by(store, now - 86400, "source")
        out["port_yield_24h"] = yield_by(store, now - 86400, "port")
        print(json.dumps(out, indent=2))
    elif args.cmd == "report":
        print(json.dumps(baseline_report(store, args.hours), indent=2))
    elif args.cmd == "bench":
        eid = _known(store, args.endpoint_id)
        identity = load_identity()
        for i in range(max(1, min(args.repeat, 10))):
            cpu0, _ = usage_snapshot()
            t0 = time.monotonic()
            res = lab.engine.deep_verify(parse_endpoint_id(eid), identity, REFRESH_HANDSHAKE_TIMEOUT_S, lab.targets)
            cpu1, rss = usage_snapshot()
            print(f"bench#{i} wall_ms={int((time.monotonic() - t0) * 1000)} cpu_ms={int((cpu1 - cpu0) * 1000)}"
                  f" maxrss_kb={rss} " + format_result(eid, res))
    return 0


def _sigterm_to_interrupt(signum, frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _sigterm_to_interrupt)
    sys.exit(main())
