# v3t7kq-cycle

WeatherX's operational controllers on GitHub Actions. This repository contains recurring data collection, independent model publication, archive work, staging qualification, guarded release entrypoints, and recovery diagnostics. Atmos owns the data algorithms and scientific/release validation; Cycle checks out the source declared by each workflow.

Use the [workflow inventory](docs/WORKFLOWS.md) to find an entrypoint, its declared triggers, dependency graph, source references, environment, and writer lock. Use the [operation and recovery guide](docs/WORKFLOW_OPERATIONS.md) to distinguish collection, publication, maintenance, and deployment. The index does not claim that a declared schedule is enabled, a source is deployed, or a model is fresh.

The main bake already collects eleven models independently. Each model publisher follows its own collector, while the whole-maintenance job joins inputs and qualifies an immutable whole-data fallback. The separate catalog workflow refreshes core components; satellite/radar archives and isolated staging workflows have their own bounded controllers. A failure in one lane is not evidence that all model publications failed.

Common starting points:

- [Refresh one model](docs/single-model-refresh.md).
- [Understand authenticated model handoff](docs/current-model-artifact-handoff.md).
- [Recover the specifically reviewed retained publication](docs/resume-model-publication.md).
- [Staging and immutable UI promotion](docs/UI-STAGING-PROMOTION.md).
- [Production consumer refresh](CONSUMER_REFRESH.md).
- [Scheduler configuration and verification](scheduler/README.md).

Data publication and application/Worker deployment are separate guarded capabilities. Credentials remain scoped to the exact workflows and environments that declare them; a missing Pages token is not a general bake-only switch. The inventory contains no credentials and grants no dispatch or publication authority.

To refresh or check the generated inventory locally, follow the [Node 22 commands](docs/WORKFLOW_OPERATIONS.md#ownership). Metadata is in [ops/workflows.json](ops/workflows.json); executable workflow YAML remains authoritative.
