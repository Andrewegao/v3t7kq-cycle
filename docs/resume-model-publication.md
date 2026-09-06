# Retained publication recovery for bake 34000676897

The first independent-publisher run authenticated collected artifacts but failed
when writing `handoff_sha256`: the output-key validator allowed no digits.
The fix accepts digits after the first output-name character and validates the
entire record before appending it. CR, LF, NUL and invalid names remain rejected.
A CLI-level regression exercises the actual successful transfer and complete
output record, in addition to the original transport tests.

Running GitHub workflows retain their original controller. Rerunning the old
publisher would execute the same buggy helper. `resume-model-publication.yml`
therefore uses the corrected controller without rerunning weather collection.
It is a manual-main, publication-only lane for exactly:

- Original run: `34000676897`, attempt `1`.
- Original controller: `3ba5567c5c4307be27910129ddc37571b1b0b9f8`.
- Producer and publisher Atmos source: `3f7479573b990337c64643077720c39b361b6841`.

The new caller is independently authenticated against its own workflow/run/SHA.
Then the existing attempt-specific collector, successful source/collection/upload
steps, original upload window, artifact ID, digest, ZIP limits and untouched model
receipts are checked against the original producer. Nothing relabels a source,
run or manifest. The original producer run is passed to the scientific installer.
The same protected production-data environment, per-model locks, exact source
approval, scientific/freshness checks and paired catalog CAS remain in force.

Select one model or `all`. Missing/incomplete or provider-abstained inputs are
withheld; malformed provenance fails. Each publisher is independent. This lane
does not call collectors, build/deploy UI, alter Workers, or interrupt the original
bake. It cannot recover other runs or sources, and cannot admit expired artifacts.
The original whole-maintenance job may continue using the same collected inputs.

GitHub may report the aggregate run as `pending` while individual jobs are
already executing or completed behind independent locks. That observed aggregate
state is accepted alongside `in_progress` and `completed`; the selected collector
must still be completed/successful with successful ordered source, collect and
upload steps. This does not admit a pending, failed or incomplete collector.

NAM-HI's first artifact is a genuine abstention, not a successful input pack.
Its diagnostic found an upstream HTTP302 during lead11 acquisition. Recovery
must not turn that receipt into published data; the current last-good model
remains subject to normal freshness limits.

Local checks: Python helper suite (including full CLI output and recovery caller
negative cases), workflow contract suite, UI credential boundary tests, and
actionlint. Dispatch only after the corrected controller's CI passes and its
current source/approval settings are verified. Production UI is out of scope.
