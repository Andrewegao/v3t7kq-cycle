#!/usr/bin/env python3
"""Read-only GitHub artifact recovery; payloads never supply executable code.

Missing/expired artifacts and explicit Atmos incompatibility are cache misses.
Forged provenance, bad archives/digests, permission errors and unexpected verifier
failures stop the job. They must not silently trigger an expensive fresh bake.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "Andrewegao/v3t7kq-cycle"
REPO_ID = 1301196656
ORIGIN_RUN = "33925520386"
ORIGIN_SOURCE = "49dc566625dfe284cb31c79ccdddfc06d47cc5c5"
CONTROLLER = "1999df9977d43972b8be9467df278cf13209e467"
WORKFLOW = ".github/workflows/bake.yml"
# Reviewed GitHub metadata, not identities asserted by downloaded payloads.
# model: (kind, artifact id, archive SHA256, archive bytes, successful job id)
ARTIFACTS = {
    "ecmwf": ("core", 9957732901, "78fb2ab61133bcace48a9fdfffbacdd263721d1ec4b1c1f9706fea7dae469ec9", 862949655, 101198170348),
    "gfs": ("core", 9958023173, "fc859a094e217ab44936eb3d4b2dc679faa1dd0d4e903f04e7c49abb09ae0738", 1243091552, 101198170456),
    "hrrr": ("core", 9957442708, "87f8d3f172ca660766e517201a88094c5174f379730baabf374e879435a70c8d", 167555957, 101198170443),
    "aifs": ("core", 9957485888, "45e1192a0b602f8125810045b1b0134e20608c936c3236af3016c09d912b12f7", 444249664, 101198170548),
    "icon": ("regional", 9957562724, "f35212028faf5343fba5a22c68103838419f4693c309d8a2337e2bc9f90232f4", 38291122, 101198170494),
    "hrdps": ("regional", 9957937398, "d6abdb6342cb71ed77db9f5ffda332e96a64b2e36afe856a5a2cefa9300dee44", 117601597, 101198170509),
    "nam": ("regional", 9957413521, "9c43e86de5602e1467d4ba543205a8628e895ab5a91c8f0daf51ecb8813227d9", 38199687, 101198170514),
    "nam-ak": ("regional", 9957371720, "68270e9d68f54efbb561b409d3971c772567af15cfb49d3e395dca451b9f4d90", 36531436, 101198170459),
    "nam-hi": ("regional", 9957253991, "43b209c1ae66c5a9d78c213a32796e58570f17f6724f6242c0a9317dbd143633", 1539987, 101198170567),
    "hrrr-ak": ("regional", 9957328626, "121d5ce254837e2ea124f6985849f1284939e4f362eedb6e464b79625a922027", 34849198, 101198170540),
    "arome-antilles": ("regional", 9957329332, "6417b4511fe4976c8ff7e770dff260fce40a5d8702470260736abba7780f6301", 13163081, 101198170437),
}
MAX_ARCHIVE = 2 * 1024**3
MAX_EXPANDED = 32 * 1024**3
MAX_MEMBER = 2 * 1024**3
MAX_FILES = 200000


class Refusal(Exception):
    pass


class Miss(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def validate_request(run, event):
    require(run in ("", ORIGIN_RUN), "unsupported-recovery-run")
    require(not run or event == "workflow_dispatch", "recovery-requires-manual-dispatch")


def verify_provenance(run, artifact, job, model, now):
    kind, artifact_id, sha, size, job_id = ARTIFACTS[model]
    require(run.get("id") == int(ORIGIN_RUN) and run.get("run_attempt") == 1
            and run.get("head_sha") == CONTROLLER and run.get("path") == WORKFLOW
            and run.get("event") == "schedule" and run.get("status") == "completed"
            and run.get("conclusion") == "failure"
            and run.get("repository", {}).get("full_name") == REPO
            and run.get("repository", {}).get("id") == REPO_ID
            and run.get("head_repository", {}).get("full_name") == REPO
            and run.get("head_repository", {}).get("id") == REPO_ID, "origin-run-identity")
    name = f"core-model-packs-{model}" if kind == "core" else f"regional-packs-{model}"
    require(artifact.get("id") == artifact_id and artifact.get("name") == name
            and artifact.get("size_in_bytes") == size and size <= MAX_ARCHIVE
            and artifact.get("digest") == "sha256:" + sha, "artifact-identity")
    origin = artifact.get("workflow_run", {})
    require(origin.get("id") == int(ORIGIN_RUN) and origin.get("head_sha") == CONTROLLER
            and origin.get("repository_id") == REPO_ID and origin.get("head_repository_id") == REPO_ID,
            "artifact-run-identity")
    require(job.get("id") == job_id and job.get("run_id") == int(ORIGIN_RUN)
            and job.get("run_attempt") == 1 and job.get("head_sha") == CONTROLLER
            and job.get("name") == f"{kind} ({model})" and job.get("status") == "completed"
            and job.get("conclusion") == "success", "collector-job-identity")
    upload_name = ("retain only sealed core model inputs for the joined bake" if kind == "core"
                   else "hand the display packs (or abstention receipts) to the bake job")
    upload = [s for s in job.get("steps", []) if s.get("name") == upload_name]
    require(len(upload) == 1 and upload[0].get("status") == "completed"
            and upload[0].get("conclusion") == "success", "collector-upload-not-successful")
    require(timestamp(upload[0]["started_at"]) <= timestamp(artifact["created_at"])
            <= timestamp(upload[0]["completed_at"]), "artifact-upload-time-mismatch")
    if artifact.get("expired") or timestamp(artifact["expires_at"]) <= now:
        raise Miss("artifact-expired")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def artifact_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    require(parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443)
            and any(host.endswith(suffix) for suffix in (".blob.core.windows.net", ".actions.githubusercontent.com")),
            "artifact-redirect-host")
    return url


class GitHub:
    def __init__(self, token):
        require(bool(token), "missing-actions-read-token")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, suffix):
        require(suffix.startswith("/") and ".." not in suffix, "api-path")
        request = urllib.request.Request("https://api.github.com/repos/" + REPO + suffix,
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "weatherx-model-recovery"})
        return self.opener.open(request, timeout=45)

    def json(self, suffix):
        try:
            with self.request(suffix) as response:
                data = response.read(2 * 1024**2 + 1)
            require(len(data) <= 2 * 1024**2, "api-response-bound")
            return json.loads(data)
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                raise Miss("artifact-unavailable") from None
            raise Refusal("github-api-request-failed") from None

    def download(self, artifact_id, destination, size, expected_hash):
        try:
            response = self.request(f"/actions/artifacts/{artifact_id}/zip")
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                raise Miss("artifact-unavailable") from None
            require(error.code == 302, "artifact-download-request-failed")
            url = artifact_url(error.headers.get("Location", ""))
            # A NEW request with no credentials or cookies; never forward the API token.
            response = self.opener.open(urllib.request.Request(url), timeout=45)
        with response, destination.open("xb") as output:
            digest, count, deadline = hashlib.sha256(), 0, time.monotonic() + 600
            while chunk := response.read(1024**2):
                count += len(chunk)
                require(count <= size and count <= MAX_ARCHIVE, "archive-size-bound")
                require(time.monotonic() < deadline, "archive-download-deadline")
                digest.update(chunk)
                output.write(chunk)
        require(count == size and digest.hexdigest() == expected_hash, "archive-digest-mismatch")


def extract(archive, output, kind, model):
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        require(0 < len(entries) <= MAX_FILES, "archive-member-bound")
        seen, expanded = set(), 0
        for entry in entries:
            name = entry.filename
            path = PurePosixPath(name)
            mode = entry.external_attr >> 16
            require(entry.orig_filename == name and name and not name.startswith("/") and "\\" not in name and ":" not in name
                    and not any(ord(c) < 32 for c in name)
                    and all(part not in ("", ".", "..") for part in name.rstrip("/").split("/")), "archive-unsafe-path")
            normalized = str(path)
            require(normalized not in seen, "archive-duplicate-path")
            seen.add(normalized)
            require(not (entry.flag_bits & 1) and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                    "archive-special-member")
            require(path.parts[0] == model or (kind == "regional" and path.parts[0] == "point-stages"
                    and (len(path.parts) == 1 or path.parts[1] == model)), "archive-unowned-path")
            require(entry.file_size <= MAX_MEMBER, "archive-member-size-bound")
            expanded += entry.file_size
            require(expanded <= MAX_EXPANDED, "archive-expanded-bound")
        require(shutil.disk_usage(output.parent).free > expanded + 256 * 1024**2, "archive-insufficient-space")
        output.mkdir()
        actual_total = 0
        for entry in entries:
            target = output / entry.filename
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open("xb") as dest:
                    actual = 0
                    while chunk := source.read(1024**2):
                        actual += len(chunk)
                        actual_total += len(chunk)
                        require(actual <= entry.file_size and actual_total <= MAX_EXPANDED,
                                "archive-stream-size-bound")
                        dest.write(chunk)
                    require(actual == entry.file_size, "archive-member-size-mismatch")


def admit(args, packs):
    kind, artifact_id, sha, _, _ = ARTIFACTS[args.model]
    envelope = packs / "recovery-admissions" / f"{kind}-{args.model}.json"
    command = [str(Path(args.atmos_root) / "data/.venv/bin/python"),
        str(Path(args.atmos_root) / "ops/artifact_recovery.py"), "admit", "--kind", kind,
        "--model", args.model, "--packs", str(packs), "--origin-source-sha", ORIGIN_SOURCE,
        "--origin-run-id", ORIGIN_RUN, "--artifact-id", str(artifact_id), "--artifact-sha256", sha,
        "--source-sha", args.current_source_sha, "--run-id", os.environ["GITHUB_RUN_ID"],
        "--output", str(envelope)]
    env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")}
    result = subprocess.run(command, cwd=args.atmos_root, env=env, capture_output=True, timeout=300)
    if result.returncode == 3:
        raise Miss("current-source-incompatible-or-stale")
    require(result.returncode == 0 and envelope.is_file() and not envelope.is_symlink(), "admission-failed")


def recover(args, client, now):
    kind, artifact_id, sha, size, job_id = ARTIFACTS[args.model]
    require(args.kind == kind, "model-kind-mismatch")
    if args.model == "icon":
        raise Miss("retained-icon-point-stage-missing")
    run = client.json(f"/actions/runs/{ORIGIN_RUN}")
    artifact = client.json(f"/actions/artifacts/{artifact_id}")
    job = client.json(f"/actions/jobs/{job_id}")
    verify_provenance(run, artifact, job, args.model, now)
    output = Path(args.output).resolve()
    require(not output.exists(), "recovery-output-already-exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="weatherx-recovery-", dir=output.parent) as temporary:
        root = Path(temporary)
        archive, packs = root / "artifact.zip", root / "packs"
        client.download(artifact_id, archive, size, sha)
        extract(archive, packs, kind, args.model)
        admit(args, packs)
        packs.rename(output)


def verify_transfer(core, regional, source_sha, current_run):
    """Presence/identity only; Atmos still reruns full payload/envelope validators."""
    def receipt(path, root):
        require(path.is_file() and 0 < path.stat().st_size <= 8 * 1024**2, "transfer-receipt-missing")
        cursor = path
        while True:
            require(not cursor.is_symlink(), "transfer-linked-path")
            if cursor == root:
                break
            cursor = cursor.parent
        value = json.loads(path.read_bytes())
        require(isinstance(value, dict), "transfer-receipt-shape")
        return value
    for model, (kind, *_unused) in ARTIFACTS.items():
        root = Path(core if kind == "core" else regional).absolute()
        item = receipt(root / model / ("manifest.json" if kind == "core" else "pack-receipt.json"), root)
        require(item.get("model") == model, "transfer-model-identity")
        source = item.get("sourceSha")
        require(source in (source_sha, ORIGIN_SOURCE), "transfer-source-identity")
        if kind == "core":
            require(str(item.get("runId")) == (ORIGIN_RUN if source == ORIGIN_SOURCE else current_run),
                    "transfer-core-run-identity")
        if source == ORIGIN_SOURCE:
            require(model != "icon", "transfer-legacy-icon-forbidden")
            receipt(root / "recovery-admissions" / f"{kind}-{model}.json", root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--model", choices=ARTIFACTS)
    parser.add_argument("--kind", choices=("core", "regional"))
    parser.add_argument("--current-source-sha", required=True)
    parser.add_argument("--atmos-root", required=True)
    parser.add_argument("--output")
    parser.add_argument("--github-output")
    parser.add_argument("--verify-transfers", action="store_true")
    parser.add_argument("--core-packs")
    parser.add_argument("--regional-packs")
    args = parser.parse_args()
    try:
        validate_request(args.run_id, os.environ.get("GITHUB_EVENT_NAME", ""))
        require(re.fullmatch(r"[a-f0-9]{40}", args.current_source_sha), "invalid-current-source")
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.atmos_root, text=True).strip()
        require(head == args.current_source_sha, "current-checkout-source-mismatch")
        require(subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=args.atmos_root).returncode == 0,
                "dirty-current-source")
        require(re.fullmatch(r"[1-9][0-9]*", os.environ.get("GITHUB_RUN_ID", "")), "current-run-identity")
        if args.verify_transfers:
            require(args.run_id == ORIGIN_RUN and args.core_packs and args.regional_packs, "transfer-check-arguments")
            verify_transfer(args.core_packs, args.regional_packs, args.current_source_sha, os.environ["GITHUB_RUN_ID"])
            print("all eleven recovery transfers present; full Atmos validation still required")
            return 0
        require(args.model and args.kind and args.output and args.github_output, "recovery-arguments")
        if not args.run_id:
            raise Miss("normal-fresh-collection")
        recover(args, GitHub(os.environ.get("GH_TOKEN", "")), datetime.now(timezone.utc))
        reused, reason = True, "verified-retained-inputs"
    except Miss as error:
        reused, reason = False, str(error)
    except Exception as error:
        # No exception repr/traceback: HTTP errors may contain signed URLs.
        reason = str(error) if isinstance(error, Refusal) else "unexpected-recovery-failure"
        print(f"recovery refused: {reason}", file=sys.stderr)
        return 1
    with open(args.github_output, "a") as output:
        output.write(f"reused={str(reused).lower()}\nreason={reason}\n")
    print(f"{args.model}: {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
