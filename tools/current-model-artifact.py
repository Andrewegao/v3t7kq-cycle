#!/usr/bin/env python3
"""Prepare one authenticated current-run model artifact for a future component publisher.

This helper does not publish. It copies one successful collector artifact and, for a
regional model, an authenticated staging baseline into an atomic handoff bundle.
"""
import sys

if __name__ == "__main__" and not sys.flags.isolated:
    print("current model artifact handoff requires python -I", file=sys.stderr)
    raise SystemExit(2)

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import types
import urllib.parse

REPO_ROOT = Path(__file__).resolve().parents[1]
LEGACY_PATH = REPO_ROOT / "tools/recover-model-inputs.py"
legacy = types.ModuleType("_weatherx_recovery_transport")
legacy.__file__ = str(LEGACY_PATH)
# Compile the reviewed source bytes directly. An ignored __pycache__ file can never
# substitute code before checkout provenance is checked.
exec(compile(LEGACY_PATH.read_bytes(), str(LEGACY_PATH), "exec"), legacy.__dict__)

REPO = legacy.REPO
REPO_ID = legacy.REPO_ID
WORKFLOW = ".github/workflows/bake.yml"
CORE = ("ecmwf", "gfs", "hrrr", "aifs")
REGIONAL = ("icon", "hrdps", "arome-antilles", "hrrr-ak", "nam", "nam-hi", "nam-ak")
MODELS = CORE + REGIONAL
SHA = re.compile(r"[a-f0-9]{40}")
SHA256 = re.compile(r"[a-f0-9]{64}")
RUN = re.compile(r"[1-9][0-9]*")
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
MAX_JSON = 2 * 1024**2
STAGING_CATALOG = "weatherx:weatherx-data-staging"
STAGING_COMPONENTS = "weatherx:weatherx-components-staging"


class Refusal(Exception):
    """Authenticated or integrity evidence is invalid; never treat as absence."""


class Withheld(Exception):
    """The selected model has no usable completed artifact yet."""


def require(value, reason):
    if not value:
        raise Refusal(reason)


def parse_time(value, reason="timestamp-invalid"):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        raise Refusal(reason) from None
    require(parsed.tzinfo is not None, reason)
    return parsed


def hash_file(path, limit=legacy.MAX_MEMBER):
    require(path.is_file() and not path.is_symlink(), "handoff-file-missing-or-linked")
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        while chunk := source.read(1024**2):
            size += len(chunk)
            require(size <= limit, "handoff-file-size-bound")
            digest.update(chunk)
    return {"size": size, "sha256": digest.hexdigest()}


def read_json(path, reason="handoff-json-invalid"):
    info = hash_file(path, MAX_JSON)
    require(info["size"] > 0, reason)
    try:
        value = json.loads(path.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise Refusal(reason) from None
    require(isinstance(value, dict), reason)
    return value


def git(root, *args):
    try:
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL,
                                       text=True).strip()
    except subprocess.CalledProcessError:
        raise Refusal("checkout-identity-unavailable") from None


def assert_clean_checkout(root, source_sha, label):
    root = Path(root).resolve()
    require(root.is_dir() and not root.is_symlink(), f"{label}-checkout-missing")
    require(git(root, "rev-parse", "HEAD") == source_sha, f"{label}-checkout-source-mismatch")
    status = subprocess.run(["git", "-C", str(root), "status", "--porcelain=v1", "-z",
                             "--untracked-files=all"], capture_output=True)
    require(status.returncode == 0 and not status.stdout, f"{label}-checkout-dirty")
    ignored = subprocess.run(["git", "-C", str(root), "ls-files", "--others", "--ignored",
                              "--exclude-standard", "-z"], capture_output=True)
    require(ignored.returncode == 0, f"{label}-checkout-identity-unavailable")
    trusted_runtime = ("data/.venv/", "node_modules/", "app/node_modules/")
    unsafe = [path for path in ignored.stdout.decode("utf-8", "strict").split("\0") if path
              and not path.startswith(trusted_runtime)]
    require(not unsafe, f"{label}-checkout-ignored-input")


def atmos_refs(workflow):
    lines = workflow.splitlines()
    refs = []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)repository:\s*(?:weatherx-hq|Andrewegao)/atmos\s*$", line)
        if not match:
            continue
        indent = len(match.group(1))
        found = None
        for candidate in lines[index + 1:]:
            if candidate.strip() and len(candidate) - len(candidate.lstrip()) < indent:
                break
            ref = re.match(r"^\s*ref:\s*([a-f0-9]{40})\s*(?:#.*)?$", candidate)
            if ref:
                found = ref.group(1)
                break
        require(found is not None, "atmos-workflow-ref-missing")
        refs.append(found)
    require(len(refs) >= 3, "atmos-workflow-checkout-count")
    return refs


def artifact_name(kind, model):
    return f"{'core-model-packs' if kind == 'core' else 'regional-packs'}-{model}"


def expected_steps(kind):
    if kind == "core":
        return ("Verify approved immutable core collector before running source",
                "collect one core model and seal its map, point and float inputs",
                "retain only sealed core model inputs for the joined bake")
    return ("Verify approved immutable regional collector before running source",
            "collect one regional model for the newest complete cycle (one older-cycle fallback)",
            "hand the display packs (or abstention receipts) to the bake job")


def one_step(job, name):
    rows = [row for row in job.get("steps", []) if row.get("name") == name]
    require(len(rows) == 1 and rows[0].get("status") == "completed"
            and rows[0].get("conclusion") == "success", "collector-step-not-successful")
    return rows[0]


def exact_run(client, run_id, attempt, controller_sha):
    try:
        run = client.json(f"/actions/runs/{run_id}")
    except legacy.Miss:
        raise Withheld("collector-run-unavailable") from None
    require(run.get("id") == int(run_id) and run.get("run_attempt") == attempt
            and run.get("head_sha") == controller_sha and run.get("path") == WORKFLOW
            and run.get("event") in ("schedule", "workflow_dispatch")
            and run.get("status") in ("in_progress", "completed")
            and run.get("repository", {}).get("id") == REPO_ID
            and run.get("repository", {}).get("full_name") == REPO
            and run.get("head_repository", {}).get("id") == REPO_ID
            and run.get("head_repository", {}).get("full_name") == REPO,
            "collector-run-provenance")
    return run


def exact_job(client, run_id, attempt, controller_sha, kind, model):
    try:
        page = client.json(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    except legacy.Miss:
        raise Withheld("collector-job-unavailable") from None
    jobs = page.get("jobs")
    require(isinstance(jobs, list) and page.get("total_count") == len(jobs) and len(jobs) <= 100,
            "collector-job-page-incomplete")
    selected = [job for job in jobs if job.get("name") == f"{kind} ({model})"]
    if not selected:
        raise Withheld("collector-job-not-complete")
    require(len(selected) == 1, "collector-job-duplicate")
    job = selected[0]
    if job.get("status") != "completed" or job.get("conclusion") not in ("success",):
        raise Withheld("collector-job-not-successful")
    require(job.get("run_id") == int(run_id) and job.get("run_attempt") == attempt
            and job.get("head_sha") == controller_sha and type(job.get("id")) is int
            and job["id"] > 0, "collector-job-provenance")
    source, collect, upload = (one_step(job, name) for name in expected_steps(kind))
    require(parse_time(source.get("started_at")) <= parse_time(source.get("completed_at"))
            <= parse_time(collect.get("started_at")) <= parse_time(collect.get("completed_at"))
            <= parse_time(upload.get("started_at")) <= parse_time(upload.get("completed_at")),
            "collector-step-order")
    return job, upload


def exact_artifact(client, run_id, attempt, controller_sha, kind, model, upload, now):
    name = artifact_name(kind, model)
    suffix = (f"/actions/runs/{run_id}/artifacts?per_page=100&name="
              + urllib.parse.quote(name, safe=""))
    try:
        page = client.json(suffix)
    except legacy.Miss:
        raise Withheld("collector-artifact-unavailable") from None
    artifacts = page.get("artifacts")
    require(isinstance(artifacts, list) and page.get("total_count") == len(artifacts)
            and len(artifacts) <= 100, "collector-artifact-page-incomplete")
    started, ended = parse_time(upload.get("started_at")), parse_time(upload.get("completed_at"))
    selected = [row for row in artifacts if row.get("name") == name
                and isinstance(row.get("created_at"), str)
                and started <= parse_time(row["created_at"]) <= ended]
    if not selected:
        raise Withheld("collector-artifact-not-uploaded")
    require(len(selected) == 1, "collector-artifact-duplicate")
    artifact = selected[0]
    digest = artifact.get("digest", "")
    size = artifact.get("size_in_bytes")
    require(type(artifact.get("id")) is int and artifact["id"] > 0
            and type(size) is int and 0 < size <= legacy.MAX_ARCHIVE
            and isinstance(digest, str) and digest.startswith("sha256:")
            and SHA256.fullmatch(digest[7:])
            and artifact.get("workflow_run", {}).get("id") == int(run_id)
            and artifact.get("workflow_run", {}).get("head_sha") == controller_sha
            and artifact.get("workflow_run", {}).get("repository_id") == REPO_ID
            and artifact.get("workflow_run", {}).get("head_repository_id") == REPO_ID,
            "collector-artifact-provenance")
    if artifact.get("expired") or parse_time(artifact.get("expires_at")) <= now:
        raise Withheld("collector-artifact-expired")
    return artifact


def inspect_pack(packs, kind, model, source_sha, run_id):
    if kind == "core":
        receipt_path = packs / model / "manifest.json"
        receipt = read_json(receipt_path, "core-artifact-receipt-invalid")
        require(receipt.get("schemaVersion") == 1 and receipt.get("status") == "unqualified-core-inputs"
                and receipt.get("model") == model and receipt.get("sourceSha") == source_sha
                and str(receipt.get("runId")) == run_id and isinstance(receipt.get("forecastRun"), str)
                and isinstance(receipt.get("files"), list), "core-artifact-receipt-identity")
        return {"receipt": str(receipt_path.relative_to(packs)),
                "receiptSha256": hash_file(receipt_path, MAX_JSON)["sha256"]}
    receipt_path = packs / model / "pack-receipt.json"
    receipt = read_json(receipt_path, "regional-artifact-receipt-invalid")
    require(receipt.get("schemaVersion") == 1 and receipt.get("kind") == "weatherx-regional-model-pack"
            and receipt.get("model") == model and receipt.get("sourceSha") == source_sha,
            "regional-artifact-receipt-identity")
    if receipt.get("status") == "abstained":
        raise Withheld("regional-provider-abstained")
    require(receipt.get("status") == "collected" and re.fullmatch(r"[0-9]{10}", receipt.get("init", ""))
            and SHA256.fullmatch(receipt.get("sourceReceiptSha256", "")),
            "regional-artifact-receipt-status")
    point_path = packs / "point-stages" / model / "point-stage-receipt.json"
    point = read_json(point_path, "regional-point-receipt-invalid")
    point_run = point.get("sourceRun", point.get("init"))
    require(point.get("model") == model and point_run == receipt["init"]
            and point.get("sourceQualificationSha256") == receipt["sourceReceiptSha256"],
            "regional-point-receipt-identity")
    return {"receipt": str(receipt_path.relative_to(packs)),
            "receiptSha256": hash_file(receipt_path, MAX_JSON)["sha256"],
            "pointReceipt": str(point_path.relative_to(packs)),
            "pointReceiptSha256": hash_file(point_path, MAX_JSON)["sha256"],
            "forecastRun": receipt["init"]}


def tree_inventory(root):
    require(root.is_dir() and not root.is_symlink(), "baseline-tree-missing")
    rows, total = [], 0
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix().encode("utf-16-be")):
        require(not path.is_symlink(), "baseline-tree-linked")
        if path.is_dir():
            continue
        require(path.is_file(), "baseline-tree-special-entry")
        relative = path.relative_to(root).as_posix()
        require(relative and len(relative) <= 1024 and all(part not in ("", ".", "..")
                for part in relative.split("/")), "baseline-tree-path")
        row = hash_file(path)
        rows.append({"path": relative, "size": row["size"], "sha256": row["sha256"]})
        total += row["size"]
        require(len(rows) <= legacy.MAX_FILES and total <= legacy.MAX_EXPANDED,
                "baseline-tree-size-bound")
    require(rows, "baseline-tree-empty")
    return rows


def inventory_digest(rows):
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def env_file(path):
    values = {}
    if not path.exists():
        return values
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 8192,
            "baseline-env-invalid")
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        require(separator and key in {"EXPECTED_COMPONENT_MANIFEST_SHA256",
                "EXPECTED_CATALOG_ROLLBACK_EPOCH", "ACTIVE_COMPONENT_GENERATION_TIME"}
                and key not in values and "\0" not in value, "baseline-env-invalid")
        values[key] = value
    return values


def hydrate_baseline(atmos_root, model, destination, runner=subprocess.run):
    script = Path(atmos_root) / "ops/platform/hydrate-r2-component.sh"
    require(script.is_file() and not script.is_symlink(), "baseline-hydrator-missing")
    component_output, github_env = destination.parent / "component.json", destination.parent / "hydrate.env"
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("GH_TOKEN", "GITHUB_TOKEN")}
    environment.update({"COMPONENT_ID": model, "CATALOG_R2_REMOTE": STAGING_CATALOG,
        "COMPONENT_R2_REMOTE": STAGING_COMPONENTS, "ALLOW_EMPTY_CATALOG": "1",
        "ALLOW_MISSING_COMPONENT": "1", "HYDRATE_MISSING_FROM_RELEASE": "1",
        "ALLOW_EXTERNAL_DESTINATION": "1", "DESTINATION": str(destination),
        "COMPONENT_MANIFEST_OUTPUT": str(component_output), "GITHUB_ENV": str(github_env),
        # Force the reviewed staging rclone transport. Caller environment cannot redirect
        # this read to production, a REST bucket, or a locally supplied catalog snapshot.
        "CATALOG_R2_BUCKET": "", "COMPONENT_R2_BUCKET": "", "PINNED_CATALOG_POINTER": "",
        "PINNED_CATALOG_SNAPSHOT": "", "PRECONDITION_ONLY": "0"})
    try:
        result = runner(["bash", str(script)], cwd=atmos_root, env=environment,
                        capture_output=True, timeout=900)
    except (OSError, subprocess.SubprocessError):
        raise Refusal("baseline-hydration-failed") from None
    require(result.returncode == 0, "baseline-hydration-failed")
    text = result.stdout.decode("utf-8", "strict") if isinstance(result.stdout, bytes) else result.stdout
    lines = [line for line in text.splitlines() if line.startswith(f"hydrated {model} from ")]
    require(len(lines) == 1, "baseline-hydration-receipt")
    catalog = re.fullmatch(rf"hydrated {re.escape(model)} from catalog ([A-Za-z0-9][A-Za-z0-9._-]{{0,95}})", lines[0])
    release = re.fullmatch(rf"hydrated {re.escape(model)} from fallback release ([A-Za-z0-9][A-Za-z0-9._-]{{0,95}})", lines[0])
    require(bool(catalog) ^ bool(release), "baseline-hydration-receipt")
    rows = tree_inventory(destination)
    values = env_file(github_env)
    evidence = {"source": "catalog" if catalog else "fallback-release",
                "identity": (catalog or release).group(1), "objectCount": len(rows),
                "inventorySha256": inventory_digest(rows)}
    if catalog:
        expected = values.get("EXPECTED_COMPONENT_MANIFEST_SHA256", "")
        require(SHA256.fullmatch(expected or ""), "baseline-component-precondition")
        info = hash_file(component_output, MAX_JSON)
        require(info["sha256"] == expected, "baseline-component-manifest-hash")
        manifest = read_json(component_output, "baseline-component-manifest-invalid")
        root_prefix = manifest.get("rootPrefix", "")
        require(manifest.get("schemaVersion") == 1 and manifest.get("componentId") == model
                and SAFE_ID.fullmatch(manifest.get("artifactId", ""))
                and re.fullmatch(rf"components/{re.escape(model)}/[A-Za-z0-9][A-Za-z0-9._-]{{0,95}}/",
                                 root_prefix)
                and manifest.get("mounts") == [f"data/{model}/"]
                and manifest.get("objectCount") == len(rows)
                and manifest.get("inventorySha256") == evidence["inventorySha256"]
                and manifest.get("quality", {}).get("status") == "passed"
                and all(check in manifest.get("quality", {}).get("checks", [])
                        for check in ("manifest", "inventory", "remote_bytes")),
                "baseline-component-manifest-identity")
        evidence["componentManifestSha256"] = expected
    else:
        require(values.get("EXPECTED_COMPONENT_MANIFEST_SHA256", "") == "",
                "baseline-fallback-precondition")
    index = read_json(destination / "index.json", "baseline-index-invalid")
    runs = index.get("runs")
    require(index.get("schemaVersion") == 1 and index.get("model") == model
            and isinstance(runs, list) and runs, "baseline-index-identity")
    latest = runs[0]
    require(isinstance(latest, dict) and re.fullmatch(r"runs/[0-9]{10}/", latest.get("path", "")),
            "baseline-index-run")
    manifest_path = destination / latest["path"] / "manifest.json"
    manifest = read_json(manifest_path, "baseline-model-manifest-invalid")
    require(manifest.get("model") == model and manifest.get("init_time") == latest.get("init_time"),
            "baseline-model-manifest-identity")
    evidence.update({"forecastRun": latest["path"].split("/")[1],
                     "manifest": str(manifest_path),
                     "manifestSha256": hash_file(manifest_path, MAX_JSON)["sha256"]})
    return evidence


def transfer(args, client, now, hydrate=hydrate_baseline):
    kind = "core" if args.model in CORE else "regional"
    require(args.kind == kind, "model-kind-mismatch")
    exact_run(client, args.run_id, args.run_attempt, args.controller_sha)
    job, upload = exact_job(client, args.run_id, args.run_attempt, args.controller_sha, kind, args.model)
    artifact = exact_artifact(client, args.run_id, args.run_attempt, args.controller_sha,
                              kind, args.model, upload, now)
    requested_output = Path(args.output)
    require(requested_output.is_absolute(), "handoff-output-must-be-absolute")
    output = requested_output.parent.resolve() / requested_output.name
    controller_root = REPO_ROOT.resolve()
    atmos_root = Path(args.atmos_root).resolve()
    require(not output.is_relative_to(controller_root) and not output.is_relative_to(atmos_root),
            "handoff-output-inside-source-checkout")
    require(not output.exists() and output.parent.is_dir() and not output.parent.is_symlink(),
            "handoff-output-invalid")
    scratch = Path(tempfile.mkdtemp(prefix=".current-model-handoff-", dir=output.parent))
    try:
        archive, packs, bundle = scratch / "artifact.zip", scratch / "packs", scratch / "bundle"
        client.download(artifact["id"], archive, artifact["size_in_bytes"], artifact["digest"][7:])
        legacy.extract(archive, packs, kind, args.model)
        pack = inspect_pack(packs, kind, args.model, args.atmos_source_sha, args.run_id)
        baseline = None
        if kind == "regional":
            baseline_tree = scratch / "baseline" / args.model
            baseline_tree.parent.mkdir()
            baseline = hydrate(args.atmos_root, args.model, baseline_tree)
        assert_clean_checkout(args.atmos_root, args.atmos_source_sha, "atmos")
        bundle.mkdir()
        packs.rename(bundle / "packs")
        if baseline:
            destination = bundle / "baseline-manifest.json"
            shutil.copyfile(baseline["manifest"], destination)
            require(hash_file(destination, MAX_JSON)["sha256"] == baseline["manifestSha256"],
                    "baseline-manifest-copy-mismatch")
            baseline = {key: value for key, value in baseline.items() if key != "manifest"}
            baseline["bundledManifest"] = "baseline-manifest.json"
        handoff = {"schemaVersion": 1, "kind": "weatherx-current-model-artifact-handoff",
            "status": "ready", "publicationAuthorized": False, "model": args.model,
            "componentKind": kind, "origin": {"repository": REPO, "repositoryId": REPO_ID,
                "workflow": WORKFLOW, "runId": args.run_id, "runAttempt": args.run_attempt,
                "controllerSha": args.controller_sha, "atmosSourceSha": args.atmos_source_sha,
                "jobId": job["id"], "jobName": job["name"], "artifactId": artifact["id"],
                "artifactName": artifact["name"], "artifactSha256": artifact["digest"][7:],
                "artifactBytes": artifact["size_in_bytes"], "artifactCreatedAt": artifact["created_at"]},
            "pack": pack, **({"regionalBaseline": baseline} if baseline else {})}
        body = (json.dumps(handoff, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        (bundle / "handoff.json").write_bytes(body)
        bundle.rename(output)
        return handoff
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def write_outputs(path, values):
    path = str(path)
    require(path and "\n" not in path and "\0" not in path, "github-output-invalid")
    with open(path, "a", encoding="utf-8") as output:
        for key, value in values.items():
            require(re.fullmatch(r"[a-z_]+", key) and "\n" not in str(value), "github-output-invalid")
            output.write(f"{key}={value}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", type=int, required=True)
    parser.add_argument("--controller-sha", required=True)
    parser.add_argument("--atmos-source-sha", required=True)
    parser.add_argument("--atmos-root", required=True)
    parser.add_argument("--kind", choices=("core", "regional"), required=True)
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--github-output", required=True)
    args = parser.parse_args()
    try:
        require(RUN.fullmatch(args.run_id) and args.run_attempt > 0
                and SHA.fullmatch(args.controller_sha) and SHA.fullmatch(args.atmos_source_sha),
                "handoff-arguments-invalid")
        require(os.environ.get("GITHUB_RUN_ID") == args.run_id
                and os.environ.get("GITHUB_RUN_ATTEMPT") == str(args.run_attempt)
                and os.environ.get("GITHUB_SHA") == args.controller_sha,
                "current-workflow-identity")
        assert_clean_checkout(REPO_ROOT, args.controller_sha, "controller")
        assert_clean_checkout(args.atmos_root, args.atmos_source_sha, "atmos")
        workflow = (REPO_ROOT / WORKFLOW).read_text()
        require(set(atmos_refs(workflow)) == {args.atmos_source_sha}, "atmos-workflow-source-mismatch")
        handoff = transfer(args, legacy.GitHub(os.environ.get("GH_TOKEN", "")),
                           datetime.now(timezone.utc))
        write_outputs(args.github_output, {"status": "ready", "reason": "authenticated-current-model-artifact",
            "bundle": args.output, "handoff_sha256": hash_file(Path(args.output) / "handoff.json", MAX_JSON)["sha256"]})
        print(f"{args.model}: authenticated current-run artifact ready; publication not authorized")
    except Withheld as error:
        write_outputs(args.github_output, {"status": "withheld", "reason": str(error)})
        print(f"{args.model}: {error}")
    except Exception as error:
        reason = str(error) if isinstance(error, Refusal) else "unexpected-current-model-handoff-failure"
        print(f"current model artifact handoff refused: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
