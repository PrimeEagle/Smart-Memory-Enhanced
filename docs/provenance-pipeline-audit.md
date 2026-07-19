# Provenance and Secondary-Tier Pipeline Audit

This note records the pipeline as it existed before the focused integrity fixes
on `codex/provenance-integrity-round`.  It is deliberately a map of the
current architecture, not a redesign.

## Primary memory flow

1. `longterm.js:extractAndStoreMemories` and
   `session.js:extractSessionMemories` format a numbered extraction window.
   The numbers initially belong to that window, not necessarily to the full
   chat.
2. `parsers.js:parseExtractionOutput` and `parseSessionOutput` parse the
   `:sources=` modifier into `source_message_indices`.  At this point those
   are chunk-relative model claims.
3. The candidate verifier removes duplicates and identifies supersessions.
   It must preserve the candidate provenance fields.
4. The extraction callers know the full-chat mapping through either each
   message's `__sme_original_index` or the calculated window offset.
   `grounding.js:applyDirectProvenance` currently translates the claimed
   indices and writes legacy `source_messages` ranges.
5. `grounding.js:validateGeneratedMemoryRecord` validates ancestry before the
   candidates are merged.  Consolidation later uses
   `memory-utils.js:reconcileTypeEntries` and must carry forward or flatten
   provenance when it replaces entries.
6. Entity promotion occurs after the final active set is assembled, through
   `graph-migration.js:resolveEntityNames`, followed by
   `reconcileEntityRegistry`.  Canonical card/persona resolution is provided
   by `canonical-entities.js`; the post-catch-up reconciliation path uses the
   same roster infrastructure.

## Secondary-tier flow

* Relationship History is generated in `longterm.js` after primary extraction,
  parsed by `parsers.js:parseRelationshipDeltaResponse`, canonicalized through
  `canonical-entities.js`, then stored in the relationship map.
* Perspectives & Secrets is generated at scene boundaries in
  `epistemic.js:extractEpistemicKnowledge`, parsed by
  `parseEpistemicResponse`, canonicalized against the roster, then grounded
  using the completed scene's original chat indices before it is persisted.
* Story arcs are generated in `arcs.js:extractArcs`; arc records receive the
  input chat indices.  Resolved summaries are produced by
  `generateArcSummary` and currently need inherited arc evidence in addition
  to their scene evidence.
* Profiles are generated in `profiles.js:generateProfiles` from approved
  long-term and session records, then validated as derived records before
  saving.  The prompt and storage are profile-level rather than field-level.
* Short-term compaction in `compaction.js:runCompaction` stores one summary
  blob in chat metadata.  Its prompt builders are `buildSummaryPrompt` and
  `buildUpdateSummaryPrompt` in `prompts.js`; both currently include a
  speculative continuation section that needs separation from factual history.

## Validation and provenance findings

The parser assigns preliminary ungrounded/needs-review values before the
caller attaches the full-chat source mapping.  Although the caller normally
updates them afterwards, that split makes stale validation states possible
when a later transformation keeps the old fields.  The focused fix introduces
one `prepareRecordForValidation(record, sourceContext)` step: normalize and
translate the source claim on the actual record, then validate it.  Any
transformation that changes provenance must call it again.

## Prompt builders requiring revision

* `buildExtractionPrompt` and `buildSessionExtractionPrompt`: mandatory,
  numbered source evidence and an unambiguous example.
* `buildRelationshipDeltaPrompt`: character-only participants and strict
  descriptor grammar.
* `buildEpistemicExtractionPrompt`: high-value asymmetric knowledge only,
  with per-scene limits.
* `buildArcSummaryPrompt`: supplied evidence only, or `NONE`.
* `buildProfileGenerationPrompt`: approved evidence only; omit unsupported
  fields.
* `buildSummaryPrompt` and `buildUpdateSummaryPrompt`: factual history must
  not blend with speculative next-beat guidance.
