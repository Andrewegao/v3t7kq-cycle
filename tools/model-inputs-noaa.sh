#!/usr/bin/env bash
set -euo pipefail

readonly NOAA_MODELS=(hrrr-ak nam nam-hi nam-ak)

write_output() {
  local key="$1" value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

contains_model() {
  local wanted="$1" model
  for model in "${NOAA_MODELS[@]}"; do
    [[ "$model" == "$wanted" ]] && return 0
  done
  return 1
}

collect_models() {
  local model failed=0
  local -a completed=()
  # GitHub keeps the last value for a repeated output key. Flush the canonical
  # prefix after every success so a later timeout cannot hide completed work.
  write_output completed ""
  for model in "${NOAA_MODELS[@]}"; do
    echo "collecting NOAA model $model"
    if MODEL_ID="$model" node cycle/tools/model-inputs.mjs gate && \
      MODEL_ID="$model" timeout --signal=TERM --kill-after=30s 45m \
        python atmos/experiments/models/cloud_model_inputs.py \
          --model "$model" --init "$MODEL_INIT" --source-sha "$MODEL_SOURCE_SHA" \
          --workers 2 --output "$RUNNER_TEMP/weatherx-model-inputs/$model"; then
      completed+=("$model")
      write_output completed "${completed[*]}"
    else
      echo "NOAA model collection failed: $model" >&2
      failed=1
    fi
  done
  write_output failed "$failed"
  return "$failed"
}

canonical_completed_models() {
  local supplied="${MODEL_INPUTS_COMPLETED:-}" token model canonical=""
  local -a supplied_models=()
  read -r -a supplied_models <<<"$supplied"
  for token in "${supplied_models[@]}"; do
    contains_model "$token" || return 1
  done
  for model in "${NOAA_MODELS[@]}"; do
    for token in "${supplied_models[@]}"; do
      if [[ "$token" == "$model" ]]; then
        [[ " $canonical " != *" $model "* ]] || return 1
        canonical="${canonical:+$canonical }$model"
      fi
    done
  done
  [[ "$canonical" == "$supplied" ]] || return 1
  printf '%s\n' "$canonical"
}

model_completed() {
  local model="$1"
  [[ " ${MODEL_INPUTS_COMPLETED:-} " == *" $model "* ]]
}

archive_one() {
  local model="$1"
  local receipt="$RUNNER_TEMP/weatherx-model-inputs/$model/cloud-input-receipt.json"
  if [[ ! -f "$receipt" || -L "$receipt" || ! -s "$receipt" ]]; then
    echo "refusing absent, linked or empty receipt for completed NOAA model: $model" >&2
    return 1
  fi
  MODEL_ID="$model" timeout --signal=TERM --kill-after=30s 30m \
    node cycle/tools/model-inputs.mjs archive
}

archive_pair() {
  local model i failed=0
  local -a pids=() models=()
  for model in "$@"; do
    if model_completed "$model"; then
      archive_one "$model" &
      pids+=("$!")
      models+=("$model")
    fi
  done
  for ((i = 0; i < ${#pids[@]}; i++)); do
    if ! wait "${pids[$i]}"; then
      echo "NOAA model archive failed: ${models[$i]}" >&2
      failed=1
    fi
  done
  return "$failed"
}

archive_models() {
  local failed=0
  local canonical
  canonical="$(canonical_completed_models)" || {
    echo "refusing non-canonical NOAA completed-model set" >&2
    return 1
  }
  [[ -n "$canonical" ]] || {
    echo "refusing empty NOAA completed-model set" >&2
    return 1
  }
  archive_pair hrrr-ak nam || failed=1
  archive_pair nam-hi nam-ak || failed=1
  write_output failed "$failed"
  return "$failed"
}

case "${1:-}" in
  collect) collect_models ;;
  archive) archive_models ;;
  *) echo "usage: $0 collect|archive" >&2; exit 2 ;;
esac
