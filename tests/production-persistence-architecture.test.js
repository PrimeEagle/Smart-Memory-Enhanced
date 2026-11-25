import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');

test('serializable-domain is the only production module allowed to invoke structuredClone', () => {
  const files = fs.readdirSync(root).filter((file) => file.endsWith('.js')
    && file !== 'serializable-domain.js');
  for (const file of files) {
    assert.doesNotMatch(read(file), /structuredClone\(/,
      `${file} bypasses the named serializable-domain clone boundary`);
  }
});

const durableWriterModules = [
  'longterm.js', 'session.js', 'scenes.js', 'arcs.js', 'profiles.js',
  'epistemic.js', 'state-ledger.js', 'canon.js', 'graph-migration.js',
  'compaction.js',
];

test('every production durable writer enters the shared persistence command boundary', () => {
  for (const file of durableWriterModules) {
    const source = read(file);
    assert.match(source, /prepareFeaturePersistenceCommand/,
      `${file} does not prepare the shared command`);
    assert.match(source, /executeFeaturePersistence|recordFeaturePersistenceReceipt/,
      `${file} bypasses the shared executor or receipt boundary`);
    assert.match(source, /serializable-domain\.js/,
      `${file} does not validate its rollback snapshot through the domain boundary`);
    assert.doesNotMatch(source, /structuredClone\(/,
      `${file} uses an unclassified raw clone at a production persistence boundary`);
  }
});

test('feature modules cannot publish persistence receipts outside the shared executor', () => {
  for (const file of durableWriterModules) {
    assert.doesNotMatch(read(file), /recordFeaturePersistenceReceipt/,
      `${file} can publish a receipt without executing the persistence effect`);
  }
  const boundary = read('feature-persistence.js');
  assert.match(boundary, /executeFeaturePersistenceSync/);
  assert.match(boundary, /executeFeaturePersistence/);
});

test('current production projections expose no removed compatibility APIs or fields', () => {
  const combined = [
    'continuity.js', 'parsers.js', 'idempotence-utils.js', 'live-memory-health.js',
    'profile-role-utils.js', 'profiles.js', 'settings.js', 'ui.js', 'arcs.js',
    'canonical-entities.js', 'provider-attempt-audit.js',
    'malformed-output-recovery.js', 'recovery-stage-eligibility.js',
    'session-partial-persistence.js', 'memorize-domain-dtos.js',
    'longterm.js', 'session.js',
  ].map(read).join('\n');
  for (const removed of [
    'normalizeIdempotenceResult', 'canonicalizeDurableIdempotenceState',
    'migrateProfileRoleDescriptorSeparation', 'legacy_outcome_unknown',
    'legacy_field_name', 'automatic_stabilization_second_pass_writes',
    'second_pass_compatibility_semantics', 'legacy_unverified',
    'legacy_status_compatibility', 'compatibility_alias',
    'buildCanonicalCharacterRoster',
    'normalizeArcExtractionDiagnostics', 'participantListsRewritten',
    'personaRosterSize', 'personaAliasesMerged', 'cardLocalEntitiesMerged',
    'relationshipPairsMerged', 'syntheticParentheticalsRemoved',
    'scene_max_history', 'accepted_partial_record_count', 'accepted_record_ids',
    'exportReport.developer_idempotence_check',
    'finalReconciliation.manual_idempotence',
    'finalReconciliation.idempotence',
    'legacy_compact_scene_summary_field_unavailable',
    'prior_request_compatibility_status', 'no_prior_compatible_run',
    'legacy_name2',
    'tier_obligations', 'owner_obligations',
    'text_link_repair_counters', 'global_legacy_integrity',
    'global_legacy_maintenance_warning', 'legacy_global_scope_audit',
    'legacy_invalid_links_repaired', 'known_legacy', 'legacy_unquarantined',
    'migration_replay', 'regenerated_legacy_record',
    'migrateStateLedgerKey', 'manualApproved', 'migration_metadata',
    'legacy_pair_key_normalization_debt', 'relationship_field_details',
    'relationship_conflict_details', 'relationshipConflictsDropped',
    'speculativeCurrentFieldsDropped', 'preservedPriorFields',
  ]) assert.doesNotMatch(combined, new RegExp(removed),
    `removed compatibility symbol remains in production: ${removed}`);
  assert.doesNotMatch(read('continuity.js'), /export async function checkContinuity\(/);
  assert.doesNotMatch(read('parsers.js'), /export function parseContradictions\(/);
  assert.doesNotMatch(read('session.js'), /deterministicLegacySessionMemoryId/);
  assert.doesNotMatch(read('canonical-entities.js'), /canonical_id:\s*(?:String\(|`persona:|entity\.)/,
    'canonical roster entries retain a duplicate canonical_id alias');
  assert.doesNotMatch(read('canonical-entities.js'), /source_type:\s*'(?:persona|character-card|chat-local-approved)'/,
    'canonical roster entries retain a duplicate source_type alias');
  assert.doesNotMatch(read('canonical-entities.js'), /roster\?\.characters instanceof Map|Array\.isArray\(roster\)|roster\?\.people/,
    'canonical roster readers retain obsolete alternate container shapes');
  assert.match(read('longterm.js'), /assertCurrentMemoryRecord\(m, 'longterm'\)/);
  assert.match(read('session.js'), /assertCurrentMemoryRecord\(m, 'session'\)/);
  assert.match(read('longterm.js'), /relationship_history_record_schema_unsupported/);
  assert.doesNotMatch(read('provider-attempt-audit.js'), /legacy-durable:/,
    'provider audit can manufacture durable record identity');
  assert.doesNotMatch(read('memorize-execution-kernel.js'), /PROVIDER_DISPATCH_ACTION_ALIASES/,
    'execution kernel retains an alternate action vocabulary');
  assert.doesNotMatch(`${read('catchup-recovery-utils.js')}\n${read('memorize-authority-model.js')}`,
    /tier_obligations|owner_obligations/,
    'run manifest retains duplicate tier or owner obligation stores');
  assert.doesNotMatch(read('catchup-recovery-utils.js'), /recordCommittedCatchUpRange/,
    'run manifest retains a projection-owned coverage mutation API');
  assert.doesNotMatch(`${read('memorize-authority-model.js')}\n${read('settings.js')}`,
    /run_manifest\.authoritative_resume_selection|manifest\.authoritative_resume_selection\s*=/,
    'Resume selection is persisted instead of remaining a local ledger projection');
  assert.doesNotMatch(`${read('catchup-recovery-utils.js')}\n${read('memorize-controller-finalizer.js')}\n${read('settings.js')}`,
    /checkpoint\.authoritative_recovery\s*=|terminalCheckpoint\.authoritative_recovery\s*=/,
    'a cached recovery authority is persisted into the checkpoint');
  assert.doesNotMatch(`${read('catchup-recovery-utils.js')}\n${read('memorize-controller-finalizer.js')}\n${read('settings.js')}`,
    /checkpoint\.resume_eligibility\s*=|rawCheckpoint\.resume_eligibility\s*=/,
    'a cached Resume eligibility decision is persisted into the checkpoint');
  assert.doesNotMatch(`${read('catchup-recovery-utils.js')}\n${read('memorize-controller-finalizer.js')}\n${read('settings.js')}`,
    /checkpoint(?:ForCommit)?\.recovery_blocked|rawCheckpoint\.recovery_blocked|terminalCheckpoint\.recovery_blocked/,
    'a cached recovery-blocked projection is persisted into the checkpoint');
  for (const removedCheckpointProjection of [
    'authority_projection_reconciliation', 'lifecycle_journal_reconciliation',
    'runtime_lifecycle_repairs', 'runtime_obligation_repairs',
    'recovery_traversal_policy', 'recovery_sweep', 'provider_completion_consistency',
    'stale_controller_audit', 'last_committed_source_start_index',
    'last_committed_source_end_index', 'committed_chunks', 'resume_progress_in_flight',
    'source_message_count', 'source_last_original_index', 'run_settings_snapshot_updated_at',
    'source_traversal_offset', 'operational_pause', 'recovery_child_manifests',
    'context_overflow_recovery', 'persona_audit_proof',
    'secondary_finalization_failures', 'stale_lease_callbacks', 'cleanup_warnings',
    'controller_failure',
  ]) assert.doesNotMatch(read('settings.js'),
    new RegExp(`checkpoint(?:ForCommit)?\\.${removedCheckpointProjection}`),
    `checkpoint retains write-only projection: ${removedCheckpointProjection}`);
  assert.doesNotMatch(read('settings.js'),
    /stale_controller_audit\s*=\s*\{[\s\S]{0,800}resume_eligibility/,
    'stale-controller evidence embeds a cached Resume decision');
  assert.doesNotMatch(`${read('memorize-resume-progress.js')}\n${read('memorize-diagnostic-snapshot.js')}`,
    /checkpoint(?:Copy)?\?\.committed_chunks/,
    'Resume and diagnostic projections read a duplicate checkpoint chunk count');
  assert.doesNotMatch(read('settings.js'), /terminalCheckpoint\.resume_progress_in_flight/,
    'completed Resume evidence depends on an invocation-local checkpoint cache');
  assert.doesNotMatch(read('memorize-controller-finalizer.js'),
    /checkpoint\.secondary_finalization_failures/,
    'controller-exit diagnostics are duplicated into the checkpoint');
  assert.doesNotMatch(read('memorize-controller-finalizer.js'),
    /checkpoint\.controller_failure/,
    'primary controller failure evidence is duplicated outside the canonical controller exit');
  assert.doesNotMatch(`${read('catchup-recovery-utils.js')}\n${read('memorize-recovery-authority.js')}`,
    /checkpoint\?*\.source_message_count|checkpoint\?*\.source_last_original_index/,
    'checkpoint readers retain duplicate source-window scalars');
  assert.doesNotMatch(read('provider-attempt-audit.js'), /public compatibility label/,
    'provider audit still translates precise parser reasons into compatibility labels');
});

test('domain result constructors contain no JSON cloning fallback', () => {
  const boundaryModules = [
    'memorize-tier-outcome.js', 'memorize-outcome.js', 'persistence-command.js',
    'provider-completion-journal.js', 'memorize-action-dispatcher.js',
    'memorize-diagnostic-observer.js', 'memorize-diagnostic-snapshot.js',
    'memorize-authority-model.js', 'live-memory-health.js', 'ui.js', 'settings.js',
  ];
  for (const file of boundaryModules) {
    assert.doesNotMatch(read(file), /JSON\.parse\(JSON\.stringify/,
      `${file} can silently discard runtime values`);
  }
});

test('provider generation uses explicit unlimited bounds rather than non-finite sentinels', () => {
  const source = read('generate.js');
  assert.doesNotMatch(source, /:\s*Infinity\s*;/,
    'provider generation can leak an Infinity sentinel into request diagnostics');
});

test('authoritative Memorize state boundaries use the explicit serializable-domain contract', () => {
  const boundaryModules = [
    'memorize-action-engine.js', 'memorize-execution-kernel.js',
    'memorize-obligation-ledger.js', 'memorize-tier-pipeline.js',
    'memorize-transaction-settlement.js', 'memorize-replay-harness.js',
    'catchup-recovery-utils.js', 'catchup-transaction.js',
    'provider-attempt-audit.js', 'provider-completion-journal.js',
  ];
  for (const file of boundaryModules) {
    const source = read(file);
    assert.match(source, /serializable-domain\.js/,
      `${file} does not import the explicit domain boundary`);
    assert.doesNotMatch(source, /structuredClone\(/,
      `${file} can discover runtime effects only after an unclassified clone failure`);
  }
});

test('multi-owner production path retains evidence and has no callback result path', () => {
  const source = read('multi-owner-longterm-runtime.js');
  assert.match(source, /findCurrentRunProviderCompletion/);
  assert.match(source, /journalReplayMode/);
  assert.match(source, /physicalProviderRequests = journalReplayMode \? 0 : 1/);
  assert.match(source, /prepared_effect_plans: effectPlans/);
  assert.match(source, /next_action: 'apply_journaled_provider_completion'/);
  assert.doesNotMatch(source, /\.commit\?\.|defer_commit/);
});

test('controller records one Long-Term root failure without a derivative recovery error', () => {
  const source = read('settings.js');
  assert.match(source, /root_error_recorded: true/);
  assert.match(source, /longtermSchedule\.root_error_recorded !== true/);
});

test('production registration publishes its validated proposal inside the leased transaction', () => {
  const pipeline = read('memorize-tier-pipeline.js');
  const settings = read('settings.js');
  assert.match(pipeline, /prepareProviderStateProposal/);
  assert.match(pipeline, /provider_state_proposal: providerStateProposal/);
  assert.match(settings, /runLeasedPersistence\('obligation_event'/);
  assert.match(settings, /provider_registration\.publish\.provider_attempt_audit/);
  assert.match(settings, /provider_registration\.publish\.provider_completion_journal/);
});

test('provider audit remains evidence-only and cannot supply hidden recovery execution state', () => {
  const audit = read('provider-attempt-audit.js');
  const recovery = read('malformed-output-recovery.js');
  assert.doesNotMatch(audit, /Object\.defineProperty\(event\.prior_window_recovery_state/);
  assert.doesNotMatch(recovery,
    /resumeState\s*\?\?\s*originalAttempt\?\.prior_window_recovery_state/);
  assert.match(recovery, /const effectiveResumeState = resumeState/);
});

test('diagnostics, Continuity Check, and injection publish through schema-owned projections', () => {
  const settings = read('settings.js');
  const projections = read('memorize-projections.js');
  const continuity = read('continuity.js');
  const injection = read('unified-inject.js');

  assert.match(settings, /createFullDiagnosticsExport/);
  assert.match(settings, /observeMemorizeDiagnostics/);
  assert.doesNotMatch(settings, /catch_up_diagnostics\s*=\s*diagnostics\s*;/,
    'settings publishes a mutable diagnostics aggregate before projection validation');
  assert.match(projections, /createFullDiagnosticsExport/);

  assert.match(continuity, /createContinuityOutcome/);
  assert.match(continuity, /createContinuityEvidenceSet/);
  assert.match(continuity, /candidateIdentityOf/);
  assert.match(continuity, /createDiagnosticError\(err\)/);
  assert.doesNotMatch(continuity, /\berror:\s*err\b/,
    'Continuity Check leaks a runtime Error into its result');

  assert.match(injection, /createInjectionTierBreakdown/);
  assert.match(injection, /createUnifiedInjectionPlan/);
  assert.match(injection, /getUnifiedInjectionReadModel/);
  for (const tier of ['PROMPT_KEY_TRIGGERED', 'PROMPT_KEY_RELATIONSHIPS',
    'PROMPT_KEY_EPISTEMIC', 'PROMPT_KEY_STATE_LEDGER']) {
    assert.match(injection, new RegExp(tier), `${tier} is omitted from unified injection`);
  }
  assert.doesNotMatch(injection, /return\s+lastTierBreakdown\s*;/,
    'injection exposes its mutable internal read model');
});

test('active Short-Term recovery contains no in-place compatibility migration path', () => {
  const settings = read('settings.js');
  const recovery = read('shortterm-recovery-utils.js');
  for (const obsolete of [
    'migrateMissingPlanCommittedCheckpoint',
    'migrateCommittedShortTermFailureState',
    'deriveMissingPlanCommittedCheckpoint',
  ]) {
    assert.doesNotMatch(settings, new RegExp(obsolete));
    assert.doesNotMatch(recovery, new RegExp(obsolete));
  }
  assert.match(recovery, /decision:\s*'fresh_start_required'/);
  assert.doesNotMatch(recovery, /legacyPhysicalAttempts|legacy_cumulative_lower_bound/);
  assert.doesNotMatch(read('catchup-recovery-utils.js'),
    /legacy_attempt_type|attempt_type_migrated|shortterm_recovery_migration/);
  assert.doesNotMatch(settings, /legacyPhysicalAttempts/);
  assert.match(recovery, /shortterm_attempt_accounting_schema_unsupported/);
  assert.doesNotMatch(read('page-run-lifecycle.js'),
    /\[1,\s*PAGE_RUN_LIFECYCLE_SCHEMA_VERSION\]/);
  const targetedReplay = read('targeted-replay-utils.js');
  assert.doesNotMatch(targetedReplay, /unavailable_for_legacy_obligation|attempted:\s*undefined/);
  assert.match(targetedReplay, /targeted_replay_schema_unsupported/);
});

test('multi-owner receipt writes do not enter the provider failure branch', () => {
  const source = read('multi-owner-longterm-runtime.js');
  const starts = source.indexOf("recordActionReceipt('provider_request_started'");
  const guard = source.indexOf('if (!journalReplayMode && !transportRejected)');
  const journal = source.indexOf('provider_completion_journal_updated(entry', guard);
  const received = source.indexOf("recordActionReceipt('provider_response_received'");
  assert.ok(starts >= 0 && starts < guard && guard < journal && journal < received);
  assert.match(source, /catch \(error\) \{\s*transportRejected = true;\s*throw error;/);
});

test('stored memory entry points validate current schemas instead of invoking migrations', () => {
  const graph = read('graph-migration.js');
  const characterValidator = graph.slice(graph.indexOf('export function ensureCharacterSchemaCurrent'),
    graph.indexOf('export async function ensureChatSchemaCurrent'));
  const chatValidator = graph.slice(graph.indexOf('export async function ensureChatSchemaCurrent'));
  assert.match(characterValidator, /assertCurrentMemoryStore\(charData, 'character'\)/);
  assert.match(chatValidator, /assertCurrentMemoryStore\(meta, 'chat'\)/);
  assert.doesNotMatch(characterValidator, /applyMigrations|CHARACTER_MIGRATIONS/);
  assert.doesNotMatch(chatValidator, /applyMigrations|CHAT_MIGRATIONS/);
  assert.doesNotMatch(graph, /migrateCharacter_v|migrateChat_v|applyMigrations|CHARACTER_MIGRATIONS|CHAT_MIGRATIONS/);
  assert.doesNotMatch(graph, /applyGraphDefaults|unknown_legacy|link_id:\s*`legacy:/);
  assert.doesNotMatch(read('ui.js'), /normalize_graph_defaults|beforeGraphDefaultNormalization/);
  assert.doesNotMatch(read('ui.js'), /unknown_legacy/);
  assert.doesNotMatch(read('idempotence-utils.js'), /deterministicLegacySessionId|legacy-arc:|unknown_legacy/);
  assert.doesNotMatch(read('idempotence-utils.js'), /:\s*data\.durable_state_changed\s*===\s*true/,
    'idempotence still falls back to a cached durable-change boolean');
  assert.doesNotMatch(read('settings.js'), /durable_state_changed:\s*finalVerificationComparison\.changed/,
    'reconciliation still publishes a duplicate cached durable-change verdict');
  assert.doesNotMatch(read('settings.js'), /first_final_semantic_hash|second_final_semantic_hash|semantic_hash_equal/,
    'reconciliation still publishes obsolete final-hash compatibility aliases');
  assert.doesNotMatch(read('scenes.js'), /legacy_indexed_lines|recoveredLegacyLines|confidence_outcomes_scope|terminal_candidate_confidence_outcomes_scope/,
    'scene detection still exposes an obsolete provider contract or diagnostic alias');
  assert.doesNotMatch(read('scene-archive-utils.js'), /stableLegacySceneId|legacy-scene-|detected_by:\s*scene\.detected_by\s*\?\?\s*'legacy'/);
  assert.doesNotMatch(read('scene-stability-utils.js'), /canonicalizeGateOutput|migrated_legacy_output|legacy_output_incomplete|migration_generated|deterministicLegacyId|gate_schema_migration_progress|provider_decisions\s*=/);
  assert.doesNotMatch(read('run-status-utils.js'), /superseded_or_migrated|legacy_unknown|historical_failure_observation_count/);
  assert.doesNotMatch(read('provider-attempt-audit.js'), /details_pruned_or_legacy|legacy_single_source_unit_regeneration_successes_meaning|not_observed_or_legacy_attempts/);
});
