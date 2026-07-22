import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('provider failures: transient server and network failures are retried, while bad requests are not', () => {
  const source = read('generate.js');
  const transient = source.slice(source.indexOf('function isTransientProviderError'), source.indexOf('function retryAfterMs'));
  assert.match(transient, /status === 429 \|\| status === 502 \|\| status === 503 \|\| status === 504/);
  assert.doesNotMatch(transient, /status === 400/);
  assert.match(source, /attempt >= maxRetries/);
  assert.match(source, /retryListeners\.forEach/);
});

test('chat-save failures: catch-up persistence is staged and rolls back failed commits', () => {
  const source = read('catchup-transaction.js');
  const longterm = read('longterm.js');
  const graph = read('graph-migration.js');
  const epistemic = read('epistemic.js');
  const scenes = read('scenes.js');
  const compaction = read('compaction.js');
  const settings = read('settings.js');
  assert.match(source, /metadataDirty: false/);
  assert.match(source, /activeTransaction\.metadataDirty = true/);
  assert.match(source, /await saveGroupChatDirect\(transaction\.context\)/);
  assert.match(source, /await saveChat\(\)/);
  assert.match(source, /rollbackCatchUpTransaction\(transaction\)/);
  assert.match(longterm, /await saveChatMetadata\(context\)/);
  assert.match(graph, /saveChatMetadata\(context\)\.catch/);
  assert.match(epistemic, /saveChatMetadata\(context\)\.catch/);
  assert.match(scenes, /await saveChatMetadata\(context\)/);
  assert.match(compaction, /await saveChatMetadata\(context\)/);
  assert.match(settings, /finalTransaction = beginCatchUpTransaction\(catchUpContext\)/);
  assert.match(settings, /final persistence error/);
  assert.match(settings, /runStagedChatCleanup/);
  assert.match(settings, /Fresh Start persistence failed/);
  assert.match(settings, /Forget This Chat persistence failed/);
  assert.match(settings, /Clear session persistence failed/);
});

test('startup never saves recap metadata before SillyTavern has selected a chat', () => {
  const recap = read('recap.js');
  const updateLastActive = recap.slice(recap.indexOf('export async function updateLastActive'), recap.indexOf('/**\n * Checks whether a recap'));
  assert.match(updateLastActive, /if \(!context\.chatId && !groupChatId\) return false/);
  assert.ok(
    updateLastActive.indexOf('if (!context.chatId && !groupChatId) return false')
      < updateLastActive.indexOf('context.chatMetadata[META_KEY].lastActive'),
    'The no-chat guard must run before metadata is mutated.',
  );
});

test('Enhanced macros use an independent namespace beside the original extension', () => {
  const macros = read('macros.js');
  assert.match(macros, /shortterm: 'smartmemory-enhanced-shortterm'/);
  assert.match(macros, /unified: 'smartmemory-enhanced-unified'/);
  assert.doesNotMatch(macros, /:\s*'smartmemory-(?!enhanced-)/);
});

test('Enhanced slash commands and global UI hooks use independent names', () => {
  const index = read('index.js');
  const ui = read('ui.js');
  const css = read('style.css');
  assert.match(index, /name: 'sme-check'/);
  assert.match(index, /name: 'sme-search'/);
  assert.doesNotMatch(index, /name: 'sm-/);
  assert.match(ui, /sme-tooltip/);
  assert.match(ui, /sme-read-only/);
  assert.match(css, /#sme-tooltip/);
  assert.match(css, /body\.sme-read-only/);
});

test('catch-up reports unparseable profile output and Enhanced owns its console prefix', () => {
  const profiles = read('profiles.js');
  const settings = read('settings.js');
  assert.match(profiles, /options\.throwOnFailure/);
  assert.match(profiles, /if \(options\.throwOnFailure\) throw error/);
  assert.match(settings, /generateProfiles\(name, null, \{ throwOnFailure: true \}\)/);
  assert.match(profiles, /\[Smart Memory Enhanced\] Profile generation produced unparseable output/);
  for (const file of ['index.js', 'settings.js', 'longterm.js', 'session.js', 'profiles.js']) {
    assert.doesNotMatch(read(file), /\[SmartMemory\]/);
  }
});

test('profile recovery repairs formatting once without replacing source evidence', () => {
  const profiles = read('profiles.js');
  const prompts = read('prompts.js');
  assert.match(profiles, /let parsed = parseProfileOutput\(response, \{ requireAll: true \}\)/);
  assert.match(profiles, /buildProfileFormatRepairPrompt\(response\)/);
  assert.match(profiles, /parseProfileOutput\(repaired, \{ requireAll: true \}\)/);
  assert.match(profiles, /canonicalizeNarrativeNames\(parsed\[field\], roster\)/);
  assert.match(prompts, /\[PROFILE FORMAT REPAIR\]/);
  assert.match(prompts, /Copy only claims already present/);
});

test('derived resolved summaries have an in-panel review queue', () => {
  const ui = read('ui.js');
  assert.match(ui, /Resolved Arc Summary Review/);
  assert.match(ui, /Review Resolved Summaries/);
  assert.match(ui, /target\.validation_status = approved \? 'approved' : 'rejected'/);
});

test('generated prose rewrites only deterministic card or persona aliases before storage', () => {
  assert.match(read('longterm.js'), /canonicalizeNarrativeNames\(mem\.content, narrativeRoster\)/);
  assert.match(read('session.js'), /canonicalizeNarrativeNames\(mem\.content, canonicalRoster\)/);
});

test('catch-up diagnostics report derived arc-summary verification outcomes', () => {
  const settings = read('settings.js');
  assert.match(settings, /arc_summary_verification: summarizeArcSummaryVerification\(loadArcSummaries\(\)\)/);
  assert.match(settings, /arcResolution: runResult\.arcResolution/);
  assert.match(settings, /identityResolutionDetails/);
  assert.match(settings, /preverification: \{\}/);
  assert.match(settings, /legacy_unverified/);
});

test('final catch-up reconciliation runs inside the staged transaction and quarantines non-resolved summaries', () => {
  const settings = read('settings.js');
  assert.match(settings, /async function runFinalIntegrityReconciliation/);
  assert.match(settings, /resolution_reclassified/);
  assert.match(settings, /await runFinalIntegrityReconciliation\(characterName\)/);
  assert.match(settings, /finalReconciliation: runResult\.finalReconciliation/);
  assert.match(settings, /profiles: runResult\.profiles/);
  assert.match(settings, /prior_fields_preserved/);
});

test('automatic and manual canon generation count only approved derived summaries', () => {
  assert.match(read('index.js'), /loadArcSummaries\(\)\.filter\(isRecordApprovedForPropagation\)\.length/);
  assert.match(read('settings.js'), /verified resolved arc summary/);
  assert.match(read('ui.js'), /loadArcSummaries\(\)\.filter\(isRecordApprovedForPropagation\)\.length/);
});

test('arc resolution is classified before a summary can be generated or an arc removed', () => {
  const arcs = read('arcs.js');
  const prompts = read('prompts.js');
  assert.match(arcs, /export async function classifyArcResolution/);
  assert.match(arcs, /if \(decision\.status !== 'resolved'\)/);
  assert.match(arcs, /if \(decision\.status === 'resolved'\) \{[\s\S]*resolvedArcObjects\.push/);
  assert.match(prompts, /\[ARC RESOLUTION CLASSIFIER\]/);
  assert.match(prompts, /INSUFFICIENT_EVIDENCE/);
});

test('resolved arc summaries use only classifier-linked evidence', () => {
  const arcs = read('arcs.js');
  assert.match(arcs, /const decisionSources = new Set\(resolvedArc\?\.resolution_decision/);
  assert.match(arcs, /filter\(\(scene\) => \(scene\.source_message_indices/);
  assert.match(arcs, /resolution_decision: \{/);
});

test('arc prompts canonicalize deterministic aliases before model generation', () => {
  const arcs = read('arcs.js');
  assert.match(arcs, /const chatHistory = canonicalizeNarrativeNames\(rawChatHistory/);
  assert.match(arcs, /const evidence = canonicalizeNarrativeNames\(rawEvidence, roster\)\.text/);
});

test('protected prompts prohibit aliases, synthetic identities, and premature arc resolution', () => {
  const prompts = read('prompts.js');
  assert.match(prompts, /partial progress, emotional reaction, or new information alone never resolves an arc/);
  assert.match(prompts, /old persona names, inferred surnames, collective labels, or parenthetical identity labels/);
  assert.match(prompts, /short-name and full-name variant as separate people/);
  assert.match(prompts, /parenthetical disambiguated names/);
  assert.match(prompts, /export function buildSceneSummaryPrompt/);
  assert.match(read('scenes.js'), /buildSceneSummaryPrompt\(sceneText\.slice/);
});

test('profiles keep only current, evidence-supported fields', () => {
  const profiles = read('profiles.js');
  const prompts = read('prompts.js');
  assert.match(profiles, /export function retainGroundedProfileFields/);
  assert.match(profiles, /validateCitationSemanticSupport/);
  assert.match(profiles, /field_grounding_rejections/);
  assert.match(profiles, /omitStaleCurrentProfileLines/);
  assert.match(profiles, /retainKnownProfileRelationships/);
  assert.match(profiles, /preserved_prior_fields/);
  assert.match(prompts, /when two facts conflict, use the later active fact/);
});

test('relationship reconciliation merges duplicate canonical pair evidence instead of keeping the first pair only', () => {
  const longterm = read('longterm.js');
  assert.match(longterm, /source_message_indices: mergeList/);
  assert.match(longterm, /updatedAt: Math\.max/);
  assert.match(longterm, /Object\.entries\(history\)\.sort/);
  assert.match(longterm, /export function reconcileRelationshipHistoryMap/);
  assert.match(read('ui.js'), /localRelationshipPairsMerged/);
});

test('legacy derived summaries are persisted as quarantined on chat load', () => {
  assert.match(read('arcs.js'), /export async function migrateLegacyArcSummaries/);
  assert.match(read('index.js'), /await migrateLegacyArcSummaries\(\)/);
});

test('editing a derived arc summary re-verifies it against saved evidence', () => {
  assert.match(read('arcs.js'), /export async function reverifyArcSummary/);
  assert.match(read('ui.js'), /Save & Reverify/);
  assert.match(read('ui.js'), /await reverifyArcSummary\(target\)/);
  assert.match(read('ui.js'), /Reverify All/);
});

test('canonical reconciliation safely rewrites deterministic aliases in existing stored prose', () => {
  const ui = read('ui.js');
  assert.match(ui, /const rewriteStoredNarratives/);
  assert.match(ui, /narrative_rewrites: longtermRewrites \+ sessionRewrites/);
  assert.match(read('profiles.js'), /for \(const field of \['character_state', 'world_state', 'relationship_matrix'\]\)/);
  assert.match(ui, /for \(const \[localName, localRegistry\] of Object\.entries\(meta\.card_local_entities/);
  assert.match(ui, /card_local_reports: localReports/);
  assert.match(ui, /Object\.keys\(meta\.profiles \?\? \{\}\)/);
  assert.match(ui, /profiles_reconciled: profilesReconciled/);
  assert.match(ui, /relationship_stores_reconciled/);
  assert.match(ui, /epistemic_stores_reconciled/);
  assert.match(ui, /synthetic_review_names_removed/);
});

test('historical persona names remain durable aliases of the active persona identity', () => {
  const graph = read('graph-migration.js');
  const canonical = read('canonical-entities.js');
  assert.match(graph, /historical_persona_names/);
  assert.match(graph, /rosterEntry\?\.source === 'user-persona'/);
  assert.match(canonical, /Historical active persona name/);
});

test('profile relationship lines require an exact descriptor from the established pair history', () => {
  const profiles = read('profiles.js');
  const prompts = read('prompts.js');
  assert.match(profiles, /const exactStatus = pair\?\.descriptors\.some/);
  assert.match(profiles, /extractCardRelationshipFacts/);
  assert.match(profiles, /extractGroundedRelationshipFacts/);
  assert.match(profiles, /const pair = cardPair \?\? historyPair \?\? groundedPair/);
  assert.match(profiles, /priorRelationshipCheck/);
  assert.match(profiles, /relationship_matrix: ''/);
  assert.match(prompts, /RELATIONSHIP HISTORY \(authoritative current descriptors\)/);
  assert.match(prompts, /use at least one exact descriptor from RELATIONSHIP HISTORY/);
});

test('profile current-state speculation is omitted instead of being stored as fact', () => {
  const profiles = read('profiles.js');
  const prompts = read('prompts.js');
  const settings = read('settings.js');
  assert.match(profiles, /export function omitSpeculativeProfileLines/);
  assert.match(profiles, /speculative_field_rejections/);
  assert.match(profiles, /rumou\?red\|implied\|seems/);
  assert.match(prompts, /Never phrase a current-state claim as speculation/);
  assert.match(settings, /speculative_fields_dropped/);
});

test('profile validation accepts a roster object and provider failures retain safe request diagnostics', () => {
  const profiles = read('profiles.js');
  const generate = read('generate.js');
  const settings = read('settings.js');
  assert.match(profiles, /function rosterEntries\(roster\)/);
  assert.match(profiles, /rosterEntries\(roster\)/);
  assert.match(profiles, /getCanonicalRosterPeople/);
  assert.match(generate, /sme_request_diagnostics/);
  for (const field of ['endpoint_category', 'message_roles', 'role_sequence_valid', 'prompt_fingerprint', 'structured_output_expected']) {
    assert.match(generate, new RegExp(field));
  }
  assert.match(generate, /estimated_input_tokens/);
  assert.match(generate, /likely_cause/);
  assert.match(settings, /providerFailures/);
});

test('run completion distinguishes operational success from tier-quality degradation', () => {
  const settings = read('settings.js');
  assert.match(settings, /quality: \{ status: 'clean', reasons: \[\] \}/);
  assert.match(settings, /session_provenance_quarantine_majority/);
  assert.match(settings, /resolved_arcs_without_persisted_summaries/);
  assert.match(settings, /quality: runResult\.quality/);
  assert.match(settings, /Data quality degraded:/);
});

test('final catch-up stage order builds scenes before one complete arc pass and reconciliation', () => {
  const settings = read('settings.js');
  const sceneStage = settings.indexOf("setStatusMessage('Detecting scene breaks...')");
  const arcStage = settings.indexOf('await extractArcs(allMessages, characterName');
  const profileStage = settings.indexOf('await generateProfiles(name, null, { throwOnFailure: true })');
  const reconcileStage = settings.indexOf('await runFinalIntegrityReconciliation(characterName)');
  const stagedCommit = settings.indexOf('commitCatchUpTransaction(finalTransaction)');
  assert.ok(sceneStage >= 0 && sceneStage < arcStage);
  assert.ok(arcStage < profileStage && profileStage < reconcileStage);
  assert.ok(reconcileStage < stagedCommit);
  assert.doesNotMatch(settings, /await extractArcs\(chunk, characterName/);
});

test('final reconciliation builds a persona-aware roster that includes approved chat-local characters', () => {
  const ui = read('ui.js');
  const canonical = read('canonical-entities.js');
  assert.match(ui, /buildCanonicalCharacterRoster\(getContext\(\), \{ includeChatLocalApproved: true \}\)/);
  assert.match(canonical, /export function buildCanonicalRoster/);
  assert.match(canonical, /scope\.activePersona/);
  assert.match(canonical, /source_type: 'persona'/);
});

test('final reconciliation uses one cross-store entity merge operation before structured-store repair', () => {
  const graph = read('graph-migration.js');
  const ui = read('ui.js');
  assert.match(graph, /export function mergeCanonicalEntityAcrossStores/);
  assert.match(graph, /card_local_entities/);
  assert.match(graph, /card_local_memories/);
  assert.match(ui, /mergeCanonicalEntityAcrossStores\(merge\.sourceId, merge\.targetId, getContext\(\)\)/);
});

test('final reconciliation canonicalizes scene and arc participant lists while retaining historical display names', () => {
  const ui = read('ui.js');
  const settings = read('settings.js');
  assert.match(ui, /const rewriteParticipantLists/);
  assert.match(ui, /display_name_at_time/);
  assert.match(ui, /participant_lists_rewritten/);
  assert.match(settings, /participantListsRewritten/);
  assert.match(settings, /personaRosterSize/);
});

test('relationship reconciliation requires stable canonical participants and preserves combined legacy evidence', () => {
  const longterm = read('longterm.js');
  const ui = read('ui.js');
  assert.match(longterm, /canonicalizeRelationshipPair\(subject, target, roster\)/);
  assert.match(longterm, /manual_approval_state/);
  assert.match(longterm, /descriptor_removals/);
  assert.match(ui, /persistentRelationshipPairsMerged/);
  assert.match(longterm, /Relationship participants could not be resolved to stable canonical identities/);
  assert.match(longterm, /compactRelationshipProvenance/);
  for (const field of ['source_record_ids', 'parent_memory_ids', 'evidence_ranges', 'manual_edits', 'validation_issues']) {
    assert.match(longterm, new RegExp(`${field}: mergeList`));
  }
});

test('session extraction repairs citation-only omissions once and never persists uncited candidates', () => {
  const session = read('session.js');
  const prompts = read('prompts.js');
  const settings = read('settings.js');
  assert.match(prompts, /Every output item MUST include one or more source message indices/);
  assert.match(session, /SESSION CITATION REPAIR/);
  assert.match(session, /Do not add, remove, reword, or combine memories/);
  assert.match(session, /const citedCandidates = parsedCandidates\.filter/);
  assert.match(settings, /sessionExtraction: \{/);
  for (const disposition of ['accepted_validated', 'accepted_after_citation_repair', 'missing_provenance', 'semantic_support_rejected', 'provider_or_parser_error', 'provider_returned_none']) {
    assert.match(settings, new RegExp(disposition));
    assert.match(session, new RegExp(`recordDisposition\\('${disposition}'`));
  }
  assert.match(session, /rejectedByValidation/);
  for (const repairField of ['repairEligible', 'repairProviderError', 'repairReturnedNone', 'repairMalformed', 'repairStillInvalid', 'repairSemanticallyUnsupported', 'repairAccepted']) {
    assert.match(settings, new RegExp(repairField));
  }
});

test('resolved arc classifications receive one traceable terminal summary outcome', () => {
  const arcs = read('arcs.js');
  const settings = read('settings.js');
  assert.match(arcs, /traceArcTerminal/);
  for (const status of ['generator_none', 'preverification_rejected', 'verification_ambiguous', 'verification_unsupported', 'provider_error', 'persisted']) {
    assert.match(arcs, new RegExp(`'${status}'`));
  }
  assert.match(settings, /arcPipeline: \{ classifiedResolved: 0/);
  assert.match(settings, /arcPipeline: runResult\.arcPipeline/);
  assert.match(settings, /arcExtraction: \{ attempted: 0/);
  assert.match(arcs, /arcExtraction\.providerError/);
  assert.match(arcs, /malformed_request/);
});

test('catch-up metadata writers cannot bypass staged saving', () => {
  const transaction = read('catchup-transaction.js');
  const writerFiles = [
    'longterm.js',
    'session.js',
    'arcs.js',
    'state-ledger.js',
    'scenes.js',
    'epistemic.js',
    'profiles.js',
    'canon.js',
    'compaction.js',
    'graph-migration.js',
  ];

  assert.match(transaction, /function belongsToActiveTransaction\(context\)/);
  assert.match(transaction, /context\.chatMetadata === activeContext\.chatMetadata/);
  assert.match(transaction, /\(context\.chatId \?\? null\) === \(activeContext\.chatId \?\? null\)/);
  assert.doesNotMatch(transaction, /\|\| activeTransaction/);
  for (const file of writerFiles) {
    const source = read(file);
    assert.match(source, /saveChatMetadata/);
    assert.doesNotMatch(source, /context\.saveMetadata/);
  }
});

test('scene archive: retention, injection, provenance, audit, and legacy settings use separate semantics', () => {
  const settings = read('settings.js');
  const scenes = read('scenes.js');
  const ui = read('ui.js');
  assert.match(settings, /scene_archive_max: 100/);
  assert.match(settings, /scene_inject_count: 5/);
  assert.match(settings, /const hadSceneInjectCount/);
  assert.match(settings, /scene_inject_count = extension_settings\[MODULE_NAME\]\.scene_max_history/);
  assert.match(settings, /Scenes: \$\{sceneAudit\.candidates\} detected/);
  assert.match(scenes, /trimSceneArchive/);
  assert.match(scenes, /selectScenesForInjection\([\s\S]*settings\.scene_inject_count/);
  assert.match(scenes, /metadata\.sceneHistory = previous/);
  assert.match(ui, /sme_jump_scene/);
  assert.match(ui, /sme_resummarize_scene/);
  assert.match(ui, /source_start_index/);
  assert.match(settings, /isDuplicateScene\(sceneResult\.summary\)/);
  assert.match(settings, /character_participants: sceneResult\.characterParticipants/);
  assert.match(settings, /sceneResult\?\.summary/);
  assert.match(scenes, /canonicalizeStructuredParticipants/);
});

test('cross-tier grounding: scenes, arcs, profiles, and epistemic entries validate before injection', () => {
  const scenes = read('scenes.js');
  const arcs = read('arcs.js');
  const profiles = read('profiles.js');
  const epistemic = read('epistemic.js');
  for (const source of [scenes, arcs, profiles, epistemic]) assert.match(source, /validateGeneratedRecord/);
  assert.match(scenes, /history\.filter\(isGeneratedRecordApproved\)/);
  assert.match(arcs, /isGeneratedRecordApproved\(a\)/);
  assert.match(profiles, /!isGeneratedRecordApproved\(profiles\)/);
  assert.match(epistemic, /loadEpistemicKnowledge\(characterName\)\.filter\(isGeneratedRecordApproved\)/);
});

test('integrity round: primary provenance is prepared before verification and consolidation flattens temporary parents', () => {
  const longterm = read('longterm.js');
  const session = read('session.js');
  const validation = read('record-validation.js');
  assert.match(longterm, /applyDirectProvenance\(parsed, recentMessages, provenanceWindowStart/);
  assert.match(session, /applyDirectProvenance\(citedCandidates, recentMessages, provenanceWindowStart/);
  assert.match(validation, /prepareRecordForValidation/);
  assert.match(validation, /flattenConsolidationProvenance/);
  assert.match(validation, /disposable extraction candidates/);
});

test('integrity round: secondary evidence promotes entities and canonical reconciliation runs automatically', () => {
  const longterm = read('longterm.js');
  const epistemic = read('epistemic.js');
  const graph = read('graph-migration.js');
  assert.match(epistemic, /A named, approved epistemic record is independent grounded evidence/);
  assert.match(epistemic, /resolveEntityNames\(entry, names/);
  assert.match(longterm, /Relationship History is independently grounded evidence/);
  assert.match(longterm, /reconcileCanonicalEntityRegistry\(entityRegistry, getContext\(\), finalActive\)/);
  assert.ok(
    longterm.indexOf('const relHistory = loadRelationshipHistory(characterName);')
      < longterm.indexOf('for (const [pairKey, relationship] of Object.entries(relHistory))'),
    'Relationship history must remain available to the later promotion pass.',
  );
  assert.match(graph, /e\.memory_ids\.length > 0 \|\| \(e\.source_record_ids\?\.length/);
});

test('integrity round: resolved arcs inherit evidence, profiles fail safely, and short summaries stay factual', () => {
  const arcs = read('arcs.js');
  const profiles = read('profiles.js');
  const epistemic = read('epistemic.js');
  const prompts = read('prompts.js');
  assert.match(arcs, /derivation_type: 'resolved-arc-summary'/);
  assert.match(arcs, /parent_arc_id: result\.parentArcId/);
  assert.match(profiles, /preserving the prior profile/);
  assert.match(profiles, /evidence_ids/);
  assert.match(profiles, /resolution\.status === 'ambiguous' \|\| resolution\.status === 'rejected'/);
  assert.match(epistemic, /\['ambiguous', 'rejected'\]\.includes\(subject\.status\)/);
  assert.doesNotMatch(prompts.slice(prompts.indexOf('export function buildSummaryPrompt'), prompts.indexOf('// ---- Short-term: progressive update')), /Next Beat/);
  assert.doesNotMatch(prompts.slice(prompts.indexOf('export function buildSummaryPrompt'), prompts.indexOf('// ---- Short-term: progressive update')), /User's Direction/);
  const arcPrompt = prompts.slice(prompts.indexOf('export function buildArcSummaryPrompt'));
  assert.match(arcPrompt, /Do not introduce new people/);
  assert.match(arcPrompt, /\[CANONICAL PARTICIPANTS\]/);
});

test('operational workflow: Memorize Chat has a no-save workload preview and exports compact diagnostics', () => {
  const settings = read('settings.js');
  const html = read('settings.html');
  assert.match(html, /sme_preview_catch_up/);
  assert.match(html, /sme_export_diagnostics/);
  assert.match(settings, /Dry run complete - no memories or entities were saved/);
  assert.match(settings, /catch_up_diagnostics/);
  assert.match(settings, /source_start_index/);
  assert.match(settings, /parser_debris_cleanup/);
  assert.match(settings, /raw provider output/);
  assert.match(settings, /reconcileCanonicalEntities\(characterName\)/);
  assert.match(settings, /identityResolution/);
});

test('dry run: primary extraction returns grounded candidates before persistence', () => {
  const longterm = read('longterm.js');
  const session = read('session.js');
  assert.match(longterm, /if \(options\.dryRun\) \{/);
  assert.match(session, /if \(options\.dryRun\) \{/);
  assert.match(longterm, /dryRun: true/);
  assert.match(session, /validation_issues/);
});

test('dry run: story arc candidates are analyzed before any arc-save path', () => {
  const arcs = read('arcs.js');
  const settings = read('settings.js');
  assert.match(arcs, /if \(options\.dryRun\) \{/);
  assert.match(arcs, /resolved_candidates/);
  assert.match(settings, /extractArcs\(messages, characterName, null, \{ dryRun: true \}\)/);
});

test('secondary tiers: relationship history, State Ledger, and canon use approved evidence only', () => {
  const relationships = read('longterm.js');
  const ledger = read('state-ledger.js');
  const canon = read('canon.js');
  assert.match(relationships, /relationshipRecord\.source_message_indices/);
  assert.match(relationships, /isGeneratedRecordApproved\(state\)/);
  assert.match(ledger, /source_message_indices: sourceMessageIndices/);
  assert.match(ledger, /Object\.entries\(ledger\)\.filter\(\(\[, fields\]\) => isGeneratedRecordApproved\(fields\)\)/);
  assert.match(canon, /allArcSummaries\.filter\(isRecordApprovedForPropagation\)/);
  assert.match(canon, /isGrounded\(m\)/);
});

test('chat-local cleanup: Forget This Chat and Fresh Start remove every chat-local store', () => {
  const settings = read('settings.js');
  const canon = read('canon.js');
  for (const key of ['card_local_memories', 'card_local_relationships', 'card_local_epistemic', 'card_local_entities', 'card_local_canon']) {
    assert.match(settings, new RegExp(`'${key}'`));
  }
  assert.match(settings, /clearChatLocalCharacterData\(context\);/);
  assert.match(settings, /clearChatLocalCharacterData\(context, characterName\);/);
  assert.match(canon, /metadata\?\.\[META_KEY\]\?\.card_local_canon/);
  assert.match(canon, /metadata\?\.\[MODULE_NAME\]\?\.card_local_canon/);
});

test('Fresh Start refreshes cleared personal prompt slots before updating token usage', () => {
  const settings = read('settings.js');
  const freshStart = settings.slice(settings.indexOf("$('#sme_fresh_start_button')"), settings.indexOf('// ---- Embedding deduplication'));
  assert.match(freshStart, /injectRelationshipHistory\(characterName\)/);
  assert.match(freshStart, /injectEpistemicKnowledge\(characterName, characterName\)/);
  assert.match(freshStart, /injectCanon\(characterName\)/);
  assert.ok(freshStart.indexOf('injectRelationshipHistory(characterName)') < freshStart.indexOf('updateTokenDisplay()'));
});

test('entity safeguards: reconciliation reports decisions, retains review candidates, and preserves aliases on rename', () => {
  const graph = read('graph-migration.js');
  assert.match(graph, /const report = \{ changed: false, matched: \[\], merged: \[\], skipped: \[\], unmatched: \[\], outcomes: \[\] \}/);
  assert.match(graph, /identity_review_queue/);
  assert.match(graph, /unmatched_review/);
  assert.match(graph, /grounded_unknown_preserved/);
  const rename = graph.slice(graph.indexOf('export function renameEntityById'), graph.indexOf('export function deleteEntityById'));
  assert.match(rename, /aliases = \[\.\.\.new Set\(\[\.\.\.\(entity\.aliases \?\? \[\]\), oldName\]\)\]/);
  assert.match(rename, /if \(conflict\) return \{ renamed: false/);
  assert.match(rename, /Use Merge instead/);
});

test('review UI: grounding and identity reviews use dialogs that clean up without closing the extensions panel', () => {
  const ui = read('ui.js');
  const scenes = read('scenes.js');
  const arcs = read('arcs.js');
  assert.match(ui, /sme_open_review_queue/);
  assert.match(ui, /dialog\.showModal\(\)/);
  assert.match(ui, /dialog\.addEventListener\('close', \(\) => dialog\.remove\(\)/);
  assert.match(ui, /event\.stopPropagation\(\)/);
  assert.match(ui, /Review identity candidates/);
  assert.match(ui, /Suggested canonical identity/);
  assert.match(ui, /Evidence records/);
  assert.match(scenes, /recordIdentityReviewCandidate/);
  assert.match(arcs, /recordIdentityReviewCandidate/);
});

test('per-character policies: full, chat-local, read-only, and disabled policies remain available', () => {
  const settings = read('settings.html');
  for (const policy of ['full', 'chat_local', 'read_only', 'disabled']) {
    assert.match(settings, new RegExp(`value="${policy}"`));
  }
  const longterm = read('longterm.js');
  assert.match(longterm, /CHARACTER_MEMORY_POLICIES\.READ_ONLY, CHARACTER_MEMORY_POLICIES\.DISABLED/);
  assert.match(longterm, /CHARACTER_MEMORY_POLICIES\.CHAT_LOCAL/);
});

test('Prompt Studio assignment labels stay beside their matching dropdowns and identify the selected character', () => {
  const html = read('settings.html');
  const assignments = html.slice(html.indexOf('Preset assignments'), html.indexOf('Prompt Preset'));
  assert.ok(assignments.indexOf('sme_prompt_global_profile') < assignments.indexOf('sme_prompt_chat_profile'));
  assert.ok(assignments.indexOf('sme_prompt_chat_profile') < assignments.indexOf('sme_prompt_character_profile'));
  assert.match(assignments, /sme_prompt_character_profile_label/);
  const settings = read('settings.js');
  assert.match(settings, /#sme_prompt_character_profile_label'\)\.text\(characterName \? `Character: \$\{characterName\}`/);
  const css = read('style.css');
  assert.match(css, /\.sme_prompt_assignment_row \{[\s\S]*grid-template-columns/);
});

test('Prompt Studio offers a read-only live inspector built from current evidence and the scoped effective prompt', () => {
  const html = read('settings.html');
  const settings = read('settings.js');
  const promptConfig = read('prompt-config.js');
  assert.match(html, /sme_prompt_inspect_live/);
  assert.match(settings, /getLivePromptInspection/);
  assert.match(settings, /LIVE PROMPT INSPECTOR/);
  assert.match(promptConfig, /export function getLivePromptInspection/);
  assert.match(promptConfig, /applyPromptOverride\(prompt, task, activeCharacter\)/);
  assert.match(promptConfig, /buildCanonicalCharacterRoster\(context\)/);
});

test('live prompt inspection preserves protected Session, Arc, and Profile contracts after scoped composition', () => {
  const promptConfig = read('prompt-config.js');
  const prompts = read('prompts.js');
  const arcs = read('arcs.js');
  assert.match(promptConfig, /buildSessionExtractionPrompt\(chat, session, longterm, roster\)/);
  assert.match(promptConfig, /buildArcExtractionPrompt\(chat, arcs\.map[\s\S]*roster\)/);
  assert.match(promptConfig, /buildProfileGenerationPrompt\(activeCharacter, longterm, session, registry, roster, relationships\)/);
  assert.match(promptConfig, /return \{\s+prompt: applyPromptOverride/);
  assert.match(prompts, /Every output item MUST include one or more source message indices/);
  assert.match(prompts, /An arc must state what remains unresolved, pending, unknown, promised, required, or undecided/);
  assert.match(prompts, /Never phrase a current-state claim as speculation/);
  assert.match(arcs, /buildArcExtractionPrompt\(chatHistory, existingText, formatCanonicalRosterForPrompt/);
});

test('lower navigation sections have distinct theme-neutral header icons', () => {
  const html = read('settings.html');
  for (const [section, icon] of [
    ['Entity Registry', 'fa-diagram-project'],
    ['Continuity Checker', 'fa-shield-halved'],
    ['Prompt Studio', 'fa-wand-magic-sparkles'],
    ['Configuration', 'fa-sliders'],
    ['Developer', 'fa-code'],
  ]) {
    const sectionIndex = html.lastIndexOf(section);
    const nearby = html.slice(Math.max(0, sectionIndex - 250), sectionIndex);
    assert.match(nearby, new RegExp(`${icon} sme_section_icon`));
  }
  const css = read('style.css');
  assert.match(css, /\.sme_section_icon \{[\s\S]*opacity: 0\.72/);
});
