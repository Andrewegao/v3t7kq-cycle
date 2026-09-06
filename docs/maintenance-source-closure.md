# Distributed maintenance source closure

The maintenance job always supplies sealed core artifacts from runner temporary
storage. Atmos deliberately disables whole-checkpoint prepare/save when these
artifacts are supplied. Restoring the unused `ops/.maintenance-checkpoint`
archive was therefore dead work, and a cache hit would introduce untracked
files before the exact checkout guard.

Remove the fingerprint, restore and save steps and their enabling variable from
this distributed workflow. Keep the rolling observations/verification cache,
authenticated retained-model recovery, private input vault, hydrated release
proofs, all source pins and all publication gates unchanged. There is no
checkpoint-directory exception added to source admission.

Run 34000676897 had a cache miss, so its observed refusal came from Atmos's own
baseline receipt at `ops/.core-model-baseline.json`, not this cache. The separate
Atmos fix moves capture and final verification together into the already allowed
`ops/logs` output directory, with a real capture/admission regression. Both fixes
are needed for a dependable future maintenance run. Neither changes UI or Workers.
