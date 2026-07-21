# v0.8.14 Regression Implementation Notes

These notes document the observed execution paths before the regression fixes.
They intentionally describe storage and ordering, not roleplay content.

## Traced paths

- Active persona roster: `canonical-entities.js` →
  `buildCanonicalCharacterRoster(context)`. It is used by primary/session
  extraction, scenes, arcs, profiles, and the final reconciliation pass.
- Final canonical reconciliation: `settings.js` →
  `runFinalIntegrityReconciliation()` → `ui.js` →
  `reconcileCanonicalEntities()`.
- Card-local registry reconciliation: `reconcileCanonicalEntities()` iterates
  `chatMetadata[smartMemoryEnhanced].card_local_entities`; the associated
  memory stores are `card_local_memories`.
- Relationship History merging: new writes pass through `longterm.js` and
  `reconcileRelationshipHistoryMap()`; final reconciliation currently handles
  card-local relationship maps separately from character-scoped maps.
- Session extraction and citations: `session.js` builds the prompt with
  `buildSessionExtractionPrompt()`, parses with `parseSessionOutput()`, then
  maps relative citations with `applyDirectProvenance()`.
- Arc pipeline: `arcs.js` performs extraction, `classifyArcResolution()`,
  `generateArcSummary()`, deterministic preverification, semantic verification,
  and summary persistence.
- Profile generation: `profiles.js` builds and parses the profile, then applies
  grounding and relationship checks before storage.
- Final diagnostics: `settings.js` assembles `runResult` after final
  reconciliation and writes it through the staged transaction.

## Root causes found before edits

1. **Persona roster omission:** the roster builder has no explicit scope or
   authoritative persona input. It only relies on a limited set of context
   fields. Final reconciliation invokes it without a selected-persona scope,
   so a context shape that lacks those fallback fields excludes the persona.
2. **Kyle/Kyle Holland card-local duplicates:** registries are reconciled in
   isolation. The existing code can rename an entry inside one registry, but
   it does not use one cross-store operation to redirect entity IDs and links
   from card-local, session, and persistent stores together.
3. **Duplicate relationship pairs:** final reconciliation rebuilds card-local
   display-name maps, then separately processes character-scoped maps. It does
   not establish a single canonical participant-ID key across every store
   before merging legacy records.
4. **Session citation loss:** citations are required by the default prompt and
   parsed, but uncited otherwise-parseable output has no narrow citation-repair
   pass. It therefore enters validation as quarantined candidates and run
   diagnostics do not characterize the tier as degraded.
5. **Resolved arcs with no summaries:** the classifier count is recorded before
   summary generation. `generateArcSummary()` can return null or a rejected
   result without producing a terminal per-arc diagnostic, leaving the drop
   from classification to persistence invisible.
6. **Malformed participants and synthetic parentheticals:** structured
   participants are normalized, but arc *content* is not passed through one
   identity-label sanitizer before validation and storage. Participants are
   also not reconciled against names demonstrably present in arc content.
7. **Profile relationship contradictions:** profile validation checks grounding
   and known names, but does not consistently compare exact relationship-status
   terms against the latest approved canonical/relationship evidence.
