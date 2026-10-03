"""Unit tests for amnezia_deploy with a fake docker/nginx/registry/HTTP world.

Run: python3 -m unittest discover -s deploy/controller -p 'test_*.py'
"""

import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import amnezia_deploy as ad  # noqa: E402

LEGACY_SHA = "c" * 40
SHA_A = "a" * 40
SHA_B = "b" * 40


def container_info(name, port, sha, digest=None, legacy=False, running=True, health="healthy"):
    labels = {"org.opencontainers.image.revision": sha[:12] if legacy else sha}
    if not legacy:
        labels.update({"amnezia.deploy.sha": sha, "amnezia.deploy.digest": digest})
    return {
        "Name": "/" + name,
        "State": {"Running": running, "Health": {"Status": health}, "StartedAt": "t0"},
        "Config": {"User": "node", "Labels": labels, "Image": f"local:{sha[:12]}"},
        "HostConfig": {
            "ReadonlyRootfs": True, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "Memory": ad.MEMORY_BYTES, "NanoCpus": ad.NANO_CPUS, "PidsLimit": ad.PIDS_LIMIT,
            "LogConfig": {"Type": "json-file", "Config": {"max-size": "10m", "max-file": "3"}},
            "PortBindings": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
            "RestartPolicy": {"Name": "unless-stopped"},
        },
    }


class FakeSystem:
    def __init__(self, paths):
        self.paths = paths
        self.clock = 1_000_000.0
        self.containers = {}
        self.images = {}
        self.pullable = {}
        self.manifests = {}
        self.blobs = {}
        self.served_slot = "blue"
        self.nginx_test_ok = True
        self.nginx_reload_ok = True
        self.unhealthy_digests = set()
        self.broken_paths = {}  # digest -> path answering 500
        self.public_down = False
        self.api_429 = 0  # how many /api/* public answers nginx rate-limits next
        self.logs = []
        self.calls = []

    # time / logging
    def time(self):
        return self.clock

    def sleep(self, seconds):
        self.clock += seconds

    def log(self, record):
        self.logs.append(record)

    # docker
    def docker_inspect(self, name):
        return copy.deepcopy(self.containers.get(name))

    def image_inspect(self, ref):
        return copy.deepcopy(self.images.get(ref))

    def image_refs(self):
        return [r for r in self.images if r.startswith(ad.IMAGE + "@")]

    def run(self, args, timeout=120, check=True):
        self.calls.append(tuple(args))
        if args[:3] == ["docker", "image", "rm"]:
            self.images.pop(args[3], None)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    def docker(self, *args, timeout=300):
        self.calls.append(("docker",) + args)
        cmd = args[0]
        if cmd == "pull":
            if args[1] not in self.pullable:
                raise RuntimeError("pull failed")
            self.images[args[1]] = self.pullable[args[1]]
        elif cmd == "run":
            a = list(args)
            name = a[a.index("--name") + 1]
            port = int(a[a.index("-p") + 1].split(":")[1])
            labels = dict(a[i + 1].split("=", 1) for i, v in enumerate(a) if v == "--label")
            ref = a[-1]
            digest = labels.get("amnezia.deploy.digest")
            health = "unhealthy" if digest in self.unhealthy_digests or ref == ad.DRILL_IMAGE else "healthy"
            info = container_info(name, port, labels["amnezia.deploy.sha"], digest, health=health)
            info["Config"]["Labels"].update(labels)
            self.containers[name] = info
        elif cmd == "start":
            self.containers[args[1]]["State"]["Running"] = True
            self.containers[args[1]]["State"]["StartedAt"] = f"t{self.clock}"
        elif cmd == "stop":
            self.containers[args[1]]["State"]["Running"] = False
        elif cmd == "rm":
            self.containers.pop(args[-1], None)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    def schedule_finalize(self, seconds, op_id):
        self.calls.append(("schedule_finalize", seconds))
        return True

    # nginx
    def nginx_test(self):
        return self.nginx_test_ok, "" if self.nginx_test_ok else "emerg: bad config"

    def nginx_reload(self):
        if not self.nginx_reload_ok:
            return False, "reload failed"
        self.served_slot = ad.upstream_slot(ad.read_text(self.paths.upstream_file))
        return True, ""

    # registry
    def registry_manifest(self, reference):
        return self.manifests.get(reference, (404, {}, b""))

    def registry_blob(self, digest):
        body = self.blobs.get(digest)
        return (200, {}, body) if body is not None else (404, {}, b"")

    # http
    def _by_port(self, port):
        for info in self.containers.values():
            if ad._host_port(info) == port and info["State"]["Running"]:
                return info
        return None

    def _answer(self, info, path):
        if info is None:
            raise ConnectionRefusedError("nothing listens")
        labels = info["Config"]["Labels"]
        digest = labels.get("amnezia.deploy.digest")
        if self.broken_paths.get(digest) == path:
            return 500, {"content-type": "application/json"}, b"{}", 0.01
        headers = {"content-type": "text/html; charset=utf-8" if path == "/" else "application/json; charset=utf-8"}
        if path != "/":
            headers["cache-control"] = "no-store"
        if "amnezia.deploy.sha" in labels:
            headers["x-app-revision"] = labels["amnezia.deploy.sha"]
        return 200, headers, b"<html>" if path == "/" else b'{"status":"unknown"}', 0.02

    def http_get(self, port, path, timeout=10):
        return self._answer(self._by_port(port), path)

    def public_get(self, path, timeout=15):
        if self.public_down:
            raise ConnectionRefusedError("public down")
        if path.startswith("/api/") and self.api_429 > 0:
            self.api_429 -= 1
            return 429, {"content-type": "application/json", "retry-after": "30"}, b"{}", 0.001
        return self._answer(self._by_port(ad.SLOTS[self.served_slot]["port"]), path)

    # helpers
    def publish(self, sha, tags=None, arch="amd64", source=ad.SOURCE_URL, env_rev=None):
        config = json.dumps({
            "architecture": arch, "os": "linux",
            "config": {"User": "node", "Env": [f"APP_REVISION={env_rev or sha}"],
                       "Labels": {"org.opencontainers.image.revision": sha, "org.opencontainers.image.source": source}},
        }).encode()
        config_digest = "sha256:" + hashlib.sha256(config).hexdigest()
        self.blobs[config_digest] = config
        media = "application/vnd.docker.distribution.manifest.v2+json"
        body = json.dumps({"schemaVersion": 2, "mediaType": media,
                           "config": {"mediaType": "x", "digest": config_digest, "size": len(config)}, "layers": []}).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        for tag in tags or [sha, "main"]:
            self.manifests[tag] = (200, {"docker-content-digest": digest, "content-type": media}, body)
        ref = f"{ad.IMAGE}@{digest}"
        self.pullable[ref] = {"Config": {"Labels": {"org.opencontainers.image.revision": sha}}, "RepoDigests": [ref]}
        return digest

    def legacy_starts(self):
        return [c for c in self.calls if c[:2] in (("docker", "start"), ("docker", "stop"), ("docker", "rm")) and ad.LEGACY_NAME in c]


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.paths = ad.Paths(os.path.join(self.dir, "state"), os.path.join(self.dir, "etc"),
                              os.path.join(self.dir, "nginx", "upstream.conf"))
        self.sys = FakeSystem(self.paths)
        self.sys.containers[ad.LEGACY_NAME] = container_info(ad.LEGACY_NAME, 13100, LEGACY_SHA, legacy=True)
        os.makedirs(self.paths.state_dir)
        ad.op_bootstrap(self.sys, self.paths, LEGACY_SHA)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def state(self):
        return ad.read_json(self.paths.state)

    def attempt(self):
        return ad.read_json(self.paths.attempt)


class DiscoveryTests(Base):
    def test_main_resolves_to_sha_and_digest(self):
        digest = self.sys.publish(SHA_A)
        cand = ad.discover(self.sys)
        self.assertEqual((cand.sha, cand.digest), (SHA_A, digest))
        self.assertEqual(cand.ref, f"{ad.IMAGE}@{digest}")

    def test_sha_tag_must_resolve_to_the_same_digest(self):
        self.sys.publish(SHA_A)
        self.sys.publish(SHA_B, tags=[SHA_B])
        self.sys.manifests[SHA_A] = self.sys.manifests[SHA_B]  # :<A> now points elsewhere
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys)
        self.assertEqual(ctx.exception.category, "tag_mismatch")

    def test_wrong_sha_rejected(self):
        self.sys.publish(SHA_A)
        for bad in ("abc", "A" * 40, SHA_A + "0"):
            with self.assertRaises(ad.DeployError):
                ad.discover(self.sys, bad)
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys, SHA_B)  # tag does not exist
        self.assertEqual(ctx.exception.category, "not_found")
        self.sys.manifests[SHA_B] = self.sys.manifests[SHA_A]  # :<B> holds revision A
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys, SHA_B)
        self.assertEqual(ctx.exception.category, "metadata_mismatch")

    def test_wrong_digest_rejected(self):
        self.sys.publish(SHA_A)
        status, headers, body = self.sys.manifests["main"]
        self.sys.manifests["main"] = (status, {**headers, "docker-content-digest": "sha256:" + "0" * 64}, body)
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys)
        self.assertEqual(ctx.exception.category, "digest_mismatch")

    def test_tampered_config_blob_rejected(self):
        self.sys.publish(SHA_A)
        cfg = json.loads(self.sys.manifests["main"][2])["config"]["digest"]
        self.sys.blobs[cfg] = self.sys.blobs[cfg] + b" "
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys)
        self.assertEqual(ctx.exception.category, "config_mismatch")

    def test_metadata_checks(self):
        for kwargs, needle in ((dict(arch="arm64"), "platform"), (dict(source="https://evil"), "source"),
                               (dict(env_rev=SHA_B), "APP_REVISION")):
            self.sys.manifests.clear()
            self.sys.publish(SHA_A, **kwargs)
            with self.assertRaises(ad.DeployError) as ctx:
                ad.discover(self.sys)
            self.assertIn(needle, str(ctx.exception))

    def test_index_manifest_rejected(self):
        self.sys.manifests["main"] = (200, {}, json.dumps({"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": []}).encode())
        with self.assertRaises(ad.DeployError) as ctx:
            ad.discover(self.sys)
        self.assertEqual(ctx.exception.category, "unsupported_manifest")

    def test_repeated_check_is_idempotent(self):
        self.sys.publish(SHA_A)
        before = (self.state(), dict(self.sys.containers))
        for _ in range(2):
            self.assertEqual(ad.op_check(self.sys, self.paths), 0)
        self.assertEqual(before, (self.state(), dict(self.sys.containers)))


class CandidateTests(Base):
    def test_run_args_are_loopback_and_hardened(self):
        args = ad.run_args("green", ad.Candidate(SHA_A, "sha256:" + "1" * 64, None))
        self.assertIn("127.0.0.1:13101:3000", args)
        self.assertFalse(any(a.startswith("0.0.0.0") or a == "13101:3000" for a in args))
        for flag in ("--read-only", "--cap-drop", "--security-opt", "--memory", "--cpus", "--pids-limit"):
            self.assertIn(flag, args)
        self.assertEqual(args[-1], f"{ad.IMAGE}@sha256:{'1' * 64}")

    def test_constraints_detect_regressions(self):
        good = container_info("x", 13101, SHA_A, "d")
        self.assertEqual(ad.constraint_problems(good, "green"), [])
        bad = copy.deepcopy(good)
        bad["HostConfig"]["PortBindings"]["3000/tcp"][0]["HostIp"] = "0.0.0.0"
        bad["HostConfig"]["ReadonlyRootfs"] = False
        problems = ad.constraint_problems(bad, "green")
        self.assertTrue(any("127.0.0.1" in p for p in problems))
        self.assertTrue(any("writable" in p for p in problems))

    def test_legacy_container_matches_production_constraints(self):
        self.assertEqual(ad.constraint_problems(self.sys.containers[ad.LEGACY_NAME], "blue"), [])

    def test_candidate_runs_healthy_smokes_and_is_removed_without_touching_production(self):
        self.sys.publish(SHA_A)
        legacy_before = copy.deepcopy(self.sys.containers[ad.LEGACY_NAME])
        self.assertEqual(ad.op_candidate(self.sys, self.paths), 0)
        self.assertEqual(self.attempt()["result"], "success")
        self.assertNotIn("amnezia-web-green", self.sys.containers)
        self.assertEqual(self.sys.containers[ad.LEGACY_NAME], legacy_before)
        self.assertEqual(self.sys.legacy_starts(), [])
        self.assertEqual(self.sys.served_slot, "blue")
        self.assertEqual(self.state()["active_slot"], "blue")

    def test_drill_broken_candidate_fails_before_any_switch(self):
        self.sys.images[ad.DRILL_IMAGE] = {"Config": {"Labels": {}}}
        upstream_before = ad.read_text(self.paths.upstream_file)
        state_before = self.state()
        self.assertEqual(ad.op_drill(self.sys, self.paths), 1)
        attempt = self.attempt()
        self.assertEqual((attempt["result"], attempt["stage"]), ("failed", "WAIT_HEALTH"))
        self.assertEqual(ad.read_json(self.paths.event)["stage"], "WAIT_HEALTH")
        self.assertEqual(ad.read_text(self.paths.upstream_file), upstream_before)
        self.assertEqual(self.state(), state_before)
        self.assertEqual(self.sys.served_slot, "blue")
        self.assertEqual(self.sys.public_get("/")[0], 200)


class DeployTests(Base):
    def deploy(self, sha=None, **kw):
        return ad.op_deploy(self.sys, self.paths, sha=sha, **kw)

    def test_full_deploy_switches_and_proves_the_target(self):
        digest = self.sys.publish(SHA_A)
        self.assertEqual(self.deploy(), 0)
        st = self.state()
        self.assertEqual((st["active_slot"], st["source_sha"], st["image_digest"]), ("green", SHA_A, digest))
        self.assertEqual((st["previous_slot"], st["previous_source_sha"], st["previous_bootstrap"]), ("blue", LEGACY_SHA, True))
        self.assertEqual(self.sys.served_slot, "green")
        self.assertEqual(self.sys.public_get("/api/status")[1]["x-app-revision"], SHA_A)
        self.assertTrue(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"], "old slot kept during grace")
        self.assertEqual(ad.read_json(self.paths.event)["result"], "success")
        stages = [r["stage"] for r in self.sys.logs if r.get("operation_id")]
        for stage in ("DISCOVER", "PULL", "VERIFY", "PREPARE_SLOT", "START_CANDIDATE", "WAIT_HEALTH", "CANDIDATE_SMOKE",
                      "SWITCH_PREPARE", "NGINX_TEST", "NGINX_RELOAD", "PUBLIC_SMOKE", "COMMIT_STATE", "GRACE", "SUCCESS"):
            self.assertIn(stage, stages)

    def test_noop_when_digest_already_active(self):
        self.sys.publish(SHA_A)
        self.deploy()
        st = self.state()
        calls = len(self.sys.calls)
        self.assertEqual(self.deploy(), 0)
        self.assertEqual(self.state()["deployed_at"], st["deployed_at"])
        self.assertFalse([c for c in self.sys.calls[calls:] if c[:2] in (("docker", "run"), ("docker", "rm"))])

    def test_unhealthy_candidate_never_switches(self):
        digest = self.sys.publish(SHA_A)
        self.sys.unhealthy_digests.add(digest)
        state_before = self.state()
        self.assertEqual(self.deploy(), 1)
        self.assertEqual(self.attempt()["stage"], "WAIT_HEALTH")
        self.assertEqual(self.state(), state_before)
        self.assertEqual(self.sys.served_slot, "blue")

    def test_candidate_smoke_failure_never_switches(self):
        digest = self.sys.publish(SHA_A)
        self.sys.broken_paths[digest] = "/api/healthcheck"
        self.assertEqual(self.deploy(), 1)
        self.assertEqual(self.attempt()["stage"], "CANDIDATE_SMOKE")
        self.assertEqual(self.sys.served_slot, "blue")

    def test_nginx_test_failure_restores_the_upstream_file(self):
        self.sys.publish(SHA_A)
        before = ad.read_text(self.paths.upstream_file)
        self.sys.nginx_test_ok = False
        self.assertEqual(self.deploy(), 1)
        self.assertEqual(self.attempt()["stage"], "NGINX_TEST")
        self.assertEqual(ad.read_text(self.paths.upstream_file), before)
        self.assertEqual(self.sys.served_slot, "blue")

    def test_reload_failure_restores_and_keeps_production(self):
        self.sys.publish(SHA_A)
        before = ad.read_text(self.paths.upstream_file)
        self.sys.nginx_reload_ok = False
        self.assertEqual(self.deploy(), 1)
        self.assertEqual(self.attempt()["stage"], "NGINX_RELOAD")
        self.assertEqual(ad.read_text(self.paths.upstream_file), before)
        self.assertEqual(self.state()["active_slot"], "blue")

    def test_public_smoke_failure_switches_back_automatically(self):
        self.sys.publish(SHA_A)
        real_public = self.sys.public_get

        def wrong_release(path, timeout=15):
            status, headers, body, t = real_public(path)
            if self.sys.served_slot == "green":
                headers = {**headers, "x-app-revision": SHA_B}
            return status, headers, body, t
        self.sys.public_get = wrong_release
        self.assertEqual(self.deploy(), 1)
        self.assertEqual(self.attempt()["stage"], "PUBLIC_SMOKE")
        self.assertEqual(self.sys.served_slot, "blue")
        self.assertEqual(ad.upstream_slot(ad.read_text(self.paths.upstream_file)), "blue")
        self.assertEqual(self.state()["active_slot"], "blue")

    def test_rollback_to_bootstrap_then_redeploy(self):
        digest = self.sys.publish(SHA_A)
        self.deploy()
        self.assertEqual(ad.op_rollback(self.sys, self.paths), 0)
        st = self.state()
        self.assertEqual((st["active_slot"], st["source_sha"], st["bootstrap"]), ("blue", LEGACY_SHA, True))
        self.assertEqual((st["previous_slot"], st["previous_image_digest"]), ("green", digest))
        self.assertEqual(self.sys.served_slot, "blue")
        self.assertNotIn("x-app-revision", self.sys.public_get("/")[1])
        self.assertEqual(self.deploy(), 0)
        self.assertEqual((self.state()["active_slot"], self.sys.served_slot), ("green", "green"))

    def test_rollback_after_grace_restarts_the_stopped_previous_slot(self):
        self.sys.publish(SHA_A)
        self.deploy()
        self.sys.clock += ad.GRACE_S + 1
        ad.op_finalize(self.sys, self.paths)
        self.assertFalse(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.assertEqual(ad.op_rollback(self.sys, self.paths), 0)
        self.assertTrue(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.assertEqual(self.sys.served_slot, "blue")

    def test_finalize_waits_for_grace(self):
        self.sys.publish(SHA_A)
        self.deploy()
        ad.op_finalize(self.sys, self.paths)
        self.assertTrue(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.sys.clock += ad.GRACE_S + 1
        ad.op_finalize(self.sys, self.paths)
        self.assertFalse(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.assertIsNone(self.state()["pending_stop"])

    def test_third_deploy_replaces_the_bootstrap_container_in_blue(self):
        self.sys.publish(SHA_A)
        self.deploy()
        self.sys.clock += ad.GRACE_S + 1
        self.sys.publish(SHA_B)
        self.assertEqual(self.deploy(), 0)
        self.assertEqual((self.state()["active_slot"], self.sys.served_slot), ("blue", "blue"))
        self.assertIn("amnezia-web-blue", self.sys.containers)
        self.assertNotIn(ad.LEGACY_NAME, self.sys.containers)

    def test_pause(self):
        self.sys.publish(SHA_A)
        ad.main(["pause", "maintenance"], self.sys, self.paths) if hasattr(ad, "fcntl") and ad.fcntl else ad.write_json(self.paths.paused, {})
        self.assertEqual(self.deploy(), 0)
        self.assertEqual(self.state()["active_slot"], "blue")
        self.assertEqual(self.deploy(automatic=True, force=True), 0)
        self.assertEqual(self.state()["active_slot"], "blue", "the timer never overrides a pause")
        self.assertEqual(self.deploy(force=True), 0)
        self.assertEqual(self.state()["active_slot"], "green")


class RateLimitTests(Base):
    def test_transient_429_after_switch_is_waited_out(self):
        self.sys.publish(SHA_A)
        self.sys.api_429 = 3
        self.assertEqual(ad.op_deploy(self.sys, self.paths), 0)
        self.assertEqual((self.state()["active_slot"], self.sys.served_slot), ("green", "green"))

    def test_persistent_429_cannot_prove_the_release_so_traffic_goes_back(self):
        self.sys.publish(SHA_A)
        self.sys.api_429 = 10**6
        self.assertEqual(ad.op_deploy(self.sys, self.paths), 1)
        self.assertEqual(self.attempt()["stage"], "PUBLIC_SMOKE")
        self.assertEqual(self.sys.served_slot, "blue")
        self.assertEqual(ad.upstream_slot(ad.read_text(self.paths.upstream_file)), "blue")
        self.assertEqual(self.state()["active_slot"], "blue")

    def test_reconcile_reads_the_revision_from_an_unlimited_path(self):
        self.sys.api_429 = 10**6
        self.assertEqual(ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))["serving_slot"], "blue")


class MonitoringContractTests(Base):
    def test_active_revision_file_follows_the_served_release(self):
        self.assertEqual(ad.read_text(self.paths.active_revision).strip(), LEGACY_SHA)
        self.sys.publish(SHA_A)
        ad.op_deploy(self.sys, self.paths)
        self.assertEqual(ad.read_text(self.paths.active_revision).strip(), SHA_A)
        ad.op_rollback(self.sys, self.paths)
        self.assertEqual(ad.read_text(self.paths.active_revision).strip(), LEGACY_SHA)

    def test_keep_old_slot_flag_keeps_the_previous_container_running(self):
        self.sys.publish(SHA_A)
        ad.op_deploy(self.sys, self.paths)
        os.makedirs(self.paths.conf_dir, exist_ok=True)
        open(self.paths.keep_old, "w").close()
        self.sys.clock += ad.GRACE_S + 1
        ad.op_finalize(self.sys, self.paths)
        self.assertTrue(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.assertIsNone(self.state()["pending_stop"])

    def test_event_contract_has_no_secrets_and_required_fields(self):
        self.sys.publish(SHA_A)
        ad.op_deploy(self.sys, self.paths)
        event = ad.read_json(self.paths.event)
        for key in ("type", "result", "stage", "source_sha", "previous_sha", "digest", "duration_s", "timestamp"):
            self.assertIn(key, event)
        self.assertEqual((event["source_sha"], event["previous_sha"]), (SHA_A, LEGACY_SHA))
        self.assertNotRegex(json.dumps(event).lower(), "token|password|secret|private")


class StateAndRecoveryTests(Base):
    def test_corrupted_state_needs_reconciliation(self):
        with open(self.paths.state, "w") as fh:
            fh.write("{not json")
        self.sys.publish(SHA_A)
        self.assertEqual(ad.op_deploy(self.sys, self.paths), 2)
        self.assertEqual(self.attempt()["result"], "needs_reconciliation")
        ad.write_json(self.paths.state, {"schema_version": 1, "active_slot": "purple"})
        with self.assertRaises(ad.NeedsReconciliation):
            ad.load_state(self.paths)

    def test_crash_after_upstream_write_before_reload_is_repaired_without_traffic_change(self):
        ad.write_atomic(self.paths.upstream_file, ad.upstream_text("green", SHA_A, None, "t"))
        evidence = ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))
        self.assertEqual(evidence["serving_slot"], "blue")
        self.assertEqual(ad.upstream_slot(ad.read_text(self.paths.upstream_file)), "blue")
        self.assertEqual(self.sys.served_slot, "blue")

    def test_crash_after_reload_before_state_commit_adopts_reality(self):
        digest = self.sys.publish(SHA_A)
        self.sys.docker(*ad.run_args("green", ad.Candidate(SHA_A, digest, None)))
        ad.write_atomic(self.paths.upstream_file, ad.upstream_text("green", SHA_A, digest, "t"))
        self.sys.nginx_reload()
        evidence = ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))
        st = self.state()
        self.assertEqual((evidence["serving_slot"], st["active_slot"], st["image_digest"]), ("green", "green", digest))
        self.assertEqual(st["previous_source_sha"], LEGACY_SHA)

    def test_unexplained_public_revision_is_not_guessed(self):
        real_public = self.sys.public_get
        self.sys.public_get = lambda path, timeout=15: (200, {**real_public(path)[1], "x-app-revision": SHA_B}, b"{}", 0.0)
        with self.assertRaises(ad.NeedsReconciliation):
            ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))

    def test_public_endpoint_down_needs_reconciliation(self):
        self.sys.public_down = True
        with self.assertRaises(ad.NeedsReconciliation):
            ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))

    def test_after_reboot_a_stopped_active_container_is_started(self):
        self.sys.containers[ad.LEGACY_NAME]["State"]["Running"] = False
        evidence = ad.reconcile(self.sys, self.paths, ad.load_state(self.paths))
        self.assertTrue(self.sys.containers[ad.LEGACY_NAME]["State"]["Running"])
        self.assertEqual(evidence["serving_slot"], "blue")

    def test_atomic_json_write_leaves_no_temp_files(self):
        ad.write_json(self.paths.state, self.state())
        self.assertEqual([f for f in os.listdir(self.paths.state_dir) if f.endswith(".tmp")], [])


@unittest.skipUnless(ad.fcntl, "flock needs Linux")
class LockTests(Base):
    def test_second_invocation_is_a_noop_while_locked(self):
        self.sys.publish(SHA_A)
        with open(self.paths.lock, "a+") as held:
            ad.fcntl.flock(held, ad.fcntl.LOCK_EX | ad.fcntl.LOCK_NB)
            self.assertEqual(ad.main(["deploy"], self.sys, self.paths), 0)
        self.assertEqual(self.state()["active_slot"], "blue")

    def test_stale_lock_file_does_not_block(self):
        self.sys.publish(SHA_A)
        with open(self.paths.lock, "w") as fh:
            fh.write("12345")  # left behind by a killed process; flock died with it
        self.assertEqual(ad.main(["deploy"], self.sys, self.paths), 0)
        self.assertEqual(self.state()["active_slot"], "green")


if __name__ == "__main__":
    unittest.main()
