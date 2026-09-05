# NAM-HI diagnostic only

This manual lane identifies a hidden qualification failure. It does not repair,
publish, activate, archive model data, or change production. The existing whole
bake continues independently. A green diagnostic means only that this exact
NAM-HI cycle passed the existing 49-lead input qualifier, not that it is serving.

The only input is a valid UTC six-hour cycle, at most 12 hours old. The controller
requires the canonical repository, manual main run, exact merged Atmos
`77487534a6ff0a17bf4e5d55f9ab5c06938138d4`, and a clean checkout. It runs the
unchanged `qualify_noaa_regional_horizon.py --root <isolated runner temp>
--model nam-hi=<cycle> --workers 2`. Its 20-minute scientific wall limit, 14 GiB
allocation, 20 GiB free-space admission, all 49 leads and scientific validation
remain unchanged. The outer process budget is 21 minutes, with process-group
termination and reaping. No automatic retry or alternative cycle is attempted.

The job uses the existing protected staging environment, as required for any
secret-bearing workflow. Only the read-only Atmos checkout step receives a
credential; no staging publication secret is referenced. The child receives
an allowlisted Python runtime environment and no Actions/cloud/checkout tokens.
No R2, Worker, Pages, serving-pointer or route authority is present in this lane.

Both child streams are drained privately, with at most 16 KiB per stream retained
in memory; no plaintext log is written. More than 1 MiB total output terminates the
child. On exit, timeout or handled interruption, the bounded tails are encrypted
once before persistence. Only the receipt (at most 80 KiB) is uploaded, for three
days. No weather files, raw GRIB, decoded arrays, source paths or raw error text
are uploaded in plaintext. An external hard kill can prevent receipt retention;
it cannot make the diagnostic publish data.

The recipient is the existing owner-local RSA diagnostic key. Public PEM SHA256:
`e62e11ec1cc48e65bf2db65f0d4806c94fd02c6828686487ddad8c2ad9a56ead`.
Private key material is neither in this repository nor in Actions.

`receipt.encryptedTail` uses RSA-OAEP-SHA256 to wrap a random 256-bit AES key,
AES-256-GCM with a random 12-byte IV, and AAD
`weatherx-nam-hi-diagnostic/v1:<keySha256>`. Wrapped key, IV, tag and ciphertext
are base64. Decrypted JSON has `{version:1, stdout:<base64>, stderr:<base64>}`;
decode the two tail values only in the owner's private diagnostic environment.
Do not paste decrypted output into public logs or artifacts. Public classification
is limited to fixed status/stage labels and allowlisted numeric HTTP statuses;
unknown errors remain `qualifier` until privately inspected.

Verification: `node --test tests/nam-hi-diagnostic.mjs` uses synthetic subprocesses
only. Workflow lint: `actionlint -shellcheck= -pyflakes=
.github/workflows/nam-hi-diagnostic.yml .github/workflows/scheduler-ci.yml`.
Dispatch remains a separate owner-approved action after review and CI.
