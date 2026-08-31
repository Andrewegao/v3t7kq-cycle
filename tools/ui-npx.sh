#!/usr/bin/env bash
# Narrow adapter for the unchanged, pinned release guard's `npx wrangler pages deploy`.
# The already-compiled Worker MUST NOT be bundled a second time during either upload.
set -euo pipefail
[[ "${1:-}" == wrangler && "${2:-}" == pages && "${3:-}" == deploy ]] || {
  echo 'UI upload adapter refuses commands outside the guarded Pages upload' >&2; exit 2;
}
shift
exec "${UI_WRANGLER_BIN:?}" "$@" --no-bundle --upload-source-maps=false
