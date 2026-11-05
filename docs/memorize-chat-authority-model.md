# Memorize Chat authority model

## Purpose

Memorize Chat persists several views of a long extraction run. Only two are
authoritative. All other views are one-way projections and may never schedule
provider work, advance a checkpoint, or classify a controller exit.

## Authorities

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

## Derived compatibility state

`tier_obligations`, `tier_coverage`, `owner_obligations`, committed ranges,
committed chunks, Resume presentation, chunk presentation, and diagnostic
summaries are projections. `rebuildMemorizeCompatibilityProjection` rebuilds
coverage fields from the obligation ledger. It is pure with respect to provider
and memory persistence, preserves attempt history, and is idempotent.

Processing offsets are reconstructed from canonical root ranges in source order
and their durable message counts. Persisted compatibility ranges are not read
back as a coordinate authority; an explicit coordinate map is accepted only at
the legacy migration boundary when canonical range identity is unavailable.

Compatibility fields exist for old checkpoints, export stability, and UI
display. Their permitted writers are migration followed by the projection
rebuild. They are not valid inputs to provider dispatch, persistence,
checkpoint advancement, controller-exit classification, or finalization gates.

## Resume reconciliation order

Before selecting work, Resume performs this order:

1. Load the checkpoint and manifest.
2. Normalize and migrate schemas.
3. Reconcile interrupted physical attempts.
4. Migrate terminal provider completions.
5. Replay journal-backed downstream dispositions.
6. Aggregate terminal child obligations.
7. Retire recovery windows whose canonical roots are terminal.
8. Rebuild compatibility projections from the ledger.
9. Derive the contiguous safe offset and select exactly one of:
   actionable recovery, normal source traversal, blocked work, or finalization.
10. Only then open a transaction or dispatch a provider request.

If no obligation is pending and source messages remain, the action is always
`continue_source_traversal`. A null action is never advertised as resumable.

## Invariants

- Canonical terminal state is monotonic.
- A compatibility projection cannot downgrade committed work or promote
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
  migration limitation.
- A terminal root retires active recovery intent without deleting historical
  attempt or durable-record evidence.
- Reconciliation and projection repair make zero provider calls and zero memory
  persistence calls; a second pass makes zero mutations.

## Migration behavior

Schema migrations may use old compatibility fields only to bootstrap missing
canonical identities. Once a ledger exists, journal and ledger evidence wins.
Journal-backed candidate mappings are restored only when both the durable record
ID and candidate ID are explicitly present. Proven historical transition gaps
move to reconciled historical observations; unproven current-runtime violations
remain active and fail integrity checks.
