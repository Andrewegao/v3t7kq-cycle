"""Offline structural admission only: never executes source or grants run authority.

Trusted metadata must be authenticated separately by the future controller. This
module does not fetch it, extract ZIPs, validate science, or authenticate a caller.
Even a conforming observation cannot become live or publication qualification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

WORKFLOW = ".github/workflows/train3-nonpublishing-validation.yml"
MODELS = [("core", m) for m in ("ecmwf", "gfs", "hrrr", "aifs")] + [
    ("regional", m) for m in ("icon", "hrdps", "arome-antilles", "hrrr-ak", "nam", "nam-hi", "nam-ak")]
PIN_NAMES = {"atmosCommit", "atmosTree", "controllerCommit", "controllerTree",
             "workflowSha256", "closureSha256", "shellSha256", "pythonSha256",
             "nodeSha256", "toolchainSha256", "pythonLockSha256", "nodeLockSha256",
             "baselineAuthoritySha256"}
GIT_PINS = {"atmosCommit", "atmosTree", "controllerCommit", "controllerTree"}
MAX_JSON = 1024 * 1024
MAX_ZIP = 16 * 1024**3


class Refusal(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)  # Never include untrusted environment/input values.


def keys(value, expected, reason):
    require(type(value) is dict and set(value) == set(expected), reason)


def positive(value, reason):
    require(type(value) is int and 0 < value < 2**63, reason)


def identifier(value, reason):
    require(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,19}", value), reason)


def digest(value, size, reason):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{" + str(size) + "}", value), reason)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def read_json(path):
    with Path(path).open("rb") as handle:
        raw = handle.read(MAX_JSON + 1)
    require(0 < len(raw) <= MAX_JSON, "json-byte-bound")
    try:
        return json.loads(raw, object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite-json")))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Refusal("invalid-json") from None


def validate_contract(contract, concrete=False):
    keys(contract, {"schemaVersion", "kind", "implementation", "trigger", "flags",
                    "permissions", "writers", "credentials", "sharedCacheWrites",
                    "productionEnvironment", "collectorModels", "workflowPath", "pins", "runtime"}, "contract-fields")
    require(type(contract["schemaVersion"]) is int and contract["schemaVersion"] == 1, "contract-version")
    require(contract["kind"] == "weatherx-train3-nonpublishing-contract-v1"
            and contract["implementation"] == "offline-contract-only", "contract-kind")
    keys(contract["trigger"], {"event", "enabledDefault"}, "trigger-fields")
    require(contract["trigger"]["event"] == "workflow_dispatch"
            and contract["trigger"]["enabledDefault"] is False, "manual-default-off")
    require(contract["flags"] == {"WEATHERX_DATA_VALIDATION_ONLY": "1", "PUBLISH": "0"}, "literal-validation-flags")
    require(contract["permissions"] == {"contents": "read", "actions": "read"}, "read-only-permissions")
    require(type(contract["writers"]) is list and not contract["writers"]
            and type(contract["credentials"]) is list and not contract["credentials"], "no-writers-or-credentials")
    require(contract["sharedCacheWrites"] is False and contract["productionEnvironment"] is False, "no-shared-production-capabilities")
    require(contract["collectorModels"] == [{"kind": k, "model": m} for k, m in MODELS], "exact-eleven-collector-graph")
    require(contract["workflowPath"] == WORKFLOW, "validation-workflow-only")
    keys(contract["pins"], PIN_NAMES, "pin-fields")
    for name, value in contract["pins"].items():
        if value is None and not concrete and name not in {"atmosCommit", "atmosTree"}:
            continue
        digest(value, 40 if name in GIT_PINS else 64, "unresolved-or-invalid-pin")
    keys(contract["runtime"], {"shell", "python", "node", "path"}, "runtime-fields")
    runtime_paths = {"shell": "/validation/toolchain/bin/bash", "python": "/validation/toolchain/bin/python3.12",
                     "node": "/validation/toolchain/bin/node22", "path": "/validation/toolchain/bin"}
    for name, value in contract["runtime"].items():
        if value is None and not concrete:
            continue
        require(value == runtime_paths[name], "unresolved-or-untrusted-runtime-path")
    return contract


def admit_request(contract, request):
    validate_contract(contract, concrete=True)
    keys(request, {"event", "enabled", "validationOnly", "publish", "environment", "runId", "attempt"}, "request-fields")
    require(request["event"] == "workflow_dispatch" and request["enabled"] is True, "explicit-manual-opt-in")
    require(request["validationOnly"] == "1" and request["publish"] == "0", "explicit-literal-flags")
    require(request["environment"] == {"PATH": contract["runtime"]["path"], "LANG": "C",
            "WEATHERX_DATA_VALIDATION_ONLY": "1", "PUBLISH": "0"}, "scrubbed-startup-environment")
    identifier(request["runId"], "run-id")
    positive(request["attempt"], "run-attempt")


ROW_FIELDS = {"kind", "model", "jobId", "jobName", "artifactId", "artifactName", "artifactFile",
              "artifactSha256", "artifactBytes", "receiptSha256", "pointReceiptSha256",
              "atmosCommit", "atmosTree", "runId", "attempt", "conclusion", "sourceVerifiedAt",
              "collectedAt", "uploadStartedAt", "createdAt", "uploadCompletedAt", "expiresAt"}


def validate_metadata(contract, request, metadata, kind, now):
    keys(metadata, {"kind", "pins", "run", "baseline", "collectors", "expiresAt"}, "metadata-fields")
    require(metadata["kind"] == kind, "metadata-kind")
    require(metadata["pins"] == contract["pins"], "exact-source-toolchain-baseline-pins")
    positive(metadata["expiresAt"], "metadata-expiry")
    require(metadata["expiresAt"] > now, "expired-metadata")
    run = metadata["run"]
    keys(run, {"id", "attempt", "repositoryId", "event", "workflowPath", "controllerCommit",
               "controllerTree", "startedAt", "completedAt"}, "run-fields")
    require(run["id"] == request["runId"] and type(run["attempt"]) is int
            and run["attempt"] == request["attempt"], "exact-run-attempt")
    require(type(run["repositoryId"]) is int and run["repositoryId"] == 1301196656
            and run["event"] == "workflow_dispatch" and run["workflowPath"] == WORKFLOW
            and run["controllerCommit"] == contract["pins"]["controllerCommit"]
            and run["controllerTree"] == contract["pins"]["controllerTree"], "exact-repository-workflow-controller")
    positive(run["startedAt"], "run-start")
    positive(run["completedAt"], "run-end")
    require(run["startedAt"] <= run["completedAt"] <= now, "run-time-order")
    baseline = metadata["baseline"]
    keys(baseline, {"sha256", "freshnessValidated", "supersetValidated"}, "baseline-fields")
    require(baseline["sha256"] == contract["pins"]["baselineAuthoritySha256"]
            and baseline["freshnessValidated"] is True and baseline["supersetValidated"] is True,
            "sealed-baseline-attestation")
    require(type(metadata["collectors"]) is list and len(metadata["collectors"]) == 11, "complete-eleven-collectors")
    seen, jobs, artifacts = set(), set(), set()
    for row in metadata["collectors"]:
        keys(row, ROW_FIELDS, "collector-fields")
        require(type(row["kind"]) is str and type(row["model"]) is str, "collector-model-type")
        pair = (row["kind"], row["model"])
        require(pair in MODELS and pair not in seen, "unique-model-closure")
        seen.add(pair)
        for field, values in (("jobId", jobs), ("artifactId", artifacts)):
            identifier(row[field], "job-or-artifact-id")
            require(row[field] not in values, "unique-job-and-artifact")
            values.add(row[field])
        require(row["jobName"] == f"validation-{row['kind']}-{row['model']} / collector"
                and row["artifactName"] == f"train3-validation-{row['model']}-{run['id']}-{run['attempt']}"
                and row["artifactFile"] == row["model"] + ".zip", "exact-job-artifact-path")
        require(row["conclusion"] == "success" and row["runId"] == run["id"]
                and type(row["attempt"]) is int and row["attempt"] == run["attempt"]
                and row["atmosCommit"] == contract["pins"]["atmosCommit"]
                and row["atmosTree"] == contract["pins"]["atmosTree"], "successful-current-source-collector")
        for name in ("artifactSha256", "receiptSha256", "pointReceiptSha256"):
            digest(row[name], 64, "artifact-or-receipt-digest")
        positive(row["artifactBytes"], "artifact-byte-count")
        require(row["artifactBytes"] <= MAX_ZIP, "artifact-byte-bound")
        times = [row[n] for n in ("sourceVerifiedAt", "collectedAt", "uploadStartedAt", "createdAt", "uploadCompletedAt")]
        for value in times:
            positive(value, "collector-time-type")
        require([run["startedAt"], *times, run["completedAt"]] == sorted([run["startedAt"], *times, run["completedAt"]]), "source-collection-upload-order")
        positive(row["expiresAt"], "artifact-expiry")
        require(row["expiresAt"] > now, "expired-artifact")


def open_artifact_root(root):
    """Anchor one absolute directory through no-follow component opens."""
    root = Path(root)
    require(root.is_absolute() and ".." not in root.parts and len(root.parts) > 1,
            "absolute-canonical-artifact-directory")
    require(hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
            and os.open in os.supports_dir_fd, "nofollow-directory-api-required")
    directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = None
    try:
        fd = os.open("/", directory)
        for component in root.parts[1:]:
            child = os.open(component, directory, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except OSError:
        if fd is not None:
            os.close(fd)
        raise Refusal("missing-or-linked-artifact-directory") from None


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def artifact_digest(root_fd, row):
    # The fixed basename is opened relative to the retained directory descriptor.
    try:
        fd = os.open(row["artifactFile"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
    except OSError:
        raise Refusal("missing-or-linked-artifact") from None
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_size == row["artifactBytes"], "regular-exact-size-artifact")
        hashed, count = hashlib.sha256(), 0
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            count += len(chunk)
            require(count <= row["artifactBytes"], "artifact-changed-during-read")
            hashed.update(chunk)
        require(count == row["artifactBytes"] and hashed.hexdigest() == row["artifactSha256"], "artifact-digest-mismatch")
        require(file_identity(info) == file_identity(os.fstat(handle.fileno())), "artifact-identity-changed")


def validate_binding(contract, request, trusted, observed, artifact_root, now):
    admit_request(contract, request)
    validate_metadata(contract, request, trusted, "weatherx-train3-trusted-metadata-v1", now)
    validate_metadata(contract, request, observed, "weatherx-train3-observation-v1", now)
    require({k: v for k, v in observed.items() if k != "kind"}
            == {k: v for k, v in trusted.items() if k != "kind"}, "independent-authority-mismatch")
    root_fd = open_artifact_root(artifact_root)
    try:
        for row in observed["collectors"]:
            artifact_digest(root_fd, row)
    finally:
        os.close(root_fd)
    return {"kind": "weatherx-train3-offline-contract-verdict-v1", "structuralBindingValid": True,
            "executionAuthorized": False, "publicationAuthorized": False, "liveCollectorQualified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--request")
    parser.add_argument("--trusted-metadata")
    parser.add_argument("--observation")
    parser.add_argument("--artifacts")
    args = parser.parse_args()
    try:
        contract = validate_contract(read_json(args.contract))
        inputs = (args.request, args.trusted_metadata, args.observation, args.artifacts)
        if not any(inputs):
            result = {"kind": "weatherx-train3-offline-contract-verdict-v1", "contractShapeValid": True,
                      "unresolvedPins": sorted(n for n, v in contract["pins"].items() if v is None),
                      "executionAuthorized": False, "publicationAuthorized": False, "liveCollectorQualified": False}
        else:
            require(all(inputs), "complete-offline-input-set-required")
            result = validate_binding(contract, read_json(args.request), read_json(args.trusted_metadata),
                                      read_json(args.observation), args.artifacts, int(time.time()))
        print(json.dumps(result, sort_keys=True))
    except Refusal as error:
        parser.exit(2, f"contract refused: {error}\n")


if __name__ == "__main__":
    main()
