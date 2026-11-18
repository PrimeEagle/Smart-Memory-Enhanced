# Memorize execution architecture

This document describes the production wiring in the current source tree. It
is descriptive; the execution kernel and persisted checkpoint are the runtime
authorities.

## Authoritative path

Memorize Chat has one controller-owned loop:

1. `memorize-action-engine.js` selects one exact incomplete leaf from the
   obligation ledger.
2. `memorize-tier-pipeline.js` registers one physical attempt and constructs a
   complete provider-completion command.
3. The tier parser assigns a `candidate_identity` envelope at parser
   acceptance. Normalization, repair, deduplication, owner partitioning, and
   active/retired merging preserve that envelope.
4. Session and multi-owner Long-Term construct durable record IDs, candidate
   mappings, provenance, idempotency keys, transition intent, checkpoint
   effect, controller ownership, and transaction generation before storage.
5. `prepareProviderCompletionCommand()` validates the complete immutable
   command before the first production record write.
6. The storage adapter writes only the validated record set. The unit-of-work
   journal records `prepared`, `storage_write_started`,
   `storage_write_confirmed`, `canonical_receipt_pending`, and `committed`.
   Storage failure becomes `compensation_required`.
7. `memorize-execution-kernel.js` is the only component that can make the leaf
   checkpoint-eligible. Coverage, health, action receipts, and provider journal
   entries are evidence or projections; they are not commitment authorities.
8. The controller rereads the graph. It dispatches the next sibling, performs
   a local parent aggregation, advances the safe checkpoint, or reports one
   exact blocker.

The execution-kernel schema is 3, execution-context schema is 2,
unit-of-work schema is 2, and provider-completion-journal schema is 7. Older
incomplete runs are intentionally unsupported and require **Fresh Start**.

## Candidate and persistence contracts

`candidate-identity.js` owns the typed identity envelope. Provider candidates
receive identity when the parser materializes the accepted record (or, for a
string-returning parser, when its typed domain record is constructed). A
transformation preserves that identity; changing it is rejected unless a
derived-candidate contract supplies a parent identity and transformation
receipt. User edits and pre-existing records receive deterministic identities
at the common save boundary because they have no provider parser event.

A controller-managed persistence command contains:

- command, workflow, controller, page, transaction, generation, work-item,
  tier, owner, source-range, and source-fingerprint identity;
- parser- and validation-accepted candidate IDs;
- stable durable record IDs and one candidate mapping per record;
- source provenance and an idempotency key per record;
- duplicate/no-update disposition, intended transition, checkpoint effect,
  and journal receipt identity.

Duplicate record IDs, missing or extraneous mappings, parser/validation
disagreement, missing provenance, missing idempotency, and missing ownership
identity fail before storage. The exact validated command is submitted to the
kernel and summarized in the replay journal.

`persistence-command.js` is domain-neutral. `feature-persistence.js` adapts
independent workflows to it with explicit synthetic controller ownership and
one transaction generation per command. It validates before `apply`, keeps a
bounded idempotent receipt table, persists the domain state and receipt in one
host save where the host exposes an awaitable save, and restores both on
failure. SillyTavern's settings API is debounced rather than awaitable;
settings-backed stores therefore validate and record the receipt synchronously
before requesting the host save, while chat-metadata stores use the full
awaitable rollback path.

## Transaction model

The immutable ownership lease contains logical run, controller, transaction,
generation, page, and cancellation epoch. A generation, owner, page,
cancellation epoch, settled transaction, or transaction-ID change is stale.
Revision is optimistic mutable state, not ownership. A callback whose revision
advanced under the same active owner/generation is rebased and revalidated;
it is reported as `same_owner_revision_rebased`, not a stale callback.

## Resume and error behavior

`deriveMemorizeRecoveryAuthority()` is the single UI, diagnostics, controller,
and status decision. It is fail-closed over
`deriveMemorizeResumeEligibility()`: a later executable sibling cannot override
an invalid earlier leaf. Persistence-command failure is one root error and the
affected obligation is moved to an exact blocked state; the controller does
not add a derivative “recovery incomplete” root error.

The provider journal retains bounded structural evidence needed for local
replay: command/attempt/work-item identity, accepted candidate IDs, validation
IDs, durable IDs, mappings, provenance, persistence command receipt,
transaction generation, checkpoint effect, and terminal disposition. Provider
response bodies and memory bodies are not exported.

## Production path inventory

| Path | Execution owner | Durable state / transaction | Current shared foundations |
| --- | --- | --- | --- |
| Memorize multi-owner Long-Term and missing-owner recovery | Canonical action engine | Owner stores inside catch-up transaction | Typed candidates, pre-write command validation, deferred owner commits, kernel receipt, journal v7 |
| Memorize Session, malformed children, partial fragments, citation repair | Canonical action engine | Session store inside catch-up transaction | Typed candidates, pre-write command validation, kernel receipt, journal v7 |
| Context-overflow and nested child recovery | Canonical action engine | Obligation children and transaction checkpoint | Same leaf command and receipt path; parents cannot dispatch |
| Provider attempt, action receipt, coverage and live health | Controller observers | Metadata checkpoint | Evidence only; cannot commit a leaf |
| Cancellation, page reload, Resume, finalization eligibility | Controller | Checkpoint and ownership lease | One recovery authority and ownership/generation lease |
| Diagnostics, integrity and idempotence audits | Observer | Read-only snapshots | Pure projections; bounded recent tables and no response bodies |
| Retrieval and prompt injection | Request-time reader | No extraction write | Outside the obligation graph |
| Realtime Long-Term and Session | Interactive workflow | Character/chat stores | Shared candidate envelope and feature persistence command; not a Memorize recovery owner |
| Profiles and profile repair | Finalization/domain workflow | Chat profile map | Shared command, snapshot rollback, bounded receipt; pending-generation notice remains operational metadata |
| Scene detection and summaries | Scene workflow | Chat scene archive | Scene candidate identity plus shared command/rollback/receipt |
| Story Arcs, resolved summaries, persistent character/group arcs | Arc workflow | Chat and settings arc stores | Shared command; chat saves rollback, settings saves validate synchronously |
| Relationship History and epistemic knowledge | Realtime/finalization workflow | Chat-local or character settings | Shared identity, command, mapping, provenance fallback, receipt |
| State Ledger and entity registries | Realtime/reconciliation workflow | Chat or character stores | Shared command; reconciliation remains the domain owner |
| Short-Term compaction | Compaction workflow | Summary, boundary and pass checkpoint | Each pass/final snapshot is one validated command and rollback unit |
| Canon | User/finalization workflow | Chat-local or character settings | Shared command and receipt; no Memorize checkpoint authority |
| Continuity Check | User-invoked read/repair workflow | Domain repair stores | Outside Memorize action selection; cannot alter Memorize checkpoint eligibility |
| Stabilization and reconciliation | Finalization workflow | Canonical stores | No tier-recovery dispatch and no alternate Memorize commitment authority |

## Diagnostic retention

The export contains one kernel table with compact obligations, attempts,
capsules, and recent receipts. Current-attempt chunk history retains at most 64
entries with total/retained/truncated metadata; the former three duplicate
chunk arrays were removed. Kernel semantic events, action receipts, stale
callbacks, provider-journal entries, errors, and historical run summaries are
independently bounded.

## Non-writing and control-path audit

- Retrieval and injection read canonical stores and update prompt/cache state;
  they do not create memory records or advance extraction checkpoints.
- Continuity Check owns its user-requested domain repair, but all resulting
  Session, Long-Term, relationship, entity, scene, arc, ledger, and canon saves
  enter through the corresponding shared writer above.
- Stabilization and reconciliation may transform several domain stores in one
  staged catch-up transaction. They cannot register provider success or make a
  Memorize leaf checkpoint-eligible.
- Cancellation increments the cancellation epoch and aborts active provider
  work. Page replacement changes page ownership. Either invalidates an old
  lease; an ordinary same-owner revision increment does not.
- Fresh Start deletes current run state rather than migrating an incompatible
  execution graph. Resume only settles attempts, replays complete evidence,
  selects an exact repair action, or returns an exact blocker.
- Diagnostics and UI consume frozen projections. Observer exceptions are
  classified and contained; neither layer may dispatch, persist, repair, or
  mutate canonical execution state.

## Error taxonomy

The command boundary preserves separate reason classes for provider transport,
malformed output, parsing, semantic/provenance validation,
persistence-command validation, storage write, canonical receipt, saga repair,
ownership loss, optimistic revision conflict, cancellation, page interruption,
external blocker, programming invariant, diagnostic observer, and UI
presentation failures. A recovery/status projection references its root error;
it does not create a second root error. The state impact, exact repair action,
and terminal/recovered disposition remain attached to that causal chain.

## Release gates

- Invalid mappings/provenance and duplicate durable IDs perform zero writes.
- Same-owner revision advancement rebases; real ownership/generation changes
  reject.
- An invalid earlier leaf suppresses Resume even when a later sibling is
  executable.
- A 9,434-message deterministic canonical orchestration completes without a
  missing leaf or duplicate dispatch.
- Diagnostic observers cannot mutate or fail a committed command.
- Feature storage failure restores both the domain snapshot and its receipt;
  repeated command IDs replace rather than duplicate receipts, and retention is
  bounded to 128 entries.
