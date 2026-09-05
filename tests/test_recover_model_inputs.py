from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

SPEC = importlib.util.spec_from_file_location("recovery", Path(__file__).parents[1] / "tools/recover-model-inputs.py")
r = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(r)
NOW = datetime(2026, 9, 5, 1, tzinfo=timezone.utc)


def metadata(model="gfs"):
    kind, aid, sha, size, jid = r.ARTIFACTS[model]
    run = dict(id=int(r.ORIGIN_RUN), run_attempt=1, head_sha=r.CONTROLLER, path=r.WORKFLOW,
               event="schedule", status="completed", conclusion="failure",
               repository=dict(id=r.REPO_ID, full_name=r.REPO), head_repository=dict(id=r.REPO_ID, full_name=r.REPO))
    artifact = dict(id=aid, name=f"{'core-model-packs' if kind == 'core' else 'regional-packs'}-{model}",
                    digest="sha256:" + sha, size_in_bytes=size, expired=False,
                    created_at="2026-09-04T23:00:01Z", expires_at="2026-09-05T23:00:00Z",
                    workflow_run=dict(id=int(r.ORIGIN_RUN), head_sha=r.CONTROLLER,
                                      repository_id=r.REPO_ID, head_repository_id=r.REPO_ID))
    job = dict(id=jid, run_id=int(r.ORIGIN_RUN), run_attempt=1, head_sha=r.CONTROLLER,
               name=f"{kind} ({model})", status="completed", conclusion="success", steps=[dict(
                   name="retain only sealed core model inputs for the joined bake" if kind == "core"
                   else "hand the display packs (or abstention receipts) to the bake job",
                   status="completed", conclusion="success", started_at="2026-09-04T23:00:00Z",
                   completed_at="2026-09-04T23:00:02Z")])
    return run, artifact, job


def zip_bytes(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as output:
        for name, contents in entries:
            output.writestr(name, contents)
    return data.getvalue()


class RecoveryTests(unittest.TestCase):
    def test_fixed_manual_scope_default_is_fresh(self):
        for event in ("schedule", "workflow_dispatch"):
            r.validate_request("", event)
        r.validate_request(r.ORIGIN_RUN, "workflow_dispatch")
        for run, event in (("123", "workflow_dispatch"), (r.ORIGIN_RUN, "schedule")):
            with self.assertRaises(r.Refusal):
                r.validate_request(run, event)

    def test_all_eleven_reviewed_provenances_and_identity_mutations(self):
        self.assertEqual(len(r.ARTIFACTS), 11)
        for model in r.ARTIFACTS:
            r.verify_provenance(*metadata(model), model, NOW)
        for index, key, value in ((0, "run_attempt", 2), (0, "head_sha", "f" * 40),
                (0, "path", "evil.yml"), (0, "event", "pull_request"),
                (0, "repository", dict(id=99, full_name=r.REPO)),
                (0, "head_repository", dict(id=r.REPO_ID, full_name="other/repo")),
                (1, "id", 1), (1, "name", "core-model-packs-aifs"), (1, "digest", "sha256:" + "f" * 64),
                (1, "size_in_bytes", 1), (1, "workflow_run", {}), (1, "created_at", "2026-09-04T22:00:00Z"),
                (2, "id", 1), (2, "run_attempt", 2), (2, "run_id", 1), (2, "conclusion", "failure"),
                (2, "name", "regional (gfs)"), (2, "steps", [])):
            rows = metadata()
            rows[index][key] = value
            with self.subTest(index=index, key=key), self.assertRaises(r.Refusal):
                r.verify_provenance(*rows, "gfs", NOW)

    def test_expiry_is_miss_not_reuse(self):
        rows = metadata()
        rows[1]["expired"] = True
        with self.assertRaises(r.Miss):
            r.verify_provenance(*rows, "gfs", NOW)
        rows = metadata()
        rows[1]["expires_at"] = "2026-09-04T23:00:00Z"
        with self.assertRaises(r.Miss):
            r.verify_provenance(*rows, "gfs", NOW)

    def test_redirect_never_forwards_token_and_digest_is_verified(self):
        content = b"archive-fixture"
        class Opener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                if len(self.requests) == 1:
                    raise urllib.error.HTTPError(request.full_url, 302, "redirect", {
                        "Location": "https://fixture.blob.core.windows.net/private?sig=hidden"}, None)
                return io.BytesIO(content)
        with tempfile.TemporaryDirectory() as directory:
            client = r.GitHub("secret-fixture")
            client.opener = Opener()
            client.download(1, Path(directory) / "ok.zip", len(content), hashlib.sha256(content).hexdigest())
            self.assertEqual(client.opener.requests[0].get_header("Authorization"), "Bearer secret-fixture")
            self.assertEqual(client.opener.requests[1].header_items(), [])
            for expected_size, digest in ((len(content) - 1, hashlib.sha256(content).hexdigest()),
                                          (len(content), "0" * 64)):
                client.opener = Opener()
                with self.assertRaises(r.Refusal):
                    client.download(1, Path(directory) / f"bad-{expected_size}.zip", expected_size, digest)
        for url in ("http://x.blob.core.windows.net/", "https://evil.test/", "https://x.blob.core.windows.net.evil.test/",
                    "https://user@x.blob.core.windows.net/", "https://x.blob.core.windows.net:123/"):
            with self.assertRaises(r.Refusal): r.artifact_url(url)

    def test_http_missing_misses_but_permissions_refuse(self):
        client = r.GitHub("fixture")
        for code, error_type in ((404, r.Miss), (410, r.Miss), (403, r.Refusal), (500, r.Refusal)):
            with patch.object(client, "request", side_effect=urllib.error.HTTPError("hidden", code, "hidden", {}, None)):
                with self.assertRaises(error_type): client.json("/actions/artifacts/1")

    def test_extract_valid_model_bytes_and_block_unsafe_paths(self):
        symlink = zipfile.ZipInfo("gfs/link")
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases = [[("../escape", b"x")], [("/absolute", b"x")], [("gfs/../escape", b"x")],
                 [("gfs\\evil", b"x")], [("C:/evil", b"x")], [("gfs/./x", b"x")],
                 [("gfs/x", b"a"), ("gfs/x", b"b")], [(symlink, b"../escape")],
                 [("ecmwf/manifest.json", b"x")], [("recovery-admissions/core-gfs.json", b"forged")],
                 [("point-stages/gfs/meta.json", b"x")]]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "pack.zip"
            for i, entries in enumerate(cases):
                archive.write_bytes(zip_bytes(entries))
                with self.subTest(entries=entries), self.assertRaises(r.Refusal):
                    r.extract(archive, root / f"bad{i}", "core", "gfs")
            archive.write_bytes(zip_bytes([("gfs/xZZ", b"x")]).replace(b"gfs/xZZ", b"gfs/x\x00Z"))
            with self.assertRaises(r.Refusal):
                r.extract(archive, root / "nul", "core", "gfs")
            archive.write_bytes(zip_bytes([("gfs/manifest.json", b"original-receipt"), ("gfs/payload/data/.gfs-point/meta.json", b"point")]))
            r.extract(archive, root / "good", "core", "gfs")
            self.assertEqual((root / "good/gfs/manifest.json").read_bytes(), b"original-receipt")
            for bound in ("MAX_FILES", "MAX_MEMBER", "MAX_EXPANDED"):
                with patch.object(r, bound, 0), self.assertRaises(r.Refusal):
                    r.extract(archive, root / bound, "core", "gfs")

    def test_quarantined_admission_preserves_original_bytes_and_miss_leaves_no_output(self):
        class Client:
            def __init__(self): self.rows = iter(metadata())
            def json(self, _): return next(self.rows)
            def download(self, aid, path, size, sha):
                path.write_bytes(zip_bytes([("gfs/manifest.json", b"original-49dc-receipt")]))
        def admitted(args, packs):
            envelope = packs / "recovery-admissions/core-gfs.json"
            envelope.parent.mkdir()
            envelope.write_text('{"origin":"33925520386"}')
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(model="gfs", kind="core", output=str(Path(directory) / "packs"))
            with patch.object(r, "admit", admitted): r.recover(args, Client(), NOW)
            self.assertEqual((Path(args.output) / "gfs/manifest.json").read_bytes(), b"original-49dc-receipt")
            self.assertTrue((Path(args.output) / "recovery-admissions/core-gfs.json").exists())
            args.output = str(Path(directory) / "missing")
            with patch.object(r, "admit", side_effect=r.Miss("incompatible")), self.assertRaises(r.Miss):
                r.recover(args, Client(), NOW)
            self.assertFalse(Path(args.output).exists())
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["packs"])

    def test_icon_recollects_without_downloading(self):
        with self.assertRaisesRegex(r.Miss, "icon-point-stage-missing"):
            r.recover(SimpleNamespace(model="icon", kind="regional"), None, NOW)

    def test_admission_exact_cli_and_failure_classification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packs = root / "packs"
            packs.mkdir()
            original = packs / "original"
            original.write_bytes(b"49dc-original-bytes")
            args = SimpleNamespace(model="gfs", atmos_root=str(root), current_source_sha="a" * 40)
            envelope = packs / "recovery-admissions/core-gfs.json"
            def accepted(command, **kwargs):
                self.assertEqual(command[0], str(root / "data/.venv/bin/python"))
                self.assertEqual(command[1], str(root / "ops/artifact_recovery.py"))
                flags = dict(zip(command[3::2], command[4::2]))
                self.assertEqual(flags["--origin-source-sha"], r.ORIGIN_SOURCE)
                self.assertEqual(flags["--origin-run-id"], r.ORIGIN_RUN)
                self.assertEqual(flags["--run-id"], "12345")
                self.assertEqual(flags["--artifact-id"], str(r.ARTIFACTS["gfs"][1]))
                self.assertEqual(flags["--artifact-sha256"], r.ARTIFACTS["gfs"][2])
                self.assertEqual(flags["--packs"], str(packs))
                self.assertNotIn("GH_TOKEN", kwargs["env"])
                self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
                envelope.parent.mkdir()
                envelope.write_text('{}')
                return SimpleNamespace(returncode=0)
            with patch.dict(r.os.environ, {"GITHUB_RUN_ID": "12345", "GH_TOKEN": "private", "GITHUB_TOKEN": "private"}):
                with patch.object(r.subprocess, "run", accepted):
                    r.admit(args, packs)
                self.assertEqual(original.read_bytes(), b"49dc-original-bytes")
                for code, failure in ((3, r.Miss), (1, r.Refusal), (2, r.Refusal), (-9, r.Refusal)):
                    with patch.object(r.subprocess, "run", return_value=SimpleNamespace(returncode=code)):
                        with self.assertRaises(failure): r.admit(args, packs)

    def test_transfer_requires_all_eleven_receipts_and_old_source_envelopes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current_source, current_run = "a" * 40, "123456789"
            def initialize():
                for model, (kind, *_unused) in r.ARTIFACTS.items():
                    base = root / kind
                    path = base / model / ("manifest.json" if kind == "core" else "pack-receipt.json")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    old = model in ("gfs", "hrdps")
                    path.write_text(json.dumps(dict(model=model, sourceSha=r.ORIGIN_SOURCE if old else current_source,
                                                   runId=r.ORIGIN_RUN if old else current_run)))
                    if old:
                        envelope = base / "recovery-admissions" / f"{kind}-{model}.json"
                        envelope.parent.mkdir(exist_ok=True)
                        envelope.write_text('{}')
            def verify():
                r.verify_transfer(root / "core", root / "regional", current_source, current_run)
            initialize()
            verify()
            for relative in ("core/gfs/manifest.json", "regional/nam-hi/pack-receipt.json",
                             "core/recovery-admissions/core-gfs.json", "regional/recovery-admissions/regional-hrdps.json"):
                path = root / relative
                path.unlink()
                with self.subTest(relative=relative), self.assertRaises(r.Refusal): verify()
                initialize()
            for model, field, bad_value in (("gfs", "sourceSha", "b" * 40), ("gfs", "runId", current_run),
                                            ("nam-hi", "model", "nam"), ("icon", "sourceSha", r.ORIGIN_SOURCE)):
                kind = r.ARTIFACTS[model][0]
                path = root / kind / model / ("manifest.json" if kind == "core" else "pack-receipt.json")
                value = json.loads(path.read_text())
                value[field] = bad_value
                path.write_text(json.dumps(value))
                with self.subTest(model=model, field=field), self.assertRaises(r.Refusal): verify()
                initialize()


if __name__ == "__main__":
    unittest.main()
