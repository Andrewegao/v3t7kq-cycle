#!/usr/bin/env bash
# Runs inside the existing Pages deploy/rollback transaction.
set -euo pipefail
node "${UI_CYCLE_ROOT:?}/tools/ui-release.mjs" verify "${1:?}"
