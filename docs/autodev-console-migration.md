# AutoDev implementation and migration evidence

This document tracks observed implementation gaps and cutover evidence, not the normative requirements in `autodev-console-target-state.md`.

### OpenLIT ingest replacement gate

- Before deleting a legacy router telemetry/receiver path, verify a real producer's authenticated OTLP traces, metrics and logs reach OpenLIT/ClickHouse and remain queryable by AutoDev Console Usage.
- Record the revision, producer, sample trace/metric/log correlation, privacy verification and rollback evidence here; do not change the target-state contract to declare the cutover complete.

