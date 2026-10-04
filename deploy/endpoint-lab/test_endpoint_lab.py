"""Unit tests for endpoint_lab (no root, no network): python3 -m unittest discover -s deploy/endpoint-lab"""

import base64
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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


class FakeProbeEngine(lab.ProbeEngine):
    def __init__(self, outcomes):
        self.outcomes = outcomes  # endpoint_id -> ProbeResult
        self.calls = []

    def probe_handshake(self, endpoint, ident):
        self.calls.append(("probe", endpoint.endpoint_id))
        return self.outcomes[endpoint.endpoint_id]

    def deep_verify(self, endpoint, ident):
        self.calls.append(("verify", endpoint.endpoint_id))
        return self.outcomes[endpoint.endpoint_id]


OK = lab.ProbeResult(True, traffic_ok=True, probe_completion_ms=120, traffic_total_ms=300)
NO_HS = lab.ProbeResult(False, error_code=lab.HANDSHAKE_NO_RESPONSE, probe_completion_ms=8000)
NO_TRAFFIC = lab.ProbeResult(True, traffic_ok=False, error_code=lab.TRAFFIC_FAILED, probe_completion_ms=90)
LOCAL = lab.ProbeResult(False, error_code=lab.LOCAL_RESOURCE_ERROR, message="netns add failed")


class ValidationTests(unittest.TestCase):
    def test_valid_endpoint_and_id(self):
        ep = lab.parse_endpoint("162.159.192.1", 2408)
        self.assertEqual(ep.endpoint_id, "162.159.192.1:2408")
        self.assertEqual(lab.parse_endpoint_id("162.159.192.1:4500").port, 4500)

    def test_rejects_bad_inputs(self):
        bad = [("162.159.192.1", 2409), ("162.159.192.1", "2408"), ("162.159.192.1", True),
               ("8.8.8.8", 2408), ("2606:4700:100::1", 2408), ("162.159.192.1; rm -rf /", 2408),
               ("not-an-ip", 2408)]
        for ip, port in bad:
            with self.subTest(ip=ip, port=port), self.assertRaises(lab.LabError):
                lab.parse_endpoint(ip, port)

    def test_rejects_shell_like_endpoint_id(self):
        for value in ("162.159.192.1:2408;id", "$(id):2408", "162.159.192.0/24:2408", "162.159.192.1"):
            with self.subTest(value=value), self.assertRaises(lab.LabError):
                lab.parse_endpoint_id(value)

    def test_candidates_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"schema_version": 1, "candidates": [
                    {"ip": "162.159.192.1", "source": "engage_dns"},
                    {"ip": "162.159.192.1", "ports": [2408], "source": "engage_dns"},
                    {"ip": "192.0.2.1", "ports": [2408], "source": "negative_control"}]}, fh)
            got = lab.load_candidates(path)
            self.assertEqual(len(got), 5)  # 4 official ports + negative control, duplicates removed
            self.assertEqual({p.port for p, _ in got[:4]}, set(lab.OFFICIAL_PORTS))

    def test_candidates_reject_ranges_and_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.json")
            for doc in ({"schema_version": 1, "candidates": [{"ip": "162.159.192.0/24"}]},
                        {"schema_version": 1, "candidates": [{"ip": f"162.159.192.{i}"} for i in range(1, 20)]},
                        {"schema_version": 1, "candidates": [{"ip": "162.159.192.1", "source": "Bad Label"}]},
                        {"schema_version": 2, "candidates": []}):
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
                with self.subTest(doc=str(doc)[:60]), self.assertRaises(lab.LabError):
                    lab.load_candidates(path)


class StateMachineTests(unittest.TestCase):
    def row(self, **kw):
        return lab.EndpointRow(endpoint_id="162.159.192.1:2408", **kw)

    def test_deep_success_makes_active_with_ttl(self):
        new = lab.apply_outcome(self.row(), OK, deep=True, now=NOW)
        self.assertEqual(new.state, lab.ACTIVE)
        self.assertEqual(new.expires_at, NOW + lab.ACTIVE_TTL_S)
        self.assertTrue(lab.is_eligible(new, NOW))
        self.assertFalse(lab.is_eligible(new, NOW + lab.ACTIVE_TTL_S))

    def test_handshake_alone_never_active(self):
        hs = lab.ProbeResult(True)
        new = lab.apply_outcome(self.row(), hs, deep=False, now=NOW)
        self.assertEqual(new.state, lab.HANDSHAKE_OK)
        self.assertFalse(lab.is_eligible(new, NOW))

    def test_traffic_failure_is_endpoint_failure(self):
        new = lab.apply_outcome(self.row(), NO_TRAFFIC, deep=True, now=NOW)
        self.assertEqual(new.consecutive_failures, 1)
        self.assertEqual(new.last_handshake_ok_at, NOW)
        self.assertNotEqual(new.state, lab.ACTIVE)

    def test_active_failure_goes_suspect_and_leaves_pool(self):
        active = lab.apply_outcome(self.row(), OK, deep=True, now=NOW)
        suspect = lab.apply_outcome(active, NO_HS, deep=True, now=NOW + 60)
        self.assertEqual(suspect.state, lab.SUSPECT)
        self.assertFalse(lab.is_eligible(suspect, NOW + 60))
        back = lab.apply_outcome(suspect, OK, deep=True, now=NOW + 120)
        self.assertEqual(back.state, lab.ACTIVE)

    def test_hysteresis_to_quarantine_and_dead(self):
        r = lab.apply_outcome(self.row(), OK, deep=True, now=NOW)
        for i in range(lab.SUSPECT_TO_QUARANTINE_FAILURES):
            r = lab.apply_outcome(r, NO_HS, deep=True, now=NOW + i)
        self.assertEqual(r.state, lab.QUARANTINE)
        self.assertIsNotNone(r.quarantine_until)
        for i in range(lab.QUARANTINE_TO_DEAD_FAILURES):
            r = lab.apply_outcome(r, NO_HS, deep=True, now=NOW + 100 + i)
        self.assertEqual(r.state, lab.DEAD)

    def test_lab_failure_never_penalises(self):
        active = lab.apply_outcome(self.row(), OK, deep=True, now=NOW)
        for code in lab.LAB_FAILURE_CODES:
            res = lab.ProbeResult(False, error_code=code)
            with self.subTest(code=code):
                self.assertEqual(lab.apply_outcome(active, res, deep=True, now=NOW + 1), active)

    def test_blacklist_outranks_success(self):
        new = lab.apply_outcome(self.row(manual_blacklist=1), OK, deep=True, now=NOW)
        self.assertEqual(new.state, lab.VERIFIED)
        self.assertFalse(lab.is_eligible(new, NOW))

    def test_global_guard(self):
        self.assertTrue(lab.global_failure_suspected([NO_HS] * 3))
        self.assertFalse(lab.global_failure_suspected([NO_HS, NO_HS, OK]))
        self.assertFalse(lab.global_failure_suspected([NO_HS] * 2))
        self.assertFalse(lab.global_failure_suspected([LOCAL] * 5))


class StoreAndLabTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "lab.db")
        self.public = os.path.join(self.tmp.name, "public")
        os.makedirs(self.public)
        self.store = lab.Store(self.db)
        with self.store.transaction():
            for ip in ("162.159.192.1", "162.159.192.2", "162.159.192.3"):
                self.store.upsert_candidate(lab.parse_endpoint(ip, 2408), "consumer_seed", NOW)

    def tearDown(self):
        self.store.conn.close()
        self.tmp.cleanup()

    def make_lab(self, outcomes, loader=None):
        return lab.Lab(self.store, FakeProbeEngine(outcomes), identity_loader=loader or (lambda: identity(self.tmp.name)),
                       clock=lambda: NOW, public_dir=self.public)

    def snapshot(self):
        with open(os.path.join(self.public, lab.SNAPSHOT_FILE), encoding="utf-8") as fh:
            return json.load(fh)

    def test_schema_version_and_wal(self):
        self.assertEqual(self.store.conn.execute("PRAGMA user_version").fetchone()[0], lab.SCHEMA_VERSION)
        self.assertEqual(self.store.conn.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
        cols = {r[1] for r in self.store.conn.execute("PRAGMA table_info(endpoint)")}
        self.assertFalse({c for c in cols if "key" in c or "token" in c})

    def test_upsert_reports_new_only_once(self):
        with self.store.transaction():
            self.assertFalse(self.store.upsert_candidate(lab.parse_endpoint("162.159.192.1", 2408), "x", NOW + 5))
            self.assertTrue(self.store.upsert_candidate(lab.parse_endpoint("162.159.192.1", 500), "x", NOW + 5))

    def test_transaction_rolls_back(self):
        with self.assertRaises(RuntimeError), self.store.transaction():
            self.store.conn.execute("UPDATE endpoint SET state='ACTIVE'")
            raise RuntimeError("boom")
        self.assertEqual({r["state"] for r in self.store.all()}, {lab.DISCOVERED})

    def test_success_records_observations_and_snapshot(self):
        eid = "162.159.192.1:2408"
        self.make_lab({eid: OK}).run([eid], deep=True)
        self.assertEqual(self.store.get(eid)["state"], lab.ACTIVE)
        obs = self.store.conn.execute("SELECT probe_type, result FROM observation").fetchall()
        self.assertEqual(sorted(tuple(o) for o in obs), [("handshake", "ok"), ("traffic", "ok")])
        snap = self.snapshot()
        self.assertEqual(snap["lab_status"], "ok")
        self.assertEqual([e["ip"] for e in snap["endpoints"]], ["162.159.192.1"])
        self.assertEqual(lab.validate_snapshot(snap, NOW)[0]["port"], 2408)

    def test_handshake_and_traffic_failures(self):
        a, b = "162.159.192.1:2408", "162.159.192.2:2408"
        self.make_lab({a: NO_HS, b: NO_TRAFFIC}).run([a, b], deep=True)
        self.assertEqual(self.store.get(a)["last_error_code"], lab.HANDSHAKE_NO_RESPONSE)
        self.assertEqual(self.store.get(b)["last_error_code"], lab.TRAFFIC_FAILED)
        self.assertEqual(self.snapshot()["endpoints"], [])
        self.assertEqual(self.snapshot()["lab_status"], "empty")

    def test_local_resource_error_is_lab_failure(self):
        eid = "162.159.192.1:2408"
        lab_ = self.make_lab({eid: OK})
        lab_.run([eid], deep=True)
        lab_.engine.outcomes[eid] = LOCAL
        lab_.run([eid], deep=True)
        row = self.store.get(eid)
        self.assertEqual(row["state"], lab.ACTIVE)
        self.assertEqual(row["consecutive_failures"], 0)
        self.assertEqual(self.store.meta()["last_run_status"], "lab_failure")
        self.assertEqual(self.snapshot()["lab_status"], "degraded")

    def test_missing_identity_is_lab_failure_without_probes(self):
        eid = "162.159.192.1:2408"

        def broken():
            raise lab.LabError(lab.PROBE_IDENTITY_INVALID, "missing")
        lab_ = self.make_lab({eid: OK}, loader=broken)
        lab_.run([eid], deep=True)
        self.assertEqual(lab_.engine.calls, [])
        self.assertEqual(self.store.get(eid)["state"], lab.DISCOVERED)
        self.assertEqual(self.store.get(eid)["consecutive_failures"], 0)

    def test_global_guard_suppresses_transitions(self):
        ids = [r["endpoint_id"] for r in self.store.all()]
        self.make_lab({i: NO_HS for i in ids}).run(ids, deep=True)
        self.assertEqual({r["consecutive_failures"] for r in self.store.all()}, {0})
        self.assertEqual(self.store.meta()["last_run_status"], "suspect_global")

    def test_each_probe_keeps_its_own_timestamp(self):
        ticks = iter(range(NOW, NOW + 100, 10))
        a, b = "162.159.192.1:2408", "162.159.192.2:2408"
        lab_ = lab.Lab(self.store, FakeProbeEngine({a: OK, b: OK}), identity_loader=lambda: identity(self.tmp.name),
                       clock=lambda: next(ticks), public_dir=self.public)
        lab_.run([a, b], deep=True)
        ta, tb = self.store.get(a)["last_traffic_ok_at"], self.store.get(b)["last_traffic_ok_at"]
        self.assertLess(ta, tb)  # freshness is never inflated to the end of the batch
        self.assertEqual(self.store.get(a)["expires_at"], ta + lab.ACTIVE_TTL_S)

    def test_state_survives_restart(self):
        eid = "162.159.192.1:2408"
        self.make_lab({eid: OK}).run([eid], deep=True)
        self.store.conn.close()
        self.store = lab.Store(self.db)
        self.assertEqual(self.store.get(eid)["state"], lab.ACTIVE)

    def test_unknown_endpoint_refused(self):
        with self.assertRaises(lab.LabError):
            self.make_lab({}).run(["162.159.192.9:2408"], deep=True)

    def test_negative_control_never_in_snapshot(self):
        with self.store.transaction():
            self.store.upsert_candidate(lab.parse_endpoint("192.0.2.1", 2408), "negative_control", NOW)
        self.make_lab({"192.0.2.1:2408": OK}).run(["192.0.2.1:2408"], deep=True)
        self.assertEqual(self.snapshot()["endpoints"], [])


class SnapshotTests(unittest.TestCase):
    def test_atomic_write_keeps_old_file_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = lab.write_snapshot(tmp, {"schema_version": 1, "old": True})
            with mock.patch.object(lab.os, "replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
                lab.write_snapshot(tmp, {"schema_version": 1, "new": True})
            with open(path, encoding="utf-8") as fh:
                self.assertTrue(json.load(fh)["old"])
            self.assertEqual(os.listdir(tmp), [lab.SNAPSHOT_FILE])  # no temp file left behind

    def test_validate_snapshot_fails_closed(self):
        good = {"schema_version": 1, "generated_at": lab.iso(NOW), "expires_at": lab.iso(NOW + 60), "endpoints": []}
        self.assertEqual(lab.validate_snapshot(good, NOW), [])
        self.assertEqual(lab.validate_snapshot({**good, "expires_at": lab.iso(NOW - 1)}, NOW), [])
        bad_ep = {k: None for k in lab.SNAPSHOT_ENDPOINT_KEYS} | {"private_key": PRIVATE}
        for doc in ({**good, "schema_version": 2}, {**good, "generated_at": lab.iso(NOW + 3600)},
                    {**good, "endpoints": [bad_ep]}, "not json object"):
            with self.subTest(doc=str(doc)[:50]), self.assertRaises((ValueError, KeyError, lab.LabError)):
                lab.validate_snapshot(doc, NOW)

    def test_snapshot_has_no_secret_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = lab.Store(os.path.join(tmp, "lab.db"))
            with store.transaction():
                store.upsert_candidate(lab.parse_endpoint("162.159.192.1", 2408), "consumer_seed", NOW)
                store.record("162.159.192.1:2408", OK, True, NOW, "op")
            snap = lab.build_snapshot(store.all(), "ok", NOW)
            store.conn.close()
        text = json.dumps(snap)
        self.assertIsNone(lab.SECRET_LIKE_RE.search(text))
        self.assertEqual(set(snap["endpoints"][0]), set(lab.SNAPSHOT_ENDPOINT_KEYS))
        for word in ("key", "token", "registration", "address_v4"):
            self.assertNotIn(word, text.replace("schema_version", ""))


class FakeRunner(lab.CommandRunner):
    """Simulates ip/wg/ping/curl. handshake_after: number of latest-handshakes polls before a handshake."""

    def __init__(self, handshake_after=1, curl_exit=0, http_code=200, extra_route=False, fail_on=None):
        self.calls, self.inputs = [], []
        self.handshake_after, self.curl_exit, self.http_code = handshake_after, curl_exit, http_code
        self.extra_route, self.fail_on = extra_route, fail_on
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
        if argv[-3:-1] == ["-o", "link"] or argv[-3:] == ["-o", "link", "show"]:
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
            if self.handshake_after is not None:
                self.tx += 148
                self.rx += 92
            else:
                self.tx += 148
            return lab.CommandResult(1, "", "")
        elif "curl" in argv:
            if self.curl_exit == 0:
                self.tx += 600
                self.rx += 2000
            body = "fl=1\nwarp=on\ncolo=HEL\n" if self.curl_exit == 0 else ""
            tail = f"\n__AEL__ {self.http_code} 0 0.050 0.120" if self.curl_exit == 0 else "\n__AEL__ 000 1 0 0"
            return lab.CommandResult(self.curl_exit, body + tail, "")
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

    def test_deep_verify_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner()
            res = self.engine(runner).deep_verify(self.ep(), identity(tmp))
        self.assertTrue(res.handshake_ok and res.traffic_ok, res)
        self.assertIsNone(res.error_code)
        self.assertEqual(res.evidence["trace_warp"], "on")
        self.assertGreater(res.evidence["rx_after"], res.evidence["rx_before"])
        self.assert_torn_down(runner)
        wg_set = next(c for c in runner.calls if c[:2] == ["wg", "set"])
        self.assertEqual(wg_set[wg_set.index("private-key") + 1], identity(tmp).key_path)
        self.assertIn("162.159.192.1:2408", wg_set)
        curl = next(c for c in runner.calls if "curl" in c and lab.HTTPS_URL in c)
        self.assertNotIn("-k", curl)
        self.assertNotIn("--insecure", curl)
        self.assertEqual(curl[:4], ["ip", "netns", "exec", "ael-abcdef"])

    def test_private_key_never_in_argv_and_dump_never_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner()
            self.engine(runner).deep_verify(self.ep(), identity(tmp))
        flat = " ".join(" ".join(c) for c in runner.calls)
        self.assertNotIn(PRIVATE, flat)
        self.assertNotIn("dump", flat)

    def test_no_handshake(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner(handshake_after=None)
            res = self.engine(runner).deep_verify(self.ep(), identity(tmp))
        self.assertEqual(res.error_code, lab.HANDSHAKE_NO_RESPONSE)
        self.assertFalse(res.lab_failure)
        self.assertFalse(any("curl" in c for c in runner.calls))
        self.assert_torn_down(runner)

    def test_tls_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner(curl_exit=60)
            res = self.engine(runner).deep_verify(self.ep(), identity(tmp))
        self.assertTrue(res.handshake_ok)
        self.assertEqual(res.error_code, lab.HTTPS_TLS_FAILED)
        self.assertFalse(res.traffic_ok)

    def test_http_error_is_traffic_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = self.engine(FakeRunner(http_code=503)).deep_verify(self.ep(), identity(tmp))
        self.assertEqual(res.error_code, lab.TRAFFIC_FAILED)

    def test_bypass_route_rejected_as_lab_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner(extra_route=True)
            res = self.engine(runner).deep_verify(self.ep(), identity(tmp))
        self.assertEqual(res.error_code, lab.ROUTE_SETUP_FAILED)
        self.assertTrue(res.lab_failure)
        self.assert_torn_down(runner)

    def test_setup_failure_is_lab_failure_and_cleans_up(self):
        for fail_on, code in (("netns add", lab.LOCAL_RESOURCE_ERROR), ("wg set", lab.TUNNEL_SETUP_FAILED),
                              ("route add", lab.ROUTE_SETUP_FAILED), ("modprobe", lab.LOCAL_RESOURCE_ERROR)):
            with self.subTest(fail_on=fail_on), tempfile.TemporaryDirectory() as tmp:
                runner = FakeRunner(fail_on=fail_on)
                res = self.engine(runner).deep_verify(self.ep(), identity(tmp))
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
        with tempfile.TemporaryDirectory() as tmp:
            runner = Interrupting()
            with self.assertRaises(KeyboardInterrupt):
                self.engine(runner).deep_verify(self.ep(), identity(tmp))
        self.assert_torn_down(runner)

    def test_handshake_only_probe_skips_https(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = FakeRunner()
            res = self.engine(runner).probe_handshake(self.ep(), identity(tmp))
        self.assertTrue(res.handshake_ok)
        self.assertFalse(res.traffic_ok)
        self.assertFalse(any("curl" in c for c in runner.calls))


class CleanupTests(unittest.TestCase):
    def test_only_lab_names_match(self):
        netns = "ael-abcdef (id: 3)\nael-123456\nael-zzzzzz\nael-abcdef1\nvpn-ns\nawg0\n"
        links = ("1: lo: <LOOPBACK>\n3: awg0: <POINTOPOINT>\n9: aelabcdef: <POINTOPOINT>\n"
                 "10: veth66b5359@if2: <BROADCAST>\n11: aelabcdefg: <X>\n12: docker0: <X>\n")
        ns, ln = lab.find_stale_resources(netns, links)
        self.assertEqual(ns, ["ael-abcdef", "ael-123456"])
        self.assertEqual(ln, ["aelabcdef"])

    def test_cleanup_deletes_only_matches(self):
        class R(FakeRunner):
            def run(self, argv, input_text=None, check=True, timeout=5):
                self.calls.append(argv)
                if argv == ["ip", "netns", "list"]:
                    return lab.CommandResult(0, "ael-abcdef\nother\n", "")
                if argv == ["ip", "-o", "link", "show"]:
                    return lab.CommandResult(0, "3: awg0: <X>\n9: ael0a0b0c: <X>\n", "")
                return lab.CommandResult(0, "", "")
        runner = R()
        removed = lab.cleanup_stale(runner)
        self.assertEqual(removed, {"namespaces": ["ael-abcdef"], "links": ["ael0a0b0c"]})
        deletes = [c for c in runner.calls if "delete" in c]
        self.assertEqual(deletes, [["ip", "netns", "delete", "ael-abcdef"], ["ip", "link", "delete", "dev", "ael0a0b0c"]])


def reg_response():
    return {"result": {"id": "reg-1", "token": "tok-secret", "config": {
        "peers": [{"public_key": PEER, "endpoint": {"host": "engage.cloudflareclient.com:2408", "v4": "162.159.192.1:0"}}],
        "interface": {"addresses": {"v4": "172.16.0.2", "v6": "2606:4700:110:8a36::1"}}}}}


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

    def test_creates_identity_once(self):
        t, calls = self.transport([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        runner = FakeRunner()
        self.assertEqual(lab.register_probe_identity(runner, lab.WarpApi(t), self.dir, self.dir, clock=lambda: NOW), "created")
        self.assertEqual([c[0] for c in calls], ["POST", "PATCH"])
        with open(os.path.join(self.dir, lab.KEY_FILE), encoding="utf-8") as fh:
            self.assertEqual(fh.read().strip(), PRIVATE)
        with open(os.path.join(self.dir, lab.IDENTITY_FILE), encoding="utf-8") as fh:
            meta_text = fh.read()
        self.assertNotIn(PRIVATE, meta_text)
        if os.name == "posix":
            for name in (lab.KEY_FILE, lab.IDENTITY_FILE):
                self.assertEqual(os.stat(os.path.join(self.dir, name)).st_mode & 0o777, 0o600)
        self.assertNotIn(PRIVATE, " ".join(" ".join(c) for c in runner.calls))  # pubkey got it via stdin
        self.assertIn(PRIVATE + "\n", runner.inputs)
        ident = lab.load_identity(self.dir, self.dir)
        self.assertEqual((ident.peer_public_key, ident.address_v4), (PEER, "172.16.0.2"))
        # a second run never registers again
        t2, calls2 = self.transport([])
        self.assertEqual(lab.register_probe_identity(runner, lab.WarpApi(t2), self.dir, self.dir), "exists")
        self.assertEqual(calls2, [])

    def test_api_unavailable_is_bounded_and_writes_nothing(self):
        t, calls = self.transport([(503, b""), OSError("reset")])
        with mock.patch.object(lab.time, "sleep"), self.assertRaises(lab.LabError) as ctx:
            lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir)
        self.assertEqual(len(calls), lab.WARP_API_MAX_ATTEMPTS)
        self.assertEqual(ctx.exception.code, lab.LOCAL_RESOURCE_ERROR)
        self.assertEqual(os.listdir(self.dir), [])

    def test_rate_limit_is_not_retried(self):
        t, calls = self.transport([(429, b"{}")])
        with self.assertRaises(lab.LabError) as ctx:
            lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir)
        self.assertEqual((ctx.exception.code, len(calls)), (lab.RATE_LIMITED, 1))

    def test_invalid_response_writes_nothing(self):
        broken = reg_response()
        broken["result"]["config"]["peers"][0]["public_key"] = "short"
        t, _ = self.transport([(200, json.dumps(broken).encode())])
        with self.assertRaises(lab.LabError):
            lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir)
        self.assertEqual(os.listdir(self.dir), [])

    def test_patch_failure_resumes_without_second_registration(self):
        t, calls = self.transport([(200, json.dumps(reg_response()).encode()), (400, b"{}")])
        with self.assertRaises(lab.LabError):
            lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir)
        with self.assertRaises(lab.LabError) as ctx:
            lab.load_identity(self.dir, self.dir)  # half-enabled identity is never used for probes
        self.assertEqual(ctx.exception.code, lab.PROBE_IDENTITY_INVALID)
        t2, calls2 = self.transport([(200, b"{}")])
        self.assertEqual(lab.register_probe_identity(FakeRunner(), lab.WarpApi(t2), self.dir, self.dir), "enabled")
        self.assertEqual([c[0] for c in calls2], ["PATCH"])
        self.assertEqual(calls2[0][2], "tok-secret")

    def test_orphan_key_refused(self):
        with open(os.path.join(self.dir, lab.KEY_FILE), "w", encoding="utf-8") as fh:
            fh.write(PRIVATE)
        with self.assertRaises(lab.LabError):
            lab.register_probe_identity(FakeRunner(), lab.WarpApi(self.transport([])[0]), self.dir, self.dir)

    @unittest.skipUnless(os.name == "posix", "permission bits are POSIX-only")
    def test_group_readable_key_rejected(self):
        t, _ = self.transport([(200, json.dumps(reg_response()).encode()), (200, b"{}")])
        lab.register_probe_identity(FakeRunner(), lab.WarpApi(t), self.dir, self.dir)
        os.chmod(os.path.join(self.dir, lab.KEY_FILE), 0o640)
        with self.assertRaises(lab.LabError):
            lab.load_identity(self.dir, self.dir)


class SecretHandlingTests(unittest.TestCase):
    def test_redaction(self):
        self.assertNotIn(PRIVATE, lab.redact(f"key={PRIVATE} end"))
        self.assertNotIn(PRIVATE, str(lab.LabError(lab.UNKNOWN, f"wg said {PRIVATE}")))
        res = lab.ProbeResult(False, error_code=lab.TRAFFIC_FAILED, message=f"leak {PRIVATE}")
        self.assertNotIn(PRIVATE, lab.format_result("162.159.192.1:2408", res))

    def test_runner_uses_argv_without_shell(self):
        with mock.patch.object(lab.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="", stderr="")
            lab.CommandRunner().run(["ip", "netns", "list"])
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(run.call_args.args[0], ["ip", "netns", "list"])
        with self.assertRaises(lab.LabError):
            lab.CommandRunner().run("ip netns list")

    def test_runner_errors_are_redacted(self):
        with mock.patch.object(lab.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=1, stdout="", stderr=f"bad key {PRIVATE}")
            with self.assertRaises(lab.LabError) as ctx:
                lab.CommandRunner().run(["wg", "set", "x"])
        self.assertNotIn(PRIVATE, str(ctx.exception))

    def test_db_never_holds_key_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = lab.Store(os.path.join(tmp, "lab.db"))
            with store.transaction():
                store.upsert_candidate(lab.parse_endpoint("162.159.192.1", 2408), "consumer_seed", NOW)
                store.record("162.159.192.1:2408", lab.ProbeResult(False, error_code=lab.TRAFFIC_FAILED,
                                                                   message=PRIVATE), True, NOW, "op")
            dump = "\n".join(store.conn.iterdump())
            store.conn.close()
        self.assertNotIn(PRIVATE, dump)


if __name__ == "__main__":
    unittest.main()
