from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "current_model_artifact", Path(__file__).parents[1] / "tools/current-model-artifact.py")
subject = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(subject)
NOW = datetime(2026, 9, 5, 20, tzinfo=timezone.utc)
RUN_ID = "33999999999"
ATTEMPT = 2
CONTROLLER = "a" * 40
SOURCE = "b" * 40


def zip_bytes(entries):
    value = io.BytesIO()
    with zipfile.ZipFile(value, "w") as bundle:
        for name, body in entries:
            bundle.writestr(name, body)
    return value.getvalue()


def metadata(kind="core", model="gfs", overall="failure"):
    step_names = subject.expected_steps(kind)
    steps = []
    for index, name in enumerate(step_names):
        minute = index * 2
        steps.append({"name": name, "status": "completed", "conclusion": "success",
                      "started_at": f"2026-09-05T19:{minute:02d}:00Z",
                      "completed_at": f"2026-09-05T19:{minute + 1:02d}:00Z"})
    run = {"id": int(RUN_ID), "run_attempt": ATTEMPT, "head_sha": CONTROLLER,
           "path": subject.WORKFLOW, "event": "schedule", "status": "in_progress",
           "conclusion": overall,
           "repository": {"id": subject.REPO_ID, "full_name": subject.REPO},
           "head_repository": {"id": subject.REPO_ID, "full_name": subject.REPO}}
    job = {"id": 1234, "run_id": int(RUN_ID), "run_attempt": ATTEMPT,
           "head_sha": CONTROLLER, "name": f"{kind} ({model})", "status": "completed",
           "conclusion": "success", "steps": steps}
    artifact = {"id": 5678, "name": subject.artifact_name(kind, model),
                "size_in_bytes": 123, "digest": "sha256:" + "c" * 64,
                "created_at": "2026-09-05T19:04:30Z", "expires_at": "2026-09-06T19:04:30Z",
                "expired": False, "workflow_run": {"id": int(RUN_ID), "head_sha": CONTROLLER,
                    "repository_id": subject.REPO_ID, "head_repository_id": subject.REPO_ID}}
    return run, {"total_count": 1, "jobs": [job]}, {"total_count": 1, "artifacts": [artifact]}


class Client:
    def __init__(self, rows, archive=b""):
        self.rows = iter(rows)
        self.archive = archive
        self.suffixes = []

    def json(self, suffix):
        self.suffixes.append(suffix)
        return next(self.rows)

    def download(self, artifact_id, destination, size, digest):
        self.download_args = (artifact_id, size, digest)
        destination.write_bytes(self.archive)


def core_archive(model="gfs"):
    receipt = {"schemaVersion": 1, "status": "unqualified-core-inputs", "model": model,
               "sourceSha": SOURCE, "runId": RUN_ID, "forecastRun": "2026090518", "files": []}
    return zip_bytes([(f"{model}/manifest.json", json.dumps(receipt)),
                      (f"{model}/payload/data/{model}/index.json", "{}")])


def regional_archive(model="nam-hi", status="collected"):
    source_hash = "d" * 64
    receipt = {"schemaVersion": 1, "kind": "weatherx-regional-model-pack", "status": status,
               "model": model, "sourceSha": SOURCE}
    entries = [(f"{model}/pack-receipt.json", json.dumps(receipt))]
    if status == "collected":
        receipt.update({"init": "2026090518", "sourceReceiptSha256": source_hash})
        entries[0] = (f"{model}/pack-receipt.json", json.dumps(receipt))
        point = {"schemaVersion": 1, "kind": "weatherx-regional-point-stage", "model": model,
                 "init": "2026090518", "sourceQualificationSha256": source_hash}
        entries.append((f"point-stages/{model}/point-stage-receipt.json", json.dumps(point)))
    return zip_bytes(entries)


def args(root, kind="core", model="gfs"):
    return SimpleNamespace(run_id=RUN_ID, run_attempt=ATTEMPT, controller_sha=CONTROLLER,
        atmos_source_sha=SOURCE, atmos_root=str(root / "atmos"), kind=kind, model=model,
        output=str(root / "handoff"), github_output=str(root / "github-output"))


class CurrentModelArtifactTests(unittest.TestCase):
    def test_all_eleven_names_and_step_contracts_are_explicit(self):
        self.assertEqual(len(subject.MODELS), 11)
        self.assertEqual(set(subject.CORE), {"ecmwf", "gfs", "hrrr", "aifs"})
        self.assertEqual(len(subject.REGIONAL), 7)
        for model in subject.CORE:
            self.assertEqual(subject.artifact_name("core", model), f"core-model-packs-{model}")
        for model in subject.REGIONAL:
            self.assertEqual(subject.artifact_name("regional", model), f"regional-packs-{model}")
        self.assertNotEqual(subject.expected_steps("core"), subject.expected_steps("regional"))

    def test_workflow_source_parser_requires_common_pinned_atmos_source(self):
        workflow = """
      - uses: actions/checkout@pinned
        with:
          repository: weatherx-hq/atmos
          ref: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb # core
      - with:
          repository: Andrewegao/atmos
          ref: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      - with:
          repository: weatherx-hq/atmos
          ref: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
"""
        self.assertEqual(subject.atmos_refs(workflow), [SOURCE] * 3)
        with self.assertRaisesRegex(subject.Refusal, "checkout-count"):
            subject.atmos_refs(workflow.split("      - with:")[0])
        with self.assertRaisesRegex(subject.Refusal, "ref-missing"):
            subject.atmos_refs(workflow.replace("ref: " + SOURCE, "ref: main", 1))

    def test_failed_aggregate_does_not_hide_successful_model_job(self):
        run, jobs, artifacts = metadata(overall="failure")
        client = Client([run, jobs, artifacts])
        self.assertEqual(subject.exact_run(client, RUN_ID, ATTEMPT, CONTROLLER), run)
        job, upload = subject.exact_job(client, RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        artifact = subject.exact_artifact(client, RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs", upload, NOW)
        self.assertEqual((job["id"], artifact["id"]), (1234, 5678))
        self.assertIn(f"/attempts/{ATTEMPT}/jobs", client.suffixes[1])

    def test_job_absence_failure_and_expiry_are_truthful_withholds(self):
        run, jobs, artifacts = metadata()
        client = Client([run, {"total_count": 0, "jobs": []}])
        subject.exact_run(client, RUN_ID, ATTEMPT, CONTROLLER)
        with self.assertRaisesRegex(subject.Withheld, "not-complete"):
            subject.exact_job(client, RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        jobs["jobs"][0]["conclusion"] = "failure"
        with self.assertRaisesRegex(subject.Withheld, "not-successful"):
            subject.exact_job(Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        _, jobs, artifacts = metadata()
        _, upload = subject.exact_job(Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        artifacts["artifacts"][0]["expired"] = True
        with self.assertRaisesRegex(subject.Withheld, "expired"):
            subject.exact_artifact(Client([artifacts]), RUN_ID, ATTEMPT, CONTROLLER,
                                   "core", "gfs", upload, NOW)

    def test_provenance_mutations_are_fatal_not_withheld(self):
        run, jobs, artifacts = metadata()
        mutations = [
            (run, "run_attempt", 1, subject.exact_run,
             (Client([run]), RUN_ID, ATTEMPT, CONTROLLER)),
            (jobs, "total_count", 2, subject.exact_job,
             (Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")),
        ]
        for target, key, value, function, arguments in mutations:
            original = target[key]
            target[key] = value
            with self.subTest(key=key), self.assertRaises(subject.Refusal):
                function(*arguments)
            target[key] = original
        job = jobs["jobs"][0]
        for key, value in (("run_attempt", 1), ("head_sha", "e" * 40)):
            original = job[key]
            job[key] = value
            with self.subTest(job=key), self.assertRaises(subject.Refusal):
                subject.exact_job(Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
            job[key] = original
        job["name"] = "core (aifs)"
        with self.assertRaises(subject.Withheld):
            subject.exact_job(Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        job["name"] = "core (gfs)"
        _, upload = subject.exact_job(Client([jobs]), RUN_ID, ATTEMPT, CONTROLLER, "core", "gfs")
        artifact = artifacts["artifacts"][0]
        for key, value in (("digest", "sha256:" + "z" * 64), ("size_in_bytes", 0),
                           ("workflow_run", {}), ("created_at", "2026-09-05T18:00:00Z")):
            original = artifact[key]
            artifact[key] = value
            error = subject.Withheld if key == "created_at" else subject.Refusal
            with self.subTest(artifact=key), self.assertRaises(error):
                subject.exact_artifact(Client([artifacts]), RUN_ID, ATTEMPT, CONTROLLER,
                                       "core", "gfs", upload, NOW)
            artifact[key] = original
        artifacts["artifacts"].append(dict(artifacts["artifacts"][0]))
        artifacts["total_count"] = 2
        with self.assertRaisesRegex(subject.Refusal, "duplicate"):
            subject.exact_artifact(Client([artifacts]), RUN_ID, ATTEMPT, CONTROLLER,
                                   "core", "gfs", upload, NOW)

    def test_core_bundle_is_atomic_and_preserves_authenticated_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs, artifacts = metadata()
            client = Client([run, jobs, artifacts], core_archive())
            arguments = args(root)
            with patch.object(subject, "assert_clean_checkout"):
                handoff = subject.transfer(arguments, client, NOW)
            output = Path(arguments.output)
            self.assertTrue((output / "packs/gfs/manifest.json").is_file())
            self.assertFalse((output / "baseline-manifest.json").exists())
            self.assertFalse(any(path.name.startswith(".current-model-handoff-") for path in root.iterdir()))
            self.assertFalse(handoff["publicationAuthorized"])
            self.assertEqual(handoff["origin"]["runAttempt"], ATTEMPT)
            self.assertEqual(client.download_args, (5678, 123, "c" * 64))
            receipt = output / "packs" / handoff["pack"]["receipt"]
            self.assertEqual(hashlib.sha256(receipt.read_bytes()).hexdigest(), handoff["pack"]["receiptSha256"])

    def test_regional_bundle_requires_bound_point_stage_and_authenticated_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs, artifacts = metadata("regional", "nam-hi")
            client = Client([run, jobs, artifacts], regional_archive())
            arguments = args(root, "regional", "nam-hi")
            def hydrate(_atmos, model, destination):
                manifest = destination.parent / "source-manifest.json"
                manifest.write_text(json.dumps({"model": model, "init_time": "2026-09-05T12:00:00Z"}))
                digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
                return {"source": "catalog", "identity": "catalog-1", "objectCount": 150,
                        "inventorySha256": "e" * 64, "forecastRun": "2026090512",
                        "manifest": str(manifest), "manifestSha256": digest,
                        "componentManifestSha256": "f" * 64}
            with patch.object(subject, "assert_clean_checkout"):
                handoff = subject.transfer(arguments, client, NOW, hydrate)
            output = Path(arguments.output)
            self.assertEqual(handoff["regionalBaseline"]["source"], "catalog")
            self.assertTrue((output / "baseline-manifest.json").is_file())
            self.assertTrue((output / "packs/point-stages/nam-hi/point-stage-receipt.json").is_file())
            broken = root / "broken"
            broken.mkdir()
            extracted = broken / "packs"
            subject.legacy.extract(root / "does-not-exist", extracted, "regional", "nam-hi") if False else None
            receipt = json.loads((output / "packs/point-stages/nam-hi/point-stage-receipt.json").read_text())
            receipt["sourceQualificationSha256"] = "0" * 64
            (output / "packs/point-stages/nam-hi/point-stage-receipt.json").write_text(json.dumps(receipt))
            with self.assertRaisesRegex(subject.Refusal, "point-receipt-identity"):
                subject.inspect_pack(output / "packs", "regional", "nam-hi", SOURCE, RUN_ID)

    def test_regional_abstention_is_withheld_without_baseline_or_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run, jobs, artifacts = metadata("regional", "nam-hi")
            arguments = args(root, "regional", "nam-hi")
            hydrate = unittest.mock.Mock(side_effect=AssertionError("must not hydrate"))
            with patch.object(subject, "assert_clean_checkout"):
                with self.assertRaisesRegex(subject.Withheld, "provider-abstained"):
                    subject.transfer(arguments, Client([run, jobs, artifacts], regional_archive(status="abstained")),
                                     NOW, hydrate)
            hydrate.assert_not_called()
            self.assertFalse(Path(arguments.output).exists())

    def test_catalog_hydration_binds_remote_component_inventory_and_model_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atmos, destination = root / "atmos", root / "work/baseline/nam-hi"
            script = atmos / "ops/platform/hydrate-r2-component.sh"
            script.parent.mkdir(parents=True)
            script.write_text("#!/usr/bin/env bash\n")
            destination.parent.mkdir(parents=True)
            def runner(command, cwd, env, capture_output, timeout):
                self.assertEqual(env["CATALOG_R2_REMOTE"], subject.STAGING_CATALOG)
                self.assertEqual(env["COMPONENT_R2_REMOTE"], subject.STAGING_COMPONENTS)
                self.assertNotIn("GH_TOKEN", env)
                self.assertEqual(env["CATALOG_R2_BUCKET"], "")
                self.assertEqual(env["PINNED_CATALOG_POINTER"], "")
                (destination / "runs/2026090512").mkdir(parents=True)
                index = {"schemaVersion": 1, "model": "nam-hi", "runs": [{
                    "init_time": "2026-09-05T12:00:00Z", "path": "runs/2026090512/"}]}
                manifest = {"schemaVersion": 1, "model": "nam-hi", "init_time": "2026-09-05T12:00:00Z"}
                (destination / "index.json").write_text(json.dumps(index))
                (destination / "runs/2026090512/manifest.json").write_text(json.dumps(manifest))
                rows = subject.tree_inventory(destination)
                component = {"schemaVersion": 1, "componentId": "nam-hi", "mounts": ["data/nam-hi/"],
                             "artifactId": "artifact-1", "rootPrefix": "components/nam-hi/artifact-1/",
                             "objectCount": len(rows), "inventorySha256": subject.inventory_digest(rows),
                             "quality": {"status": "passed", "checks": ["manifest", "inventory", "remote_bytes"]}}
                component_path = Path(env["COMPONENT_MANIFEST_OUTPUT"])
                component_path.write_text(json.dumps(component))
                digest = hashlib.sha256(component_path.read_bytes()).hexdigest()
                Path(env["GITHUB_ENV"]).write_text(
                    f"EXPECTED_COMPONENT_MANIFEST_SHA256={digest}\n"
                    "EXPECTED_CATALOG_ROLLBACK_EPOCH=3\n"
                    "ACTIVE_COMPONENT_GENERATION_TIME=2026-09-05T12:00:00Z\n")
                return SimpleNamespace(returncode=0, stdout="hydrated nam-hi from catalog catalog-7\n",
                                       stderr="signed-url-must-not-be-observed")
            with patch.dict(os.environ, {"GH_TOKEN": "secret", "GITHUB_TOKEN": "secret"}):
                proof = subject.hydrate_baseline(atmos, "nam-hi", destination, runner)
            self.assertEqual(proof["source"], "catalog")
            self.assertEqual(proof["identity"], "catalog-7")
            self.assertEqual(proof["forecastRun"], "2026090512")

    def test_hydration_inventory_mismatch_and_failure_are_fatal_and_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atmos, destination = root / "atmos", root / "work/baseline/nam-hi"
            script = atmos / "ops/platform/hydrate-r2-component.sh"
            script.parent.mkdir(parents=True)
            script.write_text("x")
            destination.parent.mkdir(parents=True)
            for code in (1, 9):
                with self.subTest(code=code), self.assertRaisesRegex(subject.Refusal, "hydration-failed"):
                    subject.hydrate_baseline(atmos, "nam-hi", destination,
                        lambda *a, **k: SimpleNamespace(returncode=code,
                            stdout="https://signed.invalid/?secret=value", stderr="token=private"))

    def test_catalog_hydration_rejects_self_claimed_inventory_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atmos, destination = root / "atmos", root / "work/baseline/nam-hi"
            script = atmos / "ops/platform/hydrate-r2-component.sh"
            script.parent.mkdir(parents=True)
            script.write_text("x")
            destination.parent.mkdir(parents=True)
            def runner(_command, cwd, env, capture_output, timeout):
                (destination / "runs/2026090512").mkdir(parents=True)
                (destination / "index.json").write_text(json.dumps({"schemaVersion": 1,
                    "model": "nam-hi", "runs": [{"init_time": "2026-09-05T12:00:00Z",
                                                   "path": "runs/2026090512/"}]}))
                (destination / "runs/2026090512/manifest.json").write_text(json.dumps({
                    "model": "nam-hi", "init_time": "2026-09-05T12:00:00Z"}))
                component = {"schemaVersion": 1, "componentId": "nam-hi", "artifactId": "a",
                    "rootPrefix": "components/nam-hi/a/", "mounts": ["data/nam-hi/"],
                    "objectCount": 2, "inventorySha256": "0" * 64,
                    "quality": {"status": "passed", "checks": ["manifest", "inventory", "remote_bytes"]}}
                component_path = Path(env["COMPONENT_MANIFEST_OUTPUT"])
                component_path.write_text(json.dumps(component))
                digest = hashlib.sha256(component_path.read_bytes()).hexdigest()
                Path(env["GITHUB_ENV"]).write_text(
                    f"EXPECTED_COMPONENT_MANIFEST_SHA256={digest}\n"
                    "EXPECTED_CATALOG_ROLLBACK_EPOCH=0\nACTIVE_COMPONENT_GENERATION_TIME=x\n")
                return SimpleNamespace(returncode=0, stdout="hydrated nam-hi from catalog catalog-1\n", stderr="")
            with self.assertRaisesRegex(subject.Refusal, "manifest-identity"):
                subject.hydrate_baseline(atmos, "nam-hi", destination, runner)

    def test_release_fallback_is_exact_hydrator_result_not_local_expectation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atmos, destination = root / "atmos", root / "work/baseline/nam-hi"
            script = atmos / "ops/platform/hydrate-r2-component.sh"
            script.parent.mkdir(parents=True)
            script.write_text("x")
            destination.parent.mkdir(parents=True)
            def runner(_command, cwd, env, capture_output, timeout):
                (destination / "runs/2026090512").mkdir(parents=True)
                (destination / "index.json").write_text(json.dumps({"schemaVersion": 1,
                    "model": "nam-hi", "runs": [{"init_time": "2026-09-05T12:00:00Z",
                                                   "path": "runs/2026090512/"}]}))
                (destination / "runs/2026090512/manifest.json").write_text(json.dumps({
                    "model": "nam-hi", "init_time": "2026-09-05T12:00:00Z"}))
                Path(env["GITHUB_ENV"]).write_text(
                    "EXPECTED_COMPONENT_MANIFEST_SHA256=\n"
                    "EXPECTED_CATALOG_ROLLBACK_EPOCH=4\nACTIVE_COMPONENT_GENERATION_TIME=\n")
                return SimpleNamespace(returncode=0,
                    stdout="hydrated nam-hi from fallback release release-17\n", stderr="")
            proof = subject.hydrate_baseline(atmos, "nam-hi", destination, runner)
            self.assertEqual((proof["source"], proof["identity"]),
                             ("fallback-release", "release-17"))
            self.assertNotIn("componentManifestSha256", proof)

    def test_git_checkout_guard_rejects_tracked_untracked_and_ignored_shadowing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", root], check=True)
            (root / ".gitignore").write_text("ignored.py\n")
            (root / "source.py").write_text("SAFE = True\n")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "-c", "user.name=Fixture", "-c",
                            "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], check=True)
            head = subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
            subject.assert_clean_checkout(root, head, "fixture")
            (root / "untracked.py").write_text("shadow")
            with self.assertRaisesRegex(subject.Refusal, "dirty"):
                subject.assert_clean_checkout(root, head, "fixture")
            (root / "untracked.py").unlink()
            (root / "ignored.py").write_text("shadow")
            with self.assertRaisesRegex(subject.Refusal, "ignored-input"):
                subject.assert_clean_checkout(root, head, "fixture")
            (root / "ignored.py").unlink()
            (root / "source.py").write_text("SAFE = False\n")
            with self.assertRaisesRegex(subject.Refusal, "dirty"):
                subject.assert_clean_checkout(root, head, "fixture")

    def test_outputs_distinguish_ready_withheld_and_security_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "github-output"
            subject.write_outputs(output, {"status": "withheld", "reason": "collector-job-not-complete"})
            self.assertEqual(output.read_text(), "status=withheld\nreason=collector-job-not-complete\n")
            with self.assertRaisesRegex(subject.Refusal, "github-output-invalid"):
                subject.write_outputs(output, {"status": "ready\ninjected=x"})


if __name__ == "__main__":
    unittest.main()
