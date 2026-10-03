"""Offline content binding only. External authority must authenticate expected pins.

Never executes binaries, candidate source, collectors or a bake. A successful
fixture cannot authenticate an issuer, runtime, archive contents or science.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat

CORE = ("ecmwf", "gfs", "hrrr", "aifs")
REGIONAL = ("icon", "hrdps", "arome-antilles", "hrrr-ak", "nam", "nam-hi", "nam-ak")
MODELS = [("core", m) for m in CORE] + [("regional", m) for m in REGIONAL]
STAGES = ("admission", "collectors", "assembly", "catalogRebase", "freshnessSuperset",
          "regionalValidation", "pointValidation", "completion", "retention")
MAX_JSON = 1024 * 1024
MAX_SEAL = 16 * 1024 * 1024
MAX_FILES = 100000
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 4 * 1024**3
ENTRYPOINTS = {"shell": "bin/bash", "python": "bin/python3.12", "node": "bin/node22",
               "bakePython": "bake-venv/bin/python"}
ALIASES = {"bin/bash": "bin/bash", "bin/python3": "bin/python3.12", "bin/node": "bin/node22"}


class Refusal(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Refusal(reason)  # Diagnostics never interpolate untrusted values.


def keys(value, names, reason):
    require(type(value) is dict and set(value) == set(names), reason)


def digest(value, size=64):
    require(type(value) is str and re.fullmatch(r"[a-f0-9]{" + str(size) + r"}", value), "invalid-digest")


def positive(value):
    require(type(value) is int and 0 < value < 2**63, "invalid-positive-integer")


def pairs(items):
    out = {}
    for key, value in items:
        require(key not in out, "duplicate-json-key")
        out[key] = value
    return out


def parse(raw, limit=MAX_JSON):
    require(type(raw) is bytes and 0 < len(raw) <= limit, "metadata-byte-bound")
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_float=lambda _: (_ for _ in ()).throw(Refusal("floating-json-number")),
                          parse_constant=lambda _: (_ for _ in ()).throw(Refusal("nonfinite-json-number")))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise Refusal("invalid-json") from None


def bound_document(raw, expected_sha):
    digest(expected_sha)
    require(type(raw) is bytes and 0 < len(raw) <= MAX_JSON, "metadata-byte-bound")
    require(hashlib.sha256(raw).hexdigest() == expected_sha, "authority-content-mismatch")
    return parse(raw)


def context(document, expected, now):
    keys(expected, {"atmosCommit", "atmosTree", "runId", "attempt"}, "context-fields")
    for name in ("atmosCommit", "atmosTree"):
        digest(expected[name], 40)
    require(type(expected["runId"]) is str and re.fullmatch(r"[1-9][0-9]{0,19}", expected["runId"]), "run-id")
    positive(expected["attempt"])
    keys(document["context"], expected, "observed-context-fields")
    positive(document["context"]["attempt"])
    require(document["context"] == expected, "source-run-attempt-mismatch")
    positive(now)
    positive(document["issuedAt"])
    positive(document["expiresAt"])
    require(document["issuedAt"] <= now < document["expiresAt"], "attestation-time-window")
    require(type(document["schemaVersion"]) is int and document["schemaVersion"] == 1, "attestation-version")


def baseline_binding(raw, expected_sha, expected, core_seal, now):
    doc = bound_document(raw, expected_sha)
    keys(doc, {"schemaVersion", "kind", "context", "issuedAt", "expiresAt", "issuerId",
               "catalog", "coreSealSha256", "regional", "policy"}, "baseline-fields")
    require(doc["kind"] == "weatherx-train3-baseline-attestation-v1", "baseline-kind")
    context(doc, expected, now)
    require(type(doc["issuerId"]) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", doc["issuerId"]), "issuer-id")
    keys(doc["catalog"], {"id", "pointerSha256", "snapshotSha256"}, "catalog-fields")
    require(type(doc["catalog"]["id"]) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", doc["catalog"]["id"]), "catalog-id")
    for name in ("pointerSha256", "snapshotSha256"):
        digest(doc["catalog"][name])
    digest(doc["coreSealSha256"])
    require(type(core_seal) is bytes and 0 < len(core_seal) <= MAX_SEAL and
            hashlib.sha256(core_seal).hexdigest() == doc["coreSealSha256"], "core-seal-content-mismatch")
    seal = parse(core_seal, MAX_SEAL)
    keys(seal, {"schemaVersion", "kind", "files"}, "core-seal-fields")
    require(type(seal["schemaVersion"]) is int and seal["schemaVersion"] == 1 and
            seal["kind"] == "weatherx-validation-catalog-baseline-v1", "core-seal-kind")
    require(type(seal["files"]) is list and 0 < len(seal["files"]) <= 250000, "core-seal-roster-bound")
    roster, previous = {}, ""
    for row in seal["files"]:
        keys(row, {"path", "size", "sha256"}, "core-seal-row-fields")
        relative_path(row["path"])
        require(row["path"] > previous, "core-seal-sorted-unique-roster")
        previous = row["path"]
        require(type(row["size"]) is int and 0 <= row["size"] <= 64 * 1024 * 1024, "core-seal-file-bound")
        digest(row["sha256"])
        roster[row["path"]] = row["sha256"]
    for name, field in (("catalog-pointer.json", "pointerSha256"), ("catalog-snapshot.json", "snapshotSha256")):
        require(roster.get(name) == doc["catalog"][field], "catalog-seal-identity-link")
    require(all(f"components/{name}/manifest.json" in roster for name in (*CORE, *(f"point-{m}" for m in CORE))), "eight-core-manifest-identities")
    require(type(doc["regional"]) is list and len(doc["regional"]) == len(REGIONAL), "seven-regional-baselines")
    for model, row in zip(REGIONAL, doc["regional"]):
        keys(row, {"model", "manifestSha256", "pointManifestSha256"}, "regional-baseline-fields")
        require(row["model"] == model, "exact-regional-baseline-roster")
        digest(row["manifestSha256"])
        digest(row["pointManifestSha256"])
    keys(doc["policy"], {"freshnessValidated", "supersetValidated", "nonregressionValidated"}, "baseline-policy-fields")
    require(all(v is True for v in doc["policy"].values()), "baseline-policy-claims-required")
    return doc


def relative_path(value):
    require(type(value) is str and 0 < len(value) <= 4096 and not value.startswith("/") and
            "\\" not in value and not re.search(r"[\x00-\x1f\x7f]", value), "unsafe-closure-path")
    parts = value.split("/")
    require(len(parts) <= 32 and all(p not in ("", ".", "..") for p in parts), "unsafe-closure-path")
    return parts


def open_root(root):
    raw = os.fspath(root)
    require(type(raw) is str and os.path.isabs(raw) and raw != "/" and
            os.path.normpath(raw) == raw and "\x00" not in raw, "canonical-local-root")
    require(hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY") and
            os.open in os.supports_dir_fd, "nofollow-api-required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in raw.split("/")[1:]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def read_leaf(root_fd, path, limit, row=None):
    parts = relative_path(path)
    parent = os.dup(root_fd)
    fd = None
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        before_name = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                identity(before) == identity(before_name) and 0 <= before.st_size <= limit, "unsafe-or-unbounded-file")
        if row is not None:
            require(before.st_size == row["bytes"], "closure-file-size")
        hashed, data, count = hashlib.sha256(), bytearray(), 0
        while True:
            block = os.read(fd, min(65536, limit - count + 1))
            if not block:
                break
            count += len(block)
            require(count <= limit and count <= before.st_size, "file-changed-during-read")
            hashed.update(block)
            if row is None:
                data.extend(block)
        require(count == before.st_size and identity(before) == identity(os.fstat(fd)) and
                identity(before) == identity(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)), "file-changed-during-read")
        if row is not None:
            require(hashed.hexdigest() == row["sha256"], "closure-file-digest")
        return bytes(data)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)


def read_local(path, limit=MAX_JSON):
    raw = os.fspath(path)
    require(type(raw) is str and os.path.isabs(raw) and os.path.normpath(raw) == raw, "canonical-local-file")
    root = open_root(os.path.dirname(raw))
    try:
        return read_leaf(root, os.path.basename(raw), limit)
    finally:
        os.close(root)


def audit_closure(fd, expected):
    directories = {""}
    for path in expected:
        parts = relative_path(path)
        directories.update("/".join(parts[:i]) for i in range(1, len(parts)))
    require(not directories.intersection(expected), "closure-path-collision")
    seen_files, seen_dirs, fingerprints = set(), set(), {}
    def walk(current, prefix):
        before = identity(os.fstat(current))
        fingerprints[prefix] = before
        seen_dirs.add(prefix)
        with os.scandir(current) as entries:
            for entry in entries:
                path = f"{prefix}/{entry.name}" if prefix else entry.name
                require(path in expected or path in directories, "extra-closure-entry")
                info = os.stat(entry.name, dir_fd=current, follow_symlinks=False)
                if path in directories:
                    require(stat.S_ISDIR(info.st_mode), "unsafe-closure-directory")
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                    try:
                        require(identity(info) == identity(os.fstat(child)), "closure-directory-binding")
                        walk(child, path)
                        require(identity(os.fstat(child)) == identity(os.stat(entry.name, dir_fd=current, follow_symlinks=False)), "closure-directory-binding")
                    finally:
                        os.close(child)
                else:
                    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "unsafe-closure-file")
                    seen_files.add(path)
                    fingerprints[path] = identity(info)
        require(before == identity(os.fstat(current)), "closure-directory-changed")
    walk(fd, "")
    require(seen_files == set(expected) and seen_dirs == directories, "missing-closure-entry")
    return fingerprints


def toolchain_binding(raw, expected_sha, expected, root, now):
    doc = bound_document(raw, expected_sha)
    keys(doc, {"schemaVersion", "kind", "context", "issuedAt", "expiresAt", "runner",
               "entrypoints", "aliases", "bakeVenvMount", "files"}, "toolchain-fields")
    require(doc["kind"] == "weatherx-train3-toolchain-attestation-v1", "toolchain-kind")
    context(doc, expected, now)
    keys(doc["runner"], {"platform", "architecture", "imageSha256", "networkPolicySha256",
                         "diskPolicySha256", "outputPolicySha256"}, "runner-fields")
    require(doc["runner"]["platform"] == "linux" and doc["runner"]["architecture"] in ("amd64", "arm64"), "runner-profile")
    for name in ("imageSha256", "networkPolicySha256", "diskPolicySha256", "outputPolicySha256"):
        digest(doc["runner"][name])
    require(doc["entrypoints"] == ENTRYPOINTS and doc["aliases"] == ALIASES, "fixed-entrypoint-aliases")
    keys(doc["bakeVenvMount"], {"source", "destination", "readOnly"}, "bake-venv-mount-fields")
    require(doc["bakeVenvMount"]["source"] == "/validation/toolchain/bake-venv" and
            doc["bakeVenvMount"]["destination"] == "/validation/source/atmos/data/.venv" and
            doc["bakeVenvMount"]["readOnly"] is True, "fixed-readonly-bake-venv-mount")
    require(type(doc["files"]) is list and 0 < len(doc["files"]) <= MAX_FILES, "closure-file-count")
    rows, roles, total, previous = {}, set(), 0, ""
    for row in doc["files"]:
        keys(row, {"path", "bytes", "sha256", "role"}, "closure-row-fields")
        relative_path(row["path"])
        require(row["path"] > previous, "sorted-unique-closure")
        previous = row["path"]
        require(type(row["bytes"]) is int and 0 <= row["bytes"] <= MAX_FILE, "closure-file-bound")
        total += row["bytes"]
        require(total <= MAX_TOTAL, "closure-total-bound")
        digest(row["sha256"])
        require(row["role"] in ("executable", "stdlib", "dependency", "library", "utility"), "closure-role")
        roles.add(row["role"])
        rows[row["path"]] = row
    require(roles == {"executable", "stdlib", "dependency", "library", "utility"}, "runtime-dependency-roles")
    for path in set(ENTRYPOINTS.values()) | set(ALIASES):
        require(path in rows and rows[path]["role"] == "executable" and rows[path]["bytes"] > 0, "entrypoint-inventory")
    for alias, target in ALIASES.items():
        require(rows[alias]["sha256"] == rows[target]["sha256"] and rows[alias]["bytes"] == rows[target]["bytes"], "alias-content-binding")
    fd = open_root(root)
    try:
        before = audit_closure(fd, rows)
        for row in rows.values():
            read_leaf(fd, row["path"], MAX_FILE, row)
        require(audit_closure(fd, rows) == before, "closure-changed-during-binding")
    finally:
        os.close(fd)
    return doc


def completion_binding(trusted_raw, expected_sha, observed_raw, expected, baseline_sha,
                       core_seal_sha, toolchain_sha, proofs, proof_shas, authority_issued_at, now):
    doc = bound_document(trusted_raw, expected_sha)
    observed = parse(observed_raw)
    # Python equality conflates numeric zero/one with false/true. Canonical JSON
    # preserves those distinct types without requiring identical whitespace.
    require(json.dumps(observed, sort_keys=True, separators=(",", ":")) ==
            json.dumps(doc, sort_keys=True, separators=(",", ":")), "independent-completion-mismatch")
    keys(doc, {"schemaVersion", "kind", "context", "issuedAt", "expiresAt", "bindings",
               "run", "exitCode", "stageStates", "models", "retention"}, "completion-fields")
    require(doc["kind"] == "weatherx-train3-completion-attestation-v1", "completion-kind")
    context(doc, expected, now)
    keys(doc["bindings"], {"baselineAuthoritySha256", "coreSealSha256", "toolchainSha256",
                          "initialWorkspaceSha256", "collectorProofSha256", "retentionPolicySha256"}, "completion-binding-fields")
    for value in doc["bindings"].values():
        digest(value)
    require(doc["bindings"]["baselineAuthoritySha256"] == baseline_sha and
            doc["bindings"]["coreSealSha256"] == core_seal_sha and
            doc["bindings"]["toolchainSha256"] == toolchain_sha, "completion-authority-link")
    proof_names = {"initialWorkspaceSha256", "collectorProofSha256", "retentionPolicySha256"}
    keys(proofs, proof_names, "proof-bytes-fields")
    keys(proof_shas, proof_names, "expected-proof-pin-fields")
    for name in proof_names:
        bound_document(proofs[name], proof_shas[name])
        require(doc["bindings"][name] == proof_shas[name], "completion-proof-content-link")
    keys(doc["run"], {"startedAt", "completedAt"}, "completion-run-fields")
    positive(doc["run"]["startedAt"])
    positive(doc["run"]["completedAt"])
    require(doc["run"]["startedAt"] <= doc["run"]["completedAt"] <= doc["issuedAt"] <= now, "completion-run-time-order")
    require(type(authority_issued_at) is list and len(authority_issued_at) == 2, "authority-time-fields")
    for issued in authority_issued_at:
        positive(issued)
        require(issued <= doc["run"]["startedAt"], "authority-before-candidate-start")
    require(type(doc["exitCode"]) is int and doc["exitCode"] == 0, "completed-exit-code")
    keys(doc["stageStates"], STAGES, "complete-stage-roster")
    previous = doc["run"]["startedAt"]
    for name in STAGES:
        stage = doc["stageStates"][name]
        keys(stage, {"status", "startedAt", "completedAt"}, "stage-state-fields")
        require(stage["status"] == "completed", "explicit-completed-stages")
        positive(stage["startedAt"])
        positive(stage["completedAt"])
        require(previous <= stage["startedAt"] <= stage["completedAt"] <= doc["run"]["completedAt"], "stage-dependency-time-order")
        previous = stage["completedAt"]
    require(type(doc["models"]) is list and len(doc["models"]) == len(MODELS), "complete-eleven-models")
    receipt_digests = set()
    for (kind, model), row in zip(MODELS, doc["models"]):
        keys(row, {"kind", "model", "status", "completedAt", "mapReceiptSha256", "pointReceiptSha256", "scientificGateSha256"}, "completion-model-fields")
        require(row["kind"] == kind and row["model"] == model and row["status"] == "validated", "explicit-model-validation")
        for name in ("mapReceiptSha256", "pointReceiptSha256", "scientificGateSha256"):
            digest(row[name])
            require(row[name] not in receipt_digests, "distinct-per-model-proof-identities")
            receipt_digests.add(row[name])
        positive(row["completedAt"])
        require(doc["stageStates"]["collectors"]["completedAt"] <= row["completedAt"] <= doc["stageStates"]["completion"]["completedAt"], "model-validation-time-order")
    keys(doc["retention"], {"baselineIdentityRecorded", "privateSnapshotRemoved",
                          "diagnosticsRedacted", "expiresAt"}, "retention-fields")
    require(all(doc["retention"][name] is True for name in ("baselineIdentityRecorded", "privateSnapshotRemoved", "diagnosticsRedacted")), "retention-claims-required")
    positive(doc["retention"]["expiresAt"])
    require(doc["retention"]["expiresAt"] > now, "retention-expiry")
    return {"kind": "weatherx-train3-offline-attestation-verdict-v1", "structuralBindingValid": True,
            "executionAuthorized": False, "publicationAuthorized": False,
            "liveCollectorQualified": False, "joinedBakeQualified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--baseline-sha256", required=True)
    parser.add_argument("--core-seal", required=True)
    parser.add_argument("--toolchain", required=True)
    parser.add_argument("--toolchain-sha256", required=True)
    parser.add_argument("--toolchain-root", required=True)
    parser.add_argument("--completion", required=True)
    parser.add_argument("--completion-sha256", required=True)
    parser.add_argument("--observation", required=True)
    for name in ("workspace-proof", "collector-proof", "retention-policy"):
        parser.add_argument("--" + name, required=True)
        parser.add_argument("--" + name + "-sha256", required=True)
    args = parser.parse_args()
    import time
    try:
        expected, now = parse(read_local(args.context)), int(time.time())
        baseline = baseline_binding(read_local(args.baseline), args.baseline_sha256, expected,
                                    read_local(args.core_seal, MAX_SEAL), now)
        toolchain = toolchain_binding(read_local(args.toolchain), args.toolchain_sha256, expected, args.toolchain_root, now)
        inputs = {"initialWorkspaceSha256": (args.workspace_proof, args.workspace_proof_sha256),
                  "collectorProofSha256": (args.collector_proof, args.collector_proof_sha256),
                  "retentionPolicySha256": (args.retention_policy, args.retention_policy_sha256)}
        result = completion_binding(read_local(args.completion), args.completion_sha256,
                                    read_local(args.observation), expected, args.baseline_sha256,
                                    baseline["coreSealSha256"], args.toolchain_sha256,
                                    {n: read_local(p) for n, (p, _) in inputs.items()},
                                    {n: sha for n, (_, sha) in inputs.items()},
                                    [baseline["issuedAt"], toolchain["issuedAt"]], now)
        print(json.dumps(result, sort_keys=True))
    except (Refusal, OSError, ValueError, RecursionError):
        parser.exit(2, "offline attestation refused: invalid, unsafe or unbound input\n")


if __name__ == "__main__":
    main()
