#!/usr/bin/env python3
"""Admit one exact historical staging receipt; read-only GitHub transport only."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location("recovery_transport", Path(__file__).with_name("recover-model-inputs.py"))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
RUN = 33988771315
JOB = 101367107255
ARTIFACT = 9975982597
CONTROLLER = "e85a47db696957887d440e8b37c59fa935c33aae"
ZIP_SHA = "43ec3ca54e9f0033461d1c753464865cf62b32cbfb3da4199a6bca62acead339"
RECEIPT_SHA = "4eb744b4691f0fc76265c30776e9ddde81397058c715c222bc8b3d5cce842b69"
SIZE = 2043
require = transport.require


def provenance(run, artifact, job, now):
    require(run.get("id") == RUN and run.get("run_attempt") == 1
            and run.get("head_sha") == CONTROLLER and run.get("head_branch") == "main"
            and run.get("path") == ".github/workflows/staging-consumer-refresh.yml"
            and run.get("event") == "workflow_dispatch" and run.get("status") == "completed"
            and run.get("conclusion") == "failure", "origin-run")
    for key in ("repository", "head_repository"):
        require(run.get(key, {}).get("id") == transport.REPO_ID
                and run[key].get("full_name") == transport.REPO, "origin-repository")
    require(artifact.get("id") == ARTIFACT and artifact.get("name") == f"staging-consumer-{RUN}-1"
            and artifact.get("size_in_bytes") == SIZE and artifact.get("digest") == "sha256:" + ZIP_SHA
            and artifact.get("expired") is False and transport.timestamp(artifact["expires_at"]) > now,
            "origin-artifact")
    origin = artifact.get("workflow_run", {})
    require(origin.get("id") == RUN and origin.get("head_sha") == CONTROLLER
            and origin.get("repository_id") == transport.REPO_ID
            and origin.get("head_repository_id") == transport.REPO_ID, "artifact-origin")
    require(job.get("id") == JOB and job.get("run_id") == RUN and job.get("run_attempt") == 1
            and job.get("head_sha") == CONTROLLER and job.get("name") == "refresh"
            and job.get("status") == "completed" and job.get("conclusion") == "failure", "origin-job")
    for name, conclusion in (
        ("Full consumer checks and controller rollback contracts", "success"),
        ("Read-only live boundary check", "success"),
        ("Guarded staging-only inactive upload and public-mode repair", "failure"),
        ("Recover prior staging version after interrupted activation", "success"),
        ("Retain non-secret staging boundary receipt", "success"),
    ):
        steps = [step for step in job.get("steps", []) if step.get("name") == name]
        require(len(steps) == 1 and steps[0].get("status") == "completed"
                and steps[0].get("conclusion") == conclusion, "origin-step")
        if name.startswith("Retain"):
            require(transport.timestamp(steps[0]["started_at"]) <= transport.timestamp(artifact["created_at"])
                    <= transport.timestamp(steps[0]["completed_at"]), "artifact-time")


def receipt_bytes(raw):
    require(len(raw) == SIZE and hashlib.sha256(raw).hexdigest() == ZIP_SHA, "archive-digest")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        require(len(members) == 1, "archive-members")
        member = members[0]
        mode = member.external_attr >> 16
        require(member.filename == "receipt.json" and not member.is_dir()
                and stat.S_IFMT(mode) in (0, stat.S_IFREG) and not member.flag_bits & 1
                and 0 < member.file_size <= 65536, "archive-member")
        with archive.open(member) as stream:
            data = stream.read(65537)
        require(len(data) == member.file_size and hashlib.sha256(data).hexdigest() == RECEIPT_SHA,
                "receipt-digest")
        json.loads(data)
        return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_REPOSITORY") == transport.REPO, "hosted-manual-only")
    github = transport.GitHub(os.environ.get("GH_TOKEN"))
    provenance(github.json(f"/actions/runs/{RUN}/attempts/1"),
               github.json(f"/actions/artifacts/{ARTIFACT}"),
               github.json(f"/actions/jobs/{JOB}"), datetime.now(timezone.utc))
    with tempfile.TemporaryDirectory(prefix="staging-origin-") as directory:
        archive = Path(directory) / "receipt.zip"
        github.download(ARTIFACT, archive, SIZE, ZIP_SHA)
        data = receipt_bytes(archive.read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.output.open("xb") as target:
        os.chmod(args.output, 0o600)
        target.write(data)
    print("Owned staging receipt provenance verified; no deployment performed")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Owned staging receipt admission refused", file=sys.stderr)
        sys.exit(1)
