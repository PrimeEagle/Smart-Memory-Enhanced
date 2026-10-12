# Memorize Chat diagnostic status model

Diagnostics schema beginning with v0.9.56 separates durable run lifecycle from
result quality. Consumers should read `run_status`, not infer completion from
`errors`, `error_details`, or retained-array lengths.

## Lifecycle and outcome

- `run_status.lifecycle_status` describes execution: `completed`, `incomplete`,
  `blocked`, `failed`, or `not_run`.
- `run_status.outcome_status` describes the completed result: `completed_clean`,
  `completed_recovered_errors`, `completed_with_notices`, or
  `completed_with_errors`. Incomplete, blocked, and failed runs use matching
  outcome values.
- `run_status.severity` is the presentation severity (`success`, `warning`,
  `error`, or `informational`). It does not redefine lifecycle.
- `run_status.completion_evidence` records source count, committed count,
  remaining gaps, finalization commitment, and final-integrity status.
- `run_status.classifier_version` identifies the pure classification logic.

A run with complete source coverage and `finalization_committed` remains
`completed` even when terminal extraction obligations remain. Those obligations
produce `completed_with_errors` and error severity. A transient failure that was
later recovered produces `completed_recovered_errors`. Safe descriptor rejection
or deterministic fallback is a notice, not an extraction error.

Legacy `partial`, `partial_state`, `degraded`, and
`completed_with_quality_debt` values are retained under
`legacy_status_compatibility`; exports derive current fields from durable
evidence without rewriting historical chat records.

## Error scopes

`error_accounting` labels every count with its scope, unit, retention behavior,
and authority:

- `current_attempt_error_records` is a bounded event-detail view.
- `historical_failure_observations` counts attempt-level observations across the
  logical run.
- `malformed_provider_responses` counts physical malformed responses.
- `unique_obligations_ever_failed`, `recovered_obligations`, and
  `terminal_unresolved_obligations` count unique logical obligations.
- `fatal_run_level_errors`, `nonfatal_generation_errors`, and
  `quality_notices` are separate terminal categories.

`error_accounting.reconciliation` verifies that unresolved obligations are a
subset of failed obligations, recovered and unresolved sets do not overlap,
fatal errors are not inferred from transient failures, and bounded details do
not replace authoritative totals.

Provider obligation detail is bounded. New audits archive exact aggregate
counters when older successful details roll off, so the unique failed,
recovered, unresolved, and generation-coverage scalars remain authoritative.
Legacy truncated audits that predate those counters identify that limitation
instead of presenting retained detail as an exact total.

## Performance and repair

`performance_diagnostics` separates active page-attempt wall time, provider
request time, and downtime between attempts. Manual/restart gaps are never
reported as provider processing. New runs accumulate exact provider duration,
request-category, message-count, segment-distribution, amplification, and
longest-request metrics. Retained Short-Term segment records also identify
whether the 32-message adaptive recovery-growth cap applied; normal compaction
passes are explicitly outside that cap. Older reports clearly label
retained-only estimates and unknown legacy cap decisions.

`targeted_extraction_replay` records the invocation, selected obligation IDs,
original lineage, provider/parse/persistence outcomes, unresolved counts before
and after, recovered and remaining IDs, and classification transition. Targeted
repair never changes a completed lifecycle into an incomplete one.

`compaction_request_audit.ledger_reconciliation` verifies exact attempt and
commit totals. Retained successful entries must be provider-complete, parsed,
and committed; legacy completed ledgers may be restored from exact durable
commit counters without rewriting historical storage.
