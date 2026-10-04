"""Unit tests for endpoint_lab (no root, no network): python3 -m unittest discover -s deploy/endpoint-lab"""

import base64
import json
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from dataclasses import replace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import endpoint_lab as lab  # noqa: E402

NOW = 1_800_000_000


def b64key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


PRIVATE = b64key()
PUBLIC = b64key()
PEER = b64key()


def identity(tmp: str) -> lab.Identity:
    return lab.Identity(key_path=os.path.join(tmp, "wg.key"), public_key=PUBLIC, peer_public_key=PEER,
                        address_v4="172.16.0.2", address_v6=None, registration_id="reg-1", warp_enabled=True,
                        created_at="2026-10-04T00:00:00Z")


def ok(target="cf-1111"):
    return lab.ProbeResult(True, traffic_ok=True, probe_completion_ms=80, traffic_total_ms=40, traffic_bytes=9000,
                           target_results=[(target, True, None)])


def no_hs():
    return lab.ProbeResult(False, error_code=lab.HANDSHAKE_NO_RESPONSE, probe_completion_ms=8000, traffic_bytes=296)


def inconclusive():
    return lab.ProbeResult(True, error_code=lab.TARGETS_UNREACHABLE, probe_completion_ms=80,
                           target_results=[(t.name, False, lab.HTTPS_TIMEOUT) for t in lab.VERIFICATION_TARGETS])


def local():
    return lab.ProbeResult(False, error_code=lab.LOCAL_RESOURCE_ERROR, message="netns add failed")


class FakeProbeEngine(lab.ProbeEngine):
    """outcomes: endpoint_id -> ProbeResult factory or list of factories (one per call); default for others."""

    def __init__(self, outcomes=None, default=ok):
        self.outcomes = outcomes or {}
        self.default = default
        self.calls = []

    def _next(self, eid):
        spec = self.outcomes.get(eid, self.default)
        if isinstance(spec, list):
            spec = spec.pop(0) if len(spec) > 1 else spec[0]
        return spec()

    def probe_handshake(self, endpoint, ident, timeout_s=None):
        self.calls.append(("probe", endpoint.endpoint_id, timeout_s))
        return self._next(endpoint.endpoint_id)

    def deep_verify(self, endpoint, ident, timeout_s=None, targets=None):
        self.calls.append(("verify", endpoint.endpoint_id, timeout_s))
        return self._next(endpoint.endpoint_id)


class ValidationTests(unittest.TestCase):
    def test_valid_endpoint_and_id(self):
        ep = lab.parse_endpoint("162.159.192.1", 2408)
        self.assertEqual(ep.endpoint_id, "162.159.192.1:2408")
        self.assertEqual(lab.parse_endpoint_id("162.159.192.1:4500").port, 4500)

    def test_rejects_bad_inputs(self):
        for ip, port in [("162.159.192.1", 2409), ("162.159.192.1", "2408"), ("162.159.192.1", True),
                         ("8.8.8.8", 2408), ("2606:4700:100::1", 2408), ("162.159.192.1; rm -rf /", 2408)]:
            with self.subTest(ip=ip, port=port), self.assertRaises(lab.LabError):
                lab.parse_endpoint(ip, port)
        for value in ("162.159.192.1:2408;id", "$(id):2408", "162.159.192.0/24:2408", "162.159.192.1"):
            with self.subTest(value=value), self.assertRaises(lab.LabError):
                lab.parse_endpoint_id(value)

    def test_candidates_file_and_caps(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"schema_version": 1, "candidates": [{"ip": "162.159.192.1", "source": "engage_dns"},
                                                              {"ip": "192.0.2.1", "ports": [2408]}]}, fh)
            self.assertEqual(len(lab.load_candidates(path)), 5)
            for doc in ({"schema_version": 1, "candidates": [{"ip": "162.159.192.0/24"}]},
                        {"schema_version": 1, "candidates": [{"ip": f"162.159.192.{i}"} for i in range(1, 20)]},
                        {"schema_version": 2, "candidates": []}):
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
                with self.subTest(doc=str(doc)[:50]), self.assertRaises(lab.LabError):
                    lab.load_candidates(path)

    def test_cursor_walks_whole_24_deterministically(self):
        ips = [lab.cursor_ip(lab.CONSUMER_PREFIX, i) for i in range(256)]
        self.assertEqual(len(set(ips)), 256)  # .0 and .255 included: anycast, no LAN semantics
        self.assertIn("162.159.192.0", ips)
        self.assertIn("162.159.192.255", ips)
        self.assertEqual(ips, [lab.cursor_ip(lab.CONSUMER_PREFIX, i) for i in range(256)])
        self.assertNotEqual(ips[:4], ["162.159.192.0", "162.159.192.1", "162.159.192.2", "162.159.192.3"])

    def test_legacy_builtins_mirror_the_generator_seed_list(self):
        js = open(os.path.join(HERE, "..", "..", "src", "server", "endpointCache.js"), encoding="utf-8").read()
        block = js[js.index("HARDCODED_FALLBACK = ["):js.index("];")]
        self.assertEqual(tuple(re.findall(r"ip: '([\d.]+)'", block)), lab.LEGACY_BUILTIN_IPS)

    def test_source_classification(self):
        self.assertEqual(lab.classify_source("162.159.192.7"), lab.SRC_CONSUMER)
        self.assertEqual(lab.classify_source("162.159.193.7"), lab.SRC_CF_ONE)
        self.assertEqual(lab.classify_source("188.114.97.1"), lab.SRC_LEGACY)
        self.assertEqual(lab.classify_source("192.0.2.1"), lab.SRC_NEGATIVE)


class StateMachineTests(unittest.TestCase):
    def row(self, **kw):
        return lab.EndpointRow(endpoint_id="162.159.192.1:2408", **kw)

    def active(self):
        return lab.apply_outcome(self.row(), ok(), deep=True, now=NOW)

    def test_deep_success_makes_active_with_ttl(self):
        new = self.active()
        self.assertEqual((new.state, new.expires_at, new.first_active_at), (lab.ACTIVE, NOW + lab.ACTIVE_TTL_S, NOW))
        self.assertTrue(lab.is_eligible(new, NOW))
        self.assertFalse(lab.is_eligible(new, NOW + lab.ACTIVE_TTL_S))

    def test_handshake_alone_never_active_or_revives(self):
        self.assertEqual(lab.apply_outcome(self.row(), lab.ProbeResult(True), deep=False, now=NOW).state, lab.HANDSHAKE_OK)
        for state in (lab.SUSPECT, lab.QUARANTINE, lab.DEAD):
            row = self.row(state=state, consecutive_failures=5, quarantine_until=NOW + 60)
            new = lab.apply_outcome(row, lab.ProbeResult(True), deep=False, now=NOW)
            self.assertEqual((new.state, new.consecutive_failures), (state, 5))

    def test_first_failure_suspect_second_quarantine(self):
        suspect = lab.apply_outcome(self.active(), no_hs(), deep=True, now=NOW + 60)
        self.assertEqual(suspect.state, lab.SUSPECT)
        self.assertFalse(lab.is_eligible(suspect, NOW + 60))  # out of the pool after the first failure
        self.assertEqual(lab.apply_outcome(suspect, ok(), deep=True, now=NOW + 120).state, lab.ACTIVE)
        q = lab.apply_outcome(suspect, no_hs(), deep=True, now=NOW + 120)
        self.assertEqual((q.state, q.quarantine_kind, q.quarantine_until), (lab.QUARANTINE, "auto", NOW + 120 + 900))

    def test_quarantine_backoff_is_bounded_and_dead_after_ten_more(self):
        r = lab.apply_outcome(lab.apply_outcome(self.active(), no_hs(), True, NOW), no_hs(), True, NOW)
        cooldowns = []
        for i in range(lab.QUARANTINE_TO_DEAD_FAILURES - 1):
            r = lab.apply_outcome(r, no_hs(), True, NOW + 1000 * (i + 1))
            cooldowns.append(r.quarantine_until - NOW - 1000 * (i + 1))
            self.assertEqual(r.state, lab.QUARANTINE)
        self.assertEqual(cooldowns[:3], [1800, 3600, 3600])
        self.assertEqual(max(cooldowns), max(lab.QUARANTINE_BACKOFF_S))
        r = lab.apply_outcome(r, no_hs(), True, NOW + 99999)
        self.assertEqual(r.state, lab.DEAD)

    def test_quarantine_recovers_on_success(self):
        q = lab.apply_outcome(lab.apply_outcome(self.active(), no_hs(), True, NOW), no_hs(), True, NOW)
        back = lab.apply_outcome(q, ok(), True, NOW + 2000)
        self.assertEqual((back.state, back.quarantine_level, back.quarantine_until), (lab.ACTIVE, 0, None))

    def test_lab_failure_and_inconclusive_never_penalise(self):
        active = self.active()
        for res in [lab.ProbeResult(False, error_code=c) for c in lab.LAB_FAILURE_CODES] + [inconclusive()]:
            with self.subTest(code=res.error_code):
                self.assertEqual(lab.apply_outcome(active, res, True, NOW + 1), active)

    def test_blacklist_and_manual_quarantine_outrank_automation(self):
        self.assertEqual(lab.apply_outcome(self.row(manual_blacklist=1), ok(), True, NOW).state, lab.VERIFIED)
        mq = self.row(state=lab.QUARANTINE, quarantine_kind="manual", quarantine_until=NOW + 600)
        self.assertEqual(lab.apply_outcome(mq, ok(), True, NOW).state, lab.QUARANTINE)
        self.assertEqual(lab.apply_outcome(mq, no_hs(), True, NOW).state, lab.QUARANTINE)

    def test_never_verified_candidate_just_counts_failures(self):
        r = lab.apply_outcome(self.row(), no_hs(), True, NOW)
        self.assertEqual((r.state, r.consecutive_failures), (lab.DISCOVERED, 1))
        self.assertEqual(lab.apply_outcome(self.row(state=lab.VERIFYING), no_hs(), True, NOW).state, lab.SUSPECT)

    def test_due_for_refresh(self):
        due = lab.due_for_refresh
        self.assertTrue(due(self.row(state=lab.ACTIVE), lab.SRC_CONSUMER, NOW))
        self.assertTrue(due(self.row(state=lab.SUSPECT), lab.SRC_CONSUMER, NOW))
        self.assertTrue(due(self.row(state=lab.VERIFYING), lab.SRC_PHASE_A, NOW))
        self.assertFalse(due(self.row(state=lab.QUARANTINE, quarantine_kind="auto", quarantine_until=NOW + 1), "x", NOW))
        self.assertTrue(due(self.row(state=lab.QUARANTINE, quarantine_kind="auto", quarantine_until=NOW), "x", NOW))
        self.assertFalse(due(self.row(state=lab.QUARANTINE, quarantine_kind="manual", quarantine_until=NOW - 1), "x", NOW))
        self.assertFalse(due(self.row(state=lab.ACTIVE, manual_blacklist=1), "x", NOW))
        self.assertFalse(due(self.row(state=lab.ACTIVE), lab.SRC_NEGATIVE, NOW))
        self.assertFalse(due(self.row(state=lab.DEAD), "x", NOW))
        self.assertFalse(due(self.row(state=lab.DISCOVERED), "x", NOW))


class LabFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "lab.db")
        self.public = os.path.join(self.tmp.name, "public")
        os.makedirs(self.public)
        self.clock_value = NOW
        self.store = lab.Store(self.db, clock=lambda: self.clock_value)

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    def add(self, ip, port=2408, state=lab.DISCOVERED, source=lab.SRC_CONSUMER, successes=0):
        ep = lab.parse_endpoint(ip, port)
        with self.store.transaction():
            self.store.upsert_candidate(ep, source, NOW)
            if state == lab.ACTIVE:
                self.store.conn.execute(
                    "UPDATE endpoint SET state='ACTIVE', expires_at=?, last_traffic_ok_at=?, first_active_at=?,"
                    " active_since=?, consecutive_successes=? WHERE endpoint_id=?",
                    (NOW + 300, NOW - 60, NOW - 3600, NOW - 3600, successes, ep.endpoint_id))
            elif state != lab.DISCOVERED:
                self.store.conn.execute("UPDATE endpoint SET state=? WHERE endpoint_id=?", (state, ep.endpoint_id))
        return ep.endpoint_id

    def make_lab(self, engine, loader=None, config=None):
        return lab.Lab(self.store, engine, identity_loader=loader or (lambda: identity(self.tmp.name)),
                       clock=lambda: self.clock_value, public_dir=self.public, config=config)

    def snapshot(self):
        with open(os.path.join(self.public, lab.SNAPSHOT_FILE), encoding="utf-8") as fh:
            return json.load(fh)

    def failures(self):
        return {r["endpoint_id"]: r["consecutive_failures"] for r in self.store.all()}

    def states(self):
        return {r["endpoint_id"]: r["state"] for r in self.store.all()}


class CircuitBreakerTests(LabFixture):
    def pool(self, n=24):
        return [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], lab.ACTIVE, successes=n - i) for i in range(1, n + 1)]

    def test_p0_targets_down_globally_never_mass_penalise(self):
        ids = self.pool()
        before = self.failures()
        engine = FakeProbeEngine(default=inconclusive)
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertEqual(self.failures(), before)
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})  # nothing went SUSPECT
        self.assertEqual(out.lab_health, lab.LAB_UNAVAILABLE)
        self.assertEqual(out.lab_reason, "VERIFICATION_TARGETS_UNAVAILABLE")
        self.assertTrue(out.aborted)
        self.assertLess(len(engine.calls), 6)  # early control check stops the run instead of burning probes
        self.assertEqual(self.store.meta()["lab_health"], lab.LAB_UNAVAILABLE)
        # endpoints only age: after their TTL the pool drains naturally
        self.clock_value = NOW + 400
        self.assertEqual(self.make_lab(FakeProbeEngine()).publish(), True)
        self.assertEqual(self.snapshot()["active_count"], 0)

    def test_uplink_down_handshakes_fail_everywhere(self):
        ids = self.pool(10)
        before = self.failures()
        out = self.make_lab(FakeProbeEngine(default=no_hs)).run_batch(ids, "refresh")
        self.assertEqual(self.failures(), before)
        self.assertEqual(out.lab_health, lab.LAB_UNAVAILABLE)
        self.assertEqual(out.lab_reason, "CONTROLS_SILENT")

    def test_control_one_dies_control_two_works(self):
        ids = self.pool(6)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        target = next(i for i in ids if i not in (c1, c2))
        engine = FakeProbeEngine({target: inconclusive, c1: [ok, no_hs]})  # c1 fine in batch, dead as control
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertTrue(out.control.global_ok)
        st = self.states()
        self.assertEqual(st[c1], lab.SUSPECT)      # control #1's own failure is an endpoint failure
        self.assertEqual(st[c2], lab.ACTIVE)
        self.assertEqual(st[target], lab.SUSPECT)  # targets failed only here: real traffic failure
        self.assertEqual(self.store.get(target)["last_error_code"], lab.TRAFFIC_FAILED)
        self.assertEqual(out.lab_health, lab.LAB_OK)

    def test_both_controls_fail_alike_no_penalty(self):
        ids = self.pool(6)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        target = next(i for i in ids if i not in (c1, c2))
        before = self.failures()
        engine = FakeProbeEngine({target: inconclusive, c1: [ok, inconclusive], c2: [ok, inconclusive]})
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertFalse(out.control.global_ok)
        self.assertEqual(self.failures(), before)
        self.assertEqual(out.lab_health, lab.LAB_UNAVAILABLE)

    def test_single_endpoint_failure_is_booked_without_controls(self):
        ids = self.pool(6)
        engine = FakeProbeEngine({ids[3]: no_hs})
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertIsNone(out.control)
        self.assertEqual(self.states()[ids[3]], lab.SUSPECT)
        self.assertEqual(len(engine.calls), 6)

    def test_transient_anomaly_is_rechecked_not_booked(self):
        ids = self.pool(8)
        c1, _ = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        failing = [i for i in ids if i != c1][:5]
        engine = FakeProbeEngine({i: [no_hs, ok] for i in failing})
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertTrue(out.control.global_ok)
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})
        self.assertEqual((out.lab_health, out.lab_reason), (lab.LAB_DEGRADED, "TRANSIENT_ANOMALY_RECHECKED"))

    def test_bootstrap_mass_failure_without_controls_is_suppressed(self):
        ids = [self.add(f"162.159.192.{i}", state=lab.VERIFYING) for i in range(1, 6)]
        out = self.make_lab(FakeProbeEngine(default=no_hs)).run_batch(ids, "refresh")
        self.assertEqual(set(self.states().values()), {lab.VERIFYING})
        self.assertEqual((out.lab_health, out.lab_reason), (lab.LAB_UNAVAILABLE, "NO_CONTROLS_ALL_FAILED"))

    def test_target_a_fails_b_answers(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        res = lambda: lab.ProbeResult(True, traffic_ok=True, traffic_total_ms=50, probe_completion_ms=70,  # noqa: E731
                                      target_results=[("cf-1111", False, lab.HTTPS_TIMEOUT), ("cf-1001", True, None)])
        runner = self.make_lab(FakeProbeEngine({eid: res}))
        runner.run_batch([eid], "refresh")
        self.assertEqual(self.states()[eid], lab.ACTIVE)
        rows = self.store.conn.execute("SELECT target, ok FROM target_result ORDER BY id").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("cf-1111", 0), ("cf-1001", 1)])
        self.assertEqual(runner.targets[0].name, "cf-1001")  # the answering target goes first for the rest of the run

    def test_ambiguous_identity_blocks_every_probe(self):
        ids = self.pool(3)

        def ambiguous():
            raise lab.LabError(lab.PROBE_IDENTITY_AMBIGUOUS, "unknown")
        engine = FakeProbeEngine()
        out = self.make_lab(engine, loader=ambiguous).run_batch(ids, "refresh")
        self.assertEqual(engine.calls, [])
        self.assertEqual((out.lab_health, out.lab_reason), (lab.LAB_UNAVAILABLE, lab.PROBE_IDENTITY_AMBIGUOUS))
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})

    def test_controls_are_dynamic_and_distinct(self):
        ids = self.pool(6)
        runner = self.make_lab(FakeProbeEngine())
        c1, c2 = runner.select_controls(NOW)
        self.assertNotEqual(self.store.get(c1)["ip"], self.store.get(c2)["ip"])
        self.assertNotEqual(self.store.get(c1)["port"], self.store.get(c2)["port"])
        with self.store.transaction():
            self.store.conn.execute("UPDATE endpoint SET state='SUSPECT' WHERE endpoint_id=?", (c1,))
        new = runner.select_controls(NOW)
        self.assertNotIn(c1, new)
        self.assertIn(c2, new)
        self.assertEqual(len(new), 2)
        self.assertIn("control_reason", self.store.meta())
        self.assertTrue(set(new) <= set(ids))


class SchedulerTests(LabFixture):
    def test_refresh_selects_due_endpoints_only(self):
        a = self.add("162.159.192.1", state=lab.ACTIVE)
        s = self.add("162.159.192.2", state=lab.SUSPECT)
        v = self.add("162.159.192.3", state=lab.VERIFYING, source=lab.SRC_PHASE_A)
        d = self.add("162.159.192.4")
        n = self.add("192.0.2.1", state=lab.ACTIVE, source=lab.SRC_NEGATIVE)
        engine = FakeProbeEngine()
        self.make_lab(engine).refresh(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        probed = [c[1] for c in engine.calls]
        self.assertEqual(probed, [a, s, v])
        self.assertNotIn(d, probed)
        self.assertNotIn(n, probed)
        self.assertEqual({c[2] for c in engine.calls}, {lab.REFRESH_HANDSHAKE_TIMEOUT_S})

    def test_refresh_reduced_mode_under_memory_pressure(self):
        a = self.add("162.159.192.1", state=lab.ACTIVE)
        self.add("162.159.192.2", state=lab.SUSPECT)
        engine = FakeProbeEngine()
        self.make_lab(engine).refresh(lab.Resources(50 * 1024, 0, 0.1, 2, 10 ** 10))
        self.assertEqual([c[1] for c in engine.calls], [a])

    def test_discovery_budget_follows_pool(self):
        runner = self.make_lab(FakeProbeEngine())
        plan, info = runner.discovery_plan(NOW)
        self.assertEqual((info["budget"], len(plan)), (32, 33))  # 8 IPs × 4 ports + one Cloudflare One observation
        for i in range(12):
            self.add(f"188.114.96.{i + 1}", state=lab.ACTIVE, source=lab.SRC_LEGACY)
        self.assertEqual(runner.discovery_plan(NOW)[1]["budget"], 16)
        for i in range(12):
            self.add(f"188.114.97.{i + 1}", state=lab.ACTIVE, source=lab.SRC_LEGACY)
        self.assertEqual(runner.discovery_plan(NOW)[1]["budget"], 4)
        for i in range(24):
            self.add(f"188.114.98.{i + 1}", state=lab.ACTIVE, source=lab.SRC_LEGACY)
        self.assertEqual(runner.discovery_plan(NOW), ([], {"reason": "pool at cap", "active": 48}))

    def test_discovery_seeds_first_and_cursor_advances_after_commit(self):
        seed = self.add("188.114.99.1", source=lab.SRC_LEGACY)
        engine = FakeProbeEngine(default=no_hs)
        runner = self.make_lab(engine)
        out = runner.discovery(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        probed = [c[1] for c in engine.calls]
        self.assertEqual(probed[0], seed)
        self.assertEqual({c[2] for c in engine.calls}, {lab.DISCOVERY_HANDSHAKE_TIMEOUT_S})
        self.assertEqual(int(self.store.meta()["discovery_cursor"]), 7)  # 1 seed + 7 IPs × 4 ports = 29 <= 32
        self.assertEqual(self.store.get(seed)["state"], lab.DISCOVERED)  # failures of new candidates cost nothing
        self.assertIsInstance(out, lab.BatchOutcome)
        self.assertNotIn("lab_health", self.store.meta())  # discovery does not own the Lab health

    def test_discovery_cursor_is_crash_safe(self):
        runner = self.make_lab(FakeProbeEngine(default=no_hs))
        plan, info = runner.discovery_plan(NOW)
        with mock.patch.object(lab.Lab, "run_batch", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.discovery(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        self.assertNotIn("discovery_cursor", self.store.meta())  # nothing skipped by the crash
        replanned = runner.discovery_plan(NOW)[0]
        self.assertEqual(set(replanned), set(plan))
        self.assertEqual(len(replanned), len(set(replanned)))  # no endpoint twice in one run

    def test_discovery_skips_when_lab_unavailable_or_host_under_pressure(self):
        runner = self.make_lab(FakeProbeEngine())
        self.assertIn("resource guard", runner.discovery(lab.Resources(100 * 1024, 0, 0.1, 2, 10 ** 10)))
        self.assertEqual(self.store.conn.execute("SELECT status, note FROM run").fetchone()[0], "skipped")
        with self.store.transaction():
            self.store.set_meta("lab_health", lab.LAB_UNAVAILABLE)
        self.assertIn("UNAVAILABLE", runner.discovery(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10)))

    def test_dead_resurrection_after_delay(self):
        eid = self.add("162.159.192.200", state=lab.DEAD)
        with self.store.transaction():
            self.store.conn.execute("UPDATE endpoint SET last_probe_at=? WHERE endpoint_id=?", (NOW - 100, eid))
        runner = self.make_lab(FakeProbeEngine())
        self.assertNotIn(eid, runner.discovery_plan(NOW)[0])
        self.assertIn(eid, runner.discovery_plan(NOW + lab.DEAD_RESURRECT_AFTER_S)[0])

    def test_cloudflare_one_trickle(self):
        runner = self.make_lab(FakeProbeEngine())
        plan, info = runner.discovery_plan(NOW)
        self.assertTrue(info["cf_one"].startswith("162.159.193."))
        with self.store.transaction():
            self.store.set_meta("discovery_runs", 1)
        self.assertIsNone(runner.discovery_plan(NOW)[1]["cf_one"])

    def test_refresh_wall_budget(self):
        ids = [self.add(f"162.159.192.{i}", state=lab.ACTIVE) for i in range(1, 6)]
        ticks = iter(range(0, 1000, 100))
        runner = lab.Lab(self.store, FakeProbeEngine(), identity_loader=lambda: identity(self.tmp.name),
                         clock=lambda: NOW, public_dir=self.public, monotonic=lambda: next(ticks))
        out = runner.run_batch(ids, "refresh", wall_s=150)
        self.assertTrue(out.aborted)
        self.assertLess(len(out.results), 5)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def transport(self, script):
        calls = []

        def t(method, path, body, token):
            calls.append((method, path, token))
            item = script.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return t, calls

    def register(self, script):
        t, calls = self.transport(script)
        return lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir, clock=lambda: NOW), calls

    def meta(self):
        with open(os.path.join(self.dir, lab.IDENTITY_FILE), encoding="utf-8") as fh:
            return json.load(fh)

    def test_absent_to_ready_with_one_post(self):
        result, calls = self.register([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        self.assertEqual(result, "created")
        self.assertEqual([c[0] for c in calls], ["POST", "PATCH"])
        self.assertEqual(self.meta()["registration_state"], lab.REG_READY)
        self.assertNotIn(PRIVATE, json.dumps(self.meta()))
        self.assertEqual(lab.load_identity(self.dir, self.dir).address_v4, "172.16.0.2")
        self.assertEqual(self.register([])[0], "exists")

    def test_lost_response_is_ambiguous_and_never_reposted(self):
        with self.assertRaises(lab.LabError) as ctx:
            self.register([lab.ApiResponseLost("TimeoutError")])
        self.assertEqual(ctx.exception.code, lab.PROBE_IDENTITY_AMBIGUOUS)
        self.assertEqual(self.meta()["registration_state"], lab.REG_AMBIGUOUS)
        with self.assertRaises(lab.LabError) as again:
            self.register([(200, b"{}")])  # would be a second POST: refused before any request
        self.assertEqual(again.exception.code, lab.PROBE_IDENTITY_AMBIGUOUS)
        with self.assertRaises(lab.LabError) as probe:
            lab.load_identity(self.dir, self.dir)
        self.assertEqual(probe.exception.code, lab.PROBE_IDENTITY_AMBIGUOUS)

    def test_5xx_and_unusable_2xx_are_ambiguous(self):
        for script in ([(503, b"")], [(200, b'{"result": {"id": "x"}}')]):
            with self.subTest(script=str(script)[:30]):
                for name in os.listdir(self.dir):
                    os.unlink(os.path.join(self.dir, name))
                with self.assertRaises(lab.LabError) as ctx:
                    self.register(script)
                self.assertEqual(ctx.exception.code, lab.PROBE_IDENTITY_AMBIGUOUS)

    def test_proven_failures_leave_nothing_behind(self):
        for script, code in (([lab.ApiNotSent("ConnectionRefusedError")], lab.LOCAL_RESOURCE_ERROR),
                             ([(400, b"{}")], lab.UNKNOWN), ([(429, b"{}")], lab.RATE_LIMITED)):
            with self.subTest(code=code):
                with self.assertRaises(lab.LabError) as ctx:
                    self.register(script)
                self.assertEqual(ctx.exception.code, code)
                self.assertEqual(os.listdir(self.dir), [])

    def test_crash_after_pending_reads_as_ambiguous(self):
        with open(os.path.join(self.dir, lab.IDENTITY_FILE), "w", encoding="utf-8") as fh:
            json.dump({"registration_state": lab.REG_PENDING, "operation_id": "x", "registration": None}, fh)
        self.assertEqual(lab.registration_state(self.meta()), lab.REG_AMBIGUOUS)
        with self.assertRaises(lab.LabError) as ctx:
            lab.load_identity(self.dir, self.dir)
        self.assertEqual(ctx.exception.code, lab.PROBE_IDENTITY_AMBIGUOUS)

    def test_patch_failure_resumes_without_second_post(self):
        with self.assertRaises(lab.LabError):
            with mock.patch.object(lab.time, "sleep"):
                self.register([(200, json.dumps(reg_response()).encode()), (503, b""), (503, b"")])
        self.assertEqual(lab.registration_state(self.meta()), lab.REG_PENDING)
        result, calls = self.register([(200, b"{}")])
        self.assertEqual((result, [c[0] for c in calls], calls[0][2]), ("enabled", ["PATCH"], "tok-secret"))

    def test_phase_a_identity_is_ready_without_api_calls(self):
        with open(os.path.join(self.dir, lab.IDENTITY_FILE), "w", encoding="utf-8") as fh:
            json.dump({"public_key": PUBLIC, "peer_public_key": PEER, "address_v4": "172.16.0.2",
                       "registration": {"id": "reg-1", "token": "t"}, "warp_enabled": True}, fh)
        with open(os.path.join(self.dir, lab.KEY_FILE), "w", encoding="utf-8") as fh:
            fh.write(PRIVATE)
        if os.name == "posix":
            os.chmod(os.path.join(self.dir, lab.KEY_FILE), 0o600)
        self.assertEqual(self.register([])[0], "exists")
        self.assertEqual(lab.load_identity(self.dir, self.dir).registration_id, "reg-1")

    def test_identity_reset_retires_but_never_touches_ready(self):
        with self.assertRaises(lab.LabError):
            self.register([lab.ApiResponseLost("EOF")])
        self.assertIn("retired", lab.identity_reset(self.dir, self.dir, clock=lambda: NOW))
        names = sorted(os.listdir(self.dir))
        self.assertTrue(all(".retired-" in n for n in names) and len(names) == 2)  # renamed, not deleted
        self.register([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        with self.assertRaises(lab.LabError):
            lab.identity_reset(self.dir, self.dir)

    def test_orphan_key_refused(self):
        with open(os.path.join(self.dir, lab.KEY_FILE), "w", encoding="utf-8") as fh:
            fh.write(PRIVATE)
        with self.assertRaises(lab.LabError):
            self.register([])

    def test_api_call_never_posts_and_bounds_retries(self):
        t, calls = self.transport([(503, b""), (503, b"")])
        with self.assertRaises(lab.LabError):
            lab.WarpApi(t).call("POST", "reg", {})
        with mock.patch.object(lab.time, "sleep"), self.assertRaises(lab.LabError):
            lab.WarpApi(t).call("PATCH", "reg/x", {}, "tok")
        self.assertEqual(len(calls), lab.WARP_API_MAX_ATTEMPTS)

    def test_identity_api_check(self):
        self.register([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        for script, expected in (([(200, b"{}")], "valid"), ([(401, b"{}")], "invalid"),
                                 ([lab.ApiNotSent("x"), lab.ApiNotSent("x")], "unknown")):
            t, _ = self.transport(script)
            with mock.patch.object(lab.time, "sleep"):
                self.assertEqual(lab.identity_api_check(lab.WarpApi(t), self.dir), expected)

    @unittest.skipUnless(os.name == "posix", "permission bits are POSIX-only")
    def test_group_readable_key_rejected(self):
        self.register([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        os.chmod(os.path.join(self.dir, lab.KEY_FILE), 0o640)
        with self.assertRaises(lab.LabError):
            lab.load_identity(self.dir, self.dir)


def reg_response():
    return {"result": {"id": "reg-1", "token": "tok-secret", "config": {
        "peers": [{"public_key": PEER, "endpoint": {"host": "engage.cloudflareclient.com:2408", "v4": "162.159.192.1:0"}}],
        "interface": {"addresses": {"v4": "172.16.0.2", "v6": "2606:4700:110:8a36::1"}}}}}


class FakeRunner(lab.CommandRunner):
    """Simulates ip/wg/ping/curl. failing_urls: curl exit code per URL substring."""

    def __init__(self, handshake_after=1, failing_urls=None, extra_route=False, fail_on=None, http_code=200):
        self.calls, self.inputs = [], []
        self.handshake_after, self.failing_urls = handshake_after, failing_urls or {}
        self.extra_route, self.fail_on, self.http_code = extra_route, fail_on, http_code
        self.hs_polls, self.rx, self.tx = 0, 0, 0

    def run(self, argv, input_text=None, check=True, timeout=lab.COMMAND_TIMEOUT_S):
        assert isinstance(argv, list) and all(isinstance(a, str) for a in argv)
        self.calls.append(argv)
        self.inputs.append(input_text)
        joined = " ".join(argv)
        if self.fail_on and self.fail_on in joined:
            if check:
                raise lab.LabError(lab.LOCAL_RESOURCE_ERROR, f"{argv[0]} failed")
            return lab.CommandResult(1, "", "fail")
        out = ""
        if argv[-3:] == ["-o", "link", "show"]:
            out = "1: lo: <LOOPBACK,UP>\n7: aelabcdef: <POINTOPOINT,NOARP,UP>\n"
        elif argv[-3:] == ["-4", "route", "show"]:
            out = "default dev aelabcdef scope link\n" + ("default via 10.0.0.1 dev eth9\n" if self.extra_route else "")
        elif "latest-handshakes" in argv:
            self.hs_polls += 1
            ts = NOW if self.handshake_after is not None and self.hs_polls > self.handshake_after else 0
            out = f"{PEER}\t{ts}\n"
        elif "transfer" in argv:
            out = f"{PEER}\t{self.rx}\t{self.tx}\n"
        elif "ping" in argv:
            self.tx += 148
            if self.handshake_after is not None:
                self.rx += 92
            return lab.CommandResult(1, "", "")
        elif "curl" in argv:
            url = argv[-1]
            code = next((c for frag, c in self.failing_urls.items() if frag in url), 0)
            if code == 0:
                self.tx += 600
                self.rx += 2000
                return lab.CommandResult(0, f"fl=1\nwarp=on\ncolo=HEL\n\n__AEL__ {self.http_code} 0 0.050 0.120", "")
            return lab.CommandResult(code, "\n__AEL__ 000 1 0 0", "")
        elif argv[:2] == ["wg", "genkey"]:
            out = PRIVATE + "\n"
        elif argv[:2] == ["wg", "pubkey"]:
            out = PUBLIC + "\n"
        return lab.CommandResult(0, out, "")


class LinuxEngineTests(unittest.TestCase):
    def engine(self, runner):
        t = {"now": 0.0}

        def sleep(s):
            t["now"] += s

        def mono():
            t["now"] += 0.01
            return t["now"]
        eng = lab.LinuxWireGuardProbeEngine(runner, sleep=sleep, monotonic=mono)
        eng.new_names = lambda: ("ael-abcdef", "aelabcdef")
        return eng

    def ep(self):
        return lab.parse_endpoint("162.159.192.1", 2408)

    def assert_torn_down(self, runner):
        self.assertIn(["ip", "netns", "delete", "ael-abcdef"], runner.calls)
        self.assertIn(["ip", "link", "delete", "dev", "aelabcdef"], runner.calls)

    def verify(self, runner, **kw):
        with tempfile.TemporaryDirectory() as tmp:
            return self.engine(runner).deep_verify(self.ep(), identity(tmp), **kw)

    def test_deep_verify_success_uses_first_target(self):
        runner = FakeRunner()
        res = self.verify(runner)
        self.assertTrue(res.ok, res)
        self.assertEqual(res.target_results, [("cf-1111", True, None)])
        self.assertEqual(res.evidence["trace_warp"], "on")
        self.assertGreater(res.traffic_bytes, 0)
        self.assert_torn_down(runner)
        curls = [c for c in runner.calls if "curl" in c]
        self.assertEqual(len(curls), 1)
        self.assertNotIn("-k", curls[0])
        self.assertNotIn("--insecure", curls[0])
        wg_set = next(c for c in runner.calls if c[:2] == ["wg", "set"])
        self.assertTrue(wg_set[wg_set.index("private-key") + 1].endswith("wg.key"))

    def test_target_quorum_falls_through(self):
        res = self.verify(FakeRunner(failing_urls={"1.1.1.1/cdn-cgi": 28}))
        self.assertTrue(res.ok)
        self.assertEqual([(n, o) for n, o, _ in res.target_results], [("cf-1111", False), ("cf-1001", True)])
        self.assertEqual(res.target_results[0][2], lab.HTTPS_TIMEOUT)

    def test_all_targets_failing_is_inconclusive(self):
        res = self.verify(FakeRunner(failing_urls={"https://": 60}))
        self.assertTrue(res.handshake_ok)
        self.assertTrue(res.inconclusive)
        self.assertFalse(res.endpoint_failure)
        self.assertEqual({e for _, _, e in res.target_results}, {lab.HTTPS_TLS_FAILED})
        self.assertEqual(len(res.target_results), len(lab.VERIFICATION_TARGETS))

    def test_private_key_never_in_argv_and_dump_never_used(self):
        runner = FakeRunner()
        self.verify(runner)
        flat = " ".join(" ".join(c) for c in runner.calls)
        self.assertNotIn(PRIVATE, flat)
        self.assertNotIn("dump", flat)

    def test_no_handshake_and_timeout_parameter(self):
        runner = FakeRunner(handshake_after=None)
        res = self.verify(runner, timeout_s=3.0)
        self.assertEqual(res.error_code, lab.HANDSHAKE_NO_RESPONSE)
        self.assertTrue(res.endpoint_failure)
        self.assertIn("3s", res.message)
        self.assertFalse(any("curl" in c for c in runner.calls))
        self.assert_torn_down(runner)

    def test_bypass_route_and_setup_failures_are_lab_failures(self):
        res = self.verify(FakeRunner(extra_route=True))
        self.assertEqual(res.error_code, lab.ROUTE_SETUP_FAILED)
        for fail_on, code in (("netns add", lab.LOCAL_RESOURCE_ERROR), ("wg set", lab.TUNNEL_SETUP_FAILED),
                              ("route add", lab.ROUTE_SETUP_FAILED), ("modprobe", lab.LOCAL_RESOURCE_ERROR)):
            with self.subTest(fail_on=fail_on):
                runner = FakeRunner(fail_on=fail_on)
                res = self.verify(runner)
                self.assertEqual(res.error_code, code)
                self.assertTrue(res.lab_failure)
                self.assert_torn_down(runner)

    def test_interrupt_tears_down_and_propagates(self):
        class Interrupting(FakeRunner):
            def run(self, argv, input_text=None, check=True, timeout=lab.COMMAND_TIMEOUT_S):
                if "curl" in argv:
                    self.calls.append(argv)
                    raise KeyboardInterrupt
                return super().run(argv, input_text, check, timeout)
        runner = Interrupting()
        with self.assertRaises(KeyboardInterrupt):
            self.verify(runner)
        self.assert_torn_down(runner)

    def test_config_knobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(lab.active_targets(lab.load_config(tmp)), list(lab.VERIFICATION_TARGETS))
            with open(os.path.join(tmp, lab.CONFIG_FILE), "w", encoding="utf-8") as fh:
                json.dump({"disabled_targets": ["cf-1111"]}, fh)
            self.assertEqual([t.name for t in lab.active_targets(lab.load_config(tmp))], ["cf-1001", "cf-www"])
            with open(os.path.join(tmp, lab.CONFIG_FILE), "w", encoding="utf-8") as fh:
                json.dump({"simulate_targets_unreachable": True}, fh)
            self.assertEqual(lab.active_targets(lab.load_config(tmp)), [lab.UNREACHABLE_TARGET])
            with open(os.path.join(tmp, lab.CONFIG_FILE), "w", encoding="utf-8") as fh:
                json.dump({"disabled_targets": ["https://evil.example"]}, fh)
            with self.assertRaises(lab.LabError):
                lab.load_config(tmp)


class CleanupTests(unittest.TestCase):
    def test_only_lab_names_match(self):
        netns = "ael-abcdef (id: 3)\nael-123456\nael-zzzzzz\nael-abcdef1\nvpn-ns\nawg0\n"
        links = ("1: lo: <LOOPBACK>\n3: awg0: <POINTOPOINT>\n9: aelabcdef: <POINTOPOINT>\n"
                 "10: veth66b5359@if2: <BROADCAST>\n11: aelabcdefg: <X>\n12: docker0: <X>\n")
        self.assertEqual(lab.find_stale_resources(netns, links), (["ael-abcdef", "ael-123456"], ["aelabcdef"]))


class StoreTests(LabFixture):
    def test_fresh_db_schema(self):
        self.assertEqual(self.store.conn.execute("PRAGMA user_version").fetchone()[0], lab.SCHEMA_VERSION)
        self.assertEqual(self.store.conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
        tables = {r[0] for r in self.store.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"endpoint", "observation", "transition", "operator_event", "target_result", "run"} <= tables)
        cols = {r[1] for r in self.store.conn.execute("PRAGMA table_info(endpoint)")}
        self.assertFalse({c for c in cols if "key" in c or "token" in c})

    def test_transitions_are_recorded(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        self.make_lab(FakeProbeEngine()).run_batch([eid], "refresh")
        row = self.store.conn.execute("SELECT from_state, to_state FROM transition").fetchone()
        self.assertEqual(tuple(row), (lab.VERIFYING, lab.ACTIVE))

    def test_prune_retention(self):
        eid = self.add("162.159.192.1")
        with self.store.transaction():
            for ts in (NOW - lab.OBSERVATION_RETENTION_S - 10, NOW - 10):
                self.store.conn.execute("INSERT INTO observation (endpoint_id, timestamp, probe_type, result, operation_id)"
                                        " VALUES (?,?,?,?,?)", (eid, ts, "handshake", "ok", "op"))
            self.store.prune(NOW)
        self.assertEqual(self.store.conn.execute("SELECT count(*) FROM observation").fetchone()[0], 1)

    def test_maintenance_is_rate_limited(self):
        runner = self.make_lab(FakeProbeEngine())
        first = runner.maintenance()
        self.assertEqual(first["checkpoint"], "TRUNCATE")
        self.assertIn("pruned", first)
        second = runner.maintenance()
        self.assertEqual(second, {"checkpoint": "PASSIVE"})
        self.assertTrue(self.store.quick_check())


class MigrationTests(unittest.TestCase):
    def make_v1(self, path):
        conn = sqlite3.connect(path)
        conn.executescript(lab.SCHEMA_V1 + ";PRAGMA user_version=1;")
        rows = [("162.159.192.1:2408", "162.159.192.1", "ACTIVE", "engage_dns", NOW - 100),
                ("162.159.193.1:2408", "162.159.193.1", "DISCOVERED", "zero_trust_range", None),
                ("188.114.97.1:500", "188.114.97.1", "SUSPECT", "project_seed", NOW - 900),
                ("192.0.2.1:2408", "192.0.2.1", "QUARANTINE", "negative_control", None)]
        for eid, ip, state, src, tok in rows:
            conn.execute("INSERT INTO endpoint (endpoint_id, ip, port, address_family, state, source, first_seen_at,"
                         " last_seen_at, last_traffic_ok_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (eid, ip, int(eid.rsplit(":", 1)[1]), 4, state, src, NOW, NOW, tok, NOW, NOW))
        conn.execute("INSERT INTO observation (endpoint_id, timestamp, probe_type, result, operation_id)"
                     " VALUES ('162.159.192.1:2408', ?, 'traffic', 'ok', 'phase-a')", (NOW - 100,))
        conn.commit()
        conn.close()

    def test_v1_to_v2_keeps_history_and_requires_reverification(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "lab.db")
            self.make_v1(path)
            store = lab.Store(path, clock=lambda: NOW)
            rows = {r["endpoint_id"]: r for r in store.all()}
            self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(rows["162.159.192.1:2408"]["state"], lab.VERIFYING)   # not ACTIVE because it once was
            self.assertEqual(rows["162.159.192.1:2408"]["source"], lab.SRC_PHASE_A)
            self.assertEqual(rows["162.159.192.1:2408"]["source_first"], "engage_dns")
            self.assertEqual(rows["162.159.193.1:2408"]["source"], lab.SRC_CF_ONE)
            self.assertEqual(rows["188.114.97.1:500"]["state"], lab.VERIFYING)
            self.assertEqual(rows["192.0.2.1:2408"]["source"], lab.SRC_NEGATIVE)
            self.assertEqual(store.conn.execute("SELECT count(*) FROM observation").fetchone()[0], 1)
            self.assertEqual(len(os.listdir(os.path.join(tmp, lab.DB_BACKUP_DIR))), 1)  # copy taken before migrating
            store.conn.close()

    def test_failed_migration_refuses_to_run_and_keeps_v1(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "lab.db")
            self.make_v1(path)
            with mock.patch.dict(lab.MIGRATIONS, {2: lab.SCHEMA_V2 + ";SELECT * FROM missing_table"}):
                with self.assertRaises(lab.LabError):
                    lab.Store(path, clock=lambda: NOW)
            conn = sqlite3.connect(path)
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT count(*) FROM endpoint").fetchone()[0], 4)
            conn.close()

    def test_newer_schema_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "lab.db")
            conn = sqlite3.connect(path)
            conn.execute("PRAGMA user_version=99")
            conn.close()
            with self.assertRaises(lab.LabError):
                lab.Store(path)


class SnapshotTests(LabFixture):
    def test_snapshot_v2_fields_and_ttls(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        self.make_lab(FakeProbeEngine()).run_batch([eid], "refresh")
        snap = self.snapshot()
        self.assertEqual(set(snap), set(lab.SNAPSHOT_TOP_KEYS))
        self.assertEqual((snap["schema_version"], snap["lab_status"], snap["active_count"]), (2, "ok", 1))
        top = lab.parse_iso(snap["expires_at"])
        self.assertLessEqual(top, NOW + lab.SNAPSHOT_TTL_S)
        self.assertLessEqual(top, lab.parse_iso(snap["endpoints"][0]["expires_at"]))
        self.assertEqual(len(lab.validate_snapshot(snap, NOW)), 1)
        self.assertEqual(lab.validate_snapshot(snap, NOW + lab.SNAPSHOT_TTL_S + 1), [])  # stale when the timer stops

    def test_validate_fails_closed(self):
        good = {"schema_version": 2, "generated_at": lab.iso(NOW), "expires_at": lab.iso(NOW + 60),
                "lab_status": "ok", "active_count": 0, "endpoints": []}
        self.assertEqual(lab.validate_snapshot(good, NOW), [])
        bad_ep = {k: None for k in lab.SNAPSHOT_ENDPOINT_KEYS} | {"private_key": PRIVATE}
        for doc in ({**good, "schema_version": 1}, {**good, "generated_at": lab.iso(NOW + 3600)},
                    {**good, "token": "x"}, {**good, "lab_status": "great"}, {**good, "active_count": 3},
                    {**good, "active_count": 1, "endpoints": [bad_ep]}, "not an object"):
            with self.subTest(doc=str(doc)[:60]), self.assertRaises((ValueError, KeyError, lab.LabError)):
                lab.validate_snapshot(doc, NOW)

    def test_atomic_write_keeps_old_file(self):
        path = lab.write_snapshot(self.public, {"old": True})
        with mock.patch.object(lab.os, "replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
            lab.write_snapshot(self.public, {"new": True})
        with open(path, encoding="utf-8") as fh:
            self.assertTrue(json.load(fh)["old"])
        self.assertEqual(os.listdir(self.public), [lab.SNAPSHOT_FILE])

    def test_snapshot_write_failure_is_recorded(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        with mock.patch.object(lab, "write_snapshot", side_effect=OSError(28, "No space left on device")):
            out = self.make_lab(FakeProbeEngine()).run_batch([eid], "refresh")
        self.assertFalse(out.snapshot_ok)
        meta = self.store.meta()
        self.assertTrue(meta["last_snapshot_error"].startswith("SNAPSHOT_WRITE_FAILED"))
        self.assertEqual((meta["lab_health"], meta["lab_health_reason"]), (lab.LAB_DEGRADED, "SNAPSHOT_WRITE_FAILED"))

    def test_db_write_failure_does_not_publish(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        runner = self.make_lab(FakeProbeEngine())
        with mock.patch.object(lab.Store, "record", side_effect=sqlite3.OperationalError("database or disk is full")):
            with self.assertRaises(lab.LabError) as ctx:
                runner.run_batch([eid], "refresh")
        self.assertIn("DB_WRITE_FAILED", str(ctx.exception))
        self.assertFalse(os.path.exists(os.path.join(self.public, lab.SNAPSHOT_FILE)))

    def test_snapshot_has_no_secrets_and_excludes_negative_control(self):
        a = self.add("162.159.192.1", state=lab.VERIFYING)
        n = self.add("192.0.2.1", state=lab.VERIFYING, source=lab.SRC_NEGATIVE)
        self.make_lab(FakeProbeEngine()).run_batch([a, n], "manual")
        text = json.dumps(self.snapshot())
        self.assertIsNone(lab.SECRET_LIKE_RE.search(text))
        self.assertNotIn("192.0.2.1", text)
        for word in ("token", "registration", "address_v4", "private"):
            self.assertNotIn(word, text)


class ReportTests(LabFixture):
    def test_stats_and_report_carry_sample_sizes(self):
        ids = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], state=lab.VERIFYING) for i in range(1, 5)]
        runner = self.make_lab(FakeProbeEngine({ids[0]: no_hs}))
        runner.run_batch(ids, "refresh")
        stats = lab.window_stats(self.store, NOW - 900)
        self.assertEqual(stats["probes"], 4)
        self.assertIn("(n=4)", stats["handshake_success"])
        report = lab.baseline_report(self.store, 24)
        self.assertEqual(report["refresh_runs"], 1)
        self.assertEqual(report["active"], {"min": 3, "median": 3, "max": 3})
        self.assertIn("2408", report["port_yield"])
        self.assertIn(lab.SRC_CONSUMER, report["source_yield"])
        self.assertIn("VERIFYING->ACTIVE", report["transitions"])


class SecretHandlingTests(unittest.TestCase):
    def test_redaction(self):
        self.assertNotIn(PRIVATE, lab.redact(f"key={PRIVATE} end"))
        self.assertNotIn(PRIVATE, str(lab.LabError(lab.UNKNOWN, f"wg said {PRIVATE}")))
        res = lab.ProbeResult(False, error_code=lab.HANDSHAKE_NO_RESPONSE, message=f"leak {PRIVATE}")
        self.assertNotIn(PRIVATE, lab.format_result("162.159.192.1:2408", res))

    def test_runner_uses_argv_without_shell(self):
        with mock.patch.object(lab.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            lab.CommandRunner().run(["ip", "netns", "list"])
        self.assertIs(run.call_args.kwargs["shell"], False)
        with self.assertRaises(lab.LabError):
            lab.CommandRunner().run("ip netns list")

    def test_runner_errors_are_redacted(self):
        with mock.patch.object(lab.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=1, stdout="", stderr=f"bad key {PRIVATE}")
            with self.assertRaises(lab.LabError) as ctx:
                lab.CommandRunner().run(["wg", "set", "x"])
        self.assertNotIn(PRIVATE, str(ctx.exception))

    def test_operator_reason_is_bounded_plain_text(self):
        self.assertEqual(lab._reason("flaps every hour (ticket #12)"), "flaps every hour (ticket #12)")
        for bad in ("$(rm -rf /)", "a" * 201, "line\nbreak", "`id`"):
            with self.subTest(bad=bad[:20]), self.assertRaises(lab.LabError):
                lab._reason(bad)


if __name__ == "__main__":
    unittest.main()
