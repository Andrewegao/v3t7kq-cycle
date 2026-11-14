#!/usr/bin/env bash
# After a whole bake publishes releases/<RELEASE_ID>/, copy its release-only forecast runs into the
# forecast history bucket and record that in history-receipts/<RELEASE_ID>.json.
#
# These families (bricks, China crops, air, verification) have no copy outside the whole releases.
# Releases retention deletes a release that carries any of them only when this receipt covers every
# such run directory (docs/production-releases-retention.md, "Forecast history"). So a failure here
# holds old releases; it never loses history.
#
# Copy only. It never deletes and never writes under releases/. A run directory keeps its newest
# version: this release is the newest, and a later bake overwrites what it changes (verification
# scores accumulate after a run).
set -euo pipefail
: "${RELEASE_ID:?}" "${R2_REMOTE:?}" "${HISTORY_REMOTE:?}"
[[ "$RELEASE_ID" =~ ^cycle-[1-9][0-9]{0,19}$ ]] || { echo "unexpected RELEASE_ID $RELEASE_ID" >&2; exit 1; }
FAMILIES=(data/ecmwf-brick data/gfs-brick data/ecmwf-cn data/gfs-cn data-atmos/air data/verify)
SRC="$R2_REMOTE/releases/$RELEASE_ID"
FLAGS=(--s3-no-check-bucket --fast-list)

if [ -z "$(rclone lsf "$SRC/" --files-only --max-depth 1 --include manifest.json "${FLAGS[@]}" 2>/dev/null)" ]; then
  echo "releases/$RELEASE_ID has no manifest (nothing was published): no history to copy"
  exit 0
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
: > "$WORK/keys"
for fam in "${FAMILIES[@]}"; do
  rclone lsf -R --files-only "$SRC/$fam/runs" "${FLAGS[@]}" > "$WORK/fam" 2>/dev/null || : > "$WORK/fam"
  [ -s "$WORK/fam" ] || { echo "$fam: no runs in this release"; continue; }
  # Server-side copies within the account; --checksum re-copies a file whose bytes changed.
  rclone copy "$SRC/$fam/runs" "$HISTORY_REMOTE/$fam/runs" --checksum --transfers 32 --checkers 64 "${FLAGS[@]}"
  # Every file of this release is in history with the same hash.
  rclone check "$SRC/$fam/runs" "$HISTORY_REMOTE/$fam/runs" --one-way "${FLAGS[@]}"
  sed "s#^#$fam/runs/#" "$WORK/fam" >> "$WORK/keys"
  echo "$fam: $(wc -l < "$WORK/fam" | tr -d ' ') objects in history"
done
[ -s "$WORK/keys" ] || { echo "no release-only runs in releases/$RELEASE_ID: no receipt needed"; exit 0; }
node - "$WORK/keys" "$RELEASE_ID" "${HISTORY_REMOTE#*:}" > "$WORK/receipt.json" <<'EOF'
const [keysPath, releaseId, historyBucket] = process.argv.slice(2);
const runs = {};
for (const key of require('node:fs').readFileSync(keysPath, 'utf8').split('\n').filter(Boolean)) {
  const m = /^(.+\/runs\/\d{10}\/)./.exec(key);
  if (!m) throw new Error(`unexpected history key ${key}`);
  runs[m[1]] = (runs[m[1]] ?? 0) + 1;
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'weatherx-forecast-history-receipt', releaseId,
  historyBucket, writtenAt: new Date().toISOString(), writer: 'bake.yml', runs }, null, 1)}\n`);
EOF
rclone copyto "$WORK/receipt.json" "$R2_REMOTE/history-receipts/$RELEASE_ID.json" "${FLAGS[@]}"
echo "history receipt written: history-receipts/$RELEASE_ID.json ($(grep -c '/runs/' "$WORK/receipt.json") run directories)"
