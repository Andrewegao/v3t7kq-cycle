import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("owned", ROOT / "tools/staging-consumer-reuse.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def evidence():
    repository = {"id": m.transport.REPO_ID, "full_name": m.transport.REPO}
    run = dict(id=m.RUN, run_attempt=1, head_sha=m.CONTROLLER, head_branch="main",
               path=".github/workflows/staging-consumer-refresh.yml", event="workflow_dispatch",
               status="completed", conclusion="failure", repository=repository, head_repository=repository)
    artifact = dict(id=m.ARTIFACT, name=f"staging-consumer-{m.RUN}-1", size_in_bytes=m.SIZE,
                    digest="sha256:" + m.ZIP_SHA, expired=False, expires_at="2026-09-19T20:01:01Z",
                    created_at="2026-09-05T20:01:02Z", workflow_run=dict(id=m.RUN, head_sha=m.CONTROLLER,
                    repository_id=m.transport.REPO_ID, head_repository_id=m.transport.REPO_ID))
    steps = [dict(name=name, status="completed", conclusion=conclusion, started_at="2026-09-05T20:01:01Z", completed_at="2026-09-05T20:01:02Z") for name, conclusion in [
        ("Full consumer checks and controller rollback contracts", "success"),
        ("Read-only live boundary check", "success"),
        ("Guarded staging-only inactive upload and public-mode repair", "failure"),
        ("Recover prior staging version after interrupted activation", "success"),
        ("Retain non-secret staging boundary receipt", "success")]]
    job = dict(id=m.JOB, run_id=m.RUN, run_attempt=1, head_sha=m.CONTROLLER, name="refresh", status="completed", conclusion="failure", steps=steps)
    return run, artifact, job


class OwnedReceipt(unittest.TestCase):
    def test_exact_provenance_and_each_wrong_identity(self):
        original = evidence()
        now = datetime(2026, 9, 5, 21, tzinfo=timezone.utc)
        m.provenance(*original, now)
        for index, key, value in [(0,"id",1),(0,"run_attempt",2),(0,"head_sha","a"*40),(0,"head_branch","branch"),
                                 (0,"repository",{}),(0,"path","wrong"),(0,"conclusion","success"),
                                 (1,"id",1),(1,"expired",True),(1,"digest","sha256:"+"b"*64),
                                 (1,"size_in_bytes",3000),(1,"workflow_run",{}),(1,"created_at","2026-09-06T00:00:00Z"),
                                 (2,"id",1),(2,"run_attempt",2),(2,"steps",[])]:
            values = copy.deepcopy(original)
            values[index][key] = value
            with self.subTest(key=key, index=index), self.assertRaises(Exception):
                m.provenance(*values, now)
        with self.assertRaises(Exception):
            m.provenance(*original, datetime(2026, 9, 20, tzinfo=timezone.utc))

    def zip_bytes(self, name="receipt.json", mode=stat.S_IFREG | 0o600, duplicate=False, payload=None):
        result = io.BytesIO()
        with zipfile.ZipFile(result,"w",zipfile.ZIP_DEFLATED) as archive:
            member=zipfile.ZipInfo(name);member.external_attr=mode<<16
            archive.writestr(member,payload if payload is not None else (ROOT / "tests/fixtures/staging-owned-receipt.json").read_bytes())
            if duplicate: archive.writestr("extra.json",b"{}")
        return result.getvalue()

    def validate_synthetic_zip(self, raw):
        with patch.object(m,"SIZE",len(raw)),patch.object(m,"ZIP_SHA",hashlib.sha256(raw).hexdigest()):
            return m.receipt_bytes(raw)

    def test_exact_receipt_bytes_and_safe_archive(self):
        self.assertEqual(self.validate_synthetic_zip(self.zip_bytes()),(ROOT / "tests/fixtures/staging-owned-receipt.json").read_bytes())
        for raw in [self.zip_bytes("../receipt.json"),self.zip_bytes("/receipt.json"),self.zip_bytes("foo\\receipt.json"),
                    self.zip_bytes(mode=stat.S_IFLNK|0o777),self.zip_bytes(duplicate=True),self.zip_bytes(payload=b"SECRET"),
                    self.zip_bytes(payload=b"x"*65537)]:
            with self.assertRaises(Exception): self.validate_synthetic_zip(raw)
        with self.assertRaises(Exception): m.receipt_bytes(self.zip_bytes())

    def test_transport_is_existing_detached_readonly_implementation(self):
        self.assertEqual(m.transport.GitHub.__module__,"recovery_transport")
        for url in ["http://safe.blob.core.windows.net/x","https://evil.test/x","https://user:SECRET@safe.blob.core.windows.net/x"]:
            with self.assertRaises(Exception): m.transport.artifact_url(url)
        self.assertEqual(m.transport.artifact_url("https://safe.blob.core.windows.net/x"),"https://safe.blob.core.windows.net/x")

    def test_public_failure_never_leaks_raw_exception_or_environment(self):
        result = subprocess.run([sys.executable,str(ROOT / "tools/staging-consumer-reuse.py"),"--output","/unused"],
                                env={"GH_TOKEN":"SECRET","GITHUB_ACTIONS":"false"},capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stderr,"Owned staging receipt admission refused\n")
        self.assertNotIn("SECRET",result.stdout+result.stderr)


if __name__ == "__main__": unittest.main()
