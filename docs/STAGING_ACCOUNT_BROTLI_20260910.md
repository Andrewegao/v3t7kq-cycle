# Staging account response completion

Run34457060969 rolled staging back safely and opened fuse204. A fresh read-only
Linux trace34463122583 reproduced the first account assertion three times: one
anonymous GET200, Brotli, no Content-Length, 87 decoded bytes, EOF/release, no
application abort/body rejection, working anonymous UI and weather. CDP's aborted
terminal was at EOF. The old exception required identity encoding and a matching
declared length; it could not prove this legitimate compressed completion.

The reviewed narrow Atmos controller04146c3f67891ed714e1d5bbd27b6998ba0e96ad adds
only this observed Brotli/no-length class, requiring exact streaming comparison
against the server's two fixed public anonymous payloads. It never retains user
bodies, clones responses, adds requests or changes the application. All existing
request identity, cancellation, timeout, EOF/release, 25ms, map, and lifecycle
checks remain. Malformed bodies/headers and unsupported encodings still fail.

This patch updates only three staging controller literals. The production
controller, ui-release workflow, compression profile, publication scope, credentials,
configuration digests, gates and rollback/fuse behavior remain unchanged.
The candidate must descend from this pin. Fresh Linux qualification, private
candidate CI, and reviewed fuse recovery are required before a staging retry.
No production deployment is authorized. Never merge the disposable Linux
diagnostic branch into Atmos master.
