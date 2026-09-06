# Refresh one model without restarting the rest

Manual `bake.yml` now accepts `model` (default `all`). A selected model runs only
its existing collector and paired publisher. The other ten collectors are
skipped; no duplicate weather collection occurs. Whole maintenance still requires
all four core collectors to succeed, so it does not run for a single-model request.

Scheduled runs have no manual input and continue to collect all eleven on the
unchanged four-times-daily schedule. Ordinary manual `model=all` also preserves
the full pipeline. Source pins, freshness/scientific admission, artifact identity,
per-model concurrency and paired compare-and-swap are unchanged. No UI or Worker
deployment capability is added.

Use a single-model refresh when a provider becomes ready later or a collector
abstained. Use the narrowly reviewed retained-publication lane instead when good
inputs already exist and only their publisher failed. Do not rerun collectors to
repair a publication-only error. Current running workflows are not interrupted.

The summary retains per-model publication outcomes; skipped unrequested models
are withheld, not claimed as freshly published. A passing single-model run does
not prove all eleven models are fresh.
