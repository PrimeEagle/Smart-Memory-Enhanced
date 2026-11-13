# Memorize Chat authority model

## Purpose

Memorize Chat persists several views of a long extraction run. Only two are
authoritative. All other views are one-way projections and may never schedule
provider work, advance a checkpoint, or classify a controller exit.

## Authorities

### Shared lifecycle coordinator

Every current-runtime Session and Long-Term extraction leaf uses one immutable
identity containing the logical run, root obligation, exact leaf obligation,
parent, physical attempt, tier/owner, source range, source fingerprint,
recovery stage, and optional source-unit identity. The root remains stable
through repartition; the leaf always names the exact dispatched range.

The coordinator validates every reducer result. Only an applied result or an
idempotent duplicate whose resulting state matches the requested boundary may
advance. A rejection stops the pipeline with the durable provider journal left
pending local reconciliation. Retry settlement resolves the exact leaf; range
fallback is limited to the versioned legacy identity migration.

### Provider-completion journal: physical authority

The provider-completion journal owns physical request facts: attempt identity,
request registration, response receipt, parser and validation dispositions,
persistence disposition, terminal outcome, durable record IDs, and replay
status. Its writers are the shared Session/Long-Term tier pipeline and the
provider completion journal module.

### Memorize obligation ledger: logical authority

The obligation ledger owns root/leaf identity, parent-child relationships,
logical state, recovery eligibility, exact next action, terminal coverage,
contiguous coverage, and checkpoint eligibility. The only production mutation
API is `applyMemorizeLifecycleEvent`. Parent aggregation and journal
reconciliation use the same reducer.

The following queries are the control API:

- `getAuthoritativeTierRangeStatus`
- `getAuthoritativeOwnerRangeStatus`
- `isAuthoritativeTierRangeSafelyCovered`
- `getFirstActionableObligation`
- `getContiguousSafeSourceOffset`
- `getNextSourceTraversalRange`

### Run manifest: controller history

The run manifest retains attempts, elapsed/controller history, source-window
identity, and bounded progress summaries. It does not independently decide
whether a tier or owner obligation is complete.

## Derived manifest state

`tier_obligations`, `tier_coverage`, `owner_obligations`, committed ranges,
committed chunks, Resume presentation, chunk presentation, and diagnostic
summaries are projections. `rebuildMemorizeManifestProjection` rebuilds
coverage fields from the obligation ledger. It is pure with respect to provider
and memory persistence, preserves attempt history, and is idempotent.

Processing offsets are reconstructed from canonical root ranges in source order
and their durable message counts. Persisted derived ranges are not read back as
a coordinate authority.

Derived fields exist for export and UI display. Their only writer is the
projection rebuild. They are not valid inputs to provider dispatch,
persistence, checkpoint advancement, controller-exit classification, or
finalization gates.

## Resume reconciliation order

Before selecting work, Resume performs this order:

1. Load the checkpoint and manifest.
2. Require the current execution-kernel schema.
3. Restore exact leaf IDs from matching current-run journal evidence.
4. Reconcile interrupted physical attempts.
5. Reconcile terminal provider completions.
6. Reconcile complete terminal evidence directly to the exact leaf.
7. Aggregate terminal child obligations.
8. Retire recovery windows whose canonical roots are terminal.
9. Rebuild manifest projections from the ledger.
10. Derive the contiguous safe offset and select exactly one of:
   actionable recovery, normal source traversal, blocked work, or finalization.
11. Only then open a transaction or dispatch a provider request.

## Durability boundaries

1. **Attempt start:** audit registration, running journal entry, verified
   `provider_attempt_started`, and controller heartbeat.
2. **Provider terminal:** retained response or transport disposition and the
   physical terminal outcome.
3. **Downstream:** parser/validation disposition, staged candidates,
   persistence result, durable IDs, and candidate mappings.
4. **Coverage:** verified terminal leaf receipt, derived parent aggregation,
   manifest projection, and checkpoint.

A later boundary cannot acknowledge an earlier one on a caller's assertion.
Journal ledger/manifest acknowledgements are written only from a verified
reducer receipt or terminal-evidence reconciliation. A crash resumes at the
first missing boundary without repeating completed external work.

If no obligation is pending and source messages remain, the action is always
`continue_source_traversal`. A null action is never advertised as resumable.

## Invariants

- Canonical terminal state is monotonic.
- A manifest projection cannot downgrade committed work or promote
  uncommitted work.
- Every enabled tier must be terminal before a source range is generally
  committed.
- Provider attempt registration and the semantic running event are one awaited
  dispatch boundary.
- Response precedes parser disposition; parser precedes validation; validation
  precedes staging; staging precedes durable persistence.
- Explicit no-update requires parser or validation evidence.
- A retry requires a typed prior disposition and recovery action.
- Durable records retain exact candidate mappings or an explicit alias or
  explicit current-schema proof.
- A terminal root retires active recovery intent without deleting historical
  attempt or durable-record evidence.
- Reconciliation and projection repair make zero provider calls and zero memory
  persistence calls; a second pass makes zero mutations.
- Terminal evidence reconciliation never manufactures candidate mappings and
  never regresses an already terminal obligation.

## Clean-start behavior

There is no old-schema bootstrap. A run starts with the current execution
kernel and exact canonical identities. Journal-backed candidate mappings are
restored only when both the durable record ID and candidate ID are explicitly
present. Current-run transition gaps remain active and fail integrity checks;
an incompatible saved run must be cleared instead of translated in place.
