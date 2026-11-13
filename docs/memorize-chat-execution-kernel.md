# Memorize Chat execution kernel

## Characterized v0.9.85 production flow

The production path before this refactor distributed one logical completion
across several independently persisted mutations:

```text
settings.js controller
  -> Session/Long-Term adapter
     -> provider-attempt-audit registration
     -> provider transport
     -> provider-completion-journal response write
     -> memorize-lifecycle-coordinator response transition
     -> tier parser
     -> coordinator parser transition
     -> tier validator
     -> coordinator validation transition
     -> memory-store write
     -> completion-journal persistence write
     -> coordinator persistence/coverage transition
  -> settings.js checkpoint/transaction write
  -> recovery/status/UI/diagnostic projections
```

Malformed output added a second recursive path through
`malformed-output-recovery.js`. That path could split an obligation, register
and settle attempts, retain partial records, and ask the tier adapter to emit
more lifecycle transitions. Resume reconciled the journal, ledger, attempt
audit, recovery windows, controller exit, transaction, and manifest
manifest before choosing work. This produced the following competing writers.

| State | v0.9.85 writers |
|---|---|
| Obligation state | tier pipeline, lifecycle coordinator, settings retry settlement, journal reconciliation |
| Provider attempt | tier pipeline, tier adapters, malformed recovery, provider attempt audit |
| Recovery state | malformed recovery, provider attempt audit, tier adapters, settings controller |
| Completion journal | tier adapters, provider attempt audit, retained-evidence application, reconciliation |
| Checkpoint | settings controller, transaction callbacks, manifest projection |
| Run/status/Resume | ledger projection, recovery authority, controller exit, retained-evidence plan, UI selectors |

The v0.9.85 failures are consequences of these split boundaries:

- parser or validation evidence could be emitted after a recovery attempt but
  attached to the root or a different leaf than the response;
- accepted records and rejected-fragment identities could persist while the
  private fragment body did not, leaving a non-executable Resume action;
- a callback could fail between journal, ledger, record-store, and checkpoint
  writes, leaving only a subset committed;
- a fixed recovery ladder repeatedly rediscovered that the active provider
  profile could not reliably satisfy the tagged-line grammar.

## Target component boundaries

### Run orchestrator

Selects one executable terminal-frontier leaf from the canonical projection.
It controls traversal and finalization gates, but cannot emit arbitrary
lifecycle transitions. Initial execution and Resume use this same selector.

### Obligation aggregate

`memorize-obligation-ledger.js` remains the single logical authority. The
execution kernel adds command receipts, exact attempt ownership, recovery
capsules, provider-profile policy, and a compact semantic event stream to that
aggregate. Parent obligations become non-dispatchable containers when split;
only unsuperseded leaves may own attempts.

### Provider adapter

Builds a request and returns a typed transport result. It never writes ledger,
journal, checkpoint, UI, or diagnostics. Structured JSON is preferred when the
profile has demonstrated native schema support.

### Parser and validator

Consume source context plus a typed provider result and return immutable typed
outcomes. They do not persist records or lifecycle state.

### Atomic completion command

`applyProviderCompletion` accepts one command ID, exact leaf ID, exact physical
attempt ID, parser result, validation result, persistence result, durable
mappings, and recovery capsule. On a cloned aggregate it verifies identity and
applies response, parser, validation, staging/persistence or recovery in legal
order. The whole new aggregate is then committed once. Replaying a command ID
is a no-op. Mismatched callbacks produce a typed, non-mutating result. A first
late callback records one bounded diagnostic observation but cannot change the
terminal obligation or its durable records; replaying it is then a no-op.

### Unit of work

The durable completion journal is the prepared intent before external record
writes. After those idempotent writes, the controller's leased completion hook
passes the command through the execution unit-of-work journal as
`prepared` -> `records_applied` -> `committed`, atomically swaps the aggregate,
checkpoint metadata, and command receipt, and saves them once. Replay uses the
completion journal plus durable record IDs/candidate mappings to finish an
interrupted intent or leaves the previous aggregate revision intact. Diagnostic
observation runs only after commit and cannot throw into execution.

### Resume coordinator and status projection

One pure projection selects the exact pending obligation and action. Resume is
enabled only if that action's durable inputs are present. Durable blockers
outrank inferred plans. UI, controller, diagnostics, and recovery panels consume
the same projection without mutating it.

## Canonical state

The run manifest owns one obligation ledger containing:

- logical run ID and monotonically increasing kernel revision;
- root/container and leaf obligations with exact source fingerprints;
- explicit child partitions and supersession state;
- exact physical attempts per leaf;
- parser, validation, durable mapping, and terminal disposition per command;
- durable recovery capsules and executable regeneration recipes;
- bounded applied-command receipts and compact semantic events;
- provider-profile protocol statistics and attempt/amplification budgets;
- checkpoint and finalization eligibility derived from terminal frontier
  coverage.

The provider-completion journal, attempt audit, coverage summaries,
diagnostics, and UI are one-way projections. Production completion writes enter
through the kernel, and all displayed state is rebuilt from the committed
aggregate.

## Commands

- `registerObligation`
- `splitObligation`
- `registerProviderAttempt`
- `applyProviderCompletion`
- `commitPersistence`
- `pauseOrBlockObligation`
- `cancelRun`
- `selectNextExecutableAction`
- `commitFinalizationPhase`

Commands carry an idempotency key and expected aggregate revision. No UI,
diagnostic or projection helper may issue semantic transitions.

## Required invariants

1. Every attempt belongs to exactly one active terminal-frontier leaf.
2. Active leaves cover each active source index exactly once.
3. Split parents and superseded leaves are non-dispatchable.
4. Children are ordered, non-overlapping, and exactly cover their parent.
5. Response, parser, validation, and persistence evidence share one leaf and
   attempt.
6. Durable records have candidate mappings and source provenance.
7. Checkpoint advancement cannot cross a nonterminal required leaf.
8. Finalization requires complete prerequisite frontier coverage.
9. Resume requires one exact action executable from durable inputs.
10. Replayed, duplicate, late, and reordered commands cannot duplicate records
    or regress terminal state.
11. Private provider text is never the only recovery route while a verified
    source window is available.
12. Diagnostic observer failures cannot affect execution.

## Crash and replay model

Each asynchronous/durable boundary records a bounded unit-of-work phase:
`prepared`, `records_applied`, or `committed`. A crash before `records_applied`
leaves the old aggregate. A crash after record application replays the same
idempotent completion command and deduplicates by durable record ID/candidate
mapping. A crash after aggregate commit sees the command receipt and performs
no mutation. Cancellation stops new dispatch but commits any already completed
atomic command before releasing controller ownership.

## Clean-start policy

There is no old-schema checkpoint migration or compatibility authority. A new
Memorize Chat manifest creates the execution kernel immediately, and every
controller-managed tier requires the atomic completion hook. Current-schema
crash recovery replays the same command and recovery capsule; an incompatible
saved run is rejected and must be cleared with Fresh Start instead of being
silently interpreted or mutated.

## Status derivation

Status is derived only from the committed aggregate. A durable blocker wins
over a planner snapshot. Expected malformed provider output is a typed recovery
outcome and historical notice; only unresolved internal invariants,
persistence failures, or genuinely non-executable external conditions are
current errors. “Resume available” is impossible unless the selected action is
executable now.
