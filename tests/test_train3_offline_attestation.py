"""Small synthetic declarations and byte files; no executable toolchain or network."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("attestation", ROOT / "tools/train3_offline_attestation.py")
subject = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(subject)
CORE = ["ecmwf", "gfs", "hrrr", "aifs"]
REGIONAL = ["icon", "hrdps", "arome-antilles", "hrrr-ak", "nam", "nam-hi", "nam-ak"]
MODELS = [("core", m) for m in CORE] + [("regional", m) for m in REGIONAL]
STAGES = ["admission", "collectors", "assembly", "catalogRebase", "freshnessSuperset",
          "regionalValidation", "pointValidation", "completion", "retention"]


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


class AttestationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wx-train3-attestation-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.bundle = self.root / "toolchain"
        self.bundle.mkdir()
        self.now = int(time.time())
        self.context = {"atmosCommit": "69ea56d9e5f0179cea21d483625022da41e9a5a5",
                        "atmosTree": "2c5e8455ad6ec975159766e06510e8e192a7d92c", "runId": "1234", "attempt": 2}
        common = {"schemaVersion": 1, "context": self.context, "issuedAt": self.now - 100, "expiresAt": self.now + 100}
        files = [{"path": f"components/{m}/manifest.json", "size": 3, "sha256": sha(m.encode())}
                 for m in CORE + ["point-" + m for m in CORE]]
        files += [{"path": "catalog-pointer.json", "size": 3, "sha256": sha(b"pointer")},
                  {"path": "catalog-snapshot.json", "size": 3, "sha256": sha(b"snapshot")}]
        self.seal = raw({"schemaVersion": 1, "kind": "weatherx-validation-catalog-baseline-v1",
                         "files": sorted(files, key=lambda r: r["path"])})
        self.baseline = {**common, "kind": "weatherx-train3-baseline-attestation-v1", "issuerId": "synthetic-authority",
            "catalog": {"id": "synthetic-catalog", "pointerSha256": sha(b"pointer"), "snapshotSha256": sha(b"snapshot")},
            "coreSealSha256": sha(self.seal), "regional": [{"model": m, "manifestSha256": sha(m.encode()),
                "pointManifestSha256": sha(("point-" + m).encode())} for m in REGIONAL],
            "policy": {"freshnessValidated": True, "supersetValidated": True, "nonregressionValidated": True}}
        definitions = {"bin/bash": ("executable", b"inert shell"), "bin/python3.12": ("executable", b"inert python"),
            "bin/python3": ("executable", b"inert python"), "bin/node22": ("executable", b"inert node"),
            "bin/node": ("executable", b"inert node"), "bake-venv/bin/python": ("executable", b"inert venv"),
            "lib/stdlib.txt": ("stdlib", b"synthetic stdlib"), "lib/dependency.txt": ("dependency", b"synthetic dependency"),
            "lib/native.txt": ("library", b"synthetic native"), "bin/utility.txt": ("utility", b"synthetic utility")}
        rows = []
        for path, (role, payload) in sorted(definitions.items()):
            file = self.bundle / path; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(payload)
            rows.append({"path": path, "bytes": len(payload), "sha256": sha(payload), "role": role})
        self.toolchain = {**common, "kind": "weatherx-train3-toolchain-attestation-v1", "runner": {
            "platform": "linux", "architecture": "amd64", "imageSha256": sha(b"image"), "networkPolicySha256": sha(b"network"),
            "diskPolicySha256": sha(b"disk"), "outputPolicySha256": sha(b"output")},
            "entrypoints": {"shell": "bin/bash", "python": "bin/python3.12", "node": "bin/node22", "bakePython": "bake-venv/bin/python"},
            "aliases": {"bin/bash": "bin/bash", "bin/python3": "bin/python3.12", "bin/node": "bin/node22"},
            "bakeVenvMount": {"source": "/validation/toolchain/bake-venv", "destination": "/validation/source/atmos/data/.venv", "readOnly": True},
            "files": rows}
        self.proofs = {"initialWorkspaceSha256": raw({"synthetic": "initial workspace"}),
                       "collectorProofSha256": raw({"synthetic": "eleven collector declarations"}),
                       "retentionPolicySha256": raw({"synthetic": "retention declarations"})}
        self.proof_shas = {k: sha(v) for k, v in self.proofs.items()}
        stages = {name: {"status": "completed", "startedAt": self.now - 80 + i * 3,
                         "completedAt": self.now - 79 + i * 3} for i, name in enumerate(STAGES)}
        self.completion = {**common, "kind": "weatherx-train3-completion-attestation-v1", "issuedAt": self.now - 10,
            "run": {"startedAt": self.now - 90, "completedAt": self.now - 40}, "exitCode": 0,
            "bindings": {"baselineAuthoritySha256": sha(raw(self.baseline)), "coreSealSha256": sha(self.seal),
                         "toolchainSha256": sha(raw(self.toolchain)), **self.proof_shas}, "stageStates": stages,
            "models": [{"kind": k, "model": m, "status": "validated", "completedAt": self.now - 60,
                        "mapReceiptSha256": sha((m + "map").encode()), "pointReceiptSha256": sha((m + "point").encode()),
                        "scientificGateSha256": sha((m + "gate").encode())} for k, m in MODELS],
            "retention": {"baselineIdentityRecorded": True, "privateSnapshotRemoved": True,
                          "diagnosticsRedacted": True, "expiresAt": self.now + 100}}

    def baseline_check(self, changed=None, pin=None, seal=None):
        payload = raw(self.baseline if changed is None else changed)
        return subject.baseline_binding(payload, sha(payload) if pin is None else pin, self.context,
                                        self.seal if seal is None else seal, self.now)

    def toolchain_check(self, changed=None, root=None):
        payload = raw(self.toolchain if changed is None else changed)
        return subject.toolchain_binding(payload, sha(payload), self.context, self.bundle if root is None else root, self.now)

    def completion_check(self, changed=None, observed=None, proofs=None, proof_shas=None):
        payload = raw(self.completion if changed is None else changed)
        return subject.completion_binding(payload, sha(payload), payload if observed is None else raw(observed), self.context,
            sha(raw(self.baseline)), sha(self.seal), sha(raw(self.toolchain)), self.proofs if proofs is None else proofs,
            self.proof_shas if proof_shas is None else proof_shas, [self.baseline["issuedAt"], self.toolchain["issuedAt"]], self.now)

    def test_valid_synthetic_declarations_never_grant_authority_or_qualification(self):
        self.baseline_check(); self.toolchain_check()
        verdict = self.completion_check()
        self.assertIs(verdict["structuralBindingValid"], True)
        for name in ("executionAuthorized", "publicationAuthorized", "liveCollectorQualified", "joinedBakeQualified"):
            self.assertIs(verdict[name], False)

    def test_baseline_pin_binds_exact_bytes_not_reencoded_equivalent_json(self):
        with self.assertRaisesRegex(subject.Refusal, "content-mismatch"):
            self.baseline_check(pin=sha(raw(self.baseline) + b" "))

    def test_baseline_links_actual_core_seal_and_catalog_digests(self):
        for mode in ("seal", "catalog", "core-roster"):
            doc = copy.deepcopy(self.baseline)
            seal = self.seal
            if mode == "seal": seal += b" "
            if mode == "catalog": doc["catalog"]["pointerSha256"] = "a" * 64
            if mode == "core-roster":
                parsed = json.loads(seal); parsed["files"] = parsed["files"][:-1]; seal = raw(parsed); doc["coreSealSha256"] = sha(seal)
            with self.subTest(mode=mode), self.assertRaises(subject.Refusal): self.baseline_check(doc, seal=seal)

    def test_missing_duplicate_or_wrong_regional_baseline_refuses(self):
        for rows in (self.baseline["regional"][:-1], [self.baseline["regional"][0]] * 7,
                     list(reversed(self.baseline["regional"]))):
            doc = copy.deepcopy(self.baseline); doc["regional"] = rows
            with self.assertRaises(subject.Refusal): self.baseline_check(doc)

    def test_baseline_policy_requires_literal_true(self):
        for name in self.baseline["policy"]:
            for value in (False, 1, "true"):
                doc = copy.deepcopy(self.baseline); doc["policy"][name] = value
                with self.subTest(name=name, value=value), self.assertRaises(subject.Refusal): self.baseline_check(doc)

    def test_source_tree_run_attempt_and_time_mismatches_refuse(self):
        for key, value in (("atmosCommit", "a"*40), ("atmosTree", "b"*40), ("runId", "456"), ("attempt", 1), ("attempt", True)):
            doc = copy.deepcopy(self.baseline); doc["context"][key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal): self.baseline_check(doc)
        for key, value in (("issuedAt", self.now+1), ("expiresAt", self.now), ("schemaVersion", True)):
            doc = copy.deepcopy(self.baseline); doc[key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal): self.baseline_check(doc)

    def test_unresolved_or_malformed_external_pin_refuses(self):
        for pin in (None, "", "a"*40, "A"*64):
            with self.subTest(pin=pin), self.assertRaises(subject.Refusal): self.baseline_check(pin=pin or "")

    def test_duplicate_nonfinite_float_oversized_and_unknown_metadata_refuse(self):
        for payload in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1e999}', b'{"a":1.0}', b" "*(subject.MAX_JSON+1)):
            with self.assertRaises(subject.Refusal): subject.parse(payload)
        doc = copy.deepcopy(self.baseline); doc["credentials"] = {"token": "secret-not-for-output"}
        with self.assertRaises(subject.Refusal): self.baseline_check(doc)

    def test_every_toolchain_role_is_required_but_claims_are_not_runtime_proof(self):
        for role in ("stdlib", "dependency", "library", "utility"):
            doc = copy.deepcopy(self.toolchain); doc["files"] = [r for r in doc["files"] if r["role"] != role]
            with self.subTest(role=role), self.assertRaises(subject.Refusal): self.toolchain_check(doc)

    def test_wrong_runner_entrypoint_alias_and_venv_mapping_refuse(self):
        for field, key, value in (("runner", "platform", "darwin"), ("runner", "imageSha256", None),
                                 ("entrypoints", "python", "bin/python3"), ("aliases", "bin/node", "bin/bash"),
                                 ("bakeVenvMount", "destination", "/tmp/data/.venv"), ("bakeVenvMount", "readOnly", 1)):
            doc = copy.deepcopy(self.toolchain); doc[field][key] = value
            with self.subTest(field=field, key=key), self.assertRaises(subject.Refusal): self.toolchain_check(doc)

    def test_alias_copy_must_match_canonical_binary_content(self):
        doc = copy.deepcopy(self.toolchain)
        for row in doc["files"]:
            if row["path"] == "bin/node": row["sha256"] = "a"*64
        with self.assertRaisesRegex(subject.Refusal, "alias-content"): self.toolchain_check(doc)

    def test_toolchain_file_bytes_mutation_refuses(self):
        (self.bundle/"lib/native.txt").write_bytes(b"mutated native bytes")
        with self.assertRaises(subject.Refusal): self.toolchain_check()

    def test_empty_dependency_files_are_valid_but_empty_entrypoints_refuse(self):
        doc = copy.deepcopy(self.toolchain)
        file = self.bundle/"lib/dependency.txt"; file.write_bytes(b"")
        for row in doc["files"]:
            if row["path"] == "lib/dependency.txt": row.update(bytes=0, sha256=sha(b""))
        self.toolchain_check(doc)
        for row in doc["files"]:
            if row["path"] == "bin/bash": row.update(bytes=0, sha256=sha(b""))
        (self.bundle/"bin/bash").write_bytes(b"")
        with self.assertRaisesRegex(subject.Refusal, "entrypoint-inventory"): self.toolchain_check(doc)

    def test_extra_missing_empty_directory_and_links_refuse(self):
        file = self.bundle/"lib/native.txt"; saved = file.read_bytes()
        file.unlink()
        with self.assertRaises(subject.Refusal): self.toolchain_check()
        outside = self.root/"outside"; outside.write_bytes(saved); file.symlink_to(outside)
        with self.assertRaises((subject.Refusal, OSError)): self.toolchain_check()
        file.unlink(); file.hardlink_to(outside)
        with self.assertRaises(subject.Refusal): self.toolchain_check()
        file.unlink(); file.write_bytes(saved)
        extra = self.bundle/"extra"; extra.mkdir()
        with self.assertRaises(subject.Refusal): self.toolchain_check()
        extra.rmdir(); extra.write_bytes(b"extra")
        with self.assertRaises(subject.Refusal): self.toolchain_check()

    def test_alias_directory_ancestor_and_noncanonical_root_refuse(self):
        alias = self.root/"alias"; alias.symlink_to(self.bundle, target_is_directory=True)
        for root in (alias, str(self.bundle)+"/.", str(self.bundle)+"//", "relative"):
            with self.subTest(root=root), self.assertRaises((subject.Refusal, OSError)): self.toolchain_check(root=root)

    def test_unsafe_duplicate_sorted_collision_and_declared_bounds_refuse(self):
        for path in ("../escape", "/absolute", "bin//node", "bin/./node", "bin\\node", "bin/\nnode"):
            doc = copy.deepcopy(self.toolchain); doc["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(subject.Refusal): self.toolchain_check(doc)
        for change in ("duplicate", "reverse", "size", "bool", "collision"):
            doc = copy.deepcopy(self.toolchain)
            if change == "duplicate": doc["files"].insert(0, doc["files"][0])
            if change == "reverse": doc["files"].reverse()
            if change == "size": doc["files"][0]["bytes"] = subject.MAX_FILE+1
            if change == "bool": doc["files"][0]["bytes"] = True
            if change == "collision": doc["files"].append({"path": "lib", "bytes": 1, "sha256": sha(b"x"), "role": "library"}); doc["files"].sort(key=lambda r:r["path"])
            with self.subTest(change=change), self.assertRaises(subject.Refusal): self.toolchain_check(doc)

    def test_file_changed_after_hash_is_detected_by_final_inventory(self):
        original = subject.read_leaf
        def reading(fd, path, limit, row=None):
            result = original(fd, path, limit, row)
            if path == "bin/bash": (self.bundle/path).write_bytes(b"later bytes")
            return result
        with mock.patch.object(subject, "read_leaf", side_effect=reading):
            with self.assertRaisesRegex(subject.Refusal, "changed-during-binding"): self.toolchain_check()

    def test_completion_exit_zero_cannot_replace_every_completed_stage(self):
        for name in STAGES:
            for status in ("skipped", "carried", "absent", "optional", "failed"):
                doc = copy.deepcopy(self.completion); doc["stageStates"][name]["status"] = status
                with self.subTest(name=name, status=status), self.assertRaises(subject.Refusal): self.completion_check(doc)
        doc = copy.deepcopy(self.completion); del doc["stageStates"]["pointValidation"]
        with self.assertRaises(subject.Refusal): self.completion_check(doc)

    def test_missing_duplicate_optional_carried_model_and_companion_refuse(self):
        for mode in ("missing", "duplicate", "carried", "point", "borrowed"):
            doc = copy.deepcopy(self.completion)
            if mode == "missing": doc["models"].pop()
            if mode == "duplicate": doc["models"][-1] = doc["models"][0]
            if mode == "carried": doc["models"][0]["status"] = "carried"
            if mode == "point": del doc["models"][0]["pointReceiptSha256"]
            if mode == "borrowed": doc["models"][1]["mapReceiptSha256"] = doc["models"][0]["mapReceiptSha256"]
            with self.subTest(mode=mode), self.assertRaises(subject.Refusal): self.completion_check(doc)

    def test_changed_authority_workspace_collector_or_retention_proof_refuses(self):
        for field in self.completion["bindings"]:
            doc = copy.deepcopy(self.completion); doc["bindings"][field] = "a"*64
            with self.subTest(field=field), self.assertRaises(subject.Refusal): self.completion_check(doc)
        for name in self.proofs:
            proofs = dict(self.proofs); proofs[name] += b" "
            with self.subTest(name=name), self.assertRaises(subject.Refusal): self.completion_check(proofs=proofs)

    def test_forged_observation_is_distinct_from_independently_pinned_completion(self):
        observed = copy.deepcopy(self.completion); observed["models"][0]["mapReceiptSha256"] = "b"*64
        with self.assertRaisesRegex(subject.Refusal, "independent-completion"): self.completion_check(observed=observed)

    def test_observation_boolean_number_ambiguity_refuses(self):
        for field, value in (("exitCode", False), ("schemaVersion", True)):
            observed = copy.deepcopy(self.completion); observed[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(subject.Refusal, "independent-completion"):
                self.completion_check(observed=observed)

    def test_closure_count_total_depth_and_special_file_bounds_refuse(self):
        for field, value in (("MAX_FILES", 1), ("MAX_TOTAL", 1), ("MAX_FILE", 1)):
            with self.subTest(field=field), mock.patch.object(subject, field, value):
                with self.assertRaises(subject.Refusal): self.toolchain_check()
        doc = copy.deepcopy(self.toolchain); doc["files"][0]["path"] = "/".join(["x"]*33)
        with self.assertRaises(subject.Refusal): self.toolchain_check(doc)
        file = self.bundle/"lib/native.txt"; file.unlink(); os.mkfifo(file)
        with self.assertRaises(subject.Refusal): self.toolchain_check()

    def test_read_local_rejects_symlink_hardlink_and_ancestor_alias(self):
        file = self.root/"document.json"; file.write_bytes(b"{}")
        alias = self.root/"document-alias"; alias.symlink_to(file)
        with self.assertRaises((subject.Refusal, OSError)): subject.read_local(alias)
        alias.unlink(); alias.hardlink_to(file)
        with self.assertRaises(subject.Refusal): subject.read_local(file)
        alias.unlink()
        directory = self.root/"root-alias"; directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((subject.Refusal, OSError)): subject.read_local(directory/"document.json")

    def test_future_completion_and_wrong_stage_dependency_times_refuse(self):
        for mode in ("future", "overlap", "before-run", "model-time", "authority-after-start"):
            doc = copy.deepcopy(self.completion)
            if mode == "future": doc["run"]["completedAt"] = self.now+1
            if mode == "overlap": doc["stageStates"]["assembly"]["startedAt"] = doc["stageStates"]["collectors"]["startedAt"]
            if mode == "before-run": doc["stageStates"]["admission"]["startedAt"] = self.now-200
            if mode == "model-time": doc["models"][0]["completedAt"] = self.now+1
            if mode == "authority-after-start": doc["run"]["startedAt"] = self.now-200
            with self.subTest(mode=mode), self.assertRaises(subject.Refusal): self.completion_check(doc)

    def test_retention_expiry_cleanup_and_numeric_booleans_refuse(self):
        for name in self.completion["retention"]:
            doc = copy.deepcopy(self.completion); doc["retention"][name] = self.now if name == "expiresAt" else 1
            with self.subTest(name=name), self.assertRaises(subject.Refusal): self.completion_check(doc)
        doc = copy.deepcopy(self.completion); doc["exitCode"] = False
        with self.assertRaises(subject.Refusal): self.completion_check(doc)

    def test_cli_consumes_actual_files_and_redacts_refusal(self):
        documents = {"context": raw(self.context), "baseline": raw(self.baseline), "core-seal": self.seal,
                     "toolchain": raw(self.toolchain), "completion": raw(self.completion), "observation": raw(self.completion),
                     "workspace-proof": self.proofs["initialWorkspaceSha256"], "collector-proof": self.proofs["collectorProofSha256"],
                     "retention-policy": self.proofs["retentionPolicySha256"]}
        command = [sys.executable, "-I", str(ROOT/"tools/train3_offline_attestation.py"), "--toolchain-root", str(self.bundle)]
        for name, payload in documents.items():
            file = self.root/(name+".json"); file.write_bytes(payload); command += ["--"+name, str(file)]
            if name not in ("context", "core-seal", "observation"): command += ["--"+name+"-sha256", sha(payload)]
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=5)
        self.assertIs(json.loads(result.stdout)["joinedBakeQualified"], False)
        (self.bundle/"lib/native.txt").write_bytes(b"secret-not-for-output")
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("secret-not-for-output", result.stdout+result.stderr)

    def test_blueprint_uses_merged_source_and_remains_unresolved_default_off(self):
        contract = json.loads((ROOT/"ops/train3-validation-contract.json").read_text())
        self.assertEqual(contract["pins"]["atmosCommit"], self.context["atmosCommit"])
        self.assertEqual(contract["pins"]["atmosTree"], self.context["atmosTree"])
        self.assertEqual(sum(v is None for v in contract["pins"].values()), 9)
        self.assertEqual(contract["runtime"], {"shell": None, "python": None, "node": None, "path": None})
        self.assertIs(contract["trigger"]["enabledDefault"], False)
        self.assertFalse((ROOT/contract["workflowPath"]).exists())


if __name__ == "__main__":
    unittest.main()
