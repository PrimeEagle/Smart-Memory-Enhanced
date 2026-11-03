# Memorize Chat canonical lifecycle

This document defines the authoritative execution model introduced in v0.9.75.
Provider output is evidence; it is never, by itself, extraction completion.

## Entities and authority

| Entity | Authoritative data | Terminal meaning |
|---|---|---|
| Logical root obligation | obligation ledger | all required leaves are covered |
| Recovery leaf obligation | obligation ledger | its exact source range is committed or explicitly no-update |
| Physical provider attempt | completion journal | one terminal provider disposition exists |
| Parsed candidate | journal parser disposition | syntax was accepted, partial, rejected, or not applicable |
| Validated candidate | journal validation disposition | semantic/provenance validation reached a terminal result |
| Durable record | memory store plus journal record ID | persistence is verified and linked to a candidate/attempt |
| Source coverage | terminal leaf states | every source index belongs to exactly one terminal or pending leaf |
| Checkpoint | contiguous terminal leaf coverage | every required tier covers every earlier source index |
| Controller invocation | controller heartbeat and exit record | ownership is active or durably closed, never both |
| Transaction | transaction lifecycle | active, committed, rolled back, or explicitly transferred |
| Recovery action | pending leaf reason/action | an executable next step for one exact leaf |

Diagnostics and UI objects are projections of these authorities. They must not
be independently mutated as competing state.

## Provider attempt pipeline

```text
registered -> provider running -> response/transport terminal
           -> parsed -> validated -> persisted/discarded/no-update
           -> leaf transition -> ancestor recompute -> checkpoint recompute
           -> transaction close -> controller select-next-or-exit
```

The attempt is registered in the completion journal before dispatch. A terminal
provider outcome is recorded before parsing. A journal entry becomes fully
applied only after parser, validation, persistence, coverage/manifest, ledger,
and live-health stages have explicit dispositions. A crash at any arrow resumes
the unapplied downstream stages without repeating a usable provider response.

## Obligation reducer

| From | Permitted classes | Forbidden example |
|---|---|---|
| unattempted/pending/paused | running when a physical attempt ID exists | running without an attempt |
| running | response, pause, failure, terminal coverage | direct unaccounted mutation |
| parser/validation/staged | later downstream stages or pending recovery | unrelated source-range completion |
| durably committed/no-update | same-state idempotent replay only | committed -> running |

The reducer validates first. A rejected transition records a bounded
current-runtime diagnostic event but does not mutate the obligation. Historical
violations imported from old schemas are retained separately as normalized
observations.

## Parent and child coverage

A recovery partition creates independent leaves. Record persistence on leaf A
does not change leaf B and does not close the parent. The parent is derived:

- **complete**: every required leaf is terminally covered;
- **pending**: at least one leaf has an executable action;
- **paused**: unresolved leaves exhausted the current bounded recovery budget;
- **failed**: a genuinely non-resumable terminal error exists.

Explicit no-update is terminal coverage without record persistence. Checkpoint
advancement uses contiguous terminal leaf coverage, never record count or the
furthest range merely traversed.

## Resume and controller ownership

Initial execution and Resume use the same provider/parse/validate/persist/cover
pipeline. Resume first reconciles journal entries, stale attempts, transactions,
and controller ownership. Completed leaves are skipped. Existing durable record
IDs are verified rather than inserted again.

Every pending leaf has a typed reason and concrete next action. Therefore the UI
may advertise Resume only when `actionable_pending_obligation_count > 0` and no
active controller/transaction owns the run. Controller exit settles or transfers
its transaction, releases its claim, clears the active provider attempt and await
point, closes the heartbeat, and persists its exact exit classification.

## Invariants

1. Terminal committed/no-update obligations cannot regress to running.
2. A parent is complete only when every required leaf is terminally covered.
3. Child record persistence never implies parent coverage.
4. Every physical attempt has exactly one durable terminal disposition.
5. Every successful response is journaled before projections are complete.
6. Every durable record maps to a validated candidate and producing attempt.
7. Pending work always has a typed reason and executable next action.
8. Unactionable work is never advertised as resumable.
9. Controller exit leaves no owned provider attempt or transaction active.
10. Resume never calls the provider for a completed leaf.
11. Reconciliation, replay, and migration are idempotent.
12. Current-runtime violations are separate from normalized historical evidence.

## v0.9.74 migration

Migration v1 recognizes an ambiguous parent only from durable evidence in the
latest root recovery epoch. It creates committed, paused, and unattempted leaves;
moves durable record provenance to the committed leaf; synthesizes completion
journal entries only where a terminal attempt and durable records support them;
and performs no provider call. A durable migration marker makes repeated startup
and Resume reconciliation mutation-free.
