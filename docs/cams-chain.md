# CAMS delivery from the component-bake chain

The existing four nominal slots remain `00:40`, `10:40`, `12:40` and `22:40` UTC. The existing producer selects the newest 00/12 UTC initialization at least ten hours old. GitHub schedules have been delayed or absent; a later successful ingest proves that initialization recovered, not that scheduling is reliable. This chain reuses requested events from the existing component-bake clock without changing the five declared Worker triggers, scientific source/publisher gates or explicit manual actions.

## Authority and admission

The workflow and controller accept only this repository's own scheduled/dispatched component-bake requests on current main. API evidence must match both run IDs, workflow IDs/paths, repository IDs, current SHA and attempt 1. Forks, renamed workflows, reruns, old-window events and main drift refuse. There are no secrets, environment/R2 credentials, cancellations, workflow-enable requests or arbitrary dispatch targets. The job token has contents read and Actions write; only cams-ingest.yml on main is dispatchable.

Derive the latest existing nominal slot and apply the unchanged ten-hour selection rule at that slot. Pass the exact initialization to the existing ingest run input so a late check cannot start the next initialization before its nominal slot. Require a bounded valid public CAMS pointer, with consistent schema/family/run/init/path/map/hash/size and no future timestamps. A pointer serving the expected or a newer initialization needs no work; HTTP/auth/schema/budget failures stop rather than authorize blind ingestion.

Completely paginate run/job lists. All five active states suppress dispatch. An equivalent real scheduled/dispatched attempt consumes only its nominal window, regardless of outcome; the next existing nominal slot remains the retry. Dry runs, older explicit initializations and previous-window attempts do not count. No new frequency or automatic recovery is introduced. Fetch-decoded gzip, Brotli and deflate responses retain the same decoded byte budget and strict UTF-8/JSON checks. Only identity bodies are compared with Content-Length; compressed transport lengths describe encoded bytes. Unsupported encodings, decoded overflow and stream/transport failures refuse.

## Planning, dispatch and uncertainty

Planning is a separate read-only step. A planning no-op after seeing an active old run or dry run does not consume the slot once that job ends. The actual-dispatch step reruns all admission and rechecks main, pointer, all active states and slot boundary immediately before one POST. Planning's slot/run must still match. A refused or lost POST is never retried.

A prior started actual-dispatch step is the durable slot ledger, including lost responses or interruption. If final admission instead returned successfully without any POST, a conditional successful `Confirm no CAMS dispatch was attempted` step records positive proof of the no-op. Only a successful actual step plus that successful proof clears consumption; absent/skipped/failed proof cannot clear an uncertain POST. This uses existing GitHub job metadata, not new storage. Chain concurrency serializes decisions; the ingest's writer lock and CAS are unchanged.

## Fallback, verification and rollback

The four native CAMS cron slots remain. A late fallback can start a job but the existing exact-init served check stands aside before dependency provisioning/credentials when the chain's initialization is already public. Manual inputs remain unchanged. A newer initialization chosen by a later native event is ordinary existing behavior.

Normally the chain receives six HRRR and one slow component-bake event per hour. Most jobs are read-only no-ops, but hosted job overhead increases. Local fixtures do not prove hosted delivery improved.

Before integration require slot/midnight/ten-hour, authority/fork/replay, pagination, all-active-state, pointer/auth, attempt/dry-run, no-op planning, uncertain POST, positive no-POST proof and final guard-change regressions. Run existing energy and inventory contracts, independent review and normal Cycle CI. Observe an actual due-slot chain, at most one matching ingest, public exact-init/body readback and unchanged production UI identity after normal integration. Disabling only this new workflow is reversible rollback; the original native cron and five Worker triggers remain. Never force a failed chain by rerunning it.
