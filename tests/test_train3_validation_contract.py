"""Tiny offline fixtures only; no collector, bake, subprocess server or network."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
import os

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("contract", ROOT / "tools/train3_validation_contract.py")
subject = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(subject)
BLUEPRINT = json.loads((ROOT / "ops/train3-validation-contract.json").read_text())
NOW = 1790978400


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wx-train3-contract-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.contract = copy.deepcopy(BLUEPRINT)
        for key, value in self.contract["pins"].items():
            if value is None:
                self.contract["pins"][key] = "c" * (40 if key in subject.GIT_PINS else 64)
        self.contract["runtime"] = {"shell": "/validation/toolchain/bin/bash",
            "python": "/validation/toolchain/bin/python3.12", "node": "/validation/toolchain/bin/node22",
            "path": "/validation/toolchain/bin"}
        self.request = {"event": "workflow_dispatch", "enabled": True, "validationOnly": "1", "publish": "0",
            "environment": {"PATH": self.contract["runtime"]["path"], "LANG": "C",
                            "WEATHERX_DATA_VALIDATION_ONLY": "1", "PUBLISH": "0"},
            "runId": "123456789", "attempt": 1}
        rows = []
        for i, (kind, model) in enumerate(subject.MODELS):
            path = self.root / (model + ".zip")
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("synthetic-only.txt", model)
            payload = path.read_bytes()
            rows.append({"kind": kind, "model": model, "jobId": str(100+i),
                "jobName": f"validation-{kind}-{model} / collector", "artifactId": str(200+i),
                "artifactName": f"train3-validation-{model}-123456789-1", "artifactFile": model+".zip",
                "artifactSha256": hashlib.sha256(payload).hexdigest(), "artifactBytes": len(payload),
                "receiptSha256": "a"*64, "pointReceiptSha256": "b"*64,
                "atmosCommit": self.contract["pins"]["atmosCommit"], "atmosTree": self.contract["pins"]["atmosTree"],
                "runId": "123456789", "attempt": 1, "conclusion": "success", "sourceVerifiedAt": NOW-80,
                "collectedAt": NOW-70, "uploadStartedAt": NOW-60, "createdAt": NOW-50,
                "uploadCompletedAt": NOW-40, "expiresAt": NOW+100})
        self.trusted = {"kind": "weatherx-train3-trusted-metadata-v1", "pins": copy.deepcopy(self.contract["pins"]),
            "run": {"id": "123456789", "attempt": 1, "repositoryId": 1301196656, "event": "workflow_dispatch",
                    "workflowPath": subject.WORKFLOW, "controllerCommit": self.contract["pins"]["controllerCommit"],
                    "controllerTree": self.contract["pins"]["controllerTree"], "startedAt": NOW-100, "completedAt": NOW-20},
            "baseline": {"sha256": self.contract["pins"]["baselineAuthoritySha256"],
                         "freshnessValidated": True, "supersetValidated": True},
            "collectors": rows, "expiresAt": NOW+100}
        self.observed = copy.deepcopy(self.trusted)
        self.observed["kind"] = "weatherx-train3-observation-v1"

    def check(self):
        return subject.validate_binding(self.contract, self.request, self.trusted, self.observed, self.root, NOW)

    def test_blueprint_shape_default_off_and_unresolved_pins_refuse_admission(self):
        subject.validate_contract(BLUEPRINT)
        with self.assertRaisesRegex(subject.Refusal, "unresolved"):
            subject.admit_request(BLUEPRINT, self.request)

    def test_valid_synthetic_binding_never_authorizes_execution_or_publication(self):
        verdict = self.check()
        self.assertTrue(verdict["structuralBindingValid"])
        for field in ("executionAuthorized", "publicationAuthorized", "liveCollectorQualified"):
            self.assertIs(verdict[field], False)

    def test_default_or_schedule_or_nonliteral_flags_refuse(self):
        for field, values in {"enabled": [False, 1, "true"], "event": ["schedule", "push"],
                              "validationOnly": [None, "", True, "01"], "publish": [None, 0, "1", "00"]}.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    request = copy.deepcopy(self.request); request[field] = value
                    with self.assertRaises(subject.Refusal):
                        subject.admit_request(self.contract, request)

    def test_unknown_or_empty_credentials_and_startup_configuration_refuse(self):
        for name in ("HOME", "BASH_ENV", "NODE_OPTIONS", "PYTHONPATH", "RCLONE_CONFIG",
                     "GITHUB_TOKEN", "VAULT_REMOTE", "CLOUDFLARE_API_TOKEN", "AWS_PROFILE"):
            for value in ("", "dummy-never-log"):
                request = copy.deepcopy(self.request); request["environment"][name] = value
                with self.subTest(name=name), self.assertRaises(subject.Refusal):
                    subject.admit_request(self.contract, request)

    def test_untrusted_path_override_refuses(self):
        for value in ("/usr/bin", "/validation/toolchain/bin:/usr/bin", "", "/validation/toolchain/../bin"):
            request = copy.deepcopy(self.request); request["environment"]["PATH"] = value
            with self.subTest(value=value), self.assertRaises(subject.Refusal):
                subject.admit_request(self.contract, request)

    def test_every_unresolved_pin_blocks_concrete_admission(self):
        for name in subject.PIN_NAMES:
            contract = copy.deepcopy(self.contract); contract["pins"][name] = None
            with self.subTest(pin=name), self.assertRaises(subject.Refusal):
                subject.admit_request(contract, self.request)

    def test_writer_graph_credentials_permissions_and_production_refuse(self):
        for name, value in [("writers", ["publish"]), ("writers", ["Wind100"]), ("credentials", ["key"]),
                            ("sharedCacheWrites", True), ("productionEnvironment", True),
                            ("permissions", {"contents": "write", "actions": "read"}),
                            ("workflowPath", ".github/workflows/bake.yml")]:
            contract = copy.deepcopy(self.contract); contract[name] = value
            with self.subTest(name=name), self.assertRaises(subject.Refusal):
                subject.validate_contract(contract)

    def test_default_off_requires_boolean_false_not_integer_zero(self):
        contract = copy.deepcopy(self.contract); contract["trigger"]["enabledDefault"] = 0
        with self.assertRaises(subject.Refusal):
            subject.validate_contract(contract)

    def test_unknown_contract_fields_refuse(self):
        self.contract["secrets"] = {}
        with self.assertRaises(subject.Refusal):
            self.check()

    def test_exact_source_tree_controller_workflow_and_locks_bind(self):
        for name in subject.PIN_NAMES:
            observed = self.observed; self.observed = copy.deepcopy(observed)
            self.observed["pins"][name] = "d" * len(self.observed["pins"][name])
            with self.subTest(pin=name), self.assertRaises(subject.Refusal):
                self.check()
            self.observed = observed

    def test_wrong_run_attempt_workflow_or_repository_refuse(self):
        for key, value in [("id", "234"), ("attempt", 2), ("attempt", True), ("repositoryId", 1),
                           ("workflowPath", ".github/workflows/bake.yml"), ("event", "schedule")]:
            old = self.observed; self.observed = copy.deepcopy(old); self.observed["run"][key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal):
                self.check()
            self.observed = old

    def test_missing_duplicate_failed_and_wrong_attempt_collectors_refuse(self):
        rows = self.observed["collectors"]
        for changed in [rows[:-1], rows[:-1]+[rows[0]], [dict(rows[0], conclusion="failure")]+rows[1:],
                        [dict(rows[0], attempt=2)]+rows[1:], [dict(rows[0], jobId=rows[1]["jobId"])]+rows[1:]]:
            self.observed["collectors"] = changed
            with self.assertRaises(subject.Refusal):
                self.check()
        self.observed["collectors"] = rows

    def test_forged_job_artifact_receipt_and_upload_order_refuse(self):
        row = self.observed["collectors"][0]
        for key, value in [("jobName", "core-ecmwf / collector"), ("artifactName", "core-model-packs-ecmwf"),
                           ("artifactFile", "../ecmwf.zip"), ("artifactId", "999"), ("receiptSha256", "d"*64),
                           ("pointReceiptSha256", "d"*64), ("createdAt", NOW-90), ("expiresAt", NOW)]:
            self.observed["collectors"][0] = dict(row, **{key: value})
            with self.subTest(key=key), self.assertRaises(subject.Refusal):
                self.check()
        self.observed["collectors"][0] = row

    def test_baseline_attestation_is_bound_and_not_numeric_boolean(self):
        for key, value in [("sha256", "d"*64), ("freshnessValidated", False), ("supersetValidated", 1)]:
            old = self.observed; self.observed = copy.deepcopy(old); self.observed["baseline"][key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal):
                self.check()
            self.observed = old

    def test_expired_independent_authority_refuses(self):
        self.trusted["expiresAt"] = NOW
        with self.assertRaises(subject.Refusal):
            self.check()

    def test_actual_zip_bytes_must_match_independent_digest(self):
        file = self.root / "ecmwf.zip"; data = bytearray(file.read_bytes()); data[0] ^= 1; file.write_bytes(data)
        with self.assertRaisesRegex(subject.Refusal, "digest"):
            self.check()

    def test_missing_or_symlinked_or_hardlinked_artifact_refuses(self):
        file = self.root / "ecmwf.zip"; payload = file.read_bytes(); file.unlink()
        with self.assertRaises(subject.Refusal):
            self.check()
        other = self.root / "other"; other.write_bytes(payload); file.symlink_to(other)
        with self.assertRaises(subject.Refusal):
            self.check()
        file.unlink(); file.hardlink_to(other)
        with self.assertRaises(subject.Refusal):
            self.check()

    def test_symlink_in_artifact_directory_ancestor_refuses(self):
        actual = self.root/"nested"; actual.mkdir()
        for _, model in subject.MODELS:
            (actual/(model+".zip")).write_bytes((self.root/(model+".zip")).read_bytes())
        alias = self.root/"alias"; alias.symlink_to(self.root, target_is_directory=True)
        self.root = alias/"nested"
        with self.assertRaises(subject.Refusal):
            self.check()

    def test_directory_replacement_cannot_redirect_an_anchored_read(self):
        stage = self.root/"stage"; stage.mkdir()
        row = self.observed["collectors"][0]
        (stage/row["artifactFile"]).write_bytes((self.root/row["artifactFile"]).read_bytes())
        replacement = self.root/"replacement"; replacement.mkdir()
        (replacement/row["artifactFile"]).write_bytes(b"untrusted replacement")
        fd = subject.open_artifact_root(stage)
        try:
            stage.rename(self.root/"original-stage")
            stage.symlink_to(replacement, target_is_directory=True)
            subject.artifact_digest(fd, row)
        finally:
            os.close(fd)

    def test_duplicate_nonfinite_and_oversized_json_refuse(self):
        path = self.root / "bad.json"
        for payload in (b'{"a":1,"a":2}', b'{"a":NaN}', b' '*(subject.MAX_JSON+1)):
            path.write_bytes(payload)
            with self.assertRaises(subject.Refusal):
                subject.read_json(path)

    def test_cli_blueprint_reports_no_execution_or_live_authority(self):
        result = subprocess.run([sys.executable, "-I", str(ROOT/"tools/train3_validation_contract.py"),
                                 "--contract", str(ROOT/"ops/train3-validation-contract.json")],
                                check=True, capture_output=True, text=True, timeout=3)
        verdict = json.loads(result.stdout)
        self.assertIs(verdict["contractShapeValid"], True)
        self.assertTrue(verdict["unresolvedPins"])
        self.assertIs(verdict["executionAuthorized"], False)
        self.assertIs(verdict["liveCollectorQualified"], False)

    def test_ci_runs_the_isolated_contract_and_watches_its_blueprint(self):
        workflow = (ROOT/".github/workflows/scheduler-ci.yml").read_text()
        self.assertIn("python3 -I tests/test_train3_validation_contract.py", workflow)
        self.assertIn('"ops/train3-validation-contract.json"', workflow)
        self.assertFalse((ROOT/subject.WORKFLOW).exists())


if __name__ == "__main__":
    unittest.main()
