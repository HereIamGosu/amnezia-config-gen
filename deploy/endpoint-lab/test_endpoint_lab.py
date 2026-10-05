"""Unit tests for endpoint_lab (no root, no network): python3 -m unittest discover -s deploy/endpoint-lab"""

import base64
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
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
        self.deadlines = []     # the deadline each call received, in call order

    def _next(self, eid):
        spec = self.outcomes.get(eid, self.default)
        if isinstance(spec, list):
            spec = spec.pop(0) if len(spec) > 1 else spec[0]
        return spec()

    def probe_handshake(self, endpoint, ident, timeout_s=None, deadline=None):
        self.calls.append(("probe", endpoint.endpoint_id, timeout_s))
        self.deadlines.append(deadline)
        return self._next(endpoint.endpoint_id)

    def deep_verify(self, endpoint, ident, timeout_s=None, targets=None, deadline=None):
        self.calls.append(("verify", endpoint.endpoint_id, timeout_s))
        self.deadlines.append(deadline)
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
        with open(os.path.join(HERE, "..", "..", "src", "server", "endpointCache.js"), encoding="utf-8") as fh:
            js = fh.read()
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

    def test_inconclusive_control_one_is_booked_when_control_two_passes(self):
        ids = self.pool(6)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        target = next(i for i in ids if i not in (c1, c2))
        engine = FakeProbeEngine({target: inconclusive, c1: [ok, inconclusive]})
        out = self.make_lab(engine).run_batch(ids, "refresh")
        self.assertTrue(out.control.global_ok)
        self.assertEqual(self.states()[c1], lab.SUSPECT)
        self.assertEqual(self.store.get(c1)["last_error_code"], lab.TRAFFIC_FAILED)

    def test_targets_dying_mid_batch_after_a_passing_control_never_mass_penalise(self):
        ids = self.pool(6)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        others = [i for i in ids if i not in (c1, c2)]
        order = [others[0], c1, c2] + others[1:]
        before = self.failures()
        # early inconclusive -> control #1 passes; afterwards every target is dead, controls included
        engine = FakeProbeEngine({c1: [ok, inconclusive], c2: [inconclusive]}, default=inconclusive)
        out = self.make_lab(engine).run_batch(order, "refresh")
        self.assertEqual(self.failures(), before)
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})
        self.assertFalse(out.control.global_ok)
        self.assertEqual(out.lab_health, lab.LAB_UNAVAILABLE)

    def test_control_is_never_booked_twice_in_one_batch(self):
        ids = self.pool(6)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        others = [i for i in ids if i not in (c1, c2)]
        # two control checks in one batch; control #1 fails in both, control #2 passes in both
        engine = FakeProbeEngine({others[0]: inconclusive, others[1]: [ok, inconclusive], c1: no_hs})
        self.make_lab(engine).run_batch([others[0], others[1]] + others[2:] + [c1, c2], "refresh")
        self.assertEqual(self.store.get(c1)["consecutive_failures"], 1)
        self.assertEqual(self.states()[c1], lab.SUSPECT)

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
            self.store.conn.execute("UPDATE endpoint SET expires_at=? WHERE endpoint_id=?", (NOW - 1, c1))
        new = runner.select_controls(NOW)  # ACTIVE but expired is not a usable control
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

    def test_hard_cap_parks_least_stable_and_keeps_controls(self):
        ids = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], lab.ACTIVE, successes=i) for i in range(1, 53)]
        runner = self.make_lab(FakeProbeEngine())
        controls = runner.select_controls(NOW)
        with self.store.transaction():  # make the weakest endpoint a control: it must survive the cap
            self.store.set_meta("controls", json.dumps([ids[0], controls[0]]))
        runner.run_batch(ids[:3], "refresh")
        st = self.states()
        # B1b working set: above ACTIVE_HIGH the pool is parked down to TARGET_ACTIVE (VERIFIED reserve)
        self.assertEqual(sum(s == lab.ACTIVE for s in st.values()), lab.TARGET_ACTIVE)
        parked = sorted((e for e, s in st.items() if s == lab.VERIFIED), key=lambda e: int(e.split(".")[3].split(":")[0]))
        self.assertEqual(len(parked), 52 - lab.TARGET_ACTIVE)
        self.assertNotIn(ids[0], parked)                # control kept although least stable
        self.assertEqual(parked, ids[1:1 + 52 - lab.TARGET_ACTIVE])  # next least stable are parked
        self.assertEqual(self.snapshot()["active_count"], lab.TARGET_ACTIVE)
        cause = self.store.conn.execute("SELECT DISTINCT cause FROM transition WHERE to_state='VERIFIED'").fetchall()
        self.assertEqual([c[0] for c in cause], ["pool_cap"])

    def test_working_set_has_hysteresis(self):
        ids = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], lab.ACTIVE, successes=i)
               for i in range(1, lab.ACTIVE_HIGH + 1)]
        self.make_lab(FakeProbeEngine()).run_batch(ids[:2], "refresh")
        self.assertEqual(sum(s == lab.ACTIVE for s in self.states().values()), lab.ACTIVE_HIGH)  # 28: nothing parked

    def test_rolling_plan_takes_oldest_third_and_bounds_extras(self):
        active = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], lab.ACTIVE) for i in range(1, 31)]
        with self.store.transaction():
            for n, eid in enumerate(active):  # verification age: .1 oldest ... .30 newest
                self.store.conn.execute("UPDATE endpoint SET last_traffic_ok_at=? WHERE endpoint_id=?", (NOW - 400 + n, eid))
        suspects = [self.add(f"188.114.96.{i}", state=lab.SUSPECT, source=lab.SRC_LEGACY) for i in range(1, 11)]
        plan = self.make_lab(FakeProbeEngine()).refresh_plan(NOW, lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        self.assertEqual(plan[:10], active[:10])            # ceil(30/3) = 10 least-recently verified ACTIVE
        self.assertEqual([p for p in plan if p in active], active[:10])  # exactly that slice, no other ACTIVE
        self.assertEqual(len([p for p in plan if p in suspects]), lab.REFRESH_SUSPECT_MAX)
        self.assertLessEqual(len(plan), lab.MAX_REFRESH_ENDPOINTS)
        few = self.make_lab(FakeProbeEngine())
        with self.store.transaction():
            self.store.conn.execute("DELETE FROM endpoint WHERE endpoint_id NOT IN (?, ?)", (active[0], active[1]))
        self.assertEqual(few.refresh_plan(NOW, lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10)), active[:2])

    def test_refresh_promotes_parked_endpoints_below_target(self):
        a = self.add("162.159.192.1", state=lab.ACTIVE)
        p = self.add("162.159.192.2", state=lab.VERIFIED)
        engine = FakeProbeEngine()
        self.make_lab(engine).refresh(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        self.assertEqual([c[1] for c in engine.calls], [a, p])
        self.assertEqual(self.states()[p], lab.ACTIVE)

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

    def test_inconclusive_discovery_probe_is_not_booked(self):
        eid = self.add("188.114.99.1", source=lab.SRC_LEGACY)
        runner = self.make_lab(FakeProbeEngine({eid: inconclusive}, default=no_hs))
        runner.run_batch([eid], "discovery", breaker=False)
        row = self.store.get(eid)
        self.assertEqual((row["state"], row["consecutive_failures"], row["last_error_code"]), (lab.DISCOVERED, 0, None))

    def test_lock_timing_invariants_hold(self):
        # hard deadline: past the wall a run overruns by at most PROBE_OVERRUN_S (DeadlineTests prove the bound)
        self.assertEqual(lab.PROBE_OVERRUN_S,
                         max(lab.DEADLINE_CMD_FLOOR_S, lab.CURL_GRACE_S) + 2 * lab.TEARDOWN_TIMEOUT_S)
        disc_hold = max(lab.DISCOVERY_WALL_S) + lab.PROBE_OVERRUN_S + lab.JOB_SLACK_S
        self.assertLess(disc_hold, lab.REFRESH_LOCK_WAIT_S)  # refresh always outlasts a discovery run
        with open(os.path.join(HERE, "systemd", "amnezia-endpoint-lab-refresh.service"), encoding="utf-8") as fh:
            unit = fh.read()
        timeout = int(re.search(r"^TimeoutStartSec=(\d+)$", unit, re.M).group(1))
        refresh_total = lab.REFRESH_LOCK_WAIT_S + lab.REFRESH_WALL_S + lab.PROBE_OVERRUN_S + lab.JOB_SLACK_S
        self.assertLess(refresh_total, timeout)  # systemd never kills a refresh that waited and then ran
        with open(os.path.join(HERE, "systemd", "amnezia-endpoint-lab-discovery.service"), encoding="utf-8") as fh:
            disc_unit = fh.read()
        disc_timeout = int(re.search(r"^TimeoutStartSec=(\d+)$", disc_unit, re.M).group(1))
        self.assertLess(lab.DISCOVERY_LOCK_WAIT_S + disc_hold, disc_timeout)

    @unittest.skipUnless(lab.fcntl, "flock is Linux-only")
    def test_discovery_yields_to_a_held_lock(self):
        path = os.path.join(self.tmp.name, "lock")
        with lab.global_lock(path), mock.patch.object(lab, "DISCOVERY_LOCK_WAIT_S", 1):
            self.assertIsNone(lab.job_lock("discovery", path))  # waits briefly, then yields
            with self.assertRaises(lab.LabError):
                lab.job_lock("verify", path)
        held = lab.job_lock("discovery", path)
        self.assertIsNotNone(held)
        held.__exit__(None, None, None)

    def test_dead_resurrection_after_delay(self):
        eid = self.add("162.159.192.200", state=lab.DEAD)
        with self.store.transaction():
            self.store.conn.execute("UPDATE endpoint SET last_probe_at=? WHERE endpoint_id=?", (NOW - 100, eid))
        runner = self.make_lab(FakeProbeEngine())
        self.assertNotIn(eid, runner.discovery_plan(NOW)[0])
        self.assertIn(eid, runner.discovery_plan(NOW + lab.DEAD_RESURRECT_AFTER_S)[0])

    def test_cloudflare_one_trickle(self):
        seeded = self.add("162.159.193.8", source=lab.SRC_CF_ONE)  # legacy seed in the Cloudflare One range
        runner = self.make_lab(FakeProbeEngine())
        self.assertNotIn(seeded, runner.discovery_plan(NOW)[0])  # never bulk-probed as a seed
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

    def __init__(self, handshake_after=1, failing_urls=None, extra_route=False, fail_on=None, http_code=200,
                 fail_first_curls=0):
        self.calls, self.inputs = [], []
        self.fail_first_curls = fail_first_curls
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
        elif argv[:3] == ["ip", "netns", "add"]:
            self.hs_polls = 0  # every session is a fresh interface
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
            if self.fail_first_curls > 0:
                self.fail_first_curls -= 1
                code = 28
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

    def test_all_targets_failing_in_both_sessions_is_inconclusive(self):
        runner = FakeRunner(failing_urls={"https://": 60})
        res = self.verify(runner)
        self.assertTrue(res.handshake_ok)
        self.assertTrue(res.inconclusive)
        self.assertFalse(res.endpoint_failure)
        self.assertEqual(res.sessions, lab.MAX_SESSIONS_PER_PROBE)
        self.assertEqual({e for _, _, e in res.target_results}, {lab.HTTPS_TLS_FAILED})
        self.assertEqual(len(res.target_results), 2 * len(lab.VERIFICATION_TARGETS))
        self.assertEqual(sum(c[:3] == ["ip", "netns", "add"] for c in runner.calls), 2)
        self.assertEqual(sum(c[:3] == ["ip", "netns", "delete"] for c in runner.calls), 2)  # both torn down

    def test_second_session_rescues_a_dead_first_session(self):
        runner = FakeRunner(fail_first_curls=len(lab.VERIFICATION_TARGETS))
        res = self.verify(runner)
        self.assertTrue(res.ok)
        self.assertEqual(res.sessions, 2)
        self.assertEqual([o for _, o, _ in res.target_results], [False, False, False, True])

    def test_slow_handshake_session_is_abandoned_after_first_timeout(self):
        runner = FakeRunner(handshake_after=5, fail_first_curls=1)  # handshake seen after ~1.25 s
        res = self.verify(runner)
        self.assertTrue(res.ok)
        self.assertEqual(res.sessions, 2)
        self.assertEqual(res.target_results[0], ("cf-1111", False, lab.HTTPS_TIMEOUT))
        self.assertEqual(len(res.target_results), 2)  # cf-1001/cf-www skipped in the dead first session

    def test_no_initiation_sent_is_a_lab_failure(self):
        class Mute(FakeRunner):  # the trigger cannot send (e.g. CAP_NET_RAW missing): tx never moves
            def run(self, argv, input_text=None, check=True, timeout=lab.COMMAND_TIMEOUT_S):
                if "ping" in argv:
                    self.calls.append(argv)
                    return lab.CommandResult(2, "", "ping: socket: Operation not permitted")
                return super().run(argv, input_text, check, timeout)
        res = self.verify(Mute(handshake_after=None))
        self.assertEqual(res.error_code, lab.LOCAL_RESOURCE_ERROR)
        self.assertTrue(res.lab_failure)  # never booked against the endpoint

    def test_handshake_failure_gets_no_second_session(self):
        runner = FakeRunner(handshake_after=None)
        res = self.verify(runner)
        self.assertEqual((res.sessions, res.error_code), (1, lab.HANDSHAKE_NO_RESPONSE))
        self.assertEqual(sum(c[:3] == ["ip", "netns", "add"] for c in runner.calls), 1)

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
                json.dump({"simulate_failing_targets": ["cf-1111"]}, fh)
            first = lab.active_targets(lab.load_config(tmp))[0]
            self.assertEqual((first.name, first.url), ("cf-1111", lab.UNREACHABLE_TARGET.url))
            with open(os.path.join(tmp, lab.CONFIG_FILE), "w", encoding="utf-8") as fh:
                json.dump({"disabled_targets": ["https://evil.example"]}, fh)
            with self.assertRaises(lab.LabError):
                lab.load_config(tmp)


class TimedRunner(FakeRunner):
    """FakeRunner on a shared simulated clock: a curl that times out takes its --max-time, other commands take
    milliseconds. Records (argv, timeout, started, ended) so every command can be checked against the deadline."""

    def __init__(self, t, **kw):
        super().__init__(**kw)
        self.t, self.log = t, []

    def run(self, argv, input_text=None, check=True, timeout=lab.COMMAND_TIMEOUT_S):
        start = self.t["now"]
        res = super().run(argv, input_text, check, timeout)
        if "curl" in argv:
            cost = float(argv[argv.index("--max-time") + 1]) if res.returncode in lab.CURL_TIMEOUT_CODES else 0.05
        else:
            cost = 0.02 if "ping" in argv else 0.001
        self.t["now"] += min(cost, timeout)
        self.log.append((argv, timeout, start, self.t["now"]))
        return res


def timed_engine(t, runner):
    def sleep(s):
        t["now"] += s
    eng = lab.LinuxWireGuardProbeEngine(runner, sleep=sleep, monotonic=lambda: t["now"])
    eng.new_names = lambda: ("ael-abcdef", "aelabcdef")
    return eng


TEARDOWN = (["ip", "netns", "delete"], ["ip", "link", "delete"])


class DeadlineEngineTests(unittest.TestCase):
    """The probe engine never waits past the run deadline (plus the bounded overrun)."""

    def probe(self, deadline_in, **runner_kw):
        t = {"now": 100.0}
        runner = TimedRunner(t, **runner_kw)
        deadline = None if deadline_in is None else t["now"] + deadline_in
        with tempfile.TemporaryDirectory() as tmp:
            res = timed_engine(t, runner).deep_verify(lab.parse_endpoint("162.159.192.1", 2408), identity(tmp),
                                                      lab.REFRESH_HANDSHAKE_TIMEOUT_S, deadline=deadline)
        return res, runner, deadline, t["now"]

    def assert_bounded(self, runner, deadline, ended):
        grace = max(lab.DEADLINE_CMD_FLOOR_S, lab.CURL_GRACE_S)
        for argv, timeout, start, end in runner.log:
            if argv[:3] in TEARDOWN:
                self.assertEqual(timeout, lab.TEARDOWN_TIMEOUT_S)
                continue
            self.assertLess(start, deadline, argv)                  # nothing new starts past the deadline
            self.assertLessEqual(end, deadline + grace, argv)
            if "curl" not in argv:
                self.assertLessEqual(timeout, max(lab.DEADLINE_CMD_FLOOR_S, deadline - start) + 1e-9, argv)
        self.assertLessEqual(ended, deadline + lab.PROBE_OVERRUN_S)
        commands = [c[0] for c in runner.log]
        self.assertIn(["ip", "netns", "delete", "ael-abcdef"], commands)              # torn down
        self.assertIn(["ip", "link", "delete", "dev", "aelabcdef"], commands)

    def test_budget_result_is_neither_an_endpoint_nor_a_lab_failure(self):
        for res in (lab.ProbeResult(False, error_code=lab.BUDGET_EXHAUSTED),
                    lab.ProbeResult(True, error_code=lab.BUDGET_EXHAUSTED)):
            self.assertTrue(res.budget_exhausted)
            self.assertFalse(res.endpoint_failure)
            self.assertFalse(res.lab_failure)
            self.assertFalse(res.inconclusive)

    def test_handshake_wait_clamps_to_the_deadline(self):
        res, runner, deadline, ended = self.probe(3, handshake_after=None)
        self.assertEqual(res.error_code, lab.BUDGET_EXHAUSTED)
        self.assertIn("handshake wait", res.message)                  # the wait itself was clamped
        self.assertLessEqual(res.probe_completion_ms, (3 + lab.POLL_INTERVAL_S) * 1000)  # at most one poll late
        self.assertFalse(res.endpoint_failure)
        self.assert_bounded(runner, deadline, ended)
        unbounded, _, _, _ = self.probe(None, handshake_after=None)   # the same endpoint without a deadline
        self.assertEqual(unbounded.error_code, lab.HANDSHAKE_NO_RESPONSE)

    def test_https_wait_clamps_to_the_deadline(self):
        res, runner, deadline, ended = self.probe(6, failing_urls={"cdn-cgi": 28})
        self.assertEqual(res.error_code, lab.BUDGET_EXHAUSTED)
        self.assertEqual(res.target_results[-1], ("cf-1001", False, lab.BUDGET_EXHAUSTED))
        times = [c[0][c[0].index("--max-time") + 1] for c in runner.log if "curl" in c[0]]
        self.assertEqual(times[0], str(lab.TARGET_MAX_TIME_S))      # a full first wait
        self.assertLess(float(times[1]), 2.0)                        # the second one only gets what is left
        self.assert_bounded(runner, deadline, ended)

    def test_second_session_is_not_started_without_budget(self):
        # session #1 may start (>= MIN_SESSION_BUDGET_S left) but its handshake poll alone leaves less than that
        res, runner, deadline, ended = self.probe(lab.MIN_SESSION_BUDGET_S + 0.05, failing_urls={"cdn-cgi": 35})
        self.assertEqual(res.error_code, lab.BUDGET_EXHAUSTED)      # not TARGETS_UNREACHABLE (inconclusive)
        self.assertFalse(res.inconclusive)
        self.assertEqual(res.sessions, 1)
        self.assertEqual(sum(c[0][:3] == ["ip", "netns", "add"] for c in runner.log), 1)
        self.assert_bounded(runner, deadline, ended)

    def test_no_session_starts_with_less_than_the_minimum_left(self):
        res, runner, _, _ = self.probe(lab.MIN_SESSION_BUDGET_S - 0.1)
        self.assertEqual(res.error_code, lab.BUDGET_EXHAUSTED)
        self.assertEqual(runner.log, [])


class TimedFakeEngine(FakeProbeEngine):
    """FakeProbeEngine on a simulated clock: a probe costs cost(eid) seconds; one that would pass its deadline stops
    there as BUDGET_EXHAUSTED, as the real engine does. timeline: (eid, start, end, deadline)."""

    def __init__(self, t, outcomes=None, default=ok, cost=lambda eid: 1.0):
        super().__init__(outcomes, default)
        self.t, self.cost, self.timeline = t, cost, []

    def deep_verify(self, endpoint, ident, timeout_s=None, targets=None, deadline=None):
        start = self.t["now"]
        res = super().deep_verify(endpoint, ident, timeout_s, targets, deadline)
        c = self.cost(endpoint.endpoint_id)
        if deadline is not None and start + c > deadline:
            self.t["now"] = max(start, deadline)
            res = lab.ProbeResult(False, error_code=lab.BUDGET_EXHAUSTED, message="simulated deadline")
        else:
            self.t["now"] = start + c
        self.timeline.append((endpoint.endpoint_id, start, self.t["now"], deadline))
        return res


class DeadlineTests(LabFixture):
    """One absolute deadline for every network step of a run: probes, controls, redo. No penalty without proof."""

    def setUp(self):
        super().setUp()
        self.t = {"now": 1000.0}

    def pool(self, n=8):
        return [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], lab.ACTIVE, successes=n - i)
                for i in range(1, n + 1)]

    def timed_lab(self, engine):
        return lab.Lab(self.store, engine, identity_loader=lambda: identity(self.tmp.name),
                       clock=lambda: self.clock_value, public_dir=self.public, monotonic=lambda: self.t["now"])

    def assert_inside(self, engine, deadline):
        for eid, start, end, dl in engine.timeline:
            self.assertEqual(dl, deadline, eid)        # every call carries the run deadline
            self.assertLessEqual(end, deadline, eid)

    def test_every_network_step_gets_the_run_deadline(self):
        ids = self.pool(6)
        engine = TimedFakeEngine(self.t, {ids[3]: inconclusive})
        self.timed_lab(engine).run_batch(ids[2:], "refresh", wall_s=45)
        self.assertTrue(engine.timeline)
        self.assert_inside(engine, 1000.0 + 45)

    def test_controls_stop_at_the_deadline(self):
        ids = self.pool(8)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        plan = [i for i in ids if i not in (c1, c2)]
        engine = TimedFakeEngine(self.t, {plan[0]: inconclusive, c1: no_hs}, cost=lambda eid: 10.0)
        before = self.failures()
        out = self.timed_lab(engine).run_batch(plan, "refresh", wall_s=25)
        self.assert_inside(engine, 1025.0)
        self.assertEqual([e for e, *_ in engine.timeline], [plan[0], c1, c2])   # control #2 cut at the deadline
        self.assertEqual(out.control.reason, lab.CONTROL_BUDGET_EXHAUSTED)
        self.assertIsNone(out.control.global_ok)
        self.assertEqual(self.failures(), before)       # neither the inconclusive probe nor control #1 is booked
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})
        self.assertEqual((out.lab_health, out.lab_reason), (lab.LAB_DEGRADED, "BREAKER_BUDGET_EXHAUSTED"))

    def test_no_control_probe_starts_without_the_minimum_left(self):
        ids = self.pool(8)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        plan = [i for i in ids if i not in (c1, c2)]
        engine = TimedFakeEngine(self.t, {plan[0]: inconclusive}, cost=lambda eid: 24.0)
        out = self.timed_lab(engine).run_batch(plan, "refresh", wall_s=25)
        self.assertEqual([e for e, *_ in engine.timeline], [plan[0]])   # 1 s left: no control is even started
        self.assertEqual(out.control.reason, lab.CONTROL_BUDGET_EXHAUSTED)
        self.assertEqual(out.control.results, {})

    def test_redo_stops_at_the_deadline_and_books_nothing_unproven(self):
        ids = self.pool(8)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        plan = [i for i in ids if i not in (c1, c2)][:5]
        engine = TimedFakeEngine(self.t, {i: [no_hs, ok] for i in plan}, cost=lambda eid: 4.0)
        before = self.failures()
        out = self.timed_lab(engine).run_batch(plan, "refresh", wall_s=34)
        self.assert_inside(engine, 1034.0)
        self.assertTrue(out.control.global_ok)
        redone = [e for e, *_ in engine.timeline[len(plan):] if e in plan]
        self.assertLess(len(redone), len(plan))         # the deadline cut the redo short
        self.assertEqual(self.failures(), before)       # nothing booked: redone ok, the rest unproven
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})
        note = self.store.conn.execute("SELECT note FROM run ORDER BY id DESC LIMIT 1").fetchone()[0]
        self.assertRegex(note, r"^budget_limited=[1-9]")

    def test_anomaly_without_control_budget_books_no_penalty(self):
        ids = self.pool(8)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        plan = [i for i in ids if i not in (c1, c2)][:5]
        engine = TimedFakeEngine(self.t, {i: no_hs for i in plan}, cost=lambda eid: 9.0)
        before = self.failures()
        out = self.timed_lab(engine).run_batch(plan, "refresh", wall_s=30)
        self.assert_inside(engine, 1030.0)
        self.assertEqual(out.control.reason, lab.CONTROL_BUDGET_EXHAUSTED)
        self.assertEqual(self.failures(), before)       # handshake failures in an anomaly need the breaker's verdict
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})
        self.assertEqual(out.lab_reason, "BREAKER_BUDGET_EXHAUSTED")

    def test_partial_results_are_committed_and_the_snapshot_published(self):
        ids = self.pool(6)
        engine = TimedFakeEngine(self.t, cost=lambda eid: 10.0)
        before = {r["endpoint_id"]: r for r in self.store.all()}
        out = self.timed_lab(engine).run_batch(ids, "refresh", wall_s=25)
        self.assert_inside(engine, 1025.0)
        done = [e for e, s, end, _ in engine.timeline if end - s == 10.0]
        cut = [e for e, s, end, _ in engine.timeline if end - s < 10.0]
        self.assertEqual((len(done), len(cut)), (2, 1))
        after = {r["endpoint_id"]: r for r in self.store.all()}
        for e in done:
            self.assertEqual(after[e]["consecutive_successes"], before[e]["consecutive_successes"] + 1)
        for e in cut + [i for i in ids if i not in done + cut]:   # cut short, or never started: untouched
            self.assertEqual((after[e]["state"], after[e]["consecutive_successes"], after[e]["consecutive_failures"],
                              after[e]["expires_at"]),
                             (before[e]["state"], before[e]["consecutive_successes"],
                              before[e]["consecutive_failures"], before[e]["expires_at"]))
        obs = self.store.conn.execute("SELECT result, error_code FROM observation WHERE endpoint_id=? AND"
                                      " probe_type='handshake'", (cut[0],)).fetchall()
        self.assertEqual([tuple(o) for o in obs], [("suppressed", lab.BUDGET_EXHAUSTED)])
        self.assertTrue(out.aborted)
        self.assertTrue(out.snapshot_ok)
        self.assertEqual(self.snapshot()["active_count"], 6)
        status, note = self.store.conn.execute("SELECT status, note FROM run ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual((status, note), ("aborted", "budget_limited=1"))

    def silent_controls_run(self, identity_check, wall_s):
        """Three ACTIVE endpoints and both controls silent: the breaker asks the WARP API about the identity."""
        ids = self.pool(8)
        c1, c2 = self.make_lab(FakeProbeEngine()).select_controls(NOW)
        plan = [i for i in ids if i not in (c1, c2)][:3]
        engine = TimedFakeEngine(self.t, {i: no_hs for i in plan + [c1, c2]}, cost=lambda eid: 1.0)
        runner = lab.Lab(self.store, engine, identity_loader=lambda: identity(self.tmp.name),
                         clock=lambda: self.clock_value, public_dir=self.public, monotonic=lambda: self.t["now"],
                         api=object())
        with mock.patch.object(lab, "identity_api_check", identity_check):
            started = time.monotonic()
            out = runner.run_batch(plan, "refresh", wall_s=wall_s)
        return out, time.monotonic() - started

    def test_a_hanging_identity_api_never_holds_the_run(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def hanging(api, conf_dir=None):
            release.wait(10)        # a blackholed API: DNS/connect never return in time
            return "valid"
        out, real_s = self.silent_controls_run(hanging, wall_s=8)   # 3 s left after the controls -> waits 1 s
        self.assertLess(real_s, 4)
        self.assertEqual(out.control.reason, "CONTROLS_SILENT")     # unknown, not a guess
        self.assertNotIn("identity_api_checked_at", self.store.meta())

    def test_identity_api_is_still_asked_when_time_allows(self):
        out, _ = self.silent_controls_run(lambda api, conf_dir=None: "valid", wall_s=30)
        self.assertEqual(out.control.reason, "WARP_UDP_UNREACHABLE")
        self.assertEqual(self.store.meta()["identity_api_status"], "valid")

    def real_engine_lab(self, **runner_kw):
        runner = TimedRunner(self.t, **runner_kw)
        return self.timed_lab(timed_engine(self.t, runner)), runner

    def test_refresh_has_an_absolute_runtime_bound(self):
        self.pool(12)
        lab_, runner = self.real_engine_lab(failing_urls={"cdn-cgi": 28})   # every session handshakes, carries nothing
        start = self.t["now"]
        lab_.refresh(lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10))
        self.assertLessEqual(self.t["now"] - start, lab.REFRESH_WALL_S + lab.PROBE_OVERRUN_S)
        deadline = start + lab.REFRESH_WALL_S
        self.assertTrue(all(s < deadline for argv, _, s, _ in runner.log if argv[:3] not in TEARDOWN))
        self.assertEqual(set(self.states().values()), {lab.ACTIVE})        # nothing proven, nothing booked

    def test_discovery_has_an_absolute_runtime_bound(self):
        ids = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4]) for i in range(1, 13)]
        lab_, runner = self.real_engine_lab(handshake_after=None)              # silent endpoints
        start = self.t["now"]
        wall = max(lab.DISCOVERY_WALL_S)
        lab_.run_batch(ids, "discovery", lab.DISCOVERY_HANDSHAKE_TIMEOUT_S, wall, breaker=False)
        self.assertLessEqual(self.t["now"] - start, wall + lab.PROBE_OVERRUN_S)
        self.assertTrue(all(s < start + wall for argv, _, s, _ in runner.log if argv[:3] not in TEARDOWN))


class HealthLabelTests(LabFixture):
    """RCA 2026-10-05: a rescued probe (session #1 carried nothing, a fresh session reached the same target) is a
    tunnel-session failure, not a target failure."""

    def classify(self, results):
        rows = [(f"162.159.192.{i}:2408", r, NOW) for i, r in enumerate(results, 1)]
        return self.make_lab(FakeProbeEngine())._classify(rows, None, False, False, [])

    def test_rescued_sessions_are_not_a_target_failure(self):
        rescued = lab.ProbeResult(True, traffic_ok=True, sessions=2,
                                  target_results=[("cf-1111", False, lab.HTTPS_TIMEOUT), ("cf-1111", True, None)])
        self.assertEqual(self.classify([rescued, rescued, ok()]), (lab.LAB_DEGRADED, "SESSION_TRAFFIC_DEGRADED"))

    def test_target_specific_failure_is_still_reported(self):
        fell_through = lab.ProbeResult(True, traffic_ok=True, sessions=1,
                                       target_results=[("cf-1111", False, lab.HTTPS_TIMEOUT), ("cf-1001", True, None)])
        self.assertEqual(self.classify([fell_through, fell_through, ok()]),
                         (lab.LAB_DEGRADED, "TARGET_FAILING:cf-1111"))

    DEAD = lab.ProbeResult(True, error_code=lab.TRAFFIC_FAILED, sessions=2,
                           target_results=[("cf-1111", False, lab.HTTPS_TIMEOUT)] * 2
                           + [("cf-1001", False, lab.HTTPS_TIMEOUT), ("cf-www", False, lab.HTTPS_TIMEOUT)])

    def test_a_few_dead_sessions_no_longer_flag_the_first_target(self):
        # the old attempt count gave TARGET_FAILING:cf-1111 here (4 failed attempts >= half of 5 probes)
        self.assertEqual(self.classify([self.DEAD, self.DEAD, ok(), ok(), ok()]), (lab.LAB_OK, "ok"))

    def test_mostly_dead_sessions_are_a_session_problem_not_a_target_one(self):
        self.assertEqual(self.classify([self.DEAD] * 3 + [ok(), ok()]), (lab.LAB_DEGRADED, "SESSION_TRAFFIC_DEGRADED"))


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

    def test_corrupt_db_stops_the_job_without_touching_it(self):
        eid = self.add("162.159.192.1", state=lab.ACTIVE)
        with open(self.db, "rb") as fh:
            before = fh.read()
        with mock.patch.object(lab.Store, "quick_check", return_value=False):
            with self.assertRaises(lab.LabError) as ctx:
                lab.ensure_db_healthy(self.store, NOW)
        self.assertIn("DB_CORRUPT", str(ctx.exception))
        with open(self.db, "rb") as fh:
            self.assertEqual(fh.read(), before)  # nothing written, nothing deleted
        self.assertFalse(os.path.exists(os.path.join(self.public, lab.SNAPSHOT_FILE)))  # snapshot only ages out
        self.assertEqual(self.store.get(eid)["state"], lab.ACTIVE)
        self.assertTrue(lab.ensure_db_healthy(self.store, NOW))      # a healthy DB passes and is remembered
        self.assertFalse(lab.ensure_db_healthy(self.store, NOW + 60))  # daily, not every job

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
            self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], lab.SCHEMA_VERSION)
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
            with mock.patch.dict(lab.MIGRATIONS, {3: lab.SCHEMA_V3 + ";SELECT * FROM missing_table"}):
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

    def test_public_status_file_is_written_and_ip_free(self):
        ids = [self.add(f"162.159.192.{i}", lab.OFFICIAL_PORTS[i % 4], state=lab.VERIFYING) for i in range(1, 5)]
        self.make_lab(FakeProbeEngine()).run_batch(ids, "refresh")
        with open(os.path.join(self.public, lab.STATUS_FILE), encoding="utf-8") as fh:
            text = fh.read()
        doc = json.loads(text)
        self.assertEqual(doc["schema_version"], lab.STATUS_SCHEMA_VERSION)
        self.assertEqual(doc["pool"]["eligible_active"], 4)
        self.assertIsInstance(doc["controls"]["count"], int)  # controls are chosen lazily, by the breaker
        self.assertIn("(n=4)", doc["stats_15m"]["handshake_success"])
        self.assertEqual(doc["stats_15m"]["sessions"]["first_session_ok"], 4)
        self.assertIsNone(re.search(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", text))  # no endpoint addresses at all
        self.assertIsNone(lab.SECRET_LIKE_RE.search(text))
        self.assertNotIn("token", text)

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
    def test_session_split_never_hides_a_rescue(self):
        a, b, c = (self.add(f"162.159.192.{i}", state=lab.VERIFYING) for i in (1, 2, 3))
        rescued = lambda: replace(ok(), sessions=2)  # noqa: E731
        both_failed = lambda: replace(inconclusive(), sessions=2)  # noqa: E731
        self.make_lab(FakeProbeEngine({b: rescued, c: both_failed})).run_batch([a, b, c], "refresh")
        self.assertEqual(lab.session_split(self.store, NOW - 60),
                         {"first_session_ok": 1, "second_session_rescued": 1, "both_sessions_failed": 1})
        self.assertEqual(lab.baseline_report(self.store, 1)["sessions"]["second_session_rescued"], 1)

    def test_read_only_store_never_writes_or_migrates(self):
        ro = lab.Store(self.db, read_only=True)
        self.assertEqual(len(ro.all()), 0)
        with self.assertRaises(sqlite3.OperationalError):
            ro.conn.execute("INSERT INTO lab_meta (key, value) VALUES ('x', 'y')")
        ro.conn.close()
        with self.store.transaction():
            self.store.conn.execute("PRAGMA user_version=2")
        with self.assertRaises(lab.LabError):
            lab.Store(self.db, read_only=True)

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


class SimEngine(FakeProbeEngine):
    """Time-dependent world for the accelerated lifecycle: outcome(eid, now) decides every probe."""

    def __init__(self, outcome):
        super().__init__()
        self.outcome = outcome

    def _next(self, eid):
        return self.outcome(eid)


class AcceleratedLifecycleTests(LabFixture):
    """A simulated day (refresh every 60 s, discovery every 30 min) in seconds, with Lab/global failure windows.
    Real time is only needed for network behaviour; every temporal rule of the state machine is checked here."""

    HOUR = 3600

    def world(self):
        healthy = [f"162.159.192.{i}:{lab.OFFICIAL_PORTS[i % 4]}" for i in range(1, 31)]
        flaky = [f"188.114.96.{i}:2408" for i in range(1, 7)]
        dead = [f"188.114.97.{i}:500" for i in range(1, 5)]
        for eid in healthy + flaky + dead:
            ip, port = eid.rsplit(":", 1)
            self.add(ip, int(port), state=lab.VERIFYING, source=lab.SRC_PHASE_A if eid in healthy else lab.SRC_LEGACY)
        return healthy, flaky, dead

    def test_simulated_day_with_failure_windows(self):
        import random
        rng = random.Random(20261004)
        healthy, flaky, dead = self.world()
        H = self.HOUR
        windows = {"targets": (6 * H, 6.5 * H), "uplink": (12 * H, 12.25 * H), "identity": (15 * H, 15.1 * H),
                   "wg": (18 * H, 18 * H + 600), "pause": (20 * H, 20.5 * H)}
        checked = {name: 0 for name in ("targets", "uplink", "identity", "wg")}

        def within(name, t, margin=0):
            a, b = windows[name]
            return NOW + a + margin <= t < NOW + b - margin

        def outcome(eid):
            t = self.clock_value
            if within("wg", t):
                return local()
            if within("uplink", t):
                return no_hs()
            if within("targets", t):
                return inconclusive()
            if eid in dead:
                return no_hs()
            if eid in flaky:
                return no_hs() if rng.random() < 0.5 else ok()
            if eid in healthy:
                r = rng.random()
                return no_hs() if r < 0.03 else (replace(inconclusive(), sessions=2) if r < 0.05 else ok())
            last = int(eid.split(".")[3].split(":")[0])  # discovery candidates: 3 of 4 addresses work
            return no_hs() if last % 4 == 0 else ok()

        def identity_loader():
            if within("identity", self.clock_value):
                raise lab.LabError(lab.PROBE_IDENTITY_INVALID, "revoked in the simulation")
            return identity(self.tmp.name)

        runner = lab.Lab(self.store, SimEngine(outcome), identity_loader=identity_loader,
                         clock=lambda: self.clock_value, public_dir=self.public)
        res = lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10)
        stale_checked = False
        with mock.patch.object(lab.os, "fsync"):  # speed: durability is tested elsewhere
            step = 0
            while self.clock_value < NOW + 24 * H:
                t = self.clock_value
                if within("pause", t):
                    if not stale_checked and t >= NOW + windows["pause"][0] + lab.SNAPSHOT_TTL_S + 1:
                        self.assertEqual(lab.validate_snapshot(self.snapshot(), t), [])  # stopped Lab => stale file
                        stale_checked = True
                else:
                    before = self.failures()
                    runner.targets = lab.active_targets(lab.LabConfig())
                    runner.refresh(res)
                    if step % 30 == 0:
                        runner.discovery(res)
                    snap = self.snapshot()
                    fresh = lab.validate_snapshot(snap, t)
                    self.assertEqual(len(fresh), snap["active_count"])            # only fresh ACTIVE are published
                    self.assertLessEqual(snap["active_count"], lab.ACTIVE_HIGH)    # working set respected
                    for w in checked:
                        if within(w, t):  # every tick inside the window, including the very first one
                            checked[w] += 1
                            self.assertEqual(self.failures(), before, f"penalty during {w} at +{(t - NOW) / H:.3f} h")
                step += 1
                self.clock_value += 60
        self.assertTrue(stale_checked)
        self.assertTrue(all(n > 0 for n in checked.values()), checked)  # no window may be checked vacuously
        c = self.store.conn
        # no endpoint was punished inside any Lab/global failure window (transitions to failure states)
        for name in ("targets", "uplink", "identity", "wg"):
            a, b = windows[name]
            n = c.execute("SELECT count(*) FROM transition WHERE ts >= ? AND ts < ? AND to_state IN ('SUSPECT','QUARANTINE','DEAD')",
                          (NOW + a, NOW + b)).fetchone()[0]
            self.assertEqual(n, 0, name)
        # dead endpoints end DEAD after bounded quarantine, then are only re-probed every >= 6 h
        for eid in dead:
            self.assertEqual(self.store.get(eid)["state"], lab.DEAD, eid)
            entered = c.execute("SELECT min(ts) FROM transition WHERE endpoint_id=? AND to_state='DEAD'", (eid,)).fetchone()[0]
            probes = [r[0] for r in c.execute("SELECT timestamp FROM observation WHERE endpoint_id=? AND probe_type='handshake'"
                                              " AND timestamp > ? ORDER BY timestamp", (eid, entered))]
            self.assertTrue(all(b - a >= lab.DEAD_RESURRECT_AFTER_S for a, b in zip(probes, probes[1:])), eid)
        # every quarantine was respected: the next probe of that endpoint never came before the shortest cooldown
        entries = c.execute("SELECT endpoint_id, ts FROM transition WHERE to_state='QUARANTINE'").fetchall()
        self.assertGreater(len(entries), 0)  # the flaky endpoints guarantee quarantines
        for eid, ts in entries:
            nxt = c.execute("SELECT min(timestamp) FROM observation WHERE endpoint_id=? AND probe_type='handshake'"
                            " AND timestamp > ?", (eid, ts)).fetchone()[0]
            if nxt is not None:
                self.assertGreaterEqual(nxt - ts, min(lab.QUARANTINE_BACKOFF_S), eid)
        for eid, until, err in c.execute("SELECT endpoint_id, quarantine_until, last_error_at FROM endpoint"
                                         " WHERE state='QUARANTINE' AND quarantine_kind='auto'"):
            self.assertIn(until - err, lab.QUARANTINE_BACKOFF_S, eid)
        # the hot pool recovered after every window and stays near target
        final = sum(lab.is_eligible(lab.Store.to_row(r), self.clock_value - 60) for r in self.store.all())
        self.assertGreaterEqual(final, lab.SOFT_FLOOR)
        self.assertGreater(c.execute("SELECT count(*) FROM transition WHERE cause='pool_cap'").fetchone()[0], 0)
        self.assertGreater(c.execute("SELECT count(*) FROM endpoint WHERE state='VERIFIED'").fetchone()[0], 0)
        health = {r[0] for r in c.execute("SELECT DISTINCT lab_reason FROM run WHERE lab_health='UNAVAILABLE'")}
        self.assertTrue({"VERIFICATION_TARGETS_UNAVAILABLE", "CONTROLS_SILENT", lab.PROBE_IDENTITY_INVALID,
                         lab.LOCAL_RESOURCE_ERROR} <= health, health)

    def test_pause_longer_than_ttl_drains_and_rebuilds(self):
        healthy, _, _ = self.world()
        runner = lab.Lab(self.store, SimEngine(lambda eid: ok() if eid in healthy else no_hs()),
                         identity_loader=lambda: identity(self.tmp.name), clock=lambda: self.clock_value,
                         public_dir=self.public)
        res = lab.Resources(10 ** 6, 0, 0.1, 2, 10 ** 10)
        with mock.patch.object(lab.os, "fsync"):
            for _ in range(10):
                runner.refresh(res)
                self.clock_value += 60
            self.assertGreaterEqual(self.snapshot()["active_count"], lab.SOFT_FLOOR)
            self.clock_value += lab.ACTIVE_TTL_S + 60     # the timer was stopped for longer than the TTL
            runner.publish()
            self.assertEqual(self.snapshot()["active_count"], 0)  # nothing stale survives a pause
            for _ in range(5):
                runner.refresh(res)
                self.clock_value += 60
            self.assertGreaterEqual(self.snapshot()["active_count"], lab.ROLLING_SLICE_MIN)

    def test_db_locked_and_disk_full_never_publish_unrecorded_state(self):
        eid = self.add("162.159.192.1", state=lab.VERIFYING)
        runner = self.make_lab(FakeProbeEngine())
        for err in (sqlite3.OperationalError("database is locked"), sqlite3.OperationalError("database or disk is full")):
            with self.subTest(err=str(err)), mock.patch.object(lab.Store, "record", side_effect=err):
                with self.assertRaises(lab.LabError) as ctx:
                    runner.run_batch([eid], "refresh")
                self.assertIn("DB_WRITE_FAILED", str(ctx.exception))
                self.assertFalse(os.path.exists(os.path.join(self.public, lab.SNAPSHOT_FILE)))
        self.assertEqual(self.store.get(eid)["state"], lab.VERIFYING)


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
