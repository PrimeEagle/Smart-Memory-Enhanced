# Memorize domain architecture

This note describes the current clean-break execution model. Persisted state
from an older schema is deliberately rejected and requires **Fresh Start**.
Short-Term Resume likewise requires its current signed recovery plan (or a
current post-commit marker); it does not synthesize plans or rewrite failure
history from older incomplete checkpoints. Its provider-attempt accounting
must also use the current schema; older bounded attempt samples are rejected
instead of being promoted into an inexact cumulative total.
Browser page-run markers and targeted replay checkpoints likewise accept only
their current schemas. Targeted replay requires both the retained and current
provider-configuration signatures to match before it can become executable.
Character and chat memory stores are also current-schema-only. Creation paths
stamp the schema immediately; startup validates rather than migrating, so an
older nonempty test store requires clearing/Fresh Start and cannot be silently
rewritten while loading a chat.

## Plain-data boundary

Every value that is persisted, hashed, journaled, checkpointed, returned as an
outcome, or projected into diagnostics crosses `serializable-domain.js`.
Allowed values are null, strings, booleans, finite numbers, dense arrays, and
plain objects with string keys. Undefined, non-finite numbers, functions,
promises, symbols, bigints, accessors, DOM-like values, class instances, sparse
arrays, and cycles are rejected with the exact failing property path.
`serializable-domain.js` is the only production module permitted to invoke the
platform clone primitive; all callers must supply a named path, stage, and
operation to its validated clone boundary.

Unavailable measurements use `null` plus an explicit status. Optional fields
are either omitted by a schema-owned builder or are present with `null`; they
are never published as `undefined`.

## Authority and projections

The canonical obligation ledger is the authority for executable work and
Resume eligibility. A provider-attempt audit is bounded accounting evidence,
and the completion journal is retained downstream evidence. Neither independently
authorizes an action. Checkpoints own committed source coverage. Controller
heartbeats describe only the currently live controller. UI and diagnostics are
read-only projections of these authorities.

| Concern | Authority | Builder / boundary | Effect / persistence owner |
| --- | --- | --- | --- |
| Obligation lifecycle | `memorize-obligation-ledger.js` | lifecycle identity and ledger reducers | lifecycle coordinator hook |
| Provider registration/dispatch | obligation ledger | provider audit + completion journal, validated at leased checkpoint | Memorize tier pipeline |
| Provider response replay | completion journal | provider-completion command | execution kernel |
| Source coverage | checkpoint/run manifest | persistence command and durable receipt | leased checkpoint transaction |
| Controller exit | controller runtime, then ledger | canonical controller-exit DTO | outer controller finalizer |
| Recovery selection | canonical obligation state | action engine/dispatcher | recovery scheduler |
| UI status | none | projection from ledger/checkpoint/controller | no effects |
| Diagnostics | none | full or independent compact projection | export only |

Full reports cross `createFullDiagnosticsExport()` only after controller and
transaction settlement. If that optional projection fails, the observer
boundary retains the completed execution result and publishes the independent
compact failure schema instead; diagnostics are never an input to execution.

## Provider boundary

Provider work advances in this order:

1. Allocate a proposed attempt identity.
2. Validate the proposed plain-data aggregate.
3. Durably record `provider_attempt_registered`.
4. Publish the registration state.
5. Immediately before network transmission, durably record
   `provider_attempt_started`.
6. Transmit and retain response or terminal transport evidence.

Registration without transmission is not a physical request. A failure before
durable registration restores the audit, journal, and leased metadata snapshot,
settles the controller transaction, and preserves the original exception.
Recovery is selected from the last verified durable stage: locally discard an
untransmitted registration, replay a retained response locally, and contact the
provider only when the canonical action requires it.

## Feature paths

Memorize Session and Long-Term use the shared tier pipeline. Independent
real-time writers use `feature-persistence.js`, which produces the same
identity-backed persistence commands and immutable receipts without joining the
Memorize lifecycle. Every feature rollback snapshot crosses the strict
serializable-domain clone before its apply effect; raw structured cloning is
not a production persistence boundary. Injection is read-only and operates on stored plain-data
records. Unified injection builds one immutable selection plan before prompt
effects, including eligibility, deterministic ordering, exact-content
deduplication, upstream-budget accounting, placement, rejection reasons, and
content-free provenance diagnostics. Its exposed token breakdown and complete
diagnostic projection are schema-owned read models.
Continuity Check consumes those same canonical stored identities and returns a
canonical outcome. Its evidence set retains the stored candidate/source
identity through budget selection while its diagnostic projection omits prose.
Provider failure is represented by a bounded diagnostic error DTO, never a
runtime `Error`. Continuity does not own persistence or recovery state.

Extension-settings writers use the synchronous form of the same feature
executor. It validates the command and snapshot, applies the mutation, records
the receipt, invokes the settings persistence effect, and restores both data
and receipts if that effect throws. Receipt construction is private to the
shared executor; feature modules cannot claim persistence independently.

## Failure settlement

The controller runtime is created outside the main try block and owns its active
transaction and cleanup resources. The outer finalizer records one prioritized
controller exit and settles the transaction to committed, rolled back, or an
explicit commit/rollback-failure state. Cleanup failures are bounded warnings
and cannot replace the first meaningful exception.

## Release gates

`test:architecture-gates` validates the plain-data contract, provider ordering,
transaction settlement, production fault matrix, startup path, compact failure
projection, independent feature persistence, and deterministic 9,434-message
replay. `npm test` remains the broader behavioral and regression suite.
