# Memorize execution architecture

This inventory defines which provider paths belong to the durable Memorize Chat
execution graph. It is a release-gate reference, not a second runtime authority.

## Category A — durable extraction work

| Path | Durable owner | Worker contract |
| --- | --- | --- |
| Long-Term source extraction and missing-owner recovery | Canonical controller scheduler and obligation ledger | One typed attempt/outcome per dispatch |
| Session source extraction, malformed recovery, and context repartition | `memorize-action-engine.js` and obligation ledger | Declare children, yield, execute one selected leaf |

Category A work must use the same initial/Resume loop. A worker must not own a
recursive retry scheduler, a private continuation budget, or parent aggregation.
The controller rereads the durable graph after every action. Registered parents
are containers: only incomplete leaves may issue provider requests.

## Category B — read-only verification

Diagnostics, idempotence checks, integrity audits, and canonical projections may
read immutable snapshots. They cannot dispatch providers, persist extraction
records, advance checkpoints, or infer a different recovery action.

## Category C — presentation and injection

UI status, Resume enablement, live health, diagnostics export, and prompt
injection are pure projections of canonical state. Observer failures are
non-fatal and remain separately classified.

## Category D — independent workflows

| Production path | Category | Lifecycle justification |
| --- | --- | --- |
| Provider-attempt audit, idempotence, integrity, stabilization audit | B | Evidence/projection only |
| Diagnostics export and run-status derivation | B | Frozen settled snapshot only |
| Resume button, live health, ETA, error/status panels | C | Canonical-state presentation only |
| Memory injection and retrieval | D | Request-time prompt assembly; never extraction authority |
| Profile extraction and repair | D | Finalization workflow with its own validated record contract |
| Scene extraction/detection | D | Finalization workflow with scene-boundary semantics |
| Story Arc extraction and repair | D | Finalization workflow after scene completion |
| Relationship extraction/history | D | Finalization workflow with grounded pair validation |
| State Ledger extraction | D | Independently enabled structured-state workflow |
| Short-term compaction/finalization | D | Summary workflow with a separate resumable phase checkpoint |
| Realtime Long-Term/Session building | D | Interactive incremental workflow outside Memorize traversal |
| Continuity Check provider work | D | Read/repair workflow initiated independently by the user |
| Automatic stabilization and final reconciliation | D | Post-extraction canonicalization; cannot dispatch tier recovery |
| Cancellation/page reload/finalization eligibility | A | Owned by the Memorize controller and durable checkpoint |

Category D paths retain explicit independent lifecycles. They may not mutate
the Memorize obligation graph or present themselves as its recovery authority.

## Invariants

1. One controller owns action selection, retry order, durable budgets, and
   parent aggregation.
2. Initial execution and Resume call the same action loop.
3. A selected leaf identity includes tier, owner, exact source range, source
   fingerprint, root, and immediate parent.
4. A committed leaf is never dispatched again.
5. A parent with incomplete registered children is never dispatched.
6. Diagnostics and UI report the canonical graph, never compatibility caches.
7. Provider output failures are not internal invariant failures.
