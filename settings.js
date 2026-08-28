/**
 * Smart Memory Enhanced - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Settings management: default values, settings migration, and UI binding.
 *
 * defaultSettings  - canonical default values for all extension_settings keys
 * loadSettings     - merges defaults + runs field migrations on startup
 * bindSettingsUI   - wires all settings panel controls; takes a ctrl object
 *                    with getter/setter properties for index.js state variables
 *                    so this module never imports from index.js
 */

import {
  extension_prompt_types,
  extension_prompt_roles,
  setExtensionPrompt,
  saveSettingsDebounced,
  getMaxContextSize,
  stopGeneration,
} from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../scripts/popup.js';
import { power_user } from '../../../../scripts/power-user.js';
import { user_avatar } from '../../../../scripts/personas.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
  generateMemoryId,
} from './constants.js';
import {
  memory_sources,
  fetchOllamaModels,
  onMemoryRequestRetry,
  retryTransientMemoryOperation,
} from './generate.js';
import { summarizeExtractionCoverage } from './extraction-window-utils.js';
import { normalizeCatchUpCheckpoint, validateCatchUpResumeSource } from './catchup-recovery-utils.js';
import {
  beginCatchUpTransaction,
  commitCatchUpTransaction,
  rollbackCatchUpTransaction,
  saveChatMetadata,
} from './catchup-transaction.js';
import { runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  clearCharacterMemories,
  clearRelationshipHistory,
  loadRelationshipHistory,
  saveRelationshipHistory,
  injectRelationshipHistory,
  getRelationshipHistoryPair,
  isFreshStart,
  setFreshStart,
  getReadOnlyStartIndex,
  setReadOnlyStartIndex,
  getReadOnlyStartTime,
  getCharacterMemoryPolicy,
  setCharacterMemoryPolicy,
} from './longterm.js';
import {
  clearEpistemicKnowledge,
  extractEpistemicKnowledge,
  injectEpistemicKnowledge,
  isEpistemicEnabled,
  loadEpistemicKnowledge,
  saveEpistemicKnowledge,
  resetEpistemicWarnFlag,
} from './epistemic.js';
import { hideChatMessageRange } from '../../../../scripts/chats.js';
import { generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  clearSessionMemories,
  purgeSessionMemoriesSince,
} from './session.js';
import {
  summarizeScene,
  sceneSimilarity,
  injectSceneHistory,
  loadSceneHistory,
  saveSceneHistory,
  clearSceneHistory,
  createSceneRecord,
  detectSceneBreakAI,
  detectSceneBreakAIBatch,
  detectSceneBreakHeuristic,
  selectSceneBoundaryCandidates,
} from './scenes.js';
import { extractArcs, injectArcs, clearArcs, clearArcSummaries, loadArcs, loadArcSummaries, saveArcSummaries } from './arcs.js';
import { isRecordApprovedForPropagation } from './record-validation.js';
import { runModelTest } from './model-test.js';
import { advanceSceneBufferAtBoundary, coalesceSceneBoundary, deriveSceneCandidateStateDelta, deriveSceneContinuitySignals, evaluateDeterministicSceneGate, shouldDeferSceneBoundaryToNextMessage } from './scene-gate-utils.js';
import { summarizeSceneCandidateSources } from './scene-candidate-utils.js';
import { analyzeSameRunBoundaryClusters, analyzeSceneStabilityHistory, compareSceneBoundaryRuns } from './scene-stability-utils.js';
import {
  PROMPT_TASKS,
  PROMPT_TASK_LABELS,
  listPromptProfiles,
  getPromptProfile,
  getPromptProfileAssignment,
  setPromptProfileAssignment,
  resolvePromptProfileId,
  savePromptProfile,
  updatePromptProfile,
  deletePromptProfile,
  renamePromptProfile,
  getDefaultPromptPreview,
  getLivePromptInspection,
  getPromptOverride,
  setPromptOverride,
  resetPromptOverride,
  resolvePromptOverride,
  exportPromptOverrides,
  importPromptOverrides,
} from './prompt-config.js';
import {
  deriveAutomaticStabilizationResult,
  deriveIdempotenceResult,
  DURABLE_SEMANTIC_PROJECTION_VERSION,
  compareDurableSemanticStates,
  durableStateHash,
  sceneHistoryHashComponents,
  summarizeDurableStateChanges,
  summarizeSessionMemoryChanges,
  summarizeStoryArcChanges,
  summarizeCardLocalMemoryChanges,
  diagnosticMetadataHash,
  revisionMetadataHash,
  normalizeIdempotenceResult,
} from './idempotence-utils.js';
import { buildIdempotenceLifecycleLedger } from './idempotence-lifecycle-utils.js';
import { resolveHistoricalGroupParticipants } from './historical-participants-utils.js';

/** Set to true while a model test is running to allow cancellation. */
let modelTestRunning = false;

/** Stable non-cryptographic fingerprint for diagnostics; never exports chat text. */
function diagnosticFingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Reconciliation touches both chat-local metadata and per-card durable
 * stores. Keep configuration/telemetry out of this snapshot; the pure
 * canonicalizer selects only reconciliation-relevant keys from it.
 */
function idempotenceDurableState(metadata = {}) {
  const settings = extension_settings[MODULE_NAME] ?? {};
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    characters: settings.characters ?? {},
    entityRegistry: metadata?.entityRegistry ?? settings.entityRegistry ?? settings.entity_registry ?? [],
  };
}

// Reconciliation mutates nested metadata in place. Idempotence comparisons
// must retain immutable point-in-time snapshots; a shallow wrapper would let
// the second pass overwrite the first pass's structural baseline.
function snapshotIdempotenceDurableState(metadata = {}) {
  const state = idempotenceDurableState(metadata);
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

function buildFinalStateConsistency({ automatic = null, manual = null, currentHash = null } = {}) {
  const automaticHash = automatic?.durable_state_hash_after_second_pass ?? null;
  const manualHash = manual?.evaluated_semantic_hash ?? manual?.durable_state_hash_after_second_pass ?? null;
  const comparable = [
    ['catch_up', automaticHash], ['post_stabilization', automaticHash],
    ['diagnostics_export', automaticHash], ['manual_developer', manualHash],
    ['restored_panel', currentHash ?? manualHash],
  ].filter(([, hash]) => typeof hash === 'string');
  const hashes = [...new Set(comparable.map(([, hash]) => hash))];
  const equal = hashes.length <= 1;
  return {
    semantic_projection_version: DURABLE_SEMANTIC_PROJECTION_VERSION,
    catch_up: { hash: automaticHash, projection: 'durable_semantic_state_v1' },
    post_stabilization: { hash: automaticHash, projection: 'durable_semantic_state_v1' },
    manual_developer: { available: Boolean(manual), current: Boolean(manual && (!currentHash || manualHash === currentHash)), hash: manualHash, projection: 'durable_semantic_state_v1' },
    restored_panel: { available: Boolean(currentHash), hash: currentHash ?? manualHash, projection: 'durable_semantic_state_v1' },
    diagnostics_export: { hash: automaticHash, projection: 'durable_semantic_state_v1' },
    all_comparable_hashes_equal: equal,
    comparison_groups: [{ projection: 'durable_semantic_state_v1', members: comparable.map(([name]) => name) }],
    interpretation_consistent: equal,
    mismatch_fields: equal ? [] : comparable.filter(([, hash]) => hash !== hashes[0]).map(([name]) => `${name}_semantic_hash`),
  };
}

/** Canonical, input-only summary for future scene-run comparability. */
function summarizeCandidateContexts(candidateContexts = []) {
  const seen = new Set();
  const duplicateCandidateIds = [];
  const pairs = (Array.isArray(candidateContexts) ? candidateContexts : [])
    .map((item) => ({ candidate_id: Number(item?.candidate_id), context_hash: String(item?.context_hash ?? '') }))
    .filter((item) => Number.isInteger(item.candidate_id) && item.context_hash);
  pairs.sort((left, right) => left.candidate_id - right.candidate_id);
  const canonicalPairs = pairs.filter((item) => {
    if (seen.has(item.candidate_id)) { duplicateCandidateIds.push(item.candidate_id); return false; }
    seen.add(item.candidate_id);
    return true;
  });
  return {
    canonical_pairs: canonicalPairs,
    summary: canonicalPairs.length ? diagnosticFingerprint(JSON.stringify(canonicalPairs)) : null,
    duplicate_candidate_ids: [...new Set(duplicateCandidateIds)],
    status: canonicalPairs.length ? (duplicateCandidateIds.length ? 'recomputed_with_duplicates_removed' : 'computed_from_candidate_contexts') : 'missing_candidate_detail',
  };
}

// Keep only bounded, text-free material needed to compare equivalent scene
// detection runs. This deliberately excludes prompts, chat messages, and raw
// provider responses.
function makeSceneStabilitySnapshot(audit = {}) {
  const finalBreakIndices = [...(audit.final_break_indices ?? [])];
  const createdAt = Date.now();
  const taskSettings = audit.task_sampling_settings ?? {};
  const contextSummary = summarizeCandidateContexts(audit.candidate_context_hashes);
  const contextByCandidate = new Map(contextSummary.canonical_pairs.map((item) => [item.candidate_id, item.context_hash]));
  const storedSummary = audit.candidate_context_hash_summary ?? null;
  const summaryMismatch = Boolean(storedSummary && contextSummary.summary && storedSummary !== contextSummary.summary);
  return {
    run_id: audit.run_id ?? `unavailable-scene-run-${createdAt}`,
    run_id_source: audit.run_id ? 'runtime' : 'unavailable',
    created_at: createdAt,
    created_at_source: 'runtime',
    run_signature: audit.scene_detection_run_signature ?? null,
    scene_detection_run_signature: audit.scene_detection_run_signature ?? null,
    final_break_indices: finalBreakIndices,
    boundary_count: finalBreakIndices.length,
    scene_count: finalBreakIndices.length + 1,
    generated: audit.generated ?? null,
    prompt_shape_hash: audit.prompt_shape_hash ?? null,
    model_identifier: audit.model_identifier ?? null,
    connection_profile_identifier: audit.connection_profile_identifier ?? null,
    task_sampling_settings: taskSettings,
    task_settings_hash: diagnosticFingerprint(JSON.stringify(taskSettings)),
    candidate_context_hashes: contextSummary.canonical_pairs,
    candidate_context_hash_summary: contextSummary.summary,
    candidate_context_hash_summary_source: 'computed_from_candidate_contexts',
    candidate_context_hash_summary_status: summaryMismatch ? 'mismatch_detected' : contextSummary.status,
    legacy_candidate_context_hash_summary: summaryMismatch ? storedSummary : null,
    candidate_context_summary_migration: {
      stored_value: storedSummary,
      recomputed_value: contextSummary.summary,
      values_match: storedSummary === null || storedSummary === contextSummary.summary,
      source_status: contextSummary.status,
      migration_applied: summaryMismatch,
      duplicate_candidate_ids: contextSummary.duplicate_candidate_ids,
    },
    // A comparison contract makes it explicit which semantic shape produced
    // these boundary decisions. Older records without it remain readable, but
    // new runs are compared only against another run with the same contract.
    comparison_contract: {
      version: 1,
      candidate_snapshot_schema_version: 1,
      boundary_semantics: audit.boundary_semantics ?? null,
      deterministic_gate_schema_version: 1,
      coalescing_schema_version: audit.scene_coalescing?.schema_version ?? 1,
      candidate_context_hash_summary: contextSummary.summary,
    },
    // Keep only bounded, privacy-safe terminal facts needed for subsequent
    // variance and deterministic-gate comparison. No chat or prompt text is
    // retained in scene history.
    candidate_detail_available: Array.isArray(audit.candidate_dispositions),
    candidate_dispositions: (audit.candidate_dispositions ?? []).map((candidate) => ({
      candidate_id: candidate.candidate_id,
      message_index: candidate.message_index ?? candidate.candidate_id,
      candidate_context_hash: contextByCandidate.get(Number(candidate.candidate_id)) ?? null,
      prompt_shape_hash: audit.prompt_shape_hash ?? null,
      task_settings_hash: diagnosticFingerprint(JSON.stringify(taskSettings)),
      decision: typeof candidate.decision === 'boolean' ? candidate.decision : null,
      ai_confidence: candidate.ai_confidence ?? null,
      gate_input_hash: candidate.gate_input_hash ?? null,
      gate_output_schema_version: candidate.gate_output_schema_version ?? 1,
      gate_executed: candidate.gate_executed === true,
      gate_result: candidate.gate_result ?? null,
      gate_reason_code: candidate.gate_reason_code ?? null,
      terminal_break_disposition: candidate.terminal_break_disposition ?? null,
      canonical_gate_output_hash: candidate.gate_executed === true
        ? JSON.stringify({ gate_executed: true, gate_result: candidate.gate_result ?? null, gate_reason_code: candidate.gate_reason_code ?? null, terminal_break_disposition: candidate.terminal_break_disposition ?? null })
        : null,
      final_boundary: candidate.terminal_break_disposition === 'accepted_final_break',
    })),
    record_source: 'runtime',
    written_at: createdAt,
    writer_stage: 'catch_up_finalization',
    history_schema_version: 2,
    malformed_batches: audit.malformed_batches ?? 0,
    fallback_boundaries: audit.fallback_boundaries ?? 0,
    total_provider_requests: audit.total_provider_requests ?? audit.scene_detector_model_request_count ?? 0,
    initial_batch_requests: audit.initial_batch_requests ?? null,
    partial_retry_requests: audit.partial_retry_requests ?? null,
    single_candidate_retry_requests: audit.single_candidate_retry_requests ?? null,
    format_repair_requests: audit.format_repair_requests ?? null,
    multi_candidate_requests: audit.multi_candidate_requests ?? null,
    provider_partial_response_count: (audit.batch_attempts ?? []).filter((attempt) => attempt.partial_or_truncated).length,
    format_repair_count: audit.format_repair_requests ?? 0,
    adaptive_batch_summary: audit.adaptive_batch_summary ?? null,
    heuristic_fallback_candidates: audit.heuristic_fallback_candidates ?? 0,
    pipeline_status: audit.pipeline_status ?? ((audit.malformed_batches ?? 0) || (audit.fallback_boundaries ?? 0) ? 'degraded' : 'clean'),
    completed_at: createdAt,
  };
}

/** Persist one unique finalized scene run; refreshes must not append it twice. */
function updateSceneStabilityHistory(history = [], audit = {}) {
  const snapshot = makeSceneStabilitySnapshot(audit);
  const uniquePrior = (history ?? []).filter((record) => record?.run_id !== snapshot.run_id);
  return [...uniquePrior, snapshot].slice(-5);
}

/**
 * Apply a user-initiated chat cleanup as one persisted operation. The storage
 * helpers used by the cleanup continue to call saveChatMetadata(), but the
 * active transaction stages those requests until the complete cleanup is
 * ready. This avoids queuing several overlapping SillyTavern chat saves.
 */
async function runStagedChatCleanup(context, mutate) {
  const transaction = beginCatchUpTransaction(context);
  try {
    await mutate();
    // Direct metadata edits (for example deleting the summary) also need to
    // mark the transaction dirty when no tier-specific helper did so.
    await saveChatMetadata(context);
    await retryTransientMemoryOperation(() => commitCatchUpTransaction(transaction));
  } catch (error) {
    rollbackCatchUpTransaction(transaction);
    throw error;
  }
}

/**
 * Final transaction-bound integrity gate. It runs after all catch-up tiers,
 * before diagnostics and the one final chat save, so a failure rolls the full
 * final phase back rather than committing a partly reconciled graph.
 */
async function runFinalIntegrityReconciliation(characterName, { forceIdempotenceCheck = false } = {}) {
  const startedAt = performance.now();
  const metadataBefore = getContext().chatMetadata?.[META_KEY] ?? {};
  const durableStateBefore = snapshotIdempotenceDurableState(metadataBefore);
  const durableStateHashBefore = durableStateHash(durableStateBefore);
  const sceneHistoryHashesBefore = sceneHistoryHashComponents(durableStateBefore);
  // Verbose logging increases local diagnostics only. It must never make an
  // automatic reconciliation masquerade as the explicit Developer command.
  const developerCheckRequested = Boolean(forceIdempotenceCheck);
  // There is currently no mutating preparation step. Keep this explicit
  // snapshot before pass one so future preparation cannot hide a mutation.
  const metadataAfterPreparation = getContext().chatMetadata?.[META_KEY] ?? {};
  const durableStateAfterPreparation = snapshotIdempotenceDurableState(metadataAfterPreparation);
  const diagnosticMetadataHashBefore = diagnosticMetadataHash(metadataBefore);
  const revisionMetadataHashBefore = revisionMetadataHash(metadataBefore);
  const reconciliation = await reconcileCanonicalEntities(characterName, { reconciliationStage: 'first_pass' });
  const summaries = loadArcSummaries();
  let quarantinedSummaries = 0;
  for (const summary of summaries) {
    const status = summary?.resolution_decision?.status;
    if (!status || status === 'resolved') continue;
    summary.grounding_status = 'derived';
    summary.validation_status = 'needs_review';
    summary.semantic_support = 'unsupported';
    summary.verification_state = 'resolution_reclassified';
    summary.validation_issues = [...new Set([...(summary.validation_issues ?? []), `Arc resolution is ${status}, not resolved.`])];
    quarantinedSummaries++;
  }
  if (quarantinedSummaries) await saveArcSummaries(summaries);
  const result = {
    ...reconciliation,
    quarantined_arc_summaries: quarantinedSummaries,
    duration_ms: Math.round(performance.now() - startedAt),
  };
  const priorAutomaticPersonaInput = forceIdempotenceCheck
    ? metadataBefore?.catch_up_diagnostics?.automatic_stabilization?.persona_reconciliation_input
      ?? metadataBefore?.catch_up_diagnostics?.finalReconciliation?.stabilization?.persona_reconciliation_input
      ?? null
    : null;
  const personaInputComparison = forceIdempotenceCheck ? {
    automatic_input_available: Boolean(priorAutomaticPersonaInput),
    automatic_context_fingerprint: priorAutomaticPersonaInput?.context_fingerprint ?? null,
    manual_context_fingerprint: reconciliation.persona_reconciliation_input?.context_fingerprint ?? null,
    equivalent: priorAutomaticPersonaInput
      ? priorAutomaticPersonaInput.context_fingerprint === reconciliation.persona_reconciliation_input?.context_fingerprint
      : null,
    active_and_historical_remain_distinct: reconciliation.persona_reconciliation_input?.active_and_historical_are_distinct ?? false,
  } : null;
  const firstPassRepairs = reconciliation.integrity_audit?.entity_link_repairs ?? {};
  const metadataAfterFirstPass = getContext().chatMetadata?.[META_KEY] ?? {};
  const durableStateAfterFirstPass = snapshotIdempotenceDurableState(metadataAfterFirstPass);
  const durableStateHashAfterFirstPass = durableStateHash(durableStateAfterFirstPass);
  // A manual check is often invoked immediately after automatic stabilization.
  // Keep a privacy-safe leaf diff of its first pass so any missed automatic
  // dependency is diagnosable by store/record path rather than only by hash.
  const postAutomaticManualMaintenanceDiff = forceIdempotenceCheck
    ? (() => {
      const comparison = summarizeDurableStateChanges(durableStateBefore, durableStateAfterFirstPass);
      const cardLocal = summarizeCardLocalMemoryChanges(durableStateBefore, durableStateAfterFirstPass);
      const writes = reconciliation.integrity_audit?.automatic_stabilization_second_pass_writes?.records ?? [];
      const accounting = reconciliation.integrity_audit?.durable_write_accounting ?? {};
      return {
        // Keep `changed` for older exports, but name the canonical-state fact
        // explicitly so a structural change can never masquerade as a zero
        // maintenance result.
        changed: comparison.changed,
        canonical_state_changed: comparison.changed,
        changed_component_count: comparison.changed_components.length,
        changed_record_count: comparison.changed_path_count,
        changed_field_count: comparison.changed_path_count,
        counted_logical_mutations: firstPassRepairs?.actual_logical_mutations_this_run ?? 0,
        counted_physical_mutations: firstPassRepairs?.actual_physical_store_mutations_this_run ?? 0,
        unaccounted_semantic_changes: accounting.unaccounted_semantic_changes ?? comparison.changed_path_count,
        total_mutations: firstPassRepairs?.actual_logical_mutations_this_run ?? 0,
        changed_components: comparison.changed_components,
        records: [
          ...cardLocal.records.map((record) => ({
            store: record.store,
            logical_record_fingerprint: record.logical_record_fingerprint,
            changed_field_paths: record.changed_fields.map((field) => field.canonical_field_path),
            before_hash: record.changed_fields[0]?.before_hash ?? null,
            after_hash: record.changed_fields[0]?.after_hash ?? null,
            source_operation: writes.find((write) => write.logical_record_fingerprint === record.logical_record_fingerprint)?.source_operation ?? 'reconcileCanonicalEntities',
            depends_on_prior_stage: true,
            dependency_sources: ['automatic_stabilization_final_state'],
          })),
          ...comparison.paths.filter((path) => !path.path.startsWith('card_local_memories')).map((path) => ({
            store: String(path.path).split('.')[0], logical_record_fingerprint: null,
            changed_field_paths: [path.path], before_hash: path.before_value_hash, after_hash: path.after_value_hash,
            source_operation: 'reconcileCanonicalEntities', depends_on_prior_stage: true,
            dependency_sources: ['automatic_stabilization_final_state'],
          })),
        ],
        accounting_reconciled: accounting.accounting_reconciled ?? !comparison.changed,
      };
    })()
    : null;
  result.idempotence = {
    available: true,
    audit_type: forceIdempotenceCheck ? 'manual_developer_idempotence_check' : 'automatic_post_catchup_stabilization',
    is_manual_developer_check: forceIdempotenceCheck,
    automatic_stabilization: !forceIdempotenceCheck,
    attempted: true,
    enabled_by: forceIdempotenceCheck ? 'developer_manual_command' : 'automatic_post_catchup_stabilization',
    not_attempted_reason: null,
    pass_count: 1,
    durable_state_hash_before: durableStateHashBefore,
    durable_state_hash_after_first_pass: durableStateHashAfterFirstPass,
    durable_state_hash_after_second_pass: null,
    diagnostic_metadata_hash_before: diagnosticMetadataHashBefore,
    diagnostic_metadata_hash_after: null,
    revision_metadata_hash_before: revisionMetadataHashBefore,
    revision_metadata_hash_after: null,
    first_pass_logical_mutations: firstPassRepairs.actual_logical_mutations_this_run ?? 0,
    first_pass_physical_mutations: firstPassRepairs.actual_physical_store_mutations_this_run ?? 0,
    second_pass_input_hash: null,
    second_pass_output_hash: null,
    second_pass_logical_mutations: null,
    second_pass_physical_mutations: null,
    recreated_after_prior_repair: firstPassRepairs.recreated_after_prior_repair ?? 0,
    stale_references_after_second_pass: null,
    idempotent: null,
    post_automatic_manual_maintenance_diff: postAutomaticManualMaintenanceDiff,
    persona_reconciliation_input: reconciliation.persona_reconciliation_input ?? null,
    persona_reconciliation_input_comparison: personaInputComparison,
    registry_reconciliation_context_trace: reconciliation.registry_reconciliation_context_trace ?? null,
    // A manual check must be able to explain any mutation that the completed
    // automatic path missed without exposing record content.  This is filled
    // from the reconciliation boundary's canonical semantic diff below.
    post_automatic_manual_dependency_trace: forceIdempotenceCheck ? {
      stage: 'manual_first_pass_after_automatic_stabilization',
      automatic_state_hash: durableStateHashBefore,
      manual_first_pass_hash: durableStateHashAfterFirstPass,
      automatic_missed_mutation: Boolean(postAutomaticManualMaintenanceDiff?.canonical_state_changed),
      records: postAutomaticManualMaintenanceDiff?.records ?? [],
      dependency_hypothesis: postAutomaticManualMaintenanceDiff?.canonical_state_changed
        ? 'durable_reference_materialized_after_prior_automatic_boundary'
        : 'none',
    } : null,
  };
  // Developer-only semantic idempotence check. It intentionally runs on the
  // already-finalized serialized metadata; it does not regenerate records or
  // introduce new IDs. Diagnostic/revision metadata may change even when no
  // durable record changes, so the metadata hash is reported but is not by
  // itself a failed reconciliation.
  // Every catch-up needs one local stabilization audit after its mutating
  // reconciliation pass.  This is not the Developer idempotence command: it
  // makes no provider calls and exists so final quality is derived from the
  // same finalized graph that a later Developer check will inspect.
  // Developer mode additionally exposes the full idempotence detail in the
  // panel, but cannot change the audit semantics.
  {
    let metadataBeforeSecondPass = getContext().chatMetadata?.[META_KEY] ?? {};
    let durableStateBeforeSecondPass = snapshotIdempotenceDurableState(metadataBeforeSecondPass);
    const interpassComparison = compareDurableSemanticStates(durableStateAfterFirstPass, durableStateBeforeSecondPass);
    let secondPass = await reconcileCanonicalEntities(characterName, { reconciliationStage: 'second_pass' });
    let metadataAfterSecondPass = getContext().chatMetadata?.[META_KEY] ?? {};
    let durableStateAfterSecondPass = snapshotIdempotenceDurableState(metadataAfterSecondPass);
    let repairs = secondPass.integrity_audit?.entity_link_repairs ?? {};
    // Automatic reconciliation used to stop after an assumed verification
    // pass. That is not sufficient when a safe redirect repair in one pass
    // makes a card-local or arc reference resolvable only in the next pass.
    // Keep the manual command deliberately two-pass; only the automatic path
    // performs a bounded local fixed-point closure before committing catch-up.
    const maximumStabilizationPasses = forceIdempotenceCheck ? 2 : 4;
    const stabilizationPasses = [];
    const summarizeStabilizationPass = (passNumber, input, output, passResult) => {
      const comparison = compareDurableSemanticStates(input, output);
      const passRepairs = passResult.integrity_audit?.entity_link_repairs ?? {};
      const writes = passResult.integrity_audit?.automatic_stabilization_second_pass_writes?.records ?? [];
      return {
        pass_number: passNumber,
        input_semantic_hash: comparison.first_hash,
        output_semantic_hash: comparison.second_hash,
        logical_mutations: passRepairs.actual_logical_mutations_this_run ?? 0,
        physical_mutations: passRepairs.actual_physical_store_mutations_this_run ?? 0,
        stale_references: passResult.integrity_audit?.stale_entity_references?.length ?? 0,
        recreated_links: passRepairs.recreated_after_prior_repair ?? 0,
        unsafe_merge_candidates: passResult.integrity_audit?.unsafe_merge_candidates ?? 0,
        unresolved_integrity_failures: passResult.integrity_audit?.relationship_integrity_errors?.length ?? 0,
        unaccounted_mutations: passResult.integrity_audit?.durable_write_accounting?.unaccounted_semantic_changes ?? 0,
        changed_components: comparison.changed_components,
        changed_paths: comparison.paths,
        source_operations: [...new Set(writes.map((write) => write.source_operation).filter(Boolean))],
      };
    };
    stabilizationPasses.push(summarizeStabilizationPass(1, durableStateAfterPreparation, durableStateAfterFirstPass, reconciliation));
    stabilizationPasses.push(summarizeStabilizationPass(2, durableStateBeforeSecondPass, durableStateAfterSecondPass, secondPass));
    const isStablePass = (pass) => pass.input_semantic_hash === pass.output_semantic_hash
      && pass.logical_mutations === 0 && pass.physical_mutations === 0
      && pass.stale_references === 0 && pass.recreated_links === 0
      && pass.unsafe_merge_candidates === 0 && pass.unresolved_integrity_failures === 0
      && pass.unaccounted_mutations === 0;
    while (!forceIdempotenceCheck && !isStablePass(stabilizationPasses.at(-1)) && stabilizationPasses.length < maximumStabilizationPasses) {
      const passNumber = stabilizationPasses.length + 1;
      metadataBeforeSecondPass = getContext().chatMetadata?.[META_KEY] ?? {};
      durableStateBeforeSecondPass = snapshotIdempotenceDurableState(metadataBeforeSecondPass);
      secondPass = await reconcileCanonicalEntities(characterName, { reconciliationStage: `stabilization_pass_${passNumber}` });
      metadataAfterSecondPass = getContext().chatMetadata?.[META_KEY] ?? {};
      durableStateAfterSecondPass = snapshotIdempotenceDurableState(metadataAfterSecondPass);
      repairs = secondPass.integrity_audit?.entity_link_repairs ?? {};
      stabilizationPasses.push(summarizeStabilizationPass(passNumber, durableStateBeforeSecondPass, durableStateAfterSecondPass, secondPass));
    }
    // The canonical idempotence verdict is about the final verification pass,
    // not whether earlier maintenance changed the graph. Preserve the complete
    // history above, but feed the authoritative derivation the final pass's
    // exact input/output pair.
    const finalVerificationComparison = compareDurableSemanticStates(durableStateBeforeSecondPass, durableStateAfterSecondPass);
    result.final_state_audit = secondPass.integrity_audit ?? null;
    // The first pass is retained in idempotence/maintenance diagnostics, but
    // every final consumer must see the stabilized second-pass graph.
    result.integrity_audit = secondPass.integrity_audit ?? result.integrity_audit;
    reconciliation.integrity_audit = result.integrity_audit;
    const staleReferenceSummary = Object.values((secondPass.integrity_audit?.stale_entity_references ?? []).reduce((groups, reference) => {
      const store = String(reference?.store ?? 'unknown');
      const field = String(reference?.field ?? reference?.reference_field_path ?? 'unknown');
      const reason = String(reference?.stale_reason_code ?? reference?.failure_reason ?? 'unknown');
      const key = `${store}|${field}|${reason}`;
      const group = groups[key] ?? { store, field, reason, count: 0 };
      group.count++;
      groups[key] = group;
      return groups;
    }, {})).sort((left, right) => right.count - left.count || left.store.localeCompare(right.store));
    const durableComparison = compareDurableSemanticStates(durableStateAfterFirstPass, durableStateAfterSecondPass);
    const durableChangeSummary = summarizeDurableStateChanges(durableStateAfterFirstPass, durableStateAfterSecondPass);
    const sessionMemoryChangeSummary = summarizeSessionMemoryChanges(durableStateAfterFirstPass, durableStateAfterSecondPass);
    const storyArcChangeSummary = summarizeStoryArcChanges(durableStateAfterFirstPass, durableStateAfterSecondPass);
    const cardLocalMemoryChangeSummary = summarizeCardLocalMemoryChanges(durableStateAfterFirstPass, durableStateAfterSecondPass);
    const secondPassWriteAccounting = secondPass.integrity_audit?.durable_write_accounting ?? {};
    const accountedMutations = (repairs.actual_logical_mutations_this_run ?? 0) + (repairs.actual_physical_store_mutations_this_run ?? 0);
    const semanticMutationUnits = secondPassWriteAccounting.semantic_mutation_units
      ?? (durableChangeSummary.changed ? Math.max(1, durableChangeSummary.changed_path_count) : 0);
    const unaccountedSemanticChanges = secondPassWriteAccounting.unaccounted_semantic_changes
      ?? Math.max(0, semanticMutationUnits - accountedMutations);
    durableChangeSummary.accounted_mutation_count = accountedMutations;
    durableChangeSummary.semantic_mutation_units = semanticMutationUnits;
    durableChangeSummary.unaccounted_mutation_count = unaccountedSemanticChanges;
    sessionMemoryChangeSummary.accounted_mutation_count = accountedMutations;
    sessionMemoryChangeSummary.semantic_mutation_units = semanticMutationUnits;
    sessionMemoryChangeSummary.unaccounted_mutation_count = unaccountedSemanticChanges;
    cardLocalMemoryChangeSummary.accounted_mutation_count = accountedMutations;
    cardLocalMemoryChangeSummary.semantic_mutation_units = semanticMutationUnits;
    cardLocalMemoryChangeSummary.unaccounted_mutation_count = unaccountedSemanticChanges;
    const baseIdempotence = {
      ...result.idempotence,
      pass_count: stabilizationPasses.length,
      durable_state_hash_after_first_pass: finalVerificationComparison.first_hash,
      durable_state_hash_after_second_pass: finalVerificationComparison.second_hash,
      diagnostic_metadata_hash_after: diagnosticMetadataHash(metadataAfterSecondPass),
      revision_metadata_hash_after: revisionMetadataHash(metadataAfterSecondPass),
      durable_state_changed: finalVerificationComparison.changed,
      diagnostic_metadata_changed: diagnosticMetadataHash(metadataBeforeSecondPass) !== diagnosticMetadataHash(metadataAfterSecondPass),
      revision_metadata_changed: revisionMetadataHash(metadataBeforeSecondPass) !== revisionMetadataHash(metadataAfterSecondPass),
      second_pass_logical_mutations: repairs.actual_logical_mutations_this_run ?? 0,
      second_pass_physical_mutations: repairs.actual_physical_store_mutations_this_run ?? 0,
      second_pass_input_hash: finalVerificationComparison.first_hash,
      second_pass_output_hash: finalVerificationComparison.second_hash,
      recreated_after_prior_repair: repairs.recreated_after_prior_repair ?? 0,
      stale_references_after_second_pass: secondPass.integrity_audit?.stale_entity_references?.length ?? 0,
      unsafe_merge_candidates_after_second_pass: secondPass.integrity_audit?.unsafe_merge_candidates ?? 0,
      unresolved_integrity_failures_after_second_pass: secondPass.integrity_audit?.relationship_integrity_errors?.length ?? 0,
      unaccounted_mutations_after_second_pass: secondPass.integrity_audit?.durable_write_accounting?.unaccounted_semantic_changes ?? 0,
      stale_reference_summary: staleReferenceSummary,
      durable_state_change_summary: durableChangeSummary,
      session_memory_change_summary: sessionMemoryChangeSummary,
      story_arc_change_summary: storyArcChangeSummary,
      card_local_memory_change_summary: cardLocalMemoryChangeSummary,
      automatic_stabilization_second_pass_writes: secondPass.integrity_audit?.automatic_stabilization_second_pass_writes ?? {
        total: 0, records: [], semantic_uncounted_writes: 0, accounting_reconciled: true,
      },
      automatic_stabilization_component_hash_diff: {
        projection_version: durableComparison.projection_version,
        first_final_hash: durableComparison.first_hash,
        second_final_hash: durableComparison.second_hash,
        changed_components: durableComparison.changed_components,
        unchanged_components: durableComparison.unchanged_components,
        accounting_reconciled: durableComparison.changed === (durableChangeSummary.changed === true),
      },
      automatic_stabilization_interpass_diff: {
        first_pass_output_hash: interpassComparison.first_hash,
        second_pass_input_hash: interpassComparison.second_hash,
        equal: !interpassComparison.changed,
        changed_components: interpassComparison.changed_components,
        changed_paths: interpassComparison.paths,
        transition_operations: [],
        mutations_counted: 0,
        unexpected_change: interpassComparison.changed,
      },
      idempotence_hash_timeline: {
        pre_preparation_hash: durableStateHashBefore,
        post_preparation_hash: durableStateHash(durableStateAfterPreparation),
        post_first_pass_hash: durableStateHashAfterFirstPass,
        post_second_pass_hash: durableStateHash(durableStateAfterSecondPass),
        changed_during_preparation: durableStateHashBefore !== durableStateHash(durableStateAfterPreparation),
        changed_during_first_pass: durableStateHash(durableStateAfterPreparation) !== durableStateHashAfterFirstPass,
        changed_during_second_pass: durableStateHashAfterFirstPass !== durableStateHash(durableStateAfterSecondPass),
      },
      session_memory_hash_timeline: {
        pre_preparation: durableStateHash({ sessionMemories: metadataBefore.sessionMemories ?? [] }),
        post_preparation: durableStateHash({ sessionMemories: metadataAfterPreparation.sessionMemories ?? [] }),
        pre_first_pass: durableStateHash({ sessionMemories: metadataAfterPreparation.sessionMemories ?? [] }),
        post_first_pass_pre_persist: durableStateHash({ sessionMemories: metadataAfterFirstPass.sessionMemories ?? [] }),
        post_first_pass_persisted: null,
        post_first_pass_reloaded: null,
        pre_second_pass: durableStateHash({ sessionMemories: metadataBeforeSecondPass.sessionMemories ?? [] }),
        post_second_pass_pre_persist: durableStateHash({ sessionMemories: metadataAfterSecondPass.sessionMemories ?? [] }),
        post_second_pass_persisted: null,
        post_second_pass_reloaded: null,
      },
      scene_history_hashes: {
        before: sceneHistoryHashesBefore,
        after_first_pass: sceneHistoryHashComponents(durableStateAfterFirstPass),
        after_second_pass: sceneHistoryHashComponents(durableStateAfterSecondPass),
      },
      // Keep the reconciliation lifecycle tied to immutable snapshots. This
      // makes a later diagnostics, save, restore, or renderer update
      // observable without allowing it to rewrite what either pass saw.
      idempotence_lifecycle_ledger: buildIdempotenceLifecycleLedger([
        { stage: 'preparation', owner: 'reconciliation', state: durableStateAfterPreparation },
        {
          stage: 'first_pass_complete', owner: 'reconciliation',
          mutation_accounted: (firstPassRepairs.actual_logical_mutations_this_run ?? 0) > 0
            || (firstPassRepairs.actual_physical_store_mutations_this_run ?? 0) > 0,
          state: durableStateAfterFirstPass,
        },
        { stage: 'second_pass_start', owner: 'reconciliation', state: durableStateBeforeSecondPass },
        {
          stage: 'second_pass_complete', owner: 'reconciliation',
          mutation_accounted: (repairs.actual_logical_mutations_this_run ?? 0) > 0
            || (repairs.actual_physical_store_mutations_this_run ?? 0) > 0,
          state: durableStateAfterSecondPass,
        },
      ]),
    };
    result.idempotence = deriveIdempotenceResult(baseIdempotence);
    const finalStabilizationPass = stabilizationPasses.at(-1);
    const convergedOnPass = isStablePass(finalStabilizationPass) ? finalStabilizationPass.pass_number : null;
    const dependencyNodes = stabilizationPasses.flatMap((pass) => (pass.changed_paths ?? []).map((path, index) => ({
      mutation_id: `pass-${pass.pass_number}-${index + 1}`,
      pass_number: pass.pass_number,
      store: String(path.path ?? 'unknown').split('.')[0],
      logical_record_fingerprint: null,
      field_paths: [path.path ?? 'root'],
      operation: pass.source_operations?.join(',') || 'reconcileCanonicalEntities',
    })));
    const dependencyEdges = stabilizationPasses.slice(1).flatMap((pass) => {
      const prior = stabilizationPasses.find((candidate) => candidate.pass_number === pass.pass_number - 1);
      if (!prior) return [];
      const priorStores = new Set((prior.changed_components ?? []).map((entry) => entry.component));
      return (pass.changed_components ?? []).filter((entry) => priorStores.has(entry.component)).map((entry) => ({
        from_mutation_id: `pass-${prior.pass_number}-${entry.component}`,
        to_mutation_id: `pass-${pass.pass_number}-${entry.component}`,
        dependency_reason: 'prior_pass_canonical_component_changed',
      }));
    });
    result.idempotence.automatic_stabilization_passes = {
      max_passes: maximumStabilizationPasses,
      executed_passes: stabilizationPasses.length,
      converged_on_pass: convergedOnPass,
      max_passes_reached: !convergedOnPass && stabilizationPasses.length >= maximumStabilizationPasses,
      passes: stabilizationPasses,
    };
    if (!forceIdempotenceCheck) {
      const boundedVerdict = deriveAutomaticStabilizationResult(stabilizationPasses, maximumStabilizationPasses);
      Object.assign(result.idempotence, boundedVerdict);
    }
    result.idempotence.stabilization_dependency_trace = {
      nodes: dependencyNodes,
      edges: dependencyEdges,
    };
    // This local second-pass audit protects the completed catch-up state, but
    // it is deliberately not presented as a user-invoked Developer result.
    // The manual path below persists its own lifecycle-verified record.
    result.idempotence.audit_type = forceIdempotenceCheck ? 'manual_developer_idempotence_check' : 'automatic_post_catchup_stabilization';
    result.idempotence.is_manual_developer_check = forceIdempotenceCheck;
    result.idempotence.automatic_stabilization = !forceIdempotenceCheck;
    if (!forceIdempotenceCheck) {
      result.idempotence.summary = result.idempotence.idempotent
        ? `Automatic stabilization converged: ${result.idempotence.second_pass_logical_mutations} second-pass mutations, ${result.idempotence.stale_references_after_second_pass} stale references, ${result.idempotence.recreated_after_prior_repair} recreated links.`
        : `Automatic stabilization needs attention: ${result.idempotence.attention_reasons.join(', ')}.`;
    }
    result.idempotence.hash_comparison = {
      durable_before: result.idempotence.durable_state_hash_before,
      durable_after_first_pass: result.idempotence.durable_state_hash_after_first_pass,
      durable_after_second_pass: result.idempotence.durable_state_hash_after_second_pass,
      durable_first_to_second_equal: result.idempotence.durable_state_hash_after_first_pass === result.idempotence.durable_state_hash_after_second_pass,
      full_metadata_before: result.idempotence.diagnostic_metadata_hash_before,
      full_metadata_after: result.idempotence.diagnostic_metadata_hash_after,
      full_metadata_equal: result.idempotence.diagnostic_metadata_hash_before === result.idempotence.diagnostic_metadata_hash_after,
      metadata_only_difference_detected: result.idempotence.metadata_only_changes,
    };
    result.idempotence.idempotence_audit_summary = {
      first_pass_had_maintenance: result.idempotence.maintenance_needed_on_first_pass,
      second_pass_stable: result.idempotence.stable_on_second_pass,
      durable_state_unchanged_on_second_pass: !result.idempotence.durable_state_changed,
      metadata_only_changes: result.idempotence.metadata_only_changes,
      stale_references_remaining: result.idempotence.stale_references_after_second_pass,
      recreated_links: result.idempotence.recreated_after_prior_repair,
      idempotent: result.idempotence.idempotent,
      attention_required: result.idempotence.attention_required,
    };
    // Catch-up holds both reconciliation passes inside one staged transaction.
    // No durable save/reload is allowed between them, so the comparable
    // lifecycle states are the normalized pre-commit first and second finals.
    // Persist/reload markers remain explicit rather than inventing a reload
    // that has not happened yet.
    result.idempotence.automatic_stabilization_hash_timeline = {
      schema_version: 2,
      projection: 'durable_semantic_state_v1',
      checkpoint_ownership: {
        pre_stabilization: 'reconciliation',
        pre_first_pass: 'reconciliation',
        post_first_pass_pre_persist: 'reconciliation',
        pre_second_pass: 'reconciliation',
        post_second_pass_pre_persist: 'reconciliation',
        final_export_state: 'diagnostics_export',
      },
      checkpoint_scope: {
        pre_stabilization: 'durable_semantic_state_snapshot',
        pre_first_pass: 'durable_semantic_state_snapshot',
        post_first_pass_pre_persist: 'durable_semantic_state_snapshot',
        pre_second_pass: 'durable_semantic_state_snapshot',
        post_second_pass_pre_persist: 'durable_semantic_state_snapshot',
        final_export_state: 'durable_semantic_state_snapshot',
      },
      pre_stabilization: durableStateHashBefore,
      pre_first_pass: durableStateHash(durableStateAfterPreparation),
      post_first_pass_pre_persist: durableStateHashAfterFirstPass,
      post_first_pass_persisted: null,
      post_first_pass_reloaded: null,
      // This must use the same immutable, durable semantic projection as the
      // inter-pass comparison. Hashing raw metadata here omitted the
      // character-store projection and produced a contradictory value.
      pre_second_pass: durableStateHash(durableStateBeforeSecondPass),
      post_second_pass_pre_persist: durableStateHash(durableStateAfterSecondPass),
      post_second_pass_persisted: null,
      post_second_pass_reloaded: null,
      final_export_state: durableStateHash(durableStateAfterSecondPass),
      transaction_mode: 'single_staged_precommit_comparison',
    };
    // The bounded stabilization history is authoritative. These compatibility
    // fields therefore describe the final verification pass, not pass one of
    // an earlier two-pass implementation.
    result.idempotence.first_final_semantic_hash = finalVerificationComparison.first_hash;
    result.idempotence.second_final_semantic_hash = finalVerificationComparison.second_hash;
    result.idempotence.semantic_hash_equal = result.idempotence.first_final_semantic_hash === result.idempotence.second_final_semantic_hash;
    result.idempotence.unaccounted_mutations = result.idempotence.durable_state_change_summary?.unaccounted_mutation_count ?? 0;
    result.idempotence.converged = Boolean(convergedOnPass)
      && !result.idempotence.automatic_stabilization_passes.max_passes_reached
      && result.idempotence.semantic_hash_equal
      && result.idempotence.second_pass_logical_mutations === 0
      && result.idempotence.second_pass_physical_mutations === 0
      && result.idempotence.stale_references_after_second_pass === 0
      && result.idempotence.recreated_after_prior_repair === 0
      && result.idempotence.unsafe_merge_candidates_after_second_pass === 0
      && result.idempotence.unresolved_integrity_failures_after_second_pass === 0;
    result.idempotence_check = {
      idempotence_pass_number: 2,
      input_metadata_hash: result.idempotence.diagnostic_metadata_hash_before,
      output_metadata_hash: result.idempotence.diagnostic_metadata_hash_after,
      logical_mutation_count: result.idempotence.second_pass_logical_mutations,
      physical_mutation_count: result.idempotence.second_pass_physical_mutations,
      recreated_link_count: result.idempotence.recreated_after_prior_repair,
      stale_entity_references: result.idempotence.stale_references_after_second_pass,
      stale_reference_summary: staleReferenceSummary,
    };
    result.idempotence.stabilization_summary = result.idempotence.summary;
    if (forceIdempotenceCheck) result.idempotence.developer_summary = result.idempotence.summary;
    result.final_state_consistency = {
      catch_up_semantic_hash: result.idempotence.durable_state_hash_after_second_pass,
      post_stabilization_semantic_hash: result.idempotence.durable_state_hash_after_second_pass,
      developer_check_semantic_hash: developerCheckRequested ? result.idempotence.durable_state_hash_after_second_pass : null,
      restored_panel_semantic_hash: null,
      diagnostics_export_semantic_hash: result.idempotence.durable_state_hash_after_second_pass,
      catch_up_integrity_status: (result.integrity_audit?.stale_entity_references?.length ?? 0) === 0 ? 'clean' : 'needs_attention',
      post_stabilization_integrity_status: (result.integrity_audit?.stale_entity_references?.length ?? 0) === 0 ? 'clean' : 'needs_attention',
      restored_panel_integrity_status: null,
      diagnostics_export_integrity_status: (result.integrity_audit?.stale_entity_references?.length ?? 0) === 0 ? 'clean' : 'needs_attention',
      developer_check_integrity_status: developerCheckRequested ? ((result.integrity_audit?.stale_entity_references?.length ?? 0) === 0 ? 'clean' : 'needs_attention') : null,
      developer_result_current: developerCheckRequested ? result.idempotence.idempotent : null,
      catch_up_stale_reference_count: result.integrity_audit?.stale_entity_references?.length ?? 0,
      developer_stale_reference_count: developerCheckRequested ? result.integrity_audit?.stale_entity_references?.length ?? 0 : null,
      restored_panel_stale_reference_count: null,
      diagnostics_export_stale_reference_count: result.integrity_audit?.stale_entity_references?.length ?? 0,
      interpretation_consistent: true,
      mismatch_fields: [],
    };
    Object.assign(result.final_state_consistency, buildFinalStateConsistency({
      automatic: forceIdempotenceCheck ? null : result.idempotence,
      manual: forceIdempotenceCheck ? result.idempotence : null,
      currentHash: forceIdempotenceCheck ? result.idempotence.durable_state_hash_after_second_pass : null,
    }));
  }
  if (extension_settings[MODULE_NAME]?.verbose_logging) {
    console.debug('[Smart Memory Enhanced] Final reconciliation timing:', {
      duration_ms: result.duration_ms,
      relationship_pairs_merged: result.relationship_pairs_merged ?? 0,
      cross_store_entity_merges: result.cross_store_entity_merges ?? 0,
    });
  }
  return result;
}
import { checkContinuity, generateRepair, injectRepair, clearRepair } from './continuity.js';
import {
  getHardwareProfile,
  getEmbeddingBatch,
  clearEmbeddingFailed,
  saveEmbeddingApiKey,
  hasEmbeddingApiKey,
} from './embeddings.js';
import { clearCanon, generateCanon, injectCanon, saveCanon } from './canon.js';
import { clearSessionEntityRegistry } from './graph-migration.js';
import {
  clearCanonicalRuntimeContextSnapshot,
  setCanonicalRuntimeContextSnapshot,
  snapshotCanonicalRuntimeContext,
} from './canonical-entities.js';
import {
  clearStateLedger,
  injectStateLedger,
  isStateLedgerEnabled,
  runStateCardExtraction,
} from './state-ledger.js';
import { generateProfiles, injectProfiles, clearProfiles, loadProfiles } from './profiles.js';
import { summarizeProfileTerminalCoverage } from './profile-recovery-utils.js';
import { clearUnifiedSlot, injectUnified, maybeInjectUnified } from './unified-inject.js';
import { getTierHWStats, getTierTrimStats, clearTierStats } from './trim-stats.js';
import { showMemoryGraph } from './graph.js';
import {
  setStatusMessage,
  updateLongTermUI,
  updateRelationshipHistoryUI,
  updateEpistemicUI,
  updateSessionUI,
  updateScenesUI,
  updateArcsUI,
  updateShortTermUI,
  updateCanonUI,
  updateProfilesUI,
  updateFreshStartUI,
  updateEntityPanel,
  updateTokenDisplay,
  reconcileCanonicalEntities,
  updateEmbeddingNotice,
  setCatchUpErrorCount,
} from './ui.js';

/**
 * Builds the explicit live-persona input used for a long-running Memorize
 * Chat.  `user_avatar` plus `power_user.personas` is SillyTavern's selected
 * persona registry; serialized/imported chat headers are only fallbacks.
 */
function getLivePersonaCaptureContext(context) {
  const metadataPersonaKey = context?.chatMetadata?.persona ?? context?.chatMetadata?.[META_KEY]?.persona_key ?? null;
  const selectedPersonaKey = String(user_avatar || metadataPersonaKey || context?.personaId || context?.persona_id || '').trim();
  const configuredName = selectedPersonaKey ? power_user?.personas?.[selectedPersonaKey] : null;
  const existing = context?.activePersona ?? context?.persona ?? {};
  const personaName = String(configuredName ?? existing?.name ?? context?.userName ?? context?.name1 ?? '').trim();
  const descriptor = selectedPersonaKey ? power_user?.persona_descriptions?.[selectedPersonaKey] : null;
  return {
    ...context,
    activePersonaKey: selectedPersonaKey || null,
    activePersona: {
      ...existing,
      id: existing?.id ?? selectedPersonaKey ?? null,
      avatar: existing?.avatar ?? selectedPersonaKey ?? null,
      name: personaName,
      aliases: existing?.aliases ?? [],
      previous_names: existing?.previous_names ?? existing?.historical_aliases ?? [],
      description: existing?.description ?? descriptor?.description ?? '',
    },
  };
}

/** Keeps legacy camelCase arc diagnostics as export aliases of snake_case. */
function normalizeArcExtractionDiagnostics(diagnostics) {
  const aliases = {
    completed: 'request_completed', providerError: 'provider_error', returnedNone: 'returned_none',
    malformedOutput: 'malformed_output', parsedCandidates: 'parsed_candidates', acceptedOpenThreads: 'accepted_open_threads',
    rejectedCompletedEvents: 'rejected_completed_events', rejectedBackgroundFacts: 'rejected_background_facts',
    rejectedRelationshipStates: 'rejected_relationship_states', rejectedSceneDetails: 'rejected_scene_details',
    rejectedMalformed: 'rejected_malformed', participantRepairs: 'participant_repairs', participantReviewItems: 'participant_review_items',
    malformedRequest: 'malformed_request', inputTokenBudget: 'input_token_budget', inputTokenEstimate: 'input_token_estimate',
    inputMessages: 'input_messages', omittedMessages: 'omitted_messages', truncatedMessage: 'truncated_message', terminalOutcome: 'terminal_outcome',
  };
  for (const [camel, snake] of Object.entries(aliases)) {
    // terminal_outcome is the single canonical *string* outcome.  Treating
    // it like a numeric counter turned values such as
    // "completed_with_candidates" into 0 during export.
    if (snake === 'terminal_outcome') {
      const value = diagnostics?.[snake] ?? diagnostics?.[camel] ?? null;
      diagnostics[snake] = value;
      diagnostics[camel] = value;
      continue;
    }
    const value = Math.max(Number(diagnostics?.[snake] ?? 0), Number(diagnostics?.[camel] ?? 0));
    diagnostics[snake] = value;
    diagnostics[camel] = value;
  }
  return diagnostics;
}

/** One canonical scoped identity-observation key for terminal accounting. */
export function makeTerminalObservationKey(sourceStore, sourceRecordId) {
  const store = String(sourceStore ?? 'unknown').trim().replace(/\s+/g, ' ').toLowerCase();
  const record = String(sourceRecordId ?? '').trim();
  return record ? `${store}::${record}` : null;
}

// ---- Default settings ---------------------------------------------------

export const defaultSettings = {
  enabled: true,
  settings_mode: 'simple',
  extraction_frequency: 'medium',

  // LLM source for all memory operations (extraction, summarization, recap)
  source: memory_sources.main,

  // Ollama direct source settings
  ollama_url: 'http://localhost:11434',
  ollama_model: '',

  // OpenAI Compatible source settings
  openai_compat_url: '',
  openai_compat_key: '',
  openai_compat_model: '',

  // ST connection profile source: ID of the saved profile to use for extraction
  connection_profile_id: null,
  connection_profile_context_sizes: {},

  // Maximum tokens the Memory LLM may generate per extraction call.
  // 8192 covers any thinking model comfortably. -1 means unlimited (Ollama only).
  generation_budget: 8192,

  // Provider requests are serialized by default and transient failures retry.
  provider_max_concurrency: 1,
  provider_request_delay_ms: 2000,
  provider_max_retries: 5,

  // Minimum number of AI messages between long-term and session injection refreshes.
  // 1 = refresh on every extraction pass (default / current behaviour).
  // Higher values keep the injected block stable for longer, preserving prompt cache
  // hits on cloud APIs. Chat history covers the gap for recent events.
  injection_refresh_period: 1,

  // OpenAI Compatible embedding API key
  embedding_api_key: '',

  // Short-term (compaction)
  compaction_enabled: true,
  compaction_threshold: 80,
  compaction_keep_recent: 10,
  compaction_response_length: 2000,
  compaction_position: extension_prompt_types.IN_PROMPT,
  compaction_depth: 0,
  compaction_role: extension_prompt_roles.SYSTEM,
  compaction_template: 'Story so far:\n{{summary}}',

  // Consolidation (shared across tiers)
  consolidation_enabled: true,
  longterm_consolidation_threshold_fact: 4,
  longterm_consolidation_threshold_relationship: 3,
  longterm_consolidation_threshold_preference: 3,
  longterm_consolidation_threshold_event: 4,
  session_consolidation_threshold_scene: 3,
  session_consolidation_threshold_revelation: 3,
  session_consolidation_threshold_development: 3,
  session_consolidation_threshold_detail: 3,

  // Long-term
  longterm_enabled: true,
  longterm_extract_every: 3,
  longterm_max_memories: 25,
  longterm_response_length: 600,
  longterm_inject_budget: 500,
  longterm_position: extension_prompt_types.IN_PROMPT,
  longterm_depth: 2,
  longterm_role: extension_prompt_roles.SYSTEM,
  longterm_triggered_depth: 4,
  longterm_triggers_enabled: false,
  longterm_template: 'Memories from previous conversations:\n{{memories}}',

  // Relationship history
  relationships_enabled: true,
  relationships_inject_budget: 250,
  relationships_position: extension_prompt_types.IN_CHAT,
  relationships_depth: 5,
  relationships_role: extension_prompt_roles.SYSTEM,
  relationships_template: 'Relationship history:\n{{relationships}}',

  // Identity review decisions. Approved aliases are intentionally separate
  // from model-discovered aliases; the review queue retains unresolved items.
  identity_review_queue: [],
  identity_aliases: {},

  // Session memory
  session_enabled: true,
  session_extract_every: 3,
  session_max_memories: 30,
  session_response_length: 500,
  session_inject_budget: 400,
  session_position: extension_prompt_types.IN_CHAT,
  session_depth: 3,
  session_role: extension_prompt_roles.SYSTEM,
  session_template: 'Details from this session:\n{{session}}',

  // Scene detection
  scene_enabled: true,
  scene_ai_detect: false,
  // scene_max_history is retained only as a migration source for older data.
  scene_max_history: 5,
  scene_archive_max: 100,
  scene_inject_count: 5,
  scene_min_messages: 3,
  scene_summary_length: 200,
  scene_inject_budget: 300,
  scene_position: extension_prompt_types.IN_CHAT,
  scene_depth: 6,
  scene_role: extension_prompt_roles.SYSTEM,

  // Story arcs
  arcs_enabled: true,
  arcs_max: 10,
  arcs_response_length: 400,
  arcs_inject_budget: 700,
  arcs_position: extension_prompt_types.IN_CHAT,
  arcs_depth: 2,
  arcs_role: extension_prompt_roles.SYSTEM,
  arc_summary_response_length: 300,
  canon_response_length: 600,
  canon_enabled: true,
  canon_inject_budget: 800,
  canon_position: extension_prompt_types.IN_PROMPT,
  canon_depth: 0,
  canon_role: extension_prompt_roles.SYSTEM,
  canon_template: 'Character history:\n{{canon}}',

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,

  // Continuity
  continuity_response_length: 300,
  continuity_auto_check: true,
  continuity_auto_repair: false,

  // Semantic embedding deduplication
  embedding_enabled: true,
  embedding_source: 'ollama',
  embedding_url: '',
  embedding_model: 'nomic-embed-text',
  embedding_keep: false,

  // Character/world profiles
  profiles_enabled: true,
  profiles_stale_threshold_minutes: 30,
  // 0 = regenerate only on extraction passes; positive = also regenerate every N
  // messages even if extraction did not run (Profile B only - too expensive on local).
  profiles_regen_every: 0,
  profiles_response_length: 600,
  profiles_inject_budget: 400,
  profiles_position: extension_prompt_types.IN_PROMPT,
  profiles_depth: 1,
  profiles_role: extension_prompt_roles.SYSTEM,
  profiles_template: '{{profiles}}',

  // Perspectives & Secrets (epistemic tracking)
  epistemic_enabled: true,
  epistemic_inject_unaware: true,
  epistemic_secondhand_framing: true,
  epistemic_response_length: 400,
  epistemic_max_per_subject_per_scene: 5,
  epistemic_inject_budget: 200,
  epistemic_depth: 1,
  epistemic_position: extension_prompt_types.IN_CHAT,
  epistemic_role: extension_prompt_roles.SYSTEM,

  // State Ledger (structured entity state cards)
  state_ledger_enabled: false,
  state_ledger_requires_grounding: true,
  state_ledger_inject_budget: 200,
  state_ledger_depth: 1,
  state_ledger_position: extension_prompt_types.IN_CHAT,
  state_ledger_role: extension_prompt_roles.SYSTEM,

  // Hardware profile - 'auto' | 'a' | 'b'
  // 'auto': detect from memory source (ollama/webllm -> A, main/openai_compat -> B)
  // 'a': force Profile A (local/low-VRAM behaviour)
  // 'b': force Profile B (hosted/high-performance behaviour)
  hardware_profile: 'auto',

  // Automatically reallocate the per-tier token budget after each extraction pass,
  // based on actual observed demand. Tiers with unused headroom give it to tiers
  // that are trimming content. The configured total budget is treated as a hard cap.
  // Off by default so manually tuned advanced budgets are not overwritten.
  auto_tune_budgets: false,

  // Show a non-blocking activity indicator while background extraction is running.
  // Gives users a visible signal that Smart Memory Enhanced is working so they know not
  // to send a new message until it finishes.
  show_activity_indicator: true,

  // Verbose logging - when false, operational extraction/migration logs are
  // suppressed. Errors (console.error) are always shown regardless of this flag.
  verbose_logging: false,
  // Developer-only tolerance used when comparing bounded scene-boundary
  // diagnostics from otherwise matching runs. It never changes scene output.
  scene_comparison_tolerance: 2,

  // Experimental: merge all tier content into a single IN_PROMPT block instead
  // of injecting each tier into its own named slot at different depths/positions.
  unified_injection: false,
  unified_position: 2, // extension_prompt_types.IN_PROMPT (Before Main Prompt)
  unified_depth: 0,
  unified_role: 0, // extension_prompt_roles.SYSTEM

  // Force macro injection mode for all tiers regardless of character card content.
  // Use this when macros are placed in instruct templates (which cannot be auto-detected
  // from character card fields). Auto-detection handles the common case of macros placed
  // in the system prompt or other card fields without needing this toggle.
  macros_enabled: false,

  // Prompt Studio global overrides and preset storage. Character and chat
  // overrides live with their respective character/chat data.
  prompt_overrides: { global: {}, presets: {} },

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

// ---- Settings mode helpers -----------------------------------------------

// Extraction frequency presets for the simple-mode dropdown.
const EXTRACTION_FREQUENCY_MAP = { low: 5, medium: 3, high: 1 };

// Fixed proportions for the simplified total-budget slider. Each value is a
// fraction of the total that gets allocated to that tier. Must sum to 1.0.
const BUDGET_RATIOS = {
  longterm: 0.16,
  session: 0.13,
  scenes: 0.1,
  arcs: 0.13,
  canon: 0.18,
  profiles: 0.13,
  relationships: 0.08,
  epistemic: 0.06,
  state_ledger: 0.06,
};

/**
 * Returns the sum of all per-tier inject budgets from current settings.
 * Used to initialise the simplified slider from existing advanced values.
 * @param {Object} s - Settings object.
 * @returns {number}
 */
function totalBudgetFromSettings(s) {
  return (
    (s.longterm_inject_budget ?? 500) +
    (s.session_inject_budget ?? 400) +
    (s.scene_inject_budget ?? 300) +
    (s.arcs_inject_budget ?? 700) +
    (s.canon_inject_budget ?? 800) +
    (s.profiles_inject_budget ?? 400) +
    (s.relationships_inject_budget ?? 250) +
    (s.epistemic_inject_budget ?? 200) +
    (s.state_ledger_inject_budget ?? 200)
  );
}

/**
 * Distributes a total token budget across tiers using BUDGET_RATIOS and
 * writes the results directly into the settings object. Rounds to nearest 50
 * to match the step granularity of the individual sliders.
 * @param {number} total
 * @param {Object} s - Settings object (mutated in place).
 */
function applyTotalBudget(total, s) {
  const snap = (v) => Math.max(50, Math.round(v / 50) * 50);
  s.longterm_inject_budget = snap(total * BUDGET_RATIOS.longterm);
  s.session_inject_budget = snap(total * BUDGET_RATIOS.session);
  s.scene_inject_budget = snap(total * BUDGET_RATIOS.scenes);
  s.arcs_inject_budget = snap(total * BUDGET_RATIOS.arcs);
  s.canon_inject_budget = snap(total * BUDGET_RATIOS.canon);
  s.profiles_inject_budget = snap(total * BUDGET_RATIOS.profiles);
  s.relationships_inject_budget = snap(total * BUDGET_RATIOS.relationships);
  s.epistemic_inject_budget = snap(total * BUDGET_RATIOS.epistemic);
  s.state_ledger_inject_budget = snap(total * BUDGET_RATIOS.state_ledger);
}

/**
 * Re-injects all memory tiers using the current budget settings and refreshes
 * the token bar. Called after any budget slider change so the trim indicators
 * clear immediately without waiting for the next message.
 *
 * Awaits the two async inject calls (injectMemories, injectSessionMemories) so
 * that updateTokenDisplay sees fully populated trim stats rather than the stale
 * values from the previous injection cycle.
 *
 * @param {string|null} characterName - Active character (or group selection).
 */
async function reinjectAfterBudgetChange(characterName) {
  loadAndInjectSummary();
  await injectMemories(characterName);
  injectRelationshipHistory(characterName);
  await injectSessionMemories();
  injectSceneHistory();
  injectArcs();
  injectCanon(characterName);
  injectProfiles(characterName);
  injectEpistemicKnowledge(characterName, characterName);
  injectStateLedger();
  maybeInjectUnified();
  updateTokenDisplay();
}

// Minimum budget any tier will be reduced to during auto-tune, and the headroom
// multiplier applied above actual demand so the next message doesn't immediately
// hit the limit again.
const AUTO_TUNE_FLOOR = 50;
const AUTO_TUNE_HEADROOM = 1.15;

// Maps each tunable tier to its settings key and DOM element IDs.
// Short-term is excluded - it self-corrects via regeneration rather than budget tuning.
const TUNABLE_TIERS = [
  {
    promptKey: PROMPT_KEY_LONG,
    setting: 'longterm_inject_budget',
    defaultBudget: 500,
    slider: 'sme_longterm_inject_budget',
    display: 'sme_longterm_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_SESSION,
    setting: 'session_inject_budget',
    defaultBudget: 400,
    slider: 'sme_session_inject_budget',
    display: 'sme_session_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_CANON,
    setting: 'canon_inject_budget',
    defaultBudget: 800,
    slider: 'sme_canon_inject_budget',
    display: 'sme_canon_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_SCENES,
    setting: 'scene_inject_budget',
    defaultBudget: 300,
    slider: 'sme_scene_inject_budget',
    display: 'sme_scene_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_ARCS,
    setting: 'arcs_inject_budget',
    defaultBudget: 700,
    slider: 'sme_arcs_inject_budget',
    display: 'sme_arcs_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_PROFILES,
    setting: 'profiles_inject_budget',
    defaultBudget: 400,
    slider: 'sme_profiles_inject_budget',
    display: 'sme_profiles_inject_budget_value',
    fmt: (v) => `${v} tokens`,
  },
  {
    promptKey: PROMPT_KEY_RELATIONSHIPS,
    setting: 'relationships_inject_budget',
    defaultBudget: 250,
    slider: 'sme_relationships_inject_budget',
    display: 'sme_relationships_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_EPISTEMIC,
    setting: 'epistemic_inject_budget',
    defaultBudget: 200,
    slider: 'sme_epistemic_inject_budget',
    display: 'sme_epistemic_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_STATE_LEDGER,
    setting: 'state_ledger_inject_budget',
    defaultBudget: 200,
    slider: 'sme_state_ledger_inject_budget',
    display: 'sme_state_ledger_inject_budget_value',
    fmt: (v) => String(v),
  },
];

/**
 * Sets each currently used injection tier to its visible current usage plus
 * modest headroom. This is intentionally a one-shot manual action: unlike
 * auto-tune it does not consult high-water marks or redistribute a total cap.
 *
 * @param {string|null} characterName - Active character (or group selection).
 */
function allocateBudgetsFromCurrentUsage(characterName) {
  const settings = extension_settings[MODULE_NAME];
  const roundToFifty = (value) => Math.ceil(value / 50) * 50;
  let updatedTiers = 0;

  for (const tier of TUNABLE_TIERS) {
    // The token mix bar represents injected content, which is the amount the
    // user asked to size from. Keep an unused tier's deliberate setting intact.
    const injected = getTierTrimStats(tier.promptKey)?.injected ?? 0;
    if (!injected) continue;
    const budget = Math.min(4000, Math.max(100, roundToFifty(injected * 1.1)));
    if (settings[tier.setting] === budget) continue;
    settings[tier.setting] = budget;
    $(`#${tier.slider}`).val(budget);
    $(`#${tier.display}`).text(tier.fmt(budget));
    updatedTiers++;
  }

  // Short-term is not one of the tunable memory tiers because it normally
  // self-compacts, but its visible injected summary belongs in this explicit
  // user-requested allocation action.
  const shortTermInjected = getTierTrimStats(PROMPT_KEY_SHORT)?.injected ?? 0;
  if (shortTermInjected) {
    const budget = Math.min(3000, Math.max(500, roundToFifty(shortTermInjected * 1.1)));
    if (settings.compaction_response_length !== budget) {
      settings.compaction_response_length = budget;
      $('#sme_compaction_response_length').val(budget);
      $('#sme_compaction_response_length_value').text(budget);
      updatedTiers++;
    }
  }

  if (!updatedTiers) {
    toastr.info('No currently injected memory tiers needed a budget update.', 'Smart Memory Enhanced');
    return;
  }

  // Keep the simple-mode slider truthful if the user switches modes later.
  const total = totalBudgetFromSettings(settings);
  $('#sme_total_budget').val(total);
  $('#sme_total_budget_value').text(total);
  saveSettingsDebounced();
  reinjectAfterBudgetChange(characterName);
  toastr.success(`Allocated ${updatedTiers} budget${updatedTiers === 1 ? '' : 's'} from current usage + 10%.`, 'Smart Memory Enhanced');
}

/**
 * Redistributes the per-tier token budget based on observed demand.
 * Tiers reporting unused headroom give it to tiers that are trimming.
 * The sum of all tier budgets never exceeds the current configured total.
 *
 * Only runs when `auto_tune_budgets` is enabled. Safe to call after every
 * extraction pass - does nothing if no trim stats have been recorded yet
 * or if no tier's demand has changed enough to warrant an update.
 *
 * @param {string|null} characterName - Active character (or group selection).
 */
export function autoTuneBudgets(characterName) {
  const s = extension_settings[MODULE_NAME];
  if (!s.auto_tune_budgets) return;

  const snap = (v, floor) => Math.max(floor ?? AUTO_TUNE_FLOOR, Math.round(v / 50) * 50);

  // Compute target budget for each tier from its actual demand.
  // Uses the high water mark so group chat budgets are sized for the greediest
  // character seen this session, not just whichever character injected last.
  // Tiers with no recorded stats (disabled or never injected) keep their
  // current budget so they are not silently shrunk.
  // The per-tier defaultBudget acts as a hard floor: auto-tune can grow a tier
  // above its default when demand is high, but never shrinks it below, so
  // characters with light content do not end up with sub-default budgets.
  const targets = TUNABLE_TIERS.map((tier) => {
    const stats = getTierHWStats(tier.promptKey);
    if (!stats || stats.full === 0) {
      return { tier, budget: s[tier.setting] };
    }
    return { tier, budget: snap(stats.full * AUTO_TUNE_HEADROOM, tier.defaultBudget) };
  });

  // In simple mode the user has set an explicit total budget cap; honour it by
  // scaling targets down if they exceed it. In advanced mode each tier slider
  // is independent and there is no user-set total, so auto-tune sets each tier
  // to exactly what it needs without a cap constraint.
  if ((s.settings_mode ?? 'simple') === 'simple') {
    const totalCap = totalBudgetFromSettings(s);
    const totalTarget = targets.reduce((sum, t) => sum + t.budget, 0);
    if (totalTarget > totalCap) {
      const scale = totalCap / totalTarget;
      for (const t of targets) {
        t.budget = Math.max(snap(t.tier.defaultBudget ?? AUTO_TUNE_FLOOR), snap(t.budget * scale));
      }
    }
  }

  // Apply any changes and update DOM sliders.
  let changed = false;
  for (const { tier, budget } of targets) {
    if (s[tier.setting] !== budget) {
      s[tier.setting] = budget;
      $(`#${tier.slider}`).val(budget);
      $(`#${tier.display}`).text(tier.fmt(budget));
      // Invalidate stale trim stats for this tier. reinjectAfterBudgetChange fires
      // async inject calls (injectMemories, injectSessionMemories) without awaiting
      // them, so updateTokenDisplay may run before those Promises resolve and see
      // the load-pass trim data rather than the fresh post-tune data. Clearing here
      // ensures the token bar shows no trim until the next real injection reports.
      clearTierStats(tier.promptKey);
      changed = true;
    }
  }

  if (changed) {
    saveSettingsDebounced();
    reinjectAfterBudgetChange(characterName);
  }
}

/**
 * Shows or hides advanced-only controls based on the current settings mode.
 * Also syncs the simplified budget slider value from the current per-tier totals.
 * @param {'simple'|'advanced'} mode
 */
function applySettingsMode(mode) {
  const isSimple = mode === 'simple';
  $('.sm-advanced-only').toggle(!isSimple);
  $('.sm-simple-only').toggle(isSimple);
  if (isSimple) {
    const total = totalBudgetFromSettings(extension_settings[MODULE_NAME]);
    $('#sme_total_budget').val(total);
    $('#sme_total_budget_value').text(total);
  }
}

// ---- Settings loading and migration -------------------------------------

/**
 * Merges defaultSettings into extension_settings for any missing keys.
 * Preserves existing values so user configuration is not overwritten on update.
 */
export function loadSettings() {
  if (!extension_settings[MODULE_NAME]) {
    // Enhanced always starts from its own settings namespace. It neither
    // requires nor imports configuration from the original Smart Memory.
    extension_settings[MODULE_NAME] = {};
  }
  const hadSceneInjectCount = Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'scene_inject_count');
  const hadSceneArchiveMax = Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'scene_archive_max');
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (extension_settings[MODULE_NAME][key] === undefined) {
      extension_settings[MODULE_NAME][key] = value;
    }
  }

  // Scene history used to use one setting as both a storage cap and injection
  // limit. Preserve the old value as the visible injection count while giving
  // the archive a safer independent capacity.
  if (!hadSceneInjectCount) {
    extension_settings[MODULE_NAME].scene_inject_count = extension_settings[MODULE_NAME].scene_max_history ?? 5;
  }
  if (!hadSceneArchiveMax) {
    extension_settings[MODULE_NAME].scene_archive_max = 100;
  }

  // Migration: replace old bracket-wrapped template defaults with plain-text equivalents.
  // Only affects users who never customized these fields (exact match on the old default).
  // Bracket notation in injections bleeds into RP output - the model mimics it.
  const TEMPLATE_MIGRATIONS = {
    compaction_template: {
      from: '[Story so far:\n{{summary}}]',
      to: 'Story so far:\n{{summary}}',
    },
    longterm_template: {
      from: '[Memories from previous conversations:\n{{memories}}]',
      to: 'Memories from previous conversations:\n{{memories}}',
    },
    session_template: {
      from: '[Details from this session:\n{{session}}]',
      to: 'Details from this session:\n{{session}}',
    },
  };
  for (const [key, migration] of Object.entries(TEMPLATE_MIGRATIONS)) {
    if (extension_settings[MODULE_NAME][key] === migration.from) {
      extension_settings[MODULE_NAME][key] = migration.to;
    }
  }

  // Migration: raise compaction response length from 1500 to 2000.
  // 1500 tokens was too tight for a 9-section summary, causing truncated output.
  if (extension_settings[MODULE_NAME].compaction_response_length === 1500) {
    extension_settings[MODULE_NAME].compaction_response_length = 2000;
  }

  // Migration: raise arc injection budget to 700.
  // 400 was too tight once the adaptive budget applies a 0.8x multiplier during intimate
  // scenes, dropping the oldest arc from injection. 200 is the pre-1.3.0 default.
  if (
    extension_settings[MODULE_NAME].arcs_inject_budget === 200 ||
    extension_settings[MODULE_NAME].arcs_inject_budget === 400
  ) {
    extension_settings[MODULE_NAME].arcs_inject_budget = 700;
  }

  // Migration: longterm_consolidate -> consolidation_enabled (now controls both tiers).
  // If a user had explicitly disabled long-term consolidation, carry that intent forward.
  if (
    Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'longterm_consolidate') &&
    !Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'consolidation_enabled')
  ) {
    extension_settings[MODULE_NAME].consolidation_enabled =
      extension_settings[MODULE_NAME].longterm_consolidate;
  }
}

// ---- Settings UI binding ------------------------------------------------

/**
 * Shows a toastr error notification for a failed Smart Memory Enhanced operation.
 * Used by all manual button handlers so failures are visible to the user.
 * @param {string} operation - Short label for what failed (e.g. "Summary generation").
 * @param {Error} err - The caught error.
 */
function showError(operation, err) {
  console.error(`[Smart Memory Enhanced] ${operation} failed:`, err);
  toastr.error(`${operation} failed. Check the browser console for details.`, 'Smart Memory Enhanced', {
    timeOut: 6000,
    positionClass: 'toast-bottom-right',
  });
}

/**
 * Binds all settings panel controls to their corresponding settings values.
 * Each control reads from extension_settings[MODULE_NAME] on mount and writes
 * back on change, calling saveSettingsDebounced() to persist.
 *
 * @param {Object} ctrl - Getter/setter proxy for index.js module-level state:
 *   extractionRunning, compactionRunning, consolidationRunning, catchUpCancelled,
 *   sceneMessageBuffer, sceneBufferLastIndex, selectedGroupCharacter.
 *   Also carries callbacks: clearAllInjections, onChatChanged,
 *   getSelectedCharacterName, getStableExtractionWindowWithFallback.
 */
export function bindSettingsUI(ctrl) {
  const s = extension_settings[MODULE_NAME];
  const autoResumeAttemptedRunIds = new Set();

  const getResumableCatchUpCheckpoint = (context = getContext()) => {
    const checkpoint = context?.chatMetadata?.[META_KEY]?.catch_up_checkpoint;
    return normalizeCatchUpCheckpoint(checkpoint);
  };

  const refreshCatchUpRecoveryUI = ({ autoResume = false } = {}) => {
    const checkpoint = getResumableCatchUpCheckpoint();
    const $resume = $('#sme_resume_catch_up');
    const $status = $('#sme_catch_up_recovery_status');
    if (!checkpoint) {
      $resume.prop('disabled', true);
      $status.hide().empty();
      return;
    }
    const committed = Math.min(Number(checkpoint.next_source_offset) || 0, Number(checkpoint.source_message_count) || 0);
    const total = Number(checkpoint.source_message_count) || 0;
    const running = Boolean(ctrl.extractionRunning || ctrl.compactionRunning);
    $resume.prop('disabled', running);
    $status.text(running
      ? `Crash recovery checkpoint: ${committed}/${total} source messages safely committed.`
      : `Incomplete Memorize Chat run available: ${committed}/${total} source messages safely committed. Resuming continues from that point.`).show();
    if (autoResume && checkpoint.status === 'in_progress' && !autoResumeAttemptedRunIds.has(checkpoint.run_id) && !ctrl.extractionRunning && !ctrl.compactionRunning) {
      autoResumeAttemptedRunIds.add(checkpoint.run_id);
      window.setTimeout(() => {
        if (!getResumableCatchUpCheckpoint() || ctrl.extractionRunning || ctrl.compactionRunning) return;
        $('#sme_catch_up').data('smeResumeRequested', true).trigger('click');
      }, 400);
    }
  };

  // Chat loading completes after this UI is initially bound. A restarted
  // SillyTavern emits this event once metadata is available, letting the same
  // persisted checkpoint drive both the resume button and auto-resume path.
  $(document).on('sme:chat-changed.sme-catchup-recovery', () => refreshCatchUpRecoveryUI({ autoResume: true }));
  refreshCatchUpRecoveryUI();

  /**
   * Returns true and shows a warning toast if a catch-up or compaction is
   * currently running. Use this to block manual extract/clear buttons that
   * would conflict with an in-progress background job.
   * @returns {boolean}
   */
  function isCatchUpRunning() {
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
      toastr.warning(
        'Cannot do this while Memorize Chat is running. Cancel it first.',
        'Smart Memory Enhanced',
        {
          timeOut: 4000,
          positionClass: 'toast-bottom-right',
        },
      );
      return true;
    }
    return false;
  }

  const clearChatLocalCharacterData = (context, characterName = null) => {
    const keys = [
      'card_local_memories',
      'card_local_relationships',
      'card_local_epistemic',
      'card_local_entities',
      'card_local_canon',
    ];
    for (const metadataKey of [META_KEY, MODULE_NAME]) {
      const metadata = context.chatMetadata?.[metadataKey];
      if (!metadata) continue;
      for (const key of keys) {
        if (!metadata[key]) continue;
        if (characterName) delete metadata[key][characterName];
        else delete metadata[key];
      }
    }
  };

  // Identity review records are shared extension settings, so Fresh Start
  // must not wipe unrelated chats' reviews. Capture only record IDs belonging
  // to this chat/current group before clearing its stores, then remove review
  // items that explicitly cite one of those records.
  const collectFreshStartRecordIds = (value, ids = new Set()) => {
    if (Array.isArray(value)) {
      for (const item of value) collectFreshStartRecordIds(item, ids);
    } else if (value && typeof value === 'object') {
      if (typeof value.id === 'string' && value.id) ids.add(value.id);
      for (const item of Object.values(value)) collectFreshStartRecordIds(item, ids);
    }
    return ids;
  };
  const clearFreshStartRunMetadata = (context, characterNames = []) => {
    const metadata = context.chatMetadata?.[META_KEY];
    if (!metadata) return { identity_reviews_removed: 0, current_chat_identity_reviews_remaining: 0 };
    const recordIds = collectFreshStartRecordIds(metadata);
    for (const name of characterNames) collectFreshStartRecordIds(extension_settings[MODULE_NAME]?.characters?.[name], recordIds);
    const reviewQueue = extension_settings[MODULE_NAME]?.identity_review_queue ?? [];
    const remainingReviewQueue = reviewQueue.filter((item) => {
      const cited = [...(item?.source_record_ids ?? []), ...(item?.memoryIds ?? [])].filter(Boolean);
      return !cited.some((id) => recordIds.has(String(id)));
    });
    extension_settings[MODULE_NAME].identity_review_queue = remainingReviewQueue;
    const currentChatIdentityReviewsRemaining = remainingReviewQueue.filter((item) => {
      const cited = [...(item?.source_record_ids ?? []), ...(item?.memoryIds ?? [])].filter(Boolean);
      return cited.some((id) => recordIds.has(String(id)));
    }).length;
    // These are derived from an earlier state of this chat. Keeping them after
    // a destructive reset can reintroduce obsolete redirects or make the next
    // fresh generation look degraded before it has produced any data.
    for (const key of [
      'entity_redirects', 'catch_up_diagnostics', 'last_catchup_run_id',
      'scene_stability_history', 'request_efficiency_history', 'repair_history',
      'repair_volume_changed', 'repair_volume_delta', 'repair_volume_change_reason',
      'developer_idempotence_check', 'historical_persona_snapshot', 'canonical_persona_context',
      'active_catchup_run_id', 'catch_up_checkpoint', 'parser_debris_cleanup',
      'fresh_start_postcondition_audit',
    ]) delete metadata[key];
    return {
      identity_reviews_removed: reviewQueue.length - remainingReviewQueue.length,
      current_chat_identity_reviews_remaining: currentChatIdentityReviewsRemaining,
    };
  };

  /**
   * Runs extraction on messages generated during the read-only window, then
   * lifts the gate without purging or ghosting anything. Called when the user
   * chooses to commit a read-only session rather than discard it.
   *
   * Session memories are already present (extraction was gated, not deleted).
   * This function fills in the missing tiers: long-term, arcs, and profiles.
   *
   * @param {number} startIndex - Chat index where the read-only window began.
   * @returns {Promise<void>}
   */
  async function commitReadOnlyWindow(startIndex) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    const windowMessages = (context.chat ?? [])
      .slice(startIndex)
      .filter((m) => m.mes && !m.is_system);

    if (windowMessages.length === 0) return;

    const characterName = ctrl.getSelectedCharacterName();
    const characterNames = (() => {
      if (!context.groupId) return characterName ? [characterName] : [];
      const group = context.groups?.find((g) => g.id === context.groupId);
      if (!group) return characterName ? [characterName] : [];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => context.characters.find((c) => c.avatar === avatar)?.name)
        .filter(Boolean);
    })();

    setStatusMessage('Committing read-only session...');

    for (const name of characterNames) {
      if (settings.longterm_enabled) {
        const nameWindow = context.groupId
          ? windowMessages.filter((m) => m.is_user || m.name === name)
          : windowMessages;
        if (nameWindow.length > 0) {
          await extractAndStoreMemories(name, nameWindow).catch((err) =>
            console.error('[Smart Memory Enhanced] Commit long-term extraction error:', err),
          );
          if (settings.consolidation_enabled) {
            await consolidateMemories(name).catch((err) =>
              console.error('[Smart Memory Enhanced] Commit consolidation error:', err),
            );
          }
        }
      }
      if (settings.profiles_enabled && name) {
        await generateProfiles(name)
          .then((profiles) => {
            if (profiles) {
              injectProfiles(name);
              updateProfilesUI(profiles);
            }
          })
          .catch((err) => console.error('[Smart Memory Enhanced] Commit profile generation error:', err));
      }
    }

    if (settings.arcs_enabled) {
      await extractArcs(windowMessages).catch((err) =>
        console.error('[Smart Memory Enhanced] Commit arc extraction error:', err),
      );
    }

    saveSettingsDebounced();
    setStatusMessage('Session committed.');
  }

  // Prevent section-header enable checkboxes from toggling the <details> open/closed
  // when clicked. Without this, clicking the checkbox both changes the setting and
  // collapses the section, which is never what the user intends.
  $(document).on('click', '.sm-section-toggle', (e) => e.stopPropagation());

  // ---- Master toggle --------------------------------------------------
  $('#sme_enabled')
    .prop('checked', s.enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].enabled) {
        // Remove all injections immediately so nothing lingers in the prompt.
        ctrl.clearAllInjections();
      } else {
        // Restore injections from stored data so the user picks up where they left off.
        ctrl.onChatChanged();
      }
    });

  // ---- Settings mode toggle -------------------------------------------
  $('#sme_settings_mode_advanced')
    .prop('checked', s.settings_mode === 'advanced')
    .on('change', function () {
      const mode = $(this).prop('checked') ? 'advanced' : 'simple';
      extension_settings[MODULE_NAME].settings_mode = mode;
      saveSettingsDebounced();
      applySettingsMode(mode);
      applyInjectionOverrideUI();
    });

  // ---- Simplified total budget slider ---------------------------------
  $('#sme_total_budget')
    .val(totalBudgetFromSettings(s))
    .on('input', function () {
      const total = parseInt($(this).val(), 10);
      $('#sme_total_budget_value').text(total);
      applyTotalBudget(total, extension_settings[MODULE_NAME]);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_reset_budgets').on('click', function () {
    const cur = extension_settings[MODULE_NAME];
    const budgetKeys = [
      'compaction_response_length',
      'longterm_inject_budget',
      'session_inject_budget',
      'scene_inject_budget',
      'arcs_inject_budget',
      'canon_inject_budget',
      'profiles_inject_budget',
      'relationships_inject_budget',
      'epistemic_inject_budget',
      'state_ledger_inject_budget',
    ];
    for (const key of budgetKeys) {
      cur[key] = defaultSettings[key];
    }
    // Sync all slider DOM elements to the restored values.
    for (const { setting, slider, display, fmt } of TUNABLE_TIERS) {
      $(`#${slider}`).val(cur[setting]);
      $(`#${display}`).text(fmt(cur[setting]));
    }
    $('#sme_compaction_response_length').val(cur.compaction_response_length);
    $('#sme_compaction_response_length_value').text(cur.compaction_response_length);
    // Sync the simple-mode total slider.
    const total = totalBudgetFromSettings(cur);
    $('#sme_total_budget').val(total);
    $('#sme_total_budget_value').text(total);
    saveSettingsDebounced();
    reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
  });

  $('#sme_allocate_budgets_from_usage').on('click', function () {
    allocateBudgetsFromCurrentUsage(ctrl.getSelectedCharacterName());
  });

  // Apply initial mode on load.
  applySettingsMode(s.settings_mode ?? 'simple');

  // ---- Group chat character selector ----------------------------------
  $('#sme_group_char_select').on('change', async function () {
    const selection = $(this).val() || null;
    ctrl.selectedGroupCharacter = selection;
    updateLongTermUI(ctrl.selectedGroupCharacter);
    updateRelationshipHistoryUI(ctrl.selectedGroupCharacter);
    updateEpistemicUI(ctrl.selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(ctrl.selectedGroupCharacter);
    updateProfilesUI(loadProfiles(ctrl.selectedGroupCharacter));
    // Re-inject the character-specific slots so updateTokenDisplay reads
    // the selected character's content rather than whoever responded last.
    // onGroupMemberDrafted will overwrite these again before the next Generate().
    await injectMemories(selection);
    if (ctrl.selectedGroupCharacter !== selection) return;
    await injectSessionMemories();
    injectCanon(selection);
    injectProfiles(selection);
    maybeInjectUnified();
    updateTokenDisplay();
    autoTuneBudgets(selection);
    refreshPromptStudio();
  });

  // ---- Prompt Studio ----------------------------------------------------
  const promptTaskValues = Object.values(PROMPT_TASKS);
  const $promptTask = $('#sme_prompt_task');
  for (const task of promptTaskValues) {
    $promptTask.append($('<option>', { value: task, text: PROMPT_TASK_LABELS[task] }));
  }

  function promptStudioCharacter() {
    return ctrl.getSelectedCharacterName();
  }

  let activePromptPresetId = 'builtin:default';
  let promptPresetDraft = {};

  function activePromptPreset() { return getPromptProfile(activePromptPresetId); }

  function fillProfileSelect(selector, assignment, { inherit = false, disabled = false } = {}) {
    const $select = $(selector).empty();
    if (inherit) $select.append($('<option>', { value: '', text: 'Inherit' }));
    const profiles = listPromptProfiles();
    for (const profile of [...profiles.builtIn, ...profiles.custom]) {
      $select.append($('<option>', { value: profile.id, text: profile.label }));
    }
    $select.val(assignment || '');
    $select.prop('disabled', disabled);
  }

  function refreshAssignments() {
    const characterName = promptStudioCharacter();
    fillProfileSelect('#sme_prompt_global_profile', getPromptProfileAssignment('global'));
    fillProfileSelect('#sme_prompt_chat_profile', getPromptProfileAssignment('chat', characterName), { inherit: true });
    fillProfileSelect('#sme_prompt_character_profile', getPromptProfileAssignment('character', characterName), { inherit: true, disabled: !characterName });
    $('#sme_prompt_character_profile_label').text(characterName ? `Character: ${characterName}` : 'Character (none selected)');
  }

  function refreshPromptPresetChoices(selected = activePromptPresetId) {
    const $preset = $('#sme_prompt_preset').empty();
    const profiles = listPromptProfiles();
    for (const [label, entries] of [['Built-in presets', profiles.builtIn], ['My prompt presets', profiles.custom]]) {
      if (!entries.length) continue;
      const $group = $('<optgroup>', { label });
      for (const profile of entries) $group.append($('<option>', { value: profile.id, text: profile.label }));
      $preset.append($group);
    }
    activePromptPresetId = getPromptProfile(selected) ? selected : resolvePromptProfileId(promptStudioCharacter());
    $preset.val(activePromptPresetId);
    promptPresetDraft = { ...(activePromptPreset()?.tasks ?? {}) };
    updatePromptPresetToolbar();
  }

  function updatePromptPresetToolbar() {
    const editable = !!activePromptPreset()?.custom;
    $('#sme_prompt_preset_save, #sme_prompt_preset_rename, #sme_prompt_preset_delete').prop('disabled', !editable);
  }

  function refreshPromptStudio() {
    const task = $promptTask.val();
    $('#sme_prompt_default').val(getDefaultPromptPreview(task));
    $('#sme_prompt_override').val(promptPresetDraft[task] ?? '');
    refreshAssignments();
  }

  $promptTask.on('change', refreshPromptStudio);
  $('#sme_prompt_override').on('input', function () { promptPresetDraft[$promptTask.val()] = $(this).val(); });
  $('#sme_prompt_preset').on('change', function () {
    activePromptPresetId = $(this).val();
    refreshPromptPresetChoices(activePromptPresetId);
    refreshPromptStudio();
  });
  $('#sme_prompt_global_profile').on('change', function () { setPromptProfileAssignment('global', $(this).val()); saveSettingsDebounced(); refreshPromptPresetChoices($(this).val()); refreshPromptStudio(); });
  $('#sme_prompt_character_profile').on('change', function () { setPromptProfileAssignment('character', $(this).val(), promptStudioCharacter()); saveSettingsDebounced(); refreshPromptStudio(); });
  $('#sme_prompt_chat_profile').on('change', async function () { setPromptProfileAssignment('chat', $(this).val(), promptStudioCharacter()); await getContext().saveMetadata?.(); refreshPromptStudio(); });

  $('#sme_prompt_preset_new').on('click', async function () {
    const name = await callGenericPopup('Name this Smart Memory Enhanced prompt preset:', POPUP_TYPE.INPUT);
    if (!name) return;
    try { const id = savePromptProfile(name, promptPresetDraft); saveSettingsDebounced(); refreshPromptPresetChoices(id); refreshPromptStudio(); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_save').on('click', function () {
    try { updatePromptProfile(activePromptPresetId, promptPresetDraft); saveSettingsDebounced(); toastr.success('Prompt preset updated.', 'Smart Memory Enhanced'); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_rename').on('click', async function () {
    const preset = activePromptPreset();
    if (!preset?.custom) return;
    const name = await callGenericPopup('Rename this Smart Memory Enhanced prompt preset:', POPUP_TYPE.INPUT, preset.label);
    if (!name || name === preset.label) return;
    try { const id = renamePromptProfile(activePromptPresetId, name); saveSettingsDebounced(); refreshPromptPresetChoices(id); refreshPromptStudio(); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_restore').on('click', function () { promptPresetDraft = { ...(activePromptPreset()?.tasks ?? {}) }; refreshPromptStudio(); });
  $('#sme_prompt_preset_delete').on('click', async function () {
    const preset = activePromptPreset();
    if (!preset?.custom) return;
    if (!(await callGenericPopup(`Delete prompt preset "${preset.label}"?`, POPUP_TYPE.CONFIRM))) return;
    deletePromptProfile(activePromptPresetId); saveSettingsDebounced(); refreshPromptPresetChoices('builtin:default'); refreshPromptStudio();
  });
  $('#sme_prompt_reset').on('click', function () { promptPresetDraft[$promptTask.val()] = ''; refreshPromptStudio(); });
  $('#sme_prompt_preview').on('click', function () {
    const task = $promptTask.val();
    const effective = promptPresetDraft[task] ?? '';
    const source = effective ? `EFFECTIVE ADDITIONAL INSTRUCTIONS:\n${effective}\n\n` : '';
    callGenericPopup(`${source}PROTECTED BUILT-IN PROMPT:\n${getDefaultPromptPreview(task)}`, POPUP_TYPE.DISPLAY);
  });
  $('#sme_prompt_inspect_live').on('click', function () {
    try {
      const task = $promptTask.val();
      const inspection = getLivePromptInspection(task, promptStudioCharacter());
      const heading = `LIVE PROMPT INSPECTOR\nTask: ${PROMPT_TASK_LABELS[task]}\nCharacter: ${inspection.characterName || '(none)'}\nPrompt preset: ${inspection.profileId}\nEvidence: ${inspection.evidence.chatMessages} chat messages, ${inspection.evidence.longterm} long-term memories, ${inspection.evidence.session} session memories, ${inspection.evidence.scenes} scenes, ${inspection.evidence.arcs} arcs\n\n${inspection.note}\n\n--- EFFECTIVE PROMPT SENT TO THE PROVIDER ---\n\n`;
      callGenericPopup(heading + inspection.prompt, POPUP_TYPE.DISPLAY);
    } catch (error) {
      toastr.error(error.message || 'Could not build the live prompt inspection.', 'Smart Memory Enhanced');
    }
  });
  $('#sme_prompt_preset_export').on('click', function () {
    try {
      const preset = activePromptPreset();
      const text = JSON.stringify({ format: 'smart-memory-enhanced-prompt-preset', version: 2, name: preset.label, tasks: promptPresetDraft }, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `smart-memory-enhanced-prompt-preset-${preset.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toastr.error(err.message || 'Could not export prompt preset.', 'Smart Memory Enhanced');
    }
  });
  $('#sme_prompt_preset_import_button').on('click', () => $('#sme_prompt_preset_import').trigger('click'));
  $('#sme_prompt_preset_import').on('change', async function () {
    const file = this.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.format !== 'smart-memory-enhanced-prompt-preset' || payload?.version !== 2 || !payload?.tasks) throw new Error('This is not a full Smart Memory Enhanced prompt preset.');
      const name = payload.name;
      const id = savePromptProfile(name, payload.tasks, { overwrite: true });
      saveSettingsDebounced();
      refreshPromptPresetChoices(id); refreshPromptStudio();
      toastr.success(`Imported prompt preset “${name}”.`, 'Smart Memory Enhanced');
    } catch (err) {
      toastr.error(err.message || 'Could not import prompt preset.', 'Smart Memory Enhanced');
    }
    this.value = '';
  });
  $('#sme_prompt_export').on('click', function () {
    const text = JSON.stringify(exportPromptOverrides(promptStudioCharacter()), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'smart-memory-enhanced-prompt-overrides.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $('#sme_prompt_import').on('click', () => $('#sme_prompt_import_file').trigger('click'));
  $('#sme_prompt_import_file').on('change', async function () {
    const file = this.files?.[0];
    if (!file) return;
    try {
      importPromptOverrides(JSON.parse(await file.text()), promptStudioCharacter());
      saveSettingsDebounced();
      await getContext().saveMetadata?.();
      refreshPromptStudio();
      toastr.success('Prompt overrides imported.', 'Smart Memory Enhanced');
    } catch (err) {
      toastr.error(err.message || 'Could not import prompt overrides.', 'Smart Memory Enhanced');
    }
    this.value = '';
  });
  refreshPromptPresetChoices();
  refreshPromptStudio();

  // Also retains a run report when the final chat save fails and its staged
  // metadata must be rolled back. Export Diagnostics must still be useful in
  // that exact failure case.
  let latestExportDiagnostics = null;
  const getExportableDiagnostics = () => {
    const metadata = getContext().chatMetadata?.[META_KEY] ?? {};
    const completedRun = metadata.catch_up_diagnostics ?? latestExportDiagnostics;
    if (completedRun) return completedRun;
    // Fresh Start is itself a consequential, persisted operation. Its
    // postcondition needs to be inspectable before a long historical rebuild,
    // rather than requiring a new Memorize Chat just to enable export.
    const freshStartAudit = metadata.fresh_start_postcondition_audit ?? null;
    const manualIdempotence = metadata.developer_idempotence_check ?? null;
    if (!freshStartAudit && !manualIdempotence) return null;
    return {
      version: 1,
      created_at: Date.now(),
      diagnostic_type: 'pre_run_state_audit',
      status: 'not_run',
      operational_status: 'not_run',
      fresh_start_postcondition_audit: freshStartAudit,
      manual_idempotence: manualIdempotence,
      automatic_stabilization: null,
      provider_calls_during_audit: 0,
    };
  };
  const exportCatchUpDiagnostics = () => {
    // A manual Developer check updates persisted chat diagnostics after the
    // catch-up has finished. Prefer that current saved report over the
    // in-memory pre-check snapshot so an export reflects the restored result.
    const report = getExportableDiagnostics();
    if (!report) return toastr.info('No Smart Memory Enhanced diagnostics are available for this chat yet.', 'Smart Memory Enhanced');
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'smart-memory-enhanced-diagnostics.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $('#sme_export_diagnostics').prop('disabled', !getExportableDiagnostics()).on('click', exportCatchUpDiagnostics);
  const showSceneStability = () => {
    const report = latestExportDiagnostics ?? getContext().chatMetadata?.[META_KEY]?.catch_up_diagnostics;
    const stability = report?.sceneDetection?.scene_stability_history;
    if (!stability) return toastr.info('No comparable scene-run history is available for this chat yet.', 'Smart Memory Enhanced');
    const yesNo = (value) => value === null || value === undefined ? 'not available' : value ? 'yes' : 'no';
    callGenericPopup(
      `Comparable runs: ${stability.total_comparable_run_count ?? stability.comparable_run_count}\nPrior retained runs: ${stability.prior_comparable_run_count ?? stability.comparable_prior_run_count ?? 0}\nComparison available: ${yesNo(stability.comparison_available)}${stability.comparison_unavailable_reason ? ` (${stability.comparison_unavailable_reason})` : ''}\nCurrent run included: ${yesNo(stability.current_run_included)}\nScene counts: ${(stability.scene_counts ?? []).join(', ') || 'none'}\nUnique mode: ${stability.scene_count_mode_is_unique ? stability.scene_count_mode : 'none'}\nScene-count range: ${stability.scene_count_range ?? 'n/a'}\nExact consensus boundaries: ${(stability.exact_consensus_boundaries ?? stability.stable_consensus_boundaries ?? []).length}\nShift-tolerant consensus transitions: ${(stability.clustered_consensus_transitions ?? []).length}\nExact majority boundaries: ${(stability.exact_majority_boundaries ?? stability.majority_boundaries ?? []).length}\nClustered majority transitions: ${(stability.clustered_majority_transitions ?? []).length}\nMarginal transitions: ${(stability.clustered_marginal_transitions ?? stability.marginal_boundaries ?? []).length}\nShifted clusters: ${(stability.shifted_boundary_clusters ?? []).length}\nPipeline stable: ${yesNo(stability.pipeline_stable)}\nScene count materially stable: ${yesNo(stability.scene_count_materially_stable)}\nBoundary positions materially stable: ${yesNo(stability.boundary_positions_materially_stable)}`,
      POPUP_TYPE.DISPLAY,
    );
  };
  $('#sme_scene_stability').toggle(Boolean(extension_settings[MODULE_NAME]?.verbose_logging)).on('click', showSceneStability);
  $('#sme_preview_catch_up').on('click', async () => {
    const context = getContext();
    const allMessages = (context.chat ?? []).filter((message) => message.mes && !message.is_system);
    const fullTokenEstimate = allMessages.reduce((total, message) => total + estimateTokens(`${message.name}: ${message.mes}`), 0);
    // Preview is a fast provider preflight, not a miniature full rebuild. The
    // former implementation sent an entire imported chat as one request,
    // which bypassed the normal catch-up chunker and caused provider 400s.
    // Keep a representative recent, stable sample small enough to leave room
    // for the extraction contract, existing-memory context, and response.
    const previewTokenBudget = Math.max(500, Math.min(1400, Math.floor(getMaxContextSize(0) * 0.15)));
    const stablePreview = ctrl.getStableExtractionWindowWithFallback(context.chat, 12)
      .filter((message) => message.mes && !message.is_system);
    const messages = [];
    let previewTokens = 0;
    for (const message of [...stablePreview].reverse()) {
      const messageTokens = estimateTokens(`${message.name}: ${message.mes}`);
      if (messages.length > 0 && previewTokens + messageTokens > previewTokenBudget) break;
      messages.unshift(message);
      previewTokens += messageTokens;
    }
    if (!messages.length && stablePreview.length) {
      const onlyMessage = stablePreview.at(-1);
      messages.push(onlyMessage);
      previewTokens = estimateTokens(`${onlyMessage.name}: ${onlyMessage.mes}`);
    }
    const chunkBudget = Math.max(500, Math.floor(getMaxContextSize(0) * 0.35));
    let scenes = 0;
    for (const message of messages) if (detectSceneBreakHeuristic(message.mes ?? '')) scenes++;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return toastr.warning('No character is active.', 'Smart Memory Enhanced');
    const button = $('#sme_preview_catch_up').prop('disabled', true);
    try {
      // Run one request at a time. Many local connection profiles serialize
      // inference, and concurrent preview calls make a provider failure less
      // actionable while offering no meaningful speed benefit.
      const longterm = await extractAndStoreMemories(characterName, messages, null, { dryRun: true });
      const session = await extractSessionMemories(messages, null, { dryRun: true });
      const arcs = await extractArcs(messages, characterName, null, { dryRun: true });
      const candidates = [...(longterm?.candidates ?? []), ...(session?.candidates ?? [])];
      const reviewCount = candidates.filter((candidate) => candidate.validation_status === 'needs_review').length;
      latestExportDiagnostics = {
        version: 1, created_at: Date.now(), dry_run: true,
        workload: {
          total_usable_messages: allMessages.length,
          total_token_estimate: fullTokenEstimate,
          estimated_catch_up_chunks: Math.ceil(fullTokenEstimate / chunkBudget),
          preview_messages: messages.length,
          preview_token_estimate: previewTokens,
          preview_token_budget: previewTokenBudget,
          heuristic_scene_candidates_in_preview: scenes,
        },
        longterm, session, arcs,
      };
      $('#sme_export_diagnostics').prop('disabled', false);
      await callGenericPopup(
        `Preview complete - no memories or entities were saved.\n\nPreflight sample: ${messages.length} recent stable messages\n~${previewTokens.toLocaleString()} sample tokens\n${scenes} heuristic scene-break candidates in sample\n${longterm?.candidates?.length ?? 0} long-term candidates\n${session?.candidates?.length ?? 0} session candidates\n${arcs?.candidates?.length ?? 0} story-arc candidates\n${arcs?.resolved_candidates ?? 0} potential arc resolutions\n${reviewCount} candidates need grounding review\n\nFull chat estimate: ${allMessages.length} usable messages, ~${fullTokenEstimate.toLocaleString()} chat tokens, ~${Math.ceil(fullTokenEstimate / chunkBudget)} extraction chunks.\n\nExport Diagnostics contains the sample candidate details.`,
        POPUP_TYPE.DISPLAY,
      );
    } catch (error) {
      showError('Dry run', error);
    } finally {
      button.prop('disabled', false);
    }
  });

  // ---- LLM source -----------------------------------------------------

  /**
   * Shows or hides the per-source settings sections based on the current source.
   * @param {string} source
   */
  function updateSourceSections(source) {
    $('#sme_ollama_settings').toggle(source === memory_sources.ollama);
    $('#sme_openai_compat_settings').toggle(source === memory_sources.openai_compatible);
    $('#sme_connection_profile_settings').toggle(source === memory_sources.connection_profile);
  }

  /**
   * Populates the connection profile picker with all profiles saved in the connection manager.
   * Shows a placeholder if the connection manager has no profiles or is unavailable.
   */
  function populateConnectionProfilePicker() {
    const $select = $('#sme_connection_profile_id');
    $select.empty();
    const profiles = extension_settings?.connectionManager?.profiles ?? [];
    // Filter by mode (cc = Chat Completion, tc = Text Completion). This covers all
    // sub-types including ollama, koboldcpp, etc. - profile.api holds the sub-type
    // string, not the top-level mode, so filtering by api would exclude most profiles.
    const compatible = profiles.filter((p) => p.mode === 'cc' || p.mode === 'tc');
    if (compatible.length === 0) {
      $select.append('<option value="">- no compatible profiles found -</option>');
      return;
    }
    compatible
      .slice()
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .forEach((p) => {
        $select.append($('<option>', { value: p.id, text: p.name ?? p.id }));
      });
    // Restore previously saved selection, or auto-save the first option so the
    // setting is never null when profiles are available (the browser auto-selects
    // the first option but does not fire a change event, so we save it explicitly).
    const saved = extension_settings[MODULE_NAME].connection_profile_id;
    if (saved && compatible.some((p) => p.id === saved)) {
      $select.val(saved);
    } else {
      const firstId = compatible[0].id;
      $select.val(firstId);
      extension_settings[MODULE_NAME].connection_profile_id = firstId;
      saveSettingsDebounced();
    }
  }

  /**
   * Fetches installed Ollama models and populates the model dropdown.
   * On success: shows the select and hides the manual text input.
   * On failure: hides the select and reveals the manual text input so users
   * who cannot reach Ollama from their browser (e.g. accessing ST remotely
   * via a different address) can still type a model name directly.
   */
  async function refreshOllamaModels() {
    const $select = $('#sme_ollama_model');
    const $manual = $('#sme_ollama_model_manual');
    const $btn = $('#sme_ollama_refresh');
    const prevModel = extension_settings[MODULE_NAME].ollama_model;
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels();
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append($('<option>', { value: name, text: name }));
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        extension_settings[MODULE_NAME].ollama_model = best;
        saveSettingsDebounced();
      }
      // Fetch succeeded - use the dropdown and hide the manual fallback.
      $select.show();
      $manual.hide();
      $btn.show();
    } catch (err) {
      toastr.error(
        `Could not reach Ollama at ${extension_settings[MODULE_NAME].ollama_url || 'http://localhost:11434'}. Is it running?`,
        'Smart Memory Enhanced',
      );
      console.error('[Smart Memory Enhanced] Ollama model fetch failed:', err);
      // Fetch failed - reveal the manual text input and hide the refresh
      // button (it would just fail again until Ollama is reachable).
      $select.hide();
      $manual.val(prevModel ?? '').show();
      $btn.hide();
    } finally {
      $btn.prop('disabled', false);
    }
  }

  /**
   * Fetches installed Ollama models and populates the embedding model dropdown.
   * Uses the embedding-specific URL so users can point embeddings at a separate
   * Ollama instance. Falls back to the manual text input on failure.
   */
  async function refreshEmbeddingModels() {
    const $select = $('#sme_embedding_model');
    const $manual = $('#sme_embedding_model_manual');
    const $btn = $('#sme_embedding_refresh');
    const prevModel = extension_settings[MODULE_NAME].embedding_model;
    const embeddingUrl = extension_settings[MODULE_NAME].embedding_url || 'http://localhost:11434';
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels(embeddingUrl);
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append($('<option>', { value: name, text: name }));
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        extension_settings[MODULE_NAME].embedding_model = best;
        clearEmbeddingFailed();
        updateEmbeddingNotice();
        saveSettingsDebounced();
      }
      $select.show();
      $manual.hide();
      $btn.show();
    } catch (err) {
      toastr.error(`Could not reach Ollama at ${embeddingUrl}. Is it running?`, 'Smart Memory Enhanced');
      console.error('[Smart Memory Enhanced] Embedding model fetch failed:', err);
      $select.hide();
      $manual.val(prevModel ?? '').show();
      $btn.hide();
    } finally {
      $btn.prop('disabled', false);
    }
  }

  const currentSource = s.source ?? memory_sources.main;
  $('#sme_source')
    .val(currentSource)
    .on('change', function () {
      const source = $(this).val();
      extension_settings[MODULE_NAME].source = source;
      saveSettingsDebounced();
      updateSourceSections(source);
      if (source === memory_sources.ollama && !extension_settings[MODULE_NAME].ollama_model) {
        refreshOllamaModels();
      }
      // Re-evaluate auto-detected hardware profile label when source changes.
      updateProfileLabel();
    });

  updateSourceSections(currentSource);

  // Connection profile picker
  populateConnectionProfilePicker();
  $('#sme_connection_profile_id').on('change', function () {
    extension_settings[MODULE_NAME].connection_profile_id = $(this).val() || null;
    const sizes = extension_settings[MODULE_NAME].connection_profile_context_sizes ?? {};
    $('#sme_connection_profile_context_size').val(sizes[$(this).val()] ?? '');
    saveSettingsDebounced();
  });
  const selectedProfileId = s.connection_profile_id;
  $('#sme_connection_profile_context_size')
    .val(s.connection_profile_context_sizes?.[selectedProfileId] ?? '')
    .on('change', function () {
      const profileId = extension_settings[MODULE_NAME].connection_profile_id;
      if (!profileId) return;
      const sizes = (extension_settings[MODULE_NAME].connection_profile_context_sizes ??= {});
      const value = parseInt($(this).val(), 10);
      if (value > 0) sizes[profileId] = value;
      else delete sizes[profileId];
      saveSettingsDebounced();
    });

  // Ollama URL field
  $('#sme_ollama_url')
    .val(s.ollama_url ?? 'http://localhost:11434')
    .on('change', function () {
      extension_settings[MODULE_NAME].ollama_url = $(this).val().trim();
      saveSettingsDebounced();
      // Refresh models when the URL changes so the list reflects the new instance.
      refreshOllamaModels();
    });

  // Ollama model dropdown - saves on selection change.
  $('#sme_ollama_model').on('change', function () {
    extension_settings[MODULE_NAME].ollama_model = $(this).val();
    saveSettingsDebounced();
  });

  // Manual text fallback - saves on blur/change so a typed name persists
  // across reloads even when Ollama is not reachable from this browser.
  $('#sme_ollama_model_manual').on('change', function () {
    extension_settings[MODULE_NAME].ollama_model = $(this).val().trim();
    saveSettingsDebounced();
  });

  // Populate Ollama model list on load if Ollama is already selected.
  if (currentSource === memory_sources.ollama) {
    refreshOllamaModels();
  }

  // Ollama refresh button
  $('#sme_ollama_refresh').on('click', () => refreshOllamaModels());

  // OpenAI Compatible fields
  $('#sme_openai_compat_url')
    .val(s.openai_compat_url ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].openai_compat_url = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sme_openai_compat_key')
    .val(s.openai_compat_key ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].openai_compat_key = $(this).val();
      saveSettingsDebounced();
    });

  $('#sme_openai_compat_model')
    .val(s.openai_compat_model ?? '')
    .on('input', function () {
      extension_settings[MODULE_NAME].openai_compat_model = $(this).val().trim();
      saveSettingsDebounced();
    });

  // Generation budget slider + unlimited checkbox
  const genBudget = s.generation_budget ?? 8192;
  const isUnlimited = genBudget === -1;
  $('#sme_generation_budget')
    .val(isUnlimited ? 8192 : genBudget)
    .prop('disabled', isUnlimited)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      $('#sme_generation_budget_value').text(val.toLocaleString() + ' tokens');
      extension_settings[MODULE_NAME].generation_budget = val;
      saveSettingsDebounced();
    });
  $('#sme_generation_budget_unlimited')
    .prop('checked', isUnlimited)
    .on('change', function () {
      const unlimited = $(this).is(':checked');
      $('#sme_generation_budget').prop('disabled', unlimited);
      const val = unlimited ? -1 : parseInt($('#sme_generation_budget').val(), 10);
      $('#sme_generation_budget_value').text(
        unlimited ? 'Unlimited' : val.toLocaleString() + ' tokens',
      );
      extension_settings[MODULE_NAME].generation_budget = val;
      saveSettingsDebounced();
    });
  $('#sme_generation_budget_value').text(
    isUnlimited ? 'Unlimited' : genBudget.toLocaleString() + ' tokens',
  );

  $('#sme_provider_max_concurrency')
    .val(s.provider_max_concurrency ?? 1)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_max_concurrency = Math.max(1, parseInt($(this).val(), 10) || 1);
      saveSettingsDebounced();
    });
  $('#sme_provider_request_delay_ms')
    .val(s.provider_request_delay_ms ?? 2000)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_request_delay_ms = Math.max(0, parseInt($(this).val(), 10) || 0);
      saveSettingsDebounced();
    });
  $('#sme_provider_max_retries')
    .val(s.provider_max_retries ?? 5)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_max_retries = Math.max(0, parseInt($(this).val(), 10) || 0);
      saveSettingsDebounced();
    });

  // Hardware profile override
  const PROFILE_LABELS = {
    a: 'Profile A: local / low-VRAM - minimal model calls, heuristic-only signals.',
    b: 'Profile B: hosted / high-performance - richer extraction, all retrieval signals active.',
  };

  /** Updates the descriptive label below the hardware profile select. */
  function updateProfileLabel() {
    const active = getHardwareProfile();
    $('#sme_hardware_profile_label').text(PROFILE_LABELS[active] ?? '');
  }

  /**
   * Dims and disables settings that only apply to Profile B when Profile A is
   * active, so users are not confused by controls that silently do nothing.
   */
  function syncProfileGating() {
    const isB = getHardwareProfile() === 'b';
    $('#smart_memory_enhanced_settings .sm-profile-b-only').each(function () {
      $(this).toggleClass('sm-gated', !isB);
      $(this).find('input, select, button').prop('disabled', !isB);
    });
  }

  $('#sme_hardware_profile')
    .val(s.hardware_profile ?? 'auto')
    .on('change', function () {
      extension_settings[MODULE_NAME].hardware_profile = $(this).val();
      saveSettingsDebounced();
      updateProfileLabel();
      syncProfileGating();
    });

  updateProfileLabel();
  syncProfileGating();

  // ---- Model test button --------------------------------------------------

  $('#sme_model_test_btn').on('click', async function () {
    const $btn = $(this);
    const $result = $('#sme_model_test_result');

    const resetBtn = () =>
      $btn
        .prop('disabled', false)
        .html(
          '<i class="fa-solid fa-flask"></i> <span>Test Extraction Model <span class="sm-info" data-tooltip="Runs a fixed test scenario through all extraction tiers. Use this to check whether your configured model is suitable for Smart Memory Enhanced before committing to a session.">ⓘ</span></span>',
        );

    // If a test is already running, cancel it and give immediate feedback.
    if (modelTestRunning) {
      modelTestRunning = false;
      stopGeneration();
      $btn
        .prop('disabled', true)
        .html('<i class="fa-solid fa-spinner fa-spin"></i> <span>Cancelling...</span>');
      $result
        .show()
        .html(
          '<div class="sme_model_test_running"><i class="fa-solid fa-spinner fa-spin"></i> Cancelling extraction test...</div>',
        );
      return;
    }

    modelTestRunning = true;
    $btn.html('<i class="fa-solid fa-circle-stop"></i> <span>Stop Testing</span>');
    $result
      .show()
      .html(
        '<div class="sme_model_test_running"><i class="fa-solid fa-spinner fa-spin"></i> Running extraction test...</div>',
      );

    let outcome;
    try {
      outcome = await runModelTest(() => !modelTestRunning);
    } catch (err) {
      console.error('[Smart Memory Enhanced] Model test failed:', err);
      $result.html(
        '<div class="sme_model_test_fail"><i class="fa-solid fa-circle-xmark"></i> Test failed with an error. Check the browser console for details.</div>',
      );
      modelTestRunning = false;
      resetBtn();
      return;
    }

    modelTestRunning = false;
    resetBtn();

    if (outcome.cancelled) {
      $result.html(
        '<div class="sme_model_test_running"><i class="fa-solid fa-circle-xmark"></i> Test cancelled.</div>',
      );
      return;
    }

    if (outcome.failedTier) {
      $result.html(
        `<div class="sme_model_test_fail"><i class="fa-solid fa-circle-xmark"></i> <strong>${outcome.failedTier}</strong> returned no output. Your model may not be suitable for Smart Memory Enhanced, or may need a stronger prompt style. Consider trying a different model.</div>`,
      );
      return;
    }

    // All tiers passed - render paginated tier review.
    const tiers = outcome.tiers;
    let current = 0;

    $result.html(`
      <div class="sme_model_test_pass_header">
        <i class="fa-solid fa-circle-check"></i> All tiers returned output.
      </div>
      <div id="sme_model_test_tier_area"></div>
    `);

    function renderTier() {
      const tier = tiers[current];
      const sc = tier.scenario;
      const scenarioLines = sc.messages.map((m) => `${m.name}: ${m.mes ?? m.text}`).join('\n');
      const charactersNote = `Characters: ${sc.characters.join(', ')}`;
      const readWarning = sc.showReadWarning
        ? 'Read through this before judging - it is the only way to catch invented facts that look plausible.'
        : 'Reference scenario for this tier.';
      const $area = $('<div>');
      $area.append(
        $('<div class="sme_model_test_tier_name">').html(
          `${tier.name} <span class="sme_model_test_tier_pos">${current + 1} / ${tiers.length}</span>`,
        ),
      );
      const $details = $('<details class="sme_model_test_scenario">');
      $details.append($('<summary>').text('View test scenario'));
      $details.append(
        $('<p class="sme_model_test_scenario_note">').text(`${charactersNote}. ${readWarning}`),
      );
      $details.append(
        $('<textarea class="sme_model_test_output text_pole" readonly>').val(scenarioLines),
      );
      $area.append($details);
      $area.append($('<div class="sme_model_test_tier_hint">').text(tier.hint));
      $area.append(
        $('<textarea class="sme_model_test_output text_pole" readonly>').val(tier.items.join('\n')),
      );
      const $nav = $('<div class="sme_model_test_nav">');
      $nav.append(
        $('<button class="menu_button sme_model_test_prev">')
          .prop('disabled', current === 0)
          .html('&#8592; Previous'),
      );
      $nav.append(
        $('<button class="menu_button sme_model_test_next">')
          .prop('disabled', current === tiers.length - 1)
          .html('Next &#8594;'),
      );
      $area.append($nav);
      $('#sme_model_test_tier_area').empty().append($area);
      $area.find('.sme_model_test_prev').on('click', () => {
        if (current > 0) {
          current--;
          renderTier();
        }
      });
      $area.find('.sme_model_test_next').on('click', () => {
        if (current < tiers.length - 1) {
          current++;
          renderTier();
        }
      });
    }

    renderTier();
  });

  $('#sme_extraction_frequency')
    .val(s.extraction_frequency ?? 'medium')
    .on('change', function () {
      const freq = $(this).val();
      const every = EXTRACTION_FREQUENCY_MAP[freq] ?? 3;
      const settings = extension_settings[MODULE_NAME];
      settings.extraction_frequency = freq;
      settings.longterm_extract_every = every;
      settings.session_extract_every = every;
      saveSettingsDebounced();
      // Keep the advanced sliders in sync so switching to advanced mode shows the right values.
      $('#sme_longterm_extract_every').val(every);
      $('#sme_longterm_extract_every_value').text(every);
      $('#sme_session_extract_every').val(every);
      $('#sme_session_extract_every_value').text(every);
    });

  // ---- Short-term (compaction) ----------------------------------------
  $('#sme_compaction_enabled')
    .prop('checked', s.compaction_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_compaction_threshold')
    .val(s.compaction_threshold)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_threshold = val;
      $('#sme_compaction_threshold_value').text(val + '%');
      saveSettingsDebounced();
    });
  $('#sme_compaction_threshold_value').text(s.compaction_threshold + '%');

  $('#sme_compaction_response_length')
    .val(s.compaction_response_length)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_response_length = val;
      $('#sme_compaction_response_length_value').text(val);
      // The response length is also the injected-summary budget. Reapply the
      // already-saved summary immediately so its trim state and token bar do
      // not continue showing the previous slider value.
      injectSummary($('#sme_current_summary').val());
      updateTokenDisplay();
      saveSettingsDebounced();
    });
  $('#sme_compaction_response_length_value').text(s.compaction_response_length);

  $('#sme_compaction_template')
    .val(s.compaction_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_compaction_position"][value="${s.compaction_position}"]`).prop('checked', true);
  $('input[name="sme_compaction_position"]').on('change', function () {
    extension_settings[MODULE_NAME].compaction_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_compaction_depth')
    .val(s.compaction_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_compaction_role')
    .val(s.compaction_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- Canon ----------------------------------------------------------

  $('#sme_canon_enabled')
    .prop('checked', s.canon_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].canon_enabled) {
        setExtensionPrompt(PROMPT_KEY_CANON, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectCanon(ctrl.getSelectedCharacterName());
        updateTokenDisplay();
      }
    });

  $('#sme_canon_inject_budget')
    .val(s.canon_inject_budget)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].canon_inject_budget = val;
      $('#sme_canon_inject_budget_value').text(val);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });
  $('#sme_canon_inject_budget_value').text(s.canon_inject_budget);

  $('#sme_canon_template')
    .val(s.canon_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_canon_position"][value="${s.canon_position}"]`).prop('checked', true);
  $('input[name="sme_canon_position"]').on('change', function () {
    extension_settings[MODULE_NAME].canon_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_canon_depth')
    .val(s.canon_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_canon_role')
    .val(s.canon_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // Allow manual edits to the canon textarea to take effect immediately.
  $('#sme_canon_display').on('input', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    const val = $(this).val().trim();
    if (val) {
      saveCanon(characterName, val);
      injectCanon(characterName);
    } else {
      clearCanon(characterName);
    }
    updateTokenDisplay();
  });

  $('#sme_summarize_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.compactionRunning) return;
    ctrl.compactionRunning = true;
    setStatusMessage('Extracting short-term memories...');
    $(this).prop('disabled', true);
    try {
      const summary = await runCompaction();
      if (summary) {
        injectSummary(summary);
        updateShortTermUI(summary);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage('Summary updated.');
      }
    } catch (err) {
      showError('Summary generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      ctrl.compactionRunning = false;
    }
  });

  $('#sme_generate_canon').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character loaded.', 'Smart Memory Enhanced');
      return;
    }
    if (loadArcSummaries().filter(isRecordApprovedForPropagation).length === 0) {
      toastr.warning(
        'Canon requires at least one verified resolved arc summary. Review or resolve a story arc first.',
        'Smart Memory Enhanced',
      );
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating canon summary...');
    try {
      const text = await generateCanon(characterName);
      if (text) {
        injectCanon(characterName);
        updateCanonUI(characterName);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage('Canon summary updated.');
      } else {
        setStatusMessage('');
        toastr.warning('Canon generation returned no output.', 'Smart Memory Enhanced');
      }
    } catch (err) {
      showError('Canon generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // Allow manual edits to the summary textarea to take effect immediately.
  $('#sme_current_summary').on('input', function () {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    const val = $(this).val();
    context.chatMetadata[META_KEY].summary = val;
    context.saveMetadata();
    injectSummary(val);
  });

  // ---- Consolidation --------------------------------------------------
  $('#sme_consolidate_enabled')
    .prop('checked', s.consolidation_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].consolidation_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  for (const [type, defVal] of [
    ['fact', 4],
    ['relationship', 3],
    ['preference', 3],
    ['event', 4],
  ]) {
    const key = `longterm_consolidation_threshold_${type}`;
    const spanId = `#sme_longterm_threshold_${type}_value`;
    $(`#sme_longterm_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  for (const [type, defVal] of [
    ['scene', 3],
    ['revelation', 3],
    ['development', 3],
    ['detail', 3],
  ]) {
    const key = `session_consolidation_threshold_${type}`;
    const spanId = `#sme_session_threshold_${type}_value`;
    $(`#sme_session_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  // ---- Long-term memory -----------------------------------------------
  $('#sme_longterm_enabled')
    .prop('checked', s.longterm_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectMemories(ctrl.getSelectedCharacterName()).catch(console.error);
    });

  $('#sme_longterm_extract_every')
    .val(s.longterm_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_extract_every = val;
      $('#sme_longterm_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_longterm_extract_every_value').text(s.longterm_extract_every);

  $('#sme_longterm_max_memories')
    .val(s.longterm_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_max_memories = val;
      $('#sme_longterm_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_longterm_max_memories_value').text(s.longterm_max_memories);

  $('#sme_longterm_template')
    .val(s.longterm_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_longterm_position"][value="${s.longterm_position}"]`).prop('checked', true);
  $('input[name="sme_longterm_position"]').on('change', function () {
    extension_settings[MODULE_NAME].longterm_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_longterm_depth')
    .val(s.longterm_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_role')
    .val(s.longterm_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_triggered_depth')
    .val(s.longterm_triggered_depth ?? 4)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_triggered_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_triggers_enabled')
    .prop('checked', s.longterm_triggers_enabled ?? false)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_triggers_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_longterm_inject_budget_value').text(s.longterm_inject_budget ?? 500);
  $('#sme_longterm_inject_budget')
    .val(s.longterm_inject_budget ?? 500)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_inject_budget = v;
      $('#sme_longterm_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  // ---- Relationship history controls ------------------------------------
  $('#sme_relationships_enabled')
    .prop('checked', s.relationships_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].relationships_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      const characterName = ctrl.getSelectedCharacterName();
      injectRelationshipHistory(characterName);
    });

  $('#sme_relationships_inject_budget_value').text(s.relationships_inject_budget ?? 250);
  $('#sme_relationships_inject_budget')
    .val(s.relationships_inject_budget ?? 250)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].relationships_inject_budget = v;
      $('#sme_relationships_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_relationships_position"][value="${s.relationships_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_relationships_position"]').on('change', function () {
    extension_settings[MODULE_NAME].relationships_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_relationships_depth')
    .val(s.relationships_depth ?? 5)
    .on('input', function () {
      extension_settings[MODULE_NAME].relationships_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_relationships_role')
    .val(s.relationships_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].relationships_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- Relationship history panel buttons -----------------------------
  $('#sme_add_relationship').on('click', function () {
    $('#sme_relationship_add_form').removeData('editing').show();
    $('#sme_rel_subject').val('').focus();
    $('#sme_rel_target').val('');
    $('#sme_rel_descriptors').val('');
  });

  $('#sme_rel_cancel').on('click', function () {
    $('#sme_relationship_add_form').removeData('editing').hide();
  });

  $('#sme_rel_save').on('click', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;

    const subject = $('#sme_rel_subject').val().trim();
    const target = $('#sme_rel_target').val().trim();
    const descriptorsRaw = $('#sme_rel_descriptors').val().trim();

    if (!subject || !target || !descriptorsRaw) return;

    // Parse "word(magnitude), word(magnitude)" format. Words without an explicit
    // magnitude get the default "medium".
    const VALID_MAGNITUDES = new Set(['low', 'medium', 'high']);
    const descriptors = descriptorsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => {
        const m = /\((\s*low|medium|high\s*)\)/i.exec(t);
        const magnitude = m ? m[1].trim().toLowerCase() : 'medium';
        const word = t
          .replace(/\([^)]*\)/g, '')
          .replace(/[^a-z\s-]/gi, '')
          .trim()
          .toLowerCase();
        return VALID_MAGNITUDES.has(word) ? null : { word, magnitude };
      })
      .filter(Boolean);

    if (descriptors.length === 0) return;
    const key = `${subject}→${target}`;

    const pair = getRelationshipHistoryPair(subject, target);
    const h = loadRelationshipHistory(characterName);

    // If editing an existing pair under a different key, remove the old entry.
    const editingKey = $('#sme_relationship_add_form').data('editing');
    if (editingKey && editingKey !== pair.key) delete h[editingKey];

    h[pair.key] = {
      descriptors,
      subject_name: pair.subject.displayName,
      target_name: pair.target.displayName,
      subject_canonical_card_id: pair.subject.cardId,
      target_canonical_card_id: pair.target.cardId,
      updatedAt: Date.now(),
    };
    saveRelationshipHistory(characterName, h);
    saveSettingsDebounced();
    injectRelationshipHistory(characterName);
    updateRelationshipHistoryUI(characterName);
    $('#sme_relationship_add_form').removeData('editing').hide();
  });

  $('#sme_clear_relationships').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (
      !(await callGenericPopup(
        `Clear all relationship history for "${characterName}"?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;
    clearRelationshipHistory(characterName);
    saveSettingsDebounced();
    injectRelationshipHistory(null);
    updateRelationshipHistoryUI(characterName);
  });

  // ---- Perspectives & Secrets bindings -----------------------------------

  $('#sme_epistemic_enabled')
    .prop('checked', s.epistemic_enabled ?? true)
    .on('change', async function () {
      const enabling = $(this).prop('checked');
      if (enabling && getHardwareProfile() === 'a') {
        const confirmed = await callGenericPopup(
          'Perspectives & Secrets works best with a cloud-based LLM or a strong capable local model (e.g. Gemma 4).\n\nWeaker models may produce low-quality extractions. Use the model test in the Configuration section to check whether your model is up to the task.',
          POPUP_TYPE.CONFIRM,
          '',
          { okButton: 'I understand', cancelButton: 'Cancel' },
        );
        if (!confirmed) {
          $(this).prop('checked', false);
          return;
        }
      }
      extension_settings[MODULE_NAME].epistemic_enabled = enabling;
      saveSettingsDebounced();
      const characterName = ctrl.getSelectedCharacterName();
      injectEpistemicKnowledge(characterName, characterName);
    });

  $('#sme_epistemic_inject_unaware')
    .prop('checked', s.epistemic_inject_unaware ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_inject_unaware = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_epistemic_secondhand_framing')
    .prop('checked', s.epistemic_secondhand_framing ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_secondhand_framing = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_epistemic_inject_budget_value').text(s.epistemic_inject_budget ?? 200);
  $('#sme_epistemic_inject_budget')
    .val(s.epistemic_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].epistemic_inject_budget = v;
      $('#sme_epistemic_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_epistemic_position"][value="${s.epistemic_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_epistemic_position"]').on('change', function () {
    extension_settings[MODULE_NAME].epistemic_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_epistemic_depth')
    .val(s.epistemic_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].epistemic_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_epistemic_role')
    .val(s.epistemic_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- State Ledger bindings ---------------------------------------------

  $('#sme_state_ledger_enabled')
    .prop('checked', s.state_ledger_enabled ?? false)
    .on('change', async function () {
      const enabling = $(this).prop('checked');
      if (enabling && getHardwareProfile() === 'a') {
        const confirmed = await callGenericPopup(
          'State Ledger works best with a cloud-based LLM or a strong capable local model (e.g. Gemma 4).\n\nWeaker models may invent field values that are not in the scene, producing inaccurate entity state. Use the model test in the Configuration section to check whether your model is up to the task.',
          POPUP_TYPE.CONFIRM,
          '',
          { okButton: 'I understand', cancelButton: 'Cancel' },
        );
        if (!confirmed) {
          $(this).prop('checked', false);
          return;
        }
      }
      extension_settings[MODULE_NAME].state_ledger_enabled = enabling;
      saveSettingsDebounced();
      injectStateLedger();
    });

  $('#sme_state_ledger_inject_budget_value').text(s.state_ledger_inject_budget ?? 200);
  $('#sme_state_ledger_inject_budget')
    .val(s.state_ledger_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].state_ledger_inject_budget = v;
      $('#sme_state_ledger_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_state_ledger_position"][value="${s.state_ledger_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_state_ledger_position"]').on('change', function () {
    extension_settings[MODULE_NAME].state_ledger_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_state_ledger_depth')
    .val(s.state_ledger_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].state_ledger_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_state_ledger_role')
    .val(s.state_ledger_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].state_ledger_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // Show/hide the target field when type changes to/from "hiding".
  $('#sme_ep_type').on('change', function () {
    $('.sme_ep_target_field').toggle($(this).val() === 'hiding');
  });

  $('#sme_epistemic_add').on('click', function () {
    $('#sme_ep_type').val('knows');
    $('#sme_ep_subject').val('');
    $('#sme_ep_target').val('');
    $('#sme_ep_content').val('');
    $('.sme_ep_target_field').hide();
    $('#sme_epistemic_add_form').removeData('editing').show();
    $('#sme_ep_subject').focus();
  });

  $('#sme_ep_cancel').on('click', function () {
    $('#sme_epistemic_add_form').removeData('editing').hide();
  });

  $('#sme_ep_save').on('click', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;

    const type = $('#sme_ep_type').val();
    const subject = $('#sme_ep_subject').val().trim();
    const target = type === 'hiding' ? $('#sme_ep_target').val().trim() : '';
    const content = $('#sme_ep_content').val().trim();

    if (!subject || !content) return;
    if (type === 'hiding' && !target) return;

    const entries = loadEpistemicKnowledge(characterName);
    const editingId = $('#sme_epistemic_add_form').data('editing');

    if (editingId) {
      // Update the existing entry in place.
      const idx = entries.findIndex((e) => e.id === editingId);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], type, subject, target, content };
      }
    } else {
      entries.push({ id: generateMemoryId(), type, subject, target, content, ts: Date.now() });
    }

    saveEpistemicKnowledge(characterName, entries);
    injectEpistemicKnowledge(characterName, characterName);
    updateEpistemicUI(characterName);
    updateTokenDisplay();
    $('#sme_epistemic_add_form').removeData('editing').hide();
  });

  $('#sme_epistemic_clear').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (
      !(await callGenericPopup(
        `Clear all Perspectives & Secrets entries for "${characterName}"?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;
    clearEpistemicKnowledge(characterName);
    injectEpistemicKnowledge(null, null);
    updateEpistemicUI(characterName);
    updateTokenDisplay();
  });

  $('#sme_read_only').on('change', async function () {
    const val = $(this).prop('checked');
    await setFreshStart(val);

    if (val) {
      // Record where this read-only window starts so we know which messages
      // to ghost if the user disables it later. setReadOnlyStartIndex also
      // records the current timestamp for session memory purging.
      const context = getContext();
      await setReadOnlyStartIndex(context.chat?.length ?? 0);
      $('body').addClass('sm-read-only');
    } else {
      const startIndex = getReadOnlyStartIndex();
      const startTime = getReadOnlyStartTime();
      const context = getContext();
      const endIndex = (context.chat?.length ?? 1) - 1;
      const hasWindow = startIndex !== null && endIndex >= startIndex;

      const commit = hasWindow
        ? await callGenericPopup(
            'Commit memories from this read-only session?\n\n' +
              'Yes - Keep session memories and extract long-term memories from this window.\n' +
              'No - Discard all memories and hide messages from this window.',
            POPUP_TYPE.CONFIRM,
          )
        : false;

      if (commit) {
        // Lift the gate and process the window as if it had always been active.
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
        await commitReadOnlyWindow(startIndex);
      } else {
        // Discard: purge session memories then ghost the messages.
        if (startTime !== null) {
          await purgeSessionMemoriesSince(startTime).catch((err) =>
            console.error('[Smart Memory Enhanced] Session memory purge failed:', err),
          );
        }
        if (hasWindow) {
          await hideChatMessageRange(startIndex, endIndex, false);
        }
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
      }
    }

    await injectMemories(ctrl.getSelectedCharacterName());
    await injectSessionMemories();
    updateSessionUI();
  });

  $('#sme_character_memory_policy').on('change', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    setCharacterMemoryPolicy(characterName, $(this).val());
    saveSettingsDebounced();
    await injectMemories(characterName);
    updateLongTermUI(characterName);
    updateTokenDisplay();
  });

  $('#sme_apply_bulk_character_memory_policy').on('click', async function () {
    if (isCatchUpRunning()) return;
    const policy = $('#sme_bulk_character_memory_policy').val();
    const characterNames = $('#sme_group_char_select option')
      .map((_, option) => option.value)
      .get()
      .filter(Boolean);
    if (!policy || characterNames.length < 2) return;

    const policyLabel = $('#sme_bulk_character_memory_policy option:selected').text();
    const confirmed = await callGenericPopup(
      `Apply “${policyLabel}” to all ${characterNames.length} character cards in this group chat?\n\n` +
        'This changes policy only. Existing memories stay in their current stores.',
      POPUP_TYPE.CONFIRM,
    );
    if (!confirmed) return;

    for (const characterName of characterNames) setCharacterMemoryPolicy(characterName, policy);
    saveSettingsDebounced();
    const selectedCharacterName = ctrl.getSelectedCharacterName();
    await injectMemories(selectedCharacterName);
    updateLongTermUI(selectedCharacterName);
    updateTokenDisplay();
    toastr.success(`Applied ${policyLabel} to ${characterNames.length} group characters.`, 'Smart Memory Enhanced');
  });

  $('#sme_extract_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.extractionRunning || ctrl.consolidationRunning) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    ctrl.extractionRunning = true;
    $(this).prop('disabled', true);
    setStatusMessage(`Extracting memories for ${characterName}...`);
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 20);
      const count = await extractAndStoreMemories(characterName, recentMessages, setStatusMessage);
      saveSettingsDebounced();
      updateLongTermUI(characterName);
      updateRelationshipHistoryUI(characterName);
      updateEpistemicUI(characterName);
      setStatusMessage(
        count > 0
          ? `${count} new memor${count === 1 ? 'y' : 'ies'} saved for ${characterName}.`
          : `No new memories found for ${characterName}.`,
      );
    } catch (err) {
      showError('Memory extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      ctrl.extractionRunning = false;
    }
  });

  $('#sme_clear_memories').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (!(await callGenericPopup(`Clear all memories for "${characterName}"?`, POPUP_TYPE.CONFIRM)))
      return;
    clearCharacterMemories(characterName);
    clearRelationshipHistory(characterName);
    clearEpistemicKnowledge(characterName);
    clearCanon(characterName);
    saveSettingsDebounced();
    updateLongTermUI(characterName);
    updateCanonUI(characterName);
    updateRelationshipHistoryUI(characterName);
    updateEpistemicUI(characterName);
    injectMemories(null).catch(console.error);
    injectRelationshipHistory(null);
    injectEpistemicKnowledge(null, null);
    injectStateLedger();
    setStatusMessage('Memories cleared.');
  });

  // ---- Session memory -------------------------------------------------
  $('#sme_session_enabled')
    .prop('checked', s.session_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSessionMemories();
    });

  $('#sme_session_extract_every')
    .val(s.session_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_extract_every = val;
      $('#sme_session_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_session_extract_every_value').text(s.session_extract_every);

  $('#sme_session_max_memories')
    .val(s.session_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_max_memories = val;
      $('#sme_session_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_session_max_memories_value').text(s.session_max_memories);

  $('#sme_session_template')
    .val(s.session_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_session_position"][value="${s.session_position}"]`).prop('checked', true);
  $('input[name="sme_session_position"]').on('change', function () {
    extension_settings[MODULE_NAME].session_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_session_depth')
    .val(s.session_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_session_role')
    .val(s.session_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_session_inject_budget_value').text(s.session_inject_budget ?? 400);
  $('#sme_session_inject_budget')
    .val(s.session_inject_budget ?? 400)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_inject_budget = v;
      $('#sme_session_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_session_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (isFreshStart()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting session memories...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 40);
      const count = await extractSessionMemories(recentMessages);
      await injectSessionMemories();
      updateSessionUI();
      updateTokenDisplay();
      setStatusMessage(
        count > 0
          ? `${count} session item${count === 1 ? '' : 's'} saved.`
          : 'No new session items found.',
      );
    } catch (err) {
      showError('Session extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_session').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all session memories for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    try {
      await runStagedChatCleanup(getContext(), async () => {
        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearStateLedger();
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Clear session persistence failed:', err);
      setStatusMessage('Session memories were not cleared because the chat could not be saved.');
      toastr.error('Could not save the cleared session memories. Please try again.', 'Smart Memory Enhanced');
      return;
    }
    injectSessionMemories();
    injectStateLedger();
    updateSessionUI();
    setStatusMessage('Session memories cleared.');
  });

  // ---- Scene detection ------------------------------------------------
  $('#sme_scene_enabled')
    .prop('checked', s.scene_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSceneHistory();
    });

  $('#sme_scene_ai_detect')
    .prop('checked', s.scene_ai_detect)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_ai_detect = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_scene_inject_count')
    .val(s.scene_inject_count)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_inject_count = val;
      $('#sme_scene_inject_count_value').text(val);
      saveSettingsDebounced();
      injectSceneHistory();
    });
  $('#sme_scene_inject_count_value').text(s.scene_inject_count);
  $('#sme_scene_archive_max')
    .val(s.scene_archive_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_archive_max = val;
      $('#sme_scene_archive_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_scene_archive_max_value').text(s.scene_archive_max);

  $(`input[name="sme_scene_position"][value="${s.scene_position}"]`).prop('checked', true);
  $('input[name="sme_scene_position"]').on('change', function () {
    extension_settings[MODULE_NAME].scene_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_scene_depth')
    .val(s.scene_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].scene_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_scene_role')
    .val(s.scene_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_scene_inject_budget_value').text(s.scene_inject_budget ?? 300);
  $('#sme_scene_inject_budget')
    .val(s.scene_inject_budget ?? 300)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_inject_budget = v;
      $('#sme_scene_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_scenes_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Summarizing current scene...');
    try {
      const context = getContext();
      // Use buffered messages since last break if available, else fall back to
      // the last 40 messages - capped to avoid overflowing the model context.
      const messages =
        ctrl.sceneMessageBuffer.length > 0 ? ctrl.sceneMessageBuffer : context.chat.slice(-40);
      const sceneResult = await summarizeScene(messages);
      if (sceneResult?.summary) {
        const history = loadSceneHistory();
        history.push(createSceneRecord(sceneResult.summary, messages, {
          detected_by: 'manual',
          character_participants: sceneResult.characterParticipants,
        }));
        await saveSceneHistory(history);
        // Reset the buffer - we just archived what was in it.
        ctrl.sceneMessageBuffer = [];
        ctrl.sceneBufferLastIndex = -1;
        injectSceneHistory();
        updateScenesUI();
        updateTokenDisplay();
        setStatusMessage('Scene added to history.');
      } else {
        setStatusMessage('Scene summary failed.');
      }
    } catch (err) {
      showError('Scene extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_scenes').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all scene history for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearSceneHistory();
    injectSceneHistory();
    updateScenesUI();
    setStatusMessage('Scene history cleared.');
  });

  // Delegated because the archive list is re-rendered after each change.
  $(document)
    .off('click.smeSceneArchive', '.sme_jump_scene, .sme_edit_scene, .sme_delete_scene, .sme_resummarize_scene')
    .on('click.smeSceneArchive', '.sme_jump_scene, .sme_edit_scene, .sme_delete_scene, .sme_resummarize_scene', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number($(this).data('index'));
      const history = loadSceneHistory();
      const scene = history[index];
      if (!scene) return;

      if ($(this).hasClass('sme_jump_scene')) {
        const message = $(`#chat .mes[mesid="${scene.source_start_index}"]`)[0];
        if (message) message.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else toastr.info(`Source message ${scene.source_start_index + 1} is not currently rendered in the chat.`, 'Smart Memory Enhanced');
        return;
      }

      if ($(this).hasClass('sme_edit_scene')) {
        const summary = await callGenericPopup('Edit scene summary:', POPUP_TYPE.INPUT, scene.summary);
        if (summary === false || summary === null || !String(summary).trim()) return;
        history[index] = { ...scene, summary: String(summary).trim(), detected_by: 'manual' };
      } else if ($(this).hasClass('sme_delete_scene')) {
        if (!(await callGenericPopup('Delete this scene from the archive?', POPUP_TYPE.CONFIRM))) return;
        history.splice(index, 1);
      } else {
        const context = getContext();
        const messages = (scene.source_message_indices ?? []).map((sourceIndex) => context.chat[sourceIndex]).filter(Boolean);
        if (messages.length === 0) {
          toastr.warning('This archived scene has no readable source range to summarize again.', 'Smart Memory Enhanced');
          return;
        }
        const sceneResult = await summarizeScene(messages);
        if (!sceneResult?.summary) return;
        history[index] = createSceneRecord(sceneResult.summary, messages, {
          id: scene.id,
          source_memory_ids: scene.source_memory_ids ?? [],
          detected_by: 'manual',
          character_participants: sceneResult.characterParticipants,
        });
      }
      await saveSceneHistory(history);
      injectSceneHistory();
      updateScenesUI();
      updateTokenDisplay();
    });

  // ---- Story arcs -----------------------------------------------------
  $('#sme_arcs_enabled')
    .prop('checked', s.arcs_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectArcs();
    });

  $('#sme_arcs_max')
    .val(s.arcs_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_max = val;
      $('#sme_arcs_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_arcs_max_value').text(s.arcs_max);

  $(`input[name="sme_arcs_position"][value="${s.arcs_position}"]`).prop('checked', true);
  $('input[name="sme_arcs_position"]').on('change', function () {
    extension_settings[MODULE_NAME].arcs_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_arcs_depth')
    .val(s.arcs_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].arcs_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_arcs_role')
    .val(s.arcs_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_arcs_inject_budget_value').text(s.arcs_inject_budget ?? 200);
  $('#sme_arcs_inject_budget')
    .val(s.arcs_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_inject_budget = v;
      $('#sme_arcs_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_arcs_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting story arcs...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 100);
      const count = await extractArcs(recentMessages);
      injectArcs();
      updateArcsUI();
      setStatusMessage(
        count > 0 ? `${count} arc${count === 1 ? '' : 's'} found.` : 'No new arcs found.',
      );
    } catch (err) {
      showError('Arc extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_arcs').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all story arcs for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearArcs();
    injectArcs();
    updateArcsUI();
    setStatusMessage('Arcs cleared.');
  });

  // ---- Away recap -----------------------------------------------------
  $('#sme_recap_enabled')
    .prop('checked', s.recap_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].recap_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_recap_threshold')
    .val(s.recap_threshold_hours)
    .on('input', function () {
      const val = parseFloat($(this).val());
      extension_settings[MODULE_NAME].recap_threshold_hours = val;
      $('#sme_recap_threshold_value').text(val + 'h');
      saveSettingsDebounced();
    });
  $('#sme_recap_threshold_value').text(s.recap_threshold_hours + 'h');

  $('#sme_recap_now').on('click', async function () {
    $(this).prop('disabled', true);
    setStatusMessage('Generating recap...');
    try {
      const recap = await generateRecap();
      if (recap) {
        displayRecap(recap);
        setStatusMessage('Recap displayed.');
      } else {
        setStatusMessage('Recap failed.');
      }
    } catch (err) {
      showError('Recap generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // ---- Catch Up -------------------------------------------------------

  // Maximum messages per catch-up chunk. Acts as a hard cap even when messages
  // are very short, so the model always has some turn-by-turn structure to work with.
  const CATCH_UP_CHUNK_SIZE = 20;

  // Token budget for chat content per catch-up chunk is computed dynamically
  // from the configured context size at the time catch-up runs - see below.

  $('#sme_resume_catch_up').on('click', function () {
    if (ctrl.extractionRunning || ctrl.compactionRunning) return;
    if (!getResumableCatchUpCheckpoint()) {
      refreshCatchUpRecoveryUI();
      return;
    }
    $('#sme_catch_up').data('smeResumeRequested', true).trigger('click');
  });

  $('#sme_catch_up').on('click', async function () {
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
      toastr.warning('An extraction is already running.', 'Smart Memory Enhanced', { timeOut: 3000 });
      return;
    }
    const resumeRequested = $(this).data('smeResumeRequested') === true;
    $(this).removeData('smeResumeRequested');
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character is active.', 'Smart Memory Enhanced', { timeOut: 3000 });
      return;
    }

    // In group chats, build the full list of active member names so long-term
    // extraction runs for every character, not just the one in the selector.
    // Solo chats collapse to a single-element array using the active character.
    const catchUpContext = getContext();
    // Capture the *live* persona before any confirmation dialog or provider
    // call. Imported JSONL headers can contain placeholder persona fields, so
    // final reconciliation must never rediscover this from serialized chat
    // metadata after a long run.
    const resumableCheckpoint = resumeRequested ? getResumableCatchUpCheckpoint(catchUpContext) : null;
    if (resumeRequested && !resumableCheckpoint) {
      toastr.warning('There is no compatible incomplete Memorize Chat run to resume.', 'Smart Memory Enhanced', { timeOut: 4000 });
      refreshCatchUpRecoveryUI();
      return;
    }
    const canonicalRuntimeContext = resumableCheckpoint?.canonical_runtime_context
      ?? snapshotCanonicalRuntimeContext(getLivePersonaCaptureContext(catchUpContext));
    const catchUpGroup = catchUpContext.groupId
      ? catchUpContext.groups?.find((group) => group.id === catchUpContext.groupId)
      : null;
    const historicalParticipantScope = resumableCheckpoint?.historical_participant_scope
      ?? resolveHistoricalGroupParticipants({
        group: catchUpGroup,
        characters: catchUpContext.characters ?? [],
        messages: catchUpContext.chat ?? [],
        fallbackCharacterName: characterName,
      });
    const catchUpCharacterNames = historicalParticipantScope.participant_names;
    const catchUpProfileCharacterNames = historicalParticipantScope.semantic_participant_names ?? catchUpCharacterNames;

    // Warn if memories already exist for any character in the list.
    const existingMemories = catchUpCharacterNames.some(
      (name) => loadCharacterMemories(name).length > 0,
    );
    if (existingMemories && !resumableCheckpoint) {
      if (
        !(await callGenericPopup(
          'Memories already exist for one or more characters. Running Memorize Chat again may add near-duplicate entries on top of existing ones.\n\nContinue?',
          POPUP_TYPE.CONFIRM,
        ))
      )
        return;
    }

    // The catch-up loop holds extractionRunning=true for its entire duration.
    // This blocks the background extraction path in onCharacterMessageRendered
    // from running concurrently, so consolidationRunning does not need a
    // separate check here - no other path can interleave with catch-up while
    // extractionRunning is set.
    ctrl.extractionRunning = true;
    ctrl.compactionRunning = true;
    ctrl.catchUpCancelled = false;
    $('#sme_resume_catch_up').prop('disabled', true);
    // The developer check touches the same durable stores as catch-up. Make
    // its unavailable state visible instead of relying only on a click-time
    // warning.
    $('#sme_run_idempotence_check').prop('disabled', true);
    setCanonicalRuntimeContextSnapshot(canonicalRuntimeContext);
    // A run ID is written before extraction so every entity link resolved by
    // a tier can distinguish this run from legacy/mirrored data at final
    // reconciliation. It is persisted by the existing staged chat save.
    const catchUpRunId = resumableCheckpoint?.run_id ?? generateMemoryId();
    catchUpContext.chatMetadata = catchUpContext.chatMetadata ?? {};
    catchUpContext.chatMetadata[META_KEY] = catchUpContext.chatMetadata[META_KEY] ?? {};
    // Preserve the reset proof created before this run.  Catch-up diagnostics
    // must describe both what the run generated and the clean baseline it
    // started from; never overwrite this evidence with current-run state.
    const preRunFreshStartAudit = catchUpContext.chatMetadata[META_KEY].fresh_start_postcondition_audit ?? null;
    catchUpContext.chatMetadata[META_KEY].active_catchup_run_id = catchUpRunId;
    // Persist only the compact historical identity evidence needed to restore
    // canonical IDs after reload. The full transcript remains the authority;
    // this is an audit snapshot, never a generated memory.
    if (canonicalRuntimeContext.historical_persona) {
      catchUpContext.chatMetadata[META_KEY].historical_persona_snapshot = {
        ...canonicalRuntimeContext.historical_persona,
        run_id: catchUpRunId,
      };
    } else {
      delete catchUpContext.chatMetadata[META_KEY].historical_persona_snapshot;
    }
    // Retain the finalized identity context with this chat's durable graph.
    // Once runtime cleanup occurs, the optional Developer check must not
    // rebuild a different current persona from imported header fields.
    catchUpContext.chatMetadata[META_KEY].canonical_persona_context = structuredClone(canonicalRuntimeContext);
    let catchUpErrorCount = 0;
    const runResult = {
      run_id: catchUpRunId,
      historical_participant_scope: historicalParticipantScope,
      totalChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      retriedRequests: 0,
      extractionFailuresByTier: {},
      saveFailures: 0,
      providerFailures: [],
      errors: [],
      warnings: [],
      warningsSuppressed: 0,
      status: 'completed',
      chunks: [],
      extractionCoverage: {
        longterm: { records: [], summary: null },
        session: { records: [], summary: null },
      },
      arcResolution: { resolved: 0, still_open: 0, abandoned: 0, superseded: 0, insufficient_evidence: 0 },
      arcExtraction: { attempted: 0, request_completed: 0, provider_error: 0, http_status: null, error_class: null, non_retryable: false, returned_none: 0, malformed_output: 0, parsed_candidates: 0, accepted_open_threads: 0, rejected_completed_events: 0, rejected_background_facts: 0, rejected_relationship_states: 0, rejected_scene_details: 0, rejected_malformed: 0, participant_repairs: 0, participant_review_items: 0, terminal_reconciled: false, malformed_request: 0, input_token_budget: 0, input_token_estimate: 0, input_messages: 0, omitted_messages: 0, truncated_message: false, terminal_outcome: null },
      arcPipeline: { classifiedResolved: 0, generationAttempted: 0, generatorNone: 0, generatorMalformed: 0, preverificationRejected: 0, verifiedSupported: 0, verifiedAmbiguous: 0, verifiedUnsupported: 0, persisted: 0, providerError: 0, records: [] },
      sessionExtraction: {
        emitted: 0,
        validated: 0,
        missingProvenance: 0,
        repairAttempts: 0,
        repairRecovered: 0,
        repairEligible: 0,
        repairProviderError: 0,
        repairReturnedNone: 0,
        repairMalformed: 0,
        repairStillInvalid: 0,
        repairSemanticallyUnsupported: 0,
        repairAccepted: 0,
        rejectedByValidation: 0,
        providerFailures: 0,
        providerReturnedNone: 0,
        malformedOutput: 0,
        terminalDispositions: {
          accepted_validated: 0,
          accepted_after_citation_repair: 0,
          missing_provenance: 0,
          semantic_support_rejected: 0,
          malformed_candidate: 0,
          duplicate_same_pass: 0,
          duplicate_existing: 0,
          provider_or_parser_error: 0,
          provider_returned_none: 0,
        },
      },
      profiles: { profiles_attempted: 0, profiles_parsed: 0, profiles_saved: 0, malformed_output: 0, malformed_output_details: [], attempts: [], terminal_accounting: null, family_role_pipeline_traces: [], family_coreference_traces: [], sibling_role_persistence_summary: [], family_role_persistence_summary: [], family_role_evidence_deduplication: [], family_role_trace_validation_failures: [], relationship_history_counts: [], profile_relationship_self_targets_rejected: { count: 0, records: [] }, profile_relationship_quality_breakdown: { fields_dropped_conflict: 0, fields_dropped_no_supported_descriptors: 0, fields_dropped_placeholder_only: 0, descriptors_rejected_unsupported: 0, descriptors_rejected_placeholder: 0, roles_unresolved: 0, canonical_roles_preserved: 0 }, sections_detected: { character_state: 0, world_state: 0, relationship_matrix: 0 }, fields: { accepted_exact: 0, accepted_normalized: 0, preserved_prior: 0, dropped_conflict: 0, dropped_speculative: 0, dropped_invalid_label: 0, dropped_unsupported: 0, dropped_malformed: 0 }, descriptor_outcomes: { accepted_exact: 0, accepted_normalized_synonym: 0, rejected_conflict: 0, rejected_unsupported: 0, rejected_placeholder: 0, rejected_malformed: 0, superseded_by_authoritative: 0 }, field_outcomes: { saved_with_all_descriptors: 0, saved_with_partial_descriptors: 0, preserved_authoritative_value: 0, dropped_no_supported_descriptors: 0, dropped_malformed_field: 0 }, relationship_conflict_details: [], relationship_descriptor_rejections: 0, relationship_field_rejections: 0, relationship_dropped_field_descriptor_count: 0, sections_parsed: 0, stale_fields_dropped: 0, speculative_fields_dropped: 0, unsupported_fields_dropped: 0, prior_fields_preserved: 0, relationship_conflicts_dropped: 0, relationshipConflictsDropped: 0, speculativeCurrentFieldsDropped: 0, preservedPriorFields: 0 },
      identity_review: { existing_at_start: extension_settings[MODULE_NAME]?.identity_review_queue?.length ?? 0, created_this_run: 0, resolved_this_run: 0, removed_as_duplicate: 0, remaining_at_end: extension_settings[MODULE_NAME]?.identity_review_queue?.length ?? 0 },
      finalReconciliation: { attempted: 0, completed: 0, rolled_back: false, failure_stage: null, error_class: null, error_message: null, persona_roster_size: 0, persona_aliases_merged: 0, card_local_entities_merged: 0, relationship_pairs_merged: 0, participant_lists_rewritten: 0, synthetic_parentheticals_removed: 0, identity_decision_duplicates_removed: 0, resolved_review_items_removed: 0, stale_entity_references: 0, unsafe_merge_candidates: 0, unsafe_merge_candidates_rejected: 0, safe_merge_candidates_completed: 0, review_items_created: 0, integrity_audit: null, personaRosterSize: 0, personaAliasesMerged: 0, cardLocalEntitiesMerged: 0, relationshipPairsMerged: 0, participantListsRewritten: 0, syntheticParentheticalsRemoved: 0 },
      runtimeContext: canonicalRuntimeContext,
      quality: { status: 'clean', reasons: [] },
    };
    let currentChunkFailed = false;
    let finalTransaction = null;
    const recordCatchUpError = (label, err, tier = null, isSave = false) => {
      catchUpErrorCount++;
      setCatchUpErrorCount(catchUpErrorCount);
      currentChunkFailed = true;
      if (tier) runResult.extractionFailuresByTier[tier] = (runResult.extractionFailuresByTier[tier] ?? 0) + 1;
      if (isSave) runResult.saveFailures++;
      runResult.errors.push({
        label,
        tier,
        persistence: isSave,
        message: String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 300),
      });
      if (err?.sme_request_diagnostics) {
        runResult.providerFailures.push({
          label,
          tier,
          ...err.sme_request_diagnostics,
        });
      }
      console.error(`[Smart Memory Enhanced] Catch-up ${label}:`, err);
    };
    const recordCatchUpWarning = (label, err, tier = null) => {
      // Avoid turning a repeated optional-provider failure (such as AI scene
      // detection) into a massive diagnostics payload that threatens the final
      // chat save itself.
      if (runResult.warnings.length < 50) {
        runResult.warnings.push({
          label,
          tier,
          message: String(err?.message ?? err ?? 'Unknown warning').replace(/\s+/g, ' ').slice(0, 300),
        });
      } else {
        runResult.warningsSuppressed++;
      }
      console.warn(`[Smart Memory Enhanced] Catch-up ${label}:`, err);
    };
    const runNonfatalPresentationTask = async (label, task) => {
      try {
        await task();
      } catch (err) {
        // Prompt/UI refresh does not change durable memories. Never let it
        // roll back a multi-hour extraction transaction.
        recordCatchUpWarning(`${label} warning`, err, 'presentation');
      }
    };
    const unsubscribeRetry = onMemoryRequestRetry(() => runResult.retriedRequests++);
    setCatchUpErrorCount(0);
    if (historicalParticipantScope.mode === 'historical_group_roster') {
      const disabledLabel = historicalParticipantScope.currently_disabled_included.length
        ? `; including ${historicalParticipantScope.currently_disabled_included.length} currently disabled historical participant${historicalParticipantScope.currently_disabled_included.length === 1 ? '' : 's'}`
        : '';
      setStatusMessage(`Historical rebuild: processing all ${catchUpCharacterNames.length} current group character${catchUpCharacterNames.length === 1 ? '' : 's'} with full chat history${disabledLabel}.`);
    }
    $('#sme_catch_up').hide();
    $('#sme_cancel_catch_up').show().prop('disabled', false);

    try {
      const context = getContext();
      const settings = extension_settings[MODULE_NAME];

      // Use the stable window first so an in-progress trailing swipe candidate
      // is not ingested during catch-up.
      const stableChat = ctrl.getStableExtractionWindowWithFallback(
        context.chat,
        context.chat.length,
      );

      // Filter to real messages only so system/hidden entries don't inflate
      // the chunk count or confuse the model.
      const discoveredMessages = stableChat
        .map((message, stableIndex) => {
          // Non-enumerable metadata is intentionally omitted from chat saves.
          // It lets every catch-up extraction retain source indices from the
          // original chat after system messages have been filtered out.
          const originalIndex = context.chat.indexOf(message);
          Object.defineProperty(message, '__sme_original_index', { value: originalIndex >= 0 ? originalIndex : stableIndex, configurable: true });
          return message;
        })
        .filter((m) => m.mes && !m.is_system);
      const resumeSourceValidation = resumableCheckpoint
        ? validateCatchUpResumeSource(resumableCheckpoint, discoveredMessages)
        : null;
      if (resumableCheckpoint && !resumeSourceValidation.valid) {
        throw new Error('The chat source window changed before the incomplete run could be resumed. Start a new Memorize Chat run instead.');
      }
      // A resumed run intentionally retains the original source-window end.
      // Messages appended after a crash are left for normal post-recovery
      // extraction rather than being mixed into the historical rebuild.
      const allMessages = resumableCheckpoint
        ? discoveredMessages.slice(0, resumeSourceValidation.source_message_count)
        : discoveredMessages;
      const total = allMessages.length;
      const resumeOffset = resumableCheckpoint ? resumeSourceValidation.resume_offset : 0;
      const checkpoint = resumableCheckpoint ?? {
        schema_version: 1,
        run_id: catchUpRunId,
        started_at: Date.now(),
        source_message_count: total,
        source_last_original_index: allMessages.at(-1)?.__sme_original_index ?? null,
        next_source_offset: 0,
        committed_chunks: 0,
        historical_participant_scope: structuredClone(historicalParticipantScope),
        canonical_runtime_context: structuredClone(canonicalRuntimeContext),
      };
      checkpoint.status = 'in_progress';
      checkpoint.updated_at = Date.now();
      checkpoint.next_source_offset = resumeOffset;
      checkpoint.source_message_count = total;
      checkpoint.source_last_original_index = allMessages.at(-1)?.__sme_original_index ?? null;
      catchUpContext.chatMetadata[META_KEY].catch_up_checkpoint = checkpoint;
      // Persist before any provider work. If the process exits during the
      // first request, a restart can still resume from the known zero offset.
      await retryTransientMemoryOperation(() => saveChatMetadata(catchUpContext));
      refreshCatchUpRecoveryUI();
      const timingSignature = diagnosticFingerprint(JSON.stringify({
        source: settings.source ?? 'main',
        model: settings.connection_profile_id ?? settings.openai_compat_model ?? settings.ollama_model ?? null,
        characters: catchUpCharacterNames.length,
        profiles: catchUpProfileCharacterNames.length,
        longterm: Boolean(settings.longterm_enabled && settings.consolidation_enabled),
        session: Boolean(settings.session_enabled),
        scenes: Boolean(settings.scene_enabled),
        scene_ai: Boolean(settings.scene_ai_detect),
        arcs: Boolean(settings.arcs_enabled && !isFreshStart()),
        compaction: Boolean(settings.compaction_enabled),
      }));
      const estimatedFinalizationUnits = Math.max(1,
        (settings.longterm_enabled && settings.consolidation_enabled ? catchUpCharacterNames.length : 0)
        + (settings.session_enabled ? 1 : 0)
        + (settings.scene_enabled ? 1 : 0)
        + (settings.arcs_enabled && !isFreshStart() ? 1 : 0)
        + (settings.compaction_enabled ? 1 : 0)
        + (settings.profiles_enabled ? catchUpProfileCharacterNames.length : 0)
        + 1,
      );
      const median = (values) => {
        const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
      };
      const comparableTimingHistory = (settings.catch_up_timing_history ?? [])
        .filter((entry) => entry?.signature === timingSignature && entry?.completed === true)
        .slice(-8);
      const historicalChunkMsPerMessage = median(comparableTimingHistory.map((entry) => Number(entry.chunk_ms_per_message)));
      const historicalFinalizationMsPerUnit = median(comparableTimingHistory.map((entry) => Number(entry.finalization_ms_per_unit)));
      const finalizationPhaseKind = (label) => {
        const text = String(label ?? '').toLowerCase();
        if (text.startsWith('long-term consolidation')) return 'longterm_consolidation';
        if (text.startsWith('session-memory consolidation')) return 'session_consolidation';
        if (text.startsWith('scene detection')) return 'scene_detection';
        if (text.startsWith('story-arc extraction')) return 'arc_extraction';
        if (text.startsWith('short-term memory extraction')) return 'shortterm_extraction';
        if (text.startsWith('profile generation')) return 'profile_generation';
        if (text.startsWith('final identity reconciliation')) return 'final_reconciliation';
        return 'other_finalization';
      };
      const finalizationPlan = [
        ...(settings.longterm_enabled && settings.consolidation_enabled ? Array(catchUpCharacterNames.length).fill('longterm_consolidation') : []),
        ...(settings.session_enabled ? ['session_consolidation'] : []),
        ...(settings.scene_enabled ? ['scene_detection'] : []),
        ...(settings.arcs_enabled && !isFreshStart() ? ['arc_extraction'] : []),
        ...(settings.compaction_enabled ? ['shortterm_extraction'] : []),
        ...(settings.profiles_enabled ? Array(catchUpProfileCharacterNames.length).fill('profile_generation') : []),
        'final_reconciliation',
      ];
      const historicalPhaseMs = Object.fromEntries([...new Set(finalizationPlan)].map((kind) => [kind, median(comparableTimingHistory.flatMap((entry) => {
        const samples = entry?.finalization_phase_durations?.[kind];
        return Array.isArray(samples) ? samples : [];
      }).map(Number))]));
      // Older timing samples only contain a whole-finalization average.  Use
      // it as a total budget, then distribute it conservatively by workload
      // shape rather than pretending a short-term provider request costs the
      // same as a bookkeeping-only consolidation phase.
      const finalizationPhaseWeights = {
        longterm_consolidation: 1,
        session_consolidation: 1,
        scene_detection: 2,
        arc_extraction: 2,
        shortterm_extraction: 4,
        profile_generation: 3,
        final_reconciliation: 2,
      };
      const totalFinalizationWeight = finalizationPlan.reduce((sum, kind) => sum + (finalizationPhaseWeights[kind] ?? 1), 0);
      // Provider speed, output length, and enabled tiers vary by chat, so an
      // ETA can only be an observed-rate estimate. Keep it explicitly scoped
      // to the token-limited chunk phase; late finalization tasks have no
      // reliable work-unit count and must not be represented as a precise ETA.
      const catchUpTiming = {
        started_at: Date.now(),
        completed_messages: 0,
        elapsed_ms: 0,
        estimated_remaining_ms: null,
        estimate_available: false,
      };
      const formatCatchUpDuration = (milliseconds) => {
        const seconds = Math.max(0, Math.round(Number(milliseconds ?? 0) / 1000));
        if (seconds < 60) return `~${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        if (minutes < 60) return `~${minutes}m${remainder ? ` ${remainder}s` : ''}`;
        const hours = Math.floor(minutes / 60);
        return `~${hours}h ${minutes % 60}m`;
      };
      const updateCatchUpEta = (completedMessages, { finalizing = false } = {}) => {
        const eta = $('#sme_catch_up_eta');
        catchUpTiming.completed_messages = Math.max(0, Math.min(total, Number(completedMessages) || 0));
        catchUpTiming.elapsed_ms = Date.now() - catchUpTiming.started_at;
        if (finalizing) {
          catchUpTiming.estimated_remaining_ms = null;
          catchUpTiming.estimate_available = false;
          eta.text('Finalizing remaining memory tiers…').show();
          return;
        }
        const observedChunkRate = catchUpTiming.completed_messages > 0 && catchUpTiming.elapsed_ms >= 1000
          ? catchUpTiming.elapsed_ms / catchUpTiming.completed_messages
          : null;
        const chunkRate = observedChunkRate ?? historicalChunkMsPerMessage;
        if (!total || !chunkRate) {
          catchUpTiming.estimated_remaining_ms = null;
          catchUpTiming.estimate_available = false;
          eta.text('Estimating chunk-processing time…').show();
          return;
        }
        const chunkRemaining = Math.round(chunkRate * (total - catchUpTiming.completed_messages));
        const finalizationRemaining = historicalFinalizationMsPerUnit
          ? Math.round(historicalFinalizationMsPerUnit * estimatedFinalizationUnits)
          : Math.max(60_000, Math.round((chunkRemaining + catchUpTiming.elapsed_ms) * 0.25));
        catchUpTiming.estimated_remaining_ms = chunkRemaining + finalizationRemaining;
        catchUpTiming.estimate_available = true;
        const rangeLow = Math.round(catchUpTiming.estimated_remaining_ms * (historicalFinalizationMsPerUnit ? 0.8 : 0.6));
        const rangeHigh = Math.round(catchUpTiming.estimated_remaining_ms * (historicalFinalizationMsPerUnit ? 1.2 : 1.6));
        eta.text(`Estimated total time remaining: ${formatCatchUpDuration(rangeLow)}–${formatCatchUpDuration(rangeHigh)}${historicalFinalizationMsPerUnit ? ` (based on ${comparableTimingHistory.length} comparable run${comparableTimingHistory.length === 1 ? '' : 's'})` : ' (provisional until a comparable run completes)'}.`).show();
        return;
      };
      // The final pass has a different workload shape from the chunk loop:
      // it can include scene summaries, compaction, profiles, and local graph
      // reconciliation.  It still has bounded, known phases, so retain a
      // deliberately rough ETA instead of dropping the estimate entirely.
      // The estimate learns from completed final-phase units in this run; it
      // never pretends that the earlier per-message rate is a provider-speed
      // prediction for a different kind of request.
      const finalizationTiming = {
        started_at: null,
        completed_units: 0,
        planned_units: 0,
        active_phase: null,
        active_label: null,
        active_phase_started_at: null,
        phase_durations: {},
      };
      let finalizationEtaRefreshTimer = null;
      const updateFinalizationEta = (label, { completed = false, refreshOnly = false } = {}) => {
        const eta = $('#sme_catch_up_eta');
        if (!finalizationTiming.started_at) {
          finalizationTiming.started_at = Date.now();
          finalizationTiming.planned_units = estimatedFinalizationUnits;
        }
        const phaseKind = finalizationPhaseKind(label);
        const now = Date.now();
        if (completed && finalizationTiming.active_phase) {
          const duration = Math.max(0, now - finalizationTiming.active_phase_started_at);
          (finalizationTiming.phase_durations[finalizationTiming.active_phase] ??= []).push(duration);
          finalizationTiming.completed_units = Math.min(finalizationTiming.planned_units, finalizationTiming.completed_units + 1);
          finalizationTiming.active_phase = null;
          finalizationTiming.active_label = null;
          finalizationTiming.active_phase_started_at = null;
        } else if (!refreshOnly && !finalizationTiming.active_phase) {
          finalizationTiming.active_phase = phaseKind;
          finalizationTiming.active_label = label;
          finalizationTiming.active_phase_started_at = now;
          finalizationEtaRefreshTimer ??= window.setInterval(() => {
            if (finalizationTiming.active_phase) updateFinalizationEta(finalizationTiming.active_label, { refreshOnly: true });
          }, 15_000);
        }
        const activeElapsed = finalizationTiming.active_phase_started_at ? Math.max(0, now - finalizationTiming.active_phase_started_at) : 0;
        const completedUnits = finalizationTiming.completed_units;
        const remainingUnits = Math.max(0, finalizationTiming.planned_units - completedUnits);
        const observedPhaseAverage = median(Object.values(finalizationTiming.phase_durations).flat());
        const weightedHistoricalEstimate = (kind) => historicalFinalizationMsPerUnit
          ? Math.round(historicalFinalizationMsPerUnit * finalizationTiming.planned_units * ((finalizationPhaseWeights[kind] ?? 1) / totalFinalizationWeight))
          : null;
        const phaseEstimate = (kind) => historicalPhaseMs[kind] ?? weightedHistoricalEstimate(kind) ?? observedPhaseAverage ?? null;
        const activeEstimate = finalizationTiming.active_phase ? phaseEstimate(finalizationTiming.active_phase) : 0;
        const futureKinds = finalizationPlan.slice(completedUnits + (finalizationTiming.active_phase ? 1 : 0));
        const futureEstimate = futureKinds.reduce((totalMs, kind) => {
          const estimate = phaseEstimate(kind);
          return estimate ? totalMs + estimate : totalMs;
        }, 0);
        const estimatedRemaining = !Number.isFinite(activeEstimate) || futureKinds.some((kind) => !Number.isFinite(phaseEstimate(kind)))
          ? null
          : Math.max(0, Math.round(Math.max(0, activeEstimate - activeElapsed) + futureEstimate));
        catchUpTiming.estimated_remaining_ms = estimatedRemaining;
        catchUpTiming.estimate_available = estimatedRemaining !== null;
        const displayPhase = Math.min(completedUnits + (finalizationTiming.active_phase ? 1 : 0), finalizationTiming.planned_units);
        eta.text(`Finalizing: ${finalizationTiming.active_label ?? label} (${displayPhase}/${finalizationTiming.planned_units} phases)${estimatedRemaining !== null ? ` - rough remaining estimate: ${formatCatchUpDuration(estimatedRemaining)}.` : ' - estimating remaining time from completed phases.'}`).show();
      };
      updateCatchUpEta(0);

      // Process the chat in token-limited chunks sequentially. Each extraction
      // function loads its existing results and passes them as context to the
      // model, so each chunk naturally builds on what the previous one found.
      // Budget = 35% of the configured context size, leaving the remainder for
      // prompt overhead (instructions, existing memories) and the model response.
      const catchUpTokenBudget = Math.max(500, Math.floor(getMaxContextSize(0) * 0.35));
      let i = resumeOffset;
      if (resumableCheckpoint) {
        setStatusMessage(`Resuming Memorize Chat from ${i}/${total} safely committed source messages...`);
      }
      while (i < total) {
        if (ctrl.catchUpCancelled) break;
        currentChunkFailed = false;

        // Yield to the browser event loop at the start of each chunk so the
        // UI remains responsive and the cancel button stays clickable even
        // when individual model calls complete quickly (e.g. cached responses).
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Build the chunk by accumulating messages until the token budget or
        // the message cap is reached. Always include at least one message so
        // a single very long message does not stall the loop forever.
        const chunk = [];
        let chunkTokens = 0;
        for (let j = i; j < total && chunk.length < CATCH_UP_CHUNK_SIZE; j++) {
          const msg = allMessages[j];
          const msgTokens = estimateTokens(`${msg.name}: ${msg.mes}`);
          if (chunk.length > 0 && chunkTokens + msgTokens > catchUpTokenBudget) break;
          chunk.push(msg);
          chunkTokens += msgTokens;
        }
        const processed = Math.min(i + chunk.length, total);
        const pct = Math.round((processed / total) * 100);
        const chunkTransaction = beginCatchUpTransaction(catchUpContext);
        setStatusMessage(
          `Catching up... (${i}/${total} messages, ${Math.round((i / total) * 100)}%)`,
        );

        if (settings.longterm_enabled && !isFreshStart()) {
          for (const name of catchUpCharacterNames) {
            // Historical group rebuilds intentionally give every current card
            // the full chunk. Older chats may predate the group split or carry
            // incorrect speaker attribution, so author filtering would hide
            // the only evidence for a card's earlier dialogue. The extraction
            // prompt remains explicitly targeted to `name`.
            const nameChunk = chunk;
            if (nameChunk.length === 0) continue;
            setStatusMessage(
              `Catching up... (${i}/${total} messages - extracting long-term for ${name})`,
            );
            await extractAndStoreMemories(name, nameChunk, setStatusMessage, { extractionCoverage: runResult.extractionCoverage }).catch((err) => {
              recordCatchUpError('long-term extraction error (chunk)', err, 'long-term');
            });
            // Consolidate after each chunk so near-duplicates are collapsed before
            // the next chunk can add more similar entries.
            if (settings.consolidation_enabled) {
              setStatusMessage(`Catching up... (${i}/${total} messages - consolidating ${name})`);
              await consolidateMemories(name).catch((err) => {
                recordCatchUpError('long-term consolidation error (chunk)', err, 'long-term');
              });
            }
          }
        }
        if (settings.session_enabled && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting session)`);
          await extractSessionMemories(chunk, null, { sessionDiagnostics: runResult.sessionExtraction, extractionCoverage: runResult.extractionCoverage }).catch((err) => {
            recordCatchUpError('session extraction error (chunk)', err, 'session');
          });
          setStatusMessage(`Catching up... (${i}/${total} messages - consolidating session)`);
          await consolidateSessionMemories().catch((err) => {
            recordCatchUpError('session consolidation error (chunk)', err, 'session');
          });
        }
        if (isStateLedgerEnabled() && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - updating state ledger)`);
          await runStateCardExtraction(characterName, chunk).catch((err) => {
            recordCatchUpError('State Ledger extraction error (chunk)', err, 'state-ledger');
          });
        }

        // Re-inject after each chunk so the token display reflects what is
        // actually stored, not just what was injected before catch-up started.
        // Wrap with .catch so an embedding failure here does not abort the
        // entire catch-up run via the outer catch block.
        if (settings.longterm_enabled && characterName) {
          await injectMemories(characterName).catch((err) => {
            recordCatchUpError('long-term injection error', err);
          });
        }
        if (settings.session_enabled) {
          await injectSessionMemories().catch((err) => {
            recordCatchUpError('session injection error', err);
          });
        }
        if (settings.arcs_enabled) {
          await runNonfatalPresentationTask('Story Arc injection', () => injectArcs());
        }
        if (settings.relationships_enabled) {
          await runNonfatalPresentationTask('Relationship History injection', () => injectRelationshipHistory(characterName));
        }

        // Advance lastExtractCutoff so the normal extraction window starts from
        // where catch-up left off rather than re-processing the same messages.
        const cuMeta = catchUpContext.chatMetadata?.[META_KEY];
        if (cuMeta) {
          const lastChunkMsg = chunk[chunk.length - 1];
          const chatIdx = lastChunkMsg
            ? catchUpContext.chat.lastIndexOf(lastChunkMsg)
            : catchUpContext.chat.length - 1;
          const cuCutoff =
            chatIdx >= 0 && lastChunkMsg && !lastChunkMsg.is_user && !lastChunkMsg.is_system
              ? chatIdx
              : chatIdx + 1;
          if (cuCutoff > (cuMeta.lastExtractCutoff ?? 0)) {
            cuMeta.lastExtractCutoff = cuCutoff;
          }
        }

        let chunkCommitted = false;
        const checkpointForCommit = catchUpContext.chatMetadata?.[META_KEY]?.catch_up_checkpoint;
        if (checkpointForCommit) {
          checkpointForCommit.next_source_offset = processed;
          checkpointForCommit.committed_chunks = Number(checkpointForCommit.committed_chunks ?? 0) + 1;
          checkpointForCommit.last_committed_source_start_index = chunk[0]?.__sme_original_index ?? null;
          checkpointForCommit.last_committed_source_end_index = chunk.at(-1)?.__sme_original_index ?? null;
          checkpointForCommit.updated_at = Date.now();
        }
        try {
          await retryTransientMemoryOperation(() => commitCatchUpTransaction(chunkTransaction));
          chunkCommitted = true;
          // The displayed recovery offset is intentionally refreshed only
          // after the same transaction succeeds. Live processing progress may
          // be ahead of this value, but the checkpoint always reflects what a
          // crash can safely resume without duplication.
          refreshCatchUpRecoveryUI();
        } catch (err) {
          // The transaction restores both chat metadata and extension state.
          // Do not advance past an uncommitted chunk: the persisted checkpoint
          // remains on its previous boundary and a later resume can safely
          // retry this exact window without loss or duplication.
          recordCatchUpError('chunk persistence error', err, null, true);
          ctrl.catchUpCancelled = true;
        }

        // Update progress and token display after each chunk so the user can
        // see memories accumulating in real time rather than only at the end.
        setStatusMessage(`Catching up... (${processed}/${total} messages, ${pct}%)`);
        updateCatchUpEta(processed);
        await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());

        runResult.totalChunks++;
        runResult.chunks.push({
          number: runResult.totalChunks,
          source_start_index: chunk[0]?.__sme_original_index ?? null,
          source_end_index: chunk.at(-1)?.__sme_original_index ?? null,
          message_count: chunk.length,
          token_estimate: chunkTokens,
          status: currentChunkFailed ? 'partial' : 'completed',
        });
        if (currentChunkFailed) runResult.failedChunks++;
        else runResult.completedChunks++;

        if (chunkCommitted) i += chunk.length;
      }

      // Scene detection and the final cross-tier passes run after the chunk
      // loop. Keep one transaction open for this whole phase so their metadata
      // writes do not fall back to individual SillyTavern chat saves.
      finalTransaction = beginCatchUpTransaction(catchUpContext);

      if (!ctrl.catchUpCancelled) {
        // The first actual finalization task starts the ETA clock. Do not make
        // this transition label a fake phase, or every later phase is shifted.
        // Complete the evidence tiers before scenes and arcs. This gives later
        // stages a stable, consolidated store and avoids creating a new arc
        // after the final identity-reconciliation phase has already begun.
        if (settings.longterm_enabled && settings.consolidation_enabled) {
          for (const name of catchUpCharacterNames) {
            updateFinalizationEta(`long-term consolidation for ${name}`);
            setStatusMessage(`Consolidating long-term memories for ${name}...`);
            await consolidateMemories(name, true).catch((err) => {
              recordCatchUpError('final long-term consolidation error', err);
            });
            updateFinalizationEta(`long-term consolidation for ${name}`, { completed: true });
          }
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }
        if (settings.session_enabled) {
          updateFinalizationEta('session-memory consolidation');
          setStatusMessage('Consolidating session memories...');
          await consolidateSessionMemories(true).catch((err) => {
            recordCatchUpError('final session consolidation error', err);
          });
          updateFinalizationEta('session-memory consolidation', { completed: true });
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }

        // Scene: walk through the full chat detecting and summarizing scenes.
        // When scene_ai_detect is enabled, AI detection runs on each AI message
        // (matching normal flow). When disabled, the heuristic is used instead.
        if (settings.scene_enabled) {
          updateFinalizationEta('scene detection and summaries');
          setStatusMessage('Detecting scene breaks...');
          const sceneHistory = loadSceneHistory();
          const minMessages = settings.scene_min_messages ?? 3;
          let sceneBuffer = [];
          let sceneCount = 0;
          let deferredSceneBoundary = null;
          const sceneAudit = { run_id: catchUpRunId, created_at: Date.now(), record_source: 'runtime', history_schema_version: 2, candidates: 0, generated: 0, duplicates: 0, failed: 0, detection_failed: 0, heuristic_break_candidates: 0, ai_breaks_rejected_by_deterministic_gate: 0, heuristic_candidates_pre_ai: 0, heuristic_fallback_candidates: 0, heuristic_fallback_breaks: 0, heuristic_fallback_no_breaks: 0, ai_breaks_added: 0, ai_no_breaks: 0, fallback_breaks_added: 0, fallback_no_breaks: 0, ai_decisions_valid: 0, ai_decisions_invalid: 0, ai_decisions_missing: 0, ai_breaks_removed: 0, final_break_indices: [], scene_boundary_source: [], scene_detector_model_request_count: 0, boundary_candidates_evaluated: 0, total_message_boundaries: 0, candidates_after_prefilter: 0, candidates_skipped_by_prefilter: 0, selection_signal_counts: {}, boundary_semantics: 'before_message', requests_sent: 0, initial_batch_requests: 0, partial_retry_requests: 0, single_candidate_retry_requests: 0, format_repair_requests: 0, total_provider_requests: 0, multi_candidate_requests: 0, request_counters_reconciled: true, batch_size_target: 12, average_candidates_per_request: 0, batched_requests: 0, malformed_batches: 0, retried_batches: 0, fallback_boundaries: 0, boundary_confidences: {}, task_sampling_settings: { temperature: 0, response_length_per_candidate: 32, minimum_response_length: 128, deterministic_break_gate: true }, model_identifier: extension_settings[MODULE_NAME]?.model ?? extension_settings[MODULE_NAME]?.source ?? 'main', connection_profile_identifier: extension_settings[MODULE_NAME]?.connection_profile_id ?? null, scene_detection_run_signature: null, candidate_context_hashes: [], candidate_context_hash_summary: null, prompt_shape_hash: diagnosticFingerprint('scene-boundary-batch-v5|prefiltered-boundary-before-message|requested_candidate_ids|candidate_id|break|confidence|deterministic-break-gate|previous-500|current-700') };
          const aiCandidates = [];
          if (settings.scene_ai_detect) {
            const selection = selectSceneBoundaryCandidates(allMessages, { cadence: 12, isGroupChat: Boolean(getContext()?.groupId) });
            aiCandidates.push(...selection.candidates);
            Object.assign(sceneAudit, selection.diagnostics);
            const selectionByCandidateId = new Map(selection.candidates.map((candidate) => [candidate.candidate_index, candidate]));
            const batchResult = await detectSceneBreakAIBatch(aiCandidates, { batchSize: sceneAudit.batch_size_target, onError: (err) => { sceneAudit.detection_failed++; recordCatchUpWarning('AI scene-break batch warning', err, 'scenes'); } });
            sceneAudit.boundary_candidates_evaluated = aiCandidates.length;
            sceneAudit.candidate_context_hashes = aiCandidates.map((candidate) => ({ candidate_id: candidate.candidate_index, context_hash: diagnosticFingerprint(`${candidate.previous_message}\n${candidate.message}`) }));
            sceneAudit.candidate_context_hash_summary = summarizeCandidateContexts(sceneAudit.candidate_context_hashes).summary;
            sceneAudit.scene_detection_run_signature = diagnosticFingerprint(sceneAudit.candidate_context_hashes.map((candidate) => `${candidate.candidate_id}:${candidate.context_hash}`).join('|'));
            sceneAudit.scene_detector_model_request_count = batchResult.diagnostics.total_provider_requests;
            Object.assign(sceneAudit, batchResult.diagnostics);
            sceneAudit.request_counters_reconciled = sceneAudit.total_provider_requests === (sceneAudit.initial_batch_requests + sceneAudit.partial_retry_requests + sceneAudit.single_candidate_retry_requests + sceneAudit.format_repair_requests);
            sceneAudit.ai_decisions = batchResult.decisions;
            sceneAudit.candidate_dispositions = batchResult.diagnostics.candidate_dispositions.map((item) => ({
              ...item,
              message_index: item.candidate_id,
              strong_candidate_admission: selectionByCandidateId.get(item.candidate_id)?.strong_candidate_admission ?? null,
              selection_provenance: selectionByCandidateId.get(item.candidate_id)?.selection_provenance ?? null,
            }));
            sceneAudit.ai_disposition_by_id = new Map(sceneAudit.candidate_dispositions.map((item) => [item.candidate_id, item]));
            sceneAudit.ai_decisions_valid = batchResult.diagnostics.candidate_dispositions.filter((item) => /^ai_/.test(item.terminal_disposition)).length;
            // Attempt-level parse misses remain available below for diagnosis,
            // while the public AI decision counters are derived only from the
            // final one-per-candidate dispositions after all bounded recovery.
            sceneAudit.attempt_invalid_decisions = batchResult.diagnostics.batch_attempts.reduce((total, item) => total + (item.invalid_decision_count ?? 0), 0);
            sceneAudit.attempt_missing_decisions = batchResult.diagnostics.batch_attempts.reduce((total, item) => total + (item.missing_candidate_ids?.length ?? 0), 0);
          }

          /**
           * Deduplicates a candidate summary against the last three stored scenes,
           * mirroring the check in processSceneBreak. Returns true if the summary
           * is too similar to an existing entry and should be skipped.
           */
          const isDuplicateScene = async (candidate) => {
            const recent = sceneHistory.slice(-3);
            for (const prev of recent) {
              const { score, semantic } = await sceneSimilarity(candidate, prev.summary);
              const threshold = semantic ? 0.82 : 0.55;
              if (score >= threshold) return true;
            }
            return false;
          };

          for (let msgIdx = 0; msgIdx < allMessages.length; msgIdx++) {
            if (ctrl.catchUpCancelled) break;
            const msg = allMessages[msgIdx];

            const msgText = msg.mes ?? '';
            const isAiMsg = !msg.is_user;

            if (settings.scene_ai_detect && sceneAudit.ai_decisions?.has(msgIdx)) {
              setStatusMessage(`Detecting scene breaks... (${msgIdx + 1}/${allMessages.length})`);
            }

            // Catch-up evaluates semantic boundaries before selected messages;
            // unlike live incremental detection, a historical boundary can be
            // triggered by either speaker's transition.
            const heuristicBreak = detectSceneBreakHeuristic(msgText);
            const aiRequestedBreak = settings.scene_ai_detect && Boolean(sceneAudit.ai_decisions?.get(msgIdx));
            const continuity = deriveSceneContinuitySignals(allMessages[msgIdx - 1]?.mes, msgText, {
              candidate_seam_index: msg.__sme_original_index ?? msgIdx,
            });
            // A closing message can contain the evidence that an interaction
            // ends (for example, a text exchange paused until morning), while
            // the following message is the actual next-scene opening. Align
            // before gate acceptance so the opening receives the complete
            // preceding scene length and still goes through the ordinary
            // gate, minimum-length, and coalescing checks.
            const hasTransitionProposal = aiRequestedBreak
              || heuristicBreak
              || continuity.explicit_transition
              || continuity.strongly_implied_transition;
            if (hasTransitionProposal && shouldDeferSceneBoundaryToNextMessage(msgText, allMessages[msgIdx + 1]?.mes)) {
              const deferredDisposition = sceneAudit.ai_disposition_by_id?.get(msgIdx);
              const alignment = {
                terminal_break_disposition: 'deferred_to_transition_opening',
                aligned_to_next_message_index: allMessages[msgIdx + 1]?.__sme_original_index ?? msgIdx + 1,
                same_message_alignment_applied: Boolean(continuity.pending_relocation_opening),
                alignment_reason: continuity.pending_relocation_opening ? 'pending_grounded_relocation_opening' : 'closing_interaction_next_opening',
                gate_executed: false,
                gate_output_schema_version: 1,
              };
              if (deferredDisposition) Object.assign(deferredDisposition, alignment);
              else sceneAudit.candidate_dispositions.push({
                candidate_id: msgIdx,
                message_index: msg.__sme_original_index ?? msgIdx,
                decision: false,
                source: 'deferred-transition-alignment',
                ...alignment,
              });
              sceneBuffer = advanceSceneBufferAtBoundary(sceneBuffer, msg, false).next_buffer;
              deferredSceneBoundary = {
                source_index: msg.__sme_original_index ?? msgIdx,
                disposition: deferredDisposition ?? null,
              };
              continue;
            }
            const gate = evaluateDeterministicSceneGate({
              // Heuristic-only operation still uses the exact same grounded
              // deterministic gate. Otherwise a bare heuristic proposal can
              // bypass direct-continuation protection simply because no
              // provider decision was requested.
              aiRequestedBreak: settings.scene_ai_detect ? aiRequestedBreak : heuristicBreak,
              heuristicBreak,
              // A `before_message` boundary belongs before `msg`, so the
              // minimum applies to the scene already accumulated rather than
              // counting the first message of the next scene in the old one.
              sceneLength: sceneBuffer.length,
              minimumSceneLength: minMessages,
              messageIndex: msg.__sme_original_index ?? msgIdx,
              previousBoundaryIndex: sceneAudit.final_break_indices.at(-1),
              continuity,
            });
            // Provider-negative candidates can now be rescued only by the
            // same grounded deterministic gate used for provider positives.
            // Persist its compact result on every selected candidate so later
            // A/B analysis can distinguish provider variance from gate work.
            let aiDisposition = sceneAudit.ai_disposition_by_id?.get(msgIdx);
            const deterministicRescue = !aiRequestedBreak && gate.deterministic_positive_rescue_used;
            if (aiDisposition) Object.assign(aiDisposition, gate, {
              gate_executed: gate.gate_result !== 'not_requested' || deterministicRescue,
              gate_output_schema_version: 1,
            });
            if (deterministicRescue && !aiDisposition) {
              aiDisposition = {
                candidate_id: msgIdx,
                message_index: msg.__sme_original_index ?? msgIdx,
                decision: false,
                source: 'deterministic-positive-rescue',
                terminal_disposition: 'deterministic_positive_rescue',
                ...gate,
                gate_executed: true,
                gate_output_schema_version: 1,
              };
              sceneAudit.candidate_dispositions.push(aiDisposition);
            }
            const coalescing = coalesceSceneBoundary({
              previousBoundaryIndex: sceneAudit.final_break_indices.at(-1),
              messageIndex: msg.__sme_original_index ?? msgIdx,
              minimumSceneLength: minMessages,
              continuity,
            });
            const requestedBreak = gate.accepted && !coalescing.suppress;
            // A deferred opening is only accepted when this message passes
            // the same gate as every other candidate. In particular, do not
            // bypass minimum-scene-length or coalescing with an alignment.
            const isDeferredBoundary = Boolean(deferredSceneBoundary && requestedBreak);
            const isBreak = requestedBreak;
            if (aiRequestedBreak || deterministicRescue) {
              if (gate.terminal_break_disposition === 'rejected_deterministic_gate') sceneAudit.ai_breaks_rejected_by_deterministic_gate++;
              Object.assign(aiDisposition ?? {}, gate, coalescing.suppress ? {
                terminal_break_disposition: 'coalesced_with_nearby_boundary',
                gate_result: 'rejected',
                gate_reason_code: coalescing.outcome,
                coalescing,
              } : { coalescing }, {
                gate_executed: true,
                gate_output_schema_version: 1,
              });
            }

            if (isBreak) {
              const disposition = isDeferredBoundary ? deferredSceneBoundary.disposition : aiDisposition;
              const boundarySource = isDeferredBoundary ? 'deferred-transition-alignment' : deterministicRescue ? 'deterministic-positive-rescue' : settings.scene_ai_detect ? (disposition?.source ?? 'heuristic-fallback') : 'deterministic-heuristic';
              if (isDeferredBoundary) sceneAudit.candidate_dispositions.push({
                ...(disposition ?? {}), candidate_id: msgIdx, message_index: msg.__sme_original_index ?? msgIdx,
                decision: true, source: boundarySource, terminal_break_disposition: 'accepted_aligned_to_transition_opening',
                aligned_from_message_index: deferredSceneBoundary.source_index,
              });
              deferredSceneBoundary = null;
              if (['ai-batch', 'ai-batch-recovered', 'ai-repair'].includes(boundarySource)) sceneAudit.ai_breaks_added++;
              else if (settings.scene_ai_detect) sceneAudit.fallback_breaks_added++;
              else sceneAudit.heuristic_break_candidates++;
              sceneAudit.final_break_indices.push(msg.__sme_original_index ?? msgIdx);
              sceneAudit.scene_boundary_source.push({
                candidate_id: msgIdx,
                message_index: msg.__sme_original_index ?? msgIdx,
                decision: true,
                source: boundarySource,
                ai_confidence: disposition?.ai_confidence ?? null,
                heuristic_score: disposition?.heuristic_score ?? null,
                batch_number: disposition?.batch_number ?? null,
                terminal_disposition: disposition?.terminal_disposition ?? 'deterministic_break',
              });
              sceneCount++;
              sceneAudit.candidates++;
              setStatusMessage(`Summarizing scene ${sceneCount}...`);
              const scenePartition = advanceSceneBufferAtBoundary(sceneBuffer, msg, true);
              const completedSceneMessages = scenePartition.completed_messages;
              const sceneResult = await summarizeScene(completedSceneMessages).catch((err) => {
                recordCatchUpError('scene summary error', err);
                sceneAudit.failed++;
                return null;
              });
              if (sceneResult?.summary && !(await isDuplicateScene(sceneResult.summary))) {
                sceneHistory.push(createSceneRecord(sceneResult.summary, completedSceneMessages, {
                  detected_by: boundarySource,
                  boundary_source: boundarySource,
                  detection_message_index: msg.__sme_original_index ?? null,
                  character_participants: sceneResult.characterParticipants,
                }));
                sceneAudit.generated++;
              } else if (sceneResult?.summary) {
                sceneAudit.duplicates++;
              }
              if (isEpistemicEnabled() && !isFreshStart()) {
                setStatusMessage(
                  `Summarizing scene ${sceneCount}... (extracting epistemic knowledge)`,
                );
                await extractEpistemicKnowledge(completedSceneMessages, characterName).catch((err) => {
                  recordCatchUpError('epistemic extraction error', err);
                });
              }
              // `before_message` means the current message begins the next
              // scene. Never summarize it as part of the one just closed.
              sceneBuffer = scenePartition.next_buffer;
            } else {
              sceneBuffer = advanceSceneBufferAtBoundary(sceneBuffer, msg, false).next_buffer;
            }
          }

          // Summarize any remaining messages after the last break as the current scene.
          if (!ctrl.catchUpCancelled && sceneBuffer.length >= minMessages) {
            sceneAudit.candidates++;
            const sceneResult = await summarizeScene(sceneBuffer).catch((err) => {
              recordCatchUpError('final scene summary error', err);
              sceneAudit.failed++;
              return null;
            });
            if (sceneResult?.summary && !(await isDuplicateScene(sceneResult.summary))) {
              sceneHistory.push(createSceneRecord(sceneResult.summary, sceneBuffer, {
                detected_by: 'final',
                boundary_source: 'final-fallback',
                detection_message_index: sceneBuffer.at(-1)?.__sme_original_index ?? null,
                character_participants: sceneResult.characterParticipants,
              }));
              sceneAudit.generated++;
            } else if (sceneResult?.summary) {
              sceneAudit.duplicates++;
            }
            if (isEpistemicEnabled() && !isFreshStart()) {
              setStatusMessage('Extracting epistemic knowledge from final scene...');
              await extractEpistemicKnowledge(sceneBuffer, characterName).catch((err) => {
                recordCatchUpError('final epistemic extraction error', err);
              });
            }
          }

          await saveSceneHistory(sceneHistory).catch((err) => {
            recordCatchUpError('scene history save error', err);
          });
          sceneAudit.average_candidates_per_request = sceneAudit.requests_sent ? Number((sceneAudit.boundary_candidates_evaluated / sceneAudit.requests_sent).toFixed(2)) : 0;
          sceneAudit.ai_no_breaks = sceneAudit.candidate_dispositions?.filter((item) => item.terminal_disposition === 'ai_no_break').length ?? 0;
          sceneAudit.ai_decisions_valid = sceneAudit.candidate_dispositions?.filter((item) => /^ai_/.test(item.terminal_disposition)).length ?? 0;
          sceneAudit.ai_decisions_invalid = sceneAudit.candidate_dispositions?.filter((item) => item.ai_result_disposition === 'invalid_ai_decision').length ?? 0;
          sceneAudit.ai_decisions_missing = sceneAudit.candidate_dispositions?.filter((item) => item.ai_result_disposition === 'missing_ai_decision').length ?? 0;
          sceneAudit.fallback_no_breaks = sceneAudit.candidate_dispositions?.filter((item) => item.terminal_disposition === 'fallback_no_break').length ?? 0;
          sceneAudit.heuristic_fallback_candidates = sceneAudit.candidate_dispositions?.filter((item) => item.source === 'heuristic-fallback').length ?? 0;
          sceneAudit.heuristic_fallback_breaks = sceneAudit.candidate_dispositions?.filter((item) => item.terminal_disposition === 'fallback_break').length ?? 0;
          sceneAudit.heuristic_fallback_no_breaks = sceneAudit.candidate_dispositions?.filter((item) => item.terminal_disposition === 'fallback_no_break').length ?? 0;
          // Aggregate from the terminal gate disposition, never from a
          // speculative/request-time counter. A minimum-length rejection is a
          // separate safety constraint, not evidence that the deterministic
          // continuity gate rejected the candidate.
          const gatedCandidates = sceneAudit.candidate_dispositions?.filter((item) => item.terminal_break_disposition) ?? [];
          sceneAudit.initial_ai_breaks = gatedCandidates.filter((item) => item.decision === true && item.source !== 'heuristic-fallback').length;
          sceneAudit.break_terminal_outcomes = gatedCandidates.reduce((counts, item) => {
            const key = item.terminal_break_disposition ?? 'removed_during_scene_assembly';
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
          }, {});
          sceneAudit.gate_acceptances = sceneAudit.break_terminal_outcomes.accepted_final_break ?? 0;
          sceneAudit.gate_rejections = sceneAudit.break_terminal_outcomes.rejected_deterministic_gate ?? 0;
          sceneAudit.gate_rejections_by_reason = gatedCandidates
            .filter((item) => item.terminal_break_disposition === 'rejected_deterministic_gate')
            .reduce((counts, item) => {
              const reason = item.gate_reason_code ?? 'unspecified_deterministic_gate_reason';
              counts[reason] = (counts[reason] ?? 0) + 1;
              return counts;
            }, {});
          sceneAudit.minimum_length_rejections = sceneAudit.break_terminal_outcomes.rejected_minimum_scene_length ?? 0;
          sceneAudit.initial_ai_break_proposals = gatedCandidates.length;
          sceneAudit.deterministic_gate_rejections = sceneAudit.gate_rejections;
          sceneAudit.post_gate_minimum_length_rejections = sceneAudit.minimum_length_rejections;
          sceneAudit.post_gate_coalescing_rejections = sceneAudit.break_terminal_outcomes.coalesced_with_nearby_boundary ?? 0;
          sceneAudit.coalescing_rejections = sceneAudit.post_gate_coalescing_rejections;
          sceneAudit.accepted_final_breaks = sceneAudit.break_terminal_outcomes.accepted_final_break ?? 0;
          sceneAudit.final_breaks_accepted = sceneAudit.accepted_final_breaks;
          sceneAudit.gate_acceptances_by_reason = gatedCandidates
            .filter((item) => item.terminal_break_disposition === 'accepted_final_break')
            .reduce((counts, item) => {
              const reason = item.gate_reason_code ?? 'accepted_without_reason';
              counts[reason] = (counts[reason] ?? 0) + 1;
              return counts;
            }, {});
          sceneAudit.gate_signal_counts = gatedCandidates.reduce((counts, item) => {
            for (const [signal, active] of Object.entries(item.gate_evidence ?? {})) {
              if (active === true) counts[signal] = (counts[signal] ?? 0) + 1;
            }
            return counts;
          }, {});
          // This records only proposals from this run.  It deliberately does
          // not compare prior runs or alter scene decisions; cross-run
          // stability remains a separate diagnostic concern.
          sceneAudit.same_run_boundary_clusters = analyzeSameRunBoundaryClusters(
            sceneAudit.candidate_dispositions ?? [],
            minMessages,
          );
          const preCoalescing = gatedCandidates
            .filter((item) => item.terminal_break_disposition === 'accepted_final_break' || item.terminal_break_disposition === 'coalesced_with_nearby_boundary')
            .map((item) => item.message_index ?? item.candidate_id)
            .filter(Number.isInteger);
          const suppressed = gatedCandidates
            .filter((item) => item.terminal_break_disposition === 'coalesced_with_nearby_boundary')
            .map((item) => ({
              index: item.message_index ?? item.candidate_id,
              reason: item.gate_reason_code ?? item.coalescing?.outcome ?? 'no_independent_state_reset',
            }));
          const clusteredCandidates = (sceneAudit.same_run_boundary_clusters?.clusters ?? [])
            .flatMap((cluster) => cluster.candidates ?? []);
          const clusteredPreCoalescing = clusteredCandidates.filter((candidate) => ['accepted_final_break', 'coalesced_with_nearby_boundary'].includes(candidate.terminal_break_disposition));
          const clusteredAlreadyRejected = clusteredCandidates.filter((candidate) => !['accepted_final_break', 'coalesced_with_nearby_boundary'].includes(candidate.terminal_break_disposition));
          sceneAudit.scene_coalescing = {
            pre_coalescing_break_indices: preCoalescing,
            post_coalescing_break_indices: [...sceneAudit.final_break_indices],
            clusters_found: sceneAudit.same_run_boundary_clusters?.clusters?.length ?? 0,
            // `analyzeSameRunBoundaryClusters` intentionally exports rich
            // candidate records under `candidates`, not a lossy `members`
            // array.  Reading the latter made valid clusters look empty in
            // exported diagnostics.
            candidates_clustered: sceneAudit.same_run_boundary_clusters?.clusters?.reduce((total, cluster) => total + (cluster.candidates?.length ?? 0), 0) ?? 0,
            cluster_members_total: clusteredCandidates.length,
            candidate_cluster_members: clusteredCandidates.length,
            pre_coalescing_break_members: clusteredPreCoalescing.length,
            already_rejected_members: clusteredAlreadyRejected.length,
            already_rejected_cluster_members: clusteredAlreadyRejected.length,
            coalescing_suppressed_breaks: suppressed.length,
            retained_breaks: sceneAudit.final_break_indices.length,
            boundaries_retained: sceneAudit.final_break_indices.length,
            boundaries_suppressed: suppressed.length,
            accounting_reconciled: preCoalescing.length === sceneAudit.final_break_indices.length + suppressed.length,
            cluster_members_accounting_reconciled: clusteredCandidates.length === clusteredAlreadyRejected.length + clusteredPreCoalescing.length,
            clusters: (sceneAudit.same_run_boundary_clusters?.clusters ?? []).map((cluster, index) => {
              const members = (cluster.candidates ?? []).map((candidate) => candidate.message_index ?? candidate.candidate_id).filter(Number.isInteger);
              return {
                cluster_id: cluster.cluster_id ?? `cluster-${index + 1}`,
                member_indices: members,
                retained_indices: members.filter((member) => sceneAudit.final_break_indices.includes(member)),
                suppressed_indices: suppressed.filter((item) => members.includes(item.index)).map((item) => item.index),
                suppression_reasons: suppressed.filter((item) => members.includes(item.index)).map((item) => ({ index: item.index, reason: item.reason })),
                candidate_terminal_dispositions: (cluster.candidates ?? []).map((candidate) => ({
                  index: candidate.message_index ?? candidate.candidate_id ?? null,
                  terminal_break_disposition: candidate.terminal_break_disposition ?? null,
                  gate_reason_code: candidate.gate_reason_code ?? null,
                })),
              };
            }),
          };
          // Every retained boundary carries only compact deterministic evidence
          // codes. This supports review of dense regions without exposing raw
          // transcript text or treating proximity as a transition by itself.
          sceneAudit.final_scene_boundary_evidence = sceneAudit.final_break_indices.map((messageIndex) => {
            const candidate = sceneAudit.candidate_dispositions?.find((item) => (item.message_index ?? item.candidate_id) === messageIndex) ?? {};
            const stateDelta = deriveSceneCandidateStateDelta(allMessages[messageIndex - 1]?.mes, allMessages[messageIndex]?.mes);
            const evidence = candidate.gate_evidence ?? {};
            const transitionEvidenceCodes = Object.entries(evidence)
              .filter(([key, value]) => value === true && /(?:change_detected|transition_detected)$/.test(key))
              .map(([key]) => key);
            const transitionEvidenceGroups = (evidence.transition_evidence_groups ?? []).map((group) => typeof group === 'string'
              ? { evidence_group_id: group, source_fingerprint: group, detector_codes: [group], strength: group === 'explicit_transition' ? 'strong' : 'weak', independent: group === 'explicit_transition' }
              : group);
            const independentStrongTransitionCount = transitionEvidenceGroups
              .filter((group) => group?.independent === true && group?.strength === 'strong').length;
            const continuityEvidenceCodes = Object.entries(evidence)
              .filter(([key, value]) => value === true && /(?:continuous|emotional_shift)/.test(key))
              .map(([key]) => key);
            return {
              message_index: messageIndex,
              retained: true,
              transition_evidence_codes: transitionEvidenceCodes,
              continuity_evidence_codes: continuityEvidenceCodes,
              transition_evidence_groups: transitionEvidenceGroups,
              independent_strong_transition_count: independentStrongTransitionCount,
              independent_reset_supported: candidate.coalescing?.outcome !== 'direct_continuation' && independentStrongTransitionCount > 0,
              gate_result: candidate.gate_result ?? null,
              coalescing_result: candidate.coalescing?.outcome ?? null,
              final_reason_code: candidate.gate_reason_code ?? 'accepted_final_break',
              scene_candidate_state_delta: {
                message_index: messageIndex,
                ...stateDelta,
                terminal_disposition: candidate.terminal_break_disposition ?? 'accepted_final_break',
              },
            };
          });
          // Transport recovery never decides a scene boundary by itself. Once
          // the ordinary gate and assembly have completed, attach the bounded
          // final outcome for each recovered provider decision so exports can
          // distinguish a harmless omission from one that retained a boundary.
          const recoveredFinalBoundaryIds = new Set(sceneAudit.final_break_indices);
          for (const recovery of sceneAudit.partial_response_recovery?.targeted_recoveries ?? []) {
            recovery.recovered_decision_outcomes = recovery.requested_candidate_ids.map((candidateId) => {
              const disposition = sceneAudit.candidate_dispositions?.find((item) => item.candidate_id === candidateId);
              const retained = recoveredFinalBoundaryIds.has(candidateId);
              return {
                candidate_id: candidateId,
                recovered: !recovery.unresolved_candidate_ids.includes(candidateId),
                terminal_disposition: disposition?.terminal_break_disposition ?? disposition?.terminal_disposition ?? 'unresolved_after_recovery',
                final_boundary_retained: retained,
              };
            });
            recovery.final_boundary_effect = recovery.recovered_decision_outcomes.some((outcome) => outcome.final_boundary_retained)
              ? 'recovered_decision_retained_final_boundary'
              : 'recovered_decision_did_not_retain_final_boundary';
          }
          sceneAudit.final_break_support = sceneAudit.final_scene_boundary_evidence.map((boundary) => ({
            message_index: boundary.message_index,
            ai_break: Boolean(sceneAudit.candidate_dispositions?.find((item) => (item.message_index ?? item.candidate_id) === boundary.message_index)?.decision),
            strong_transition_evidence: boundary.transition_evidence_groups
              .filter((group) => group?.strength === 'strong').map((group) => group.evidence_group_id),
            weak_transition_evidence: boundary.transition_evidence_groups
              .filter((group) => group?.strength !== 'strong').map((group) => group.evidence_group_id),
            continuity_evidence: boundary.continuity_evidence_codes,
            independent_reset_supported: boundary.independent_reset_supported,
            exception_used: null,
            accepted: true,
            terminal_reason: boundary.final_reason_code,
          }));
          // Keep rejected provider proposals reviewable without exporting their
          // transcript text. This audits potential false negatives separately
          // from accepted-boundary evidence and never changes gate behavior.
          const rejectedProviderBreaks = (sceneAudit.candidate_dispositions ?? []).filter((candidate) => candidate?.decision === true
            && candidate?.terminal_break_disposition !== 'accepted_final_break');
          const candidateStateDelta = (candidate) => {
            const index = candidate.message_index ?? candidate.candidate_id;
            const delta = deriveSceneCandidateStateDelta(allMessages[index - 1]?.mes, allMessages[index]?.mes);
            return { message_index: index, ...delta, terminal_disposition: candidate.terminal_break_disposition ?? null };
          };
          sceneAudit.scene_rejected_break_audit = {
            rejected_break_count: rejectedProviderBreaks.length,
            high_risk_false_negative_count: 0,
            records: rejectedProviderBreaks.slice(0, 96).map((candidate) => {
              const evidence = candidate.gate_evidence ?? {};
              const groups = (evidence.transition_evidence_groups ?? []).map((group) => typeof group === 'string'
                ? { evidence_group_id: group, strength: 'weak', independent: false }
                : group).filter((group) => group?.evidence_group_id);
              const groundedExplicit = groups.filter((group) => group.independent === true && group.strength === 'strong' && group.evidence_group_id !== 'narrative_context_reset').map((group) => group.evidence_group_id);
              const implied = groups.filter((group) => group.independent === true && group.strength === 'strong' && group.evidence_group_id === 'narrative_context_reset').map((group) => group.evidence_group_id);
              const weak = groups.filter((group) => !(group.independent === true && group.strength === 'strong')).map((group) => group.evidence_group_id);
              const continuityReason = ['strong_continuity_veto', 'same_continuous_interaction'].includes(candidate.gate_reason_code);
              const continuity = continuityReason ? 'strong' : evidence.continuity_detected ? 'weak' : 'none';
              const stateDelta = candidateStateDelta(candidate);
              const groundedReset = stateDelta.grounded?.time_jump_evidence
                || stateDelta.grounded?.location_reset_evidence
                || stateDelta.grounded?.channel_reset_evidence
                || stateDelta.grounded?.participant_context_reset_evidence
                || stateDelta.grounded?.interaction_reset
                || stateDelta.grounded?.new_setting_opening;
              const observedDelta = stateDelta.observed?.location_changed
                || stateDelta.observed?.channel_changed
                || stateDelta.observed?.participant_set_changed
                || stateDelta.observed?.time_changed;
              const onlyObservedDelta = observedDelta && !groundedReset;
              const providerConfident = Number(candidate.ai_confidence ?? 0) >= 0.8;
              const groundedRelocationCoverageGap = providerConfident
                && !continuityReason
                && candidate.gate_reason_code === 'missing_independent_transition_evidence'
                && Boolean(stateDelta.grounded?.completed_relocation_evidence || stateDelta.grounded?.pending_relocation_opening);
              const risk = groundedRelocationCoverageGap || (groundedReset && !continuityReason) ? 'high'
                : continuityReason ? 'low'
                  : providerConfident && (groundedExplicit.length || implied.length) ? 'medium'
                    : observedDelta ? 'medium'
                    : candidate.ai_confidence == null && !groups.length ? 'unknown'
                      : 'low';
              return {
                message_index: candidate.message_index ?? candidate.candidate_id ?? null,
                provider_confidence: candidate.ai_confidence ?? null,
                gate_reason: candidate.gate_reason_code ?? null,
                raw_transition_signals: groups.map((group) => group.evidence_group_id),
                grounded_explicit_transition_support: groundedExplicit,
                grounded_implied_transition_support: implied,
                weak_transition_signals: weak,
                continuity: { strength: continuity, evidence_groups: continuityReason ? ['terminal_gate_continuity'] : [], direct_reply: continuityReason || null, same_channel: null, same_location: null, same_participants: null, immediate_reaction: continuityReason || null, same_interaction_state: continuityReason || null },
                scene_candidate_state_delta: stateDelta,
                final_false_negative_risk: risk,
                review_reason: groundedRelocationCoverageGap ? 'transition_evidence_coverage_risk'
                  : risk === 'high' ? 'grounded_reset_rejected'
                  : onlyObservedDelta ? 'observed_state_delta_without_grounded_reset'
                    : risk === 'medium' ? 'high_confidence_transition_support_rejected'
                    : risk === 'unknown' ? 'insufficient_independent_evidence'
                      : 'gate_rejection_supported',
              };
            }),
          };
          sceneAudit.scene_rejected_break_audit.high_risk_false_negative_count = sceneAudit.scene_rejected_break_audit.records
            .filter((record) => record.final_false_negative_risk === 'high').length;
          // A bounded, text-free candidate ledger makes the two positive
          // sources (provider and deterministic rescue) auditable without
          // exposing replay content in diagnostics exports.
          sceneAudit.scene_transition_evaluation = (sceneAudit.candidate_dispositions ?? []).slice(0, 192).map((candidate) => {
            const messageIndex = candidate.message_index ?? candidate.candidate_id;
            const stateDelta = deriveSceneCandidateStateDelta(allMessages[messageIndex - 1]?.mes, allMessages[messageIndex]?.mes);
            const groups = candidate.gate_evidence?.transition_evidence_groups ?? [];
            const strongGroups = groups.filter((group) => group?.independent === true && group?.strength === 'strong');
            const continuity = candidate.gate_evidence?.same_continuous_interaction ? 'strong' : stateDelta.continuity_strength;
            const groundedReset = stateDelta.grounded?.time_jump_evidence || stateDelta.grounded?.location_reset_evidence
              || stateDelta.grounded?.channel_reset_evidence || stateDelta.grounded?.participant_context_reset_evidence
              || stateDelta.grounded?.interaction_reset || stateDelta.grounded?.new_setting_opening;
            return {
              message_index: messageIndex,
              provider_decision: Boolean(candidate.decision),
              provider_confidence: candidate.ai_confidence ?? null,
              proposal_sources: candidate.proposal_sources ?? (candidate.decision ? ['provider'] : []),
              raw_signals: groups.map((group) => group?.evidence_group_id).filter(Boolean),
              grounded_explicit_support: strongGroups.filter((group) => group.evidence_group_id !== 'narrative_context_reset').map((group) => group.evidence_group_id),
              grounded_implied_support: strongGroups.filter((group) => group.evidence_group_id === 'narrative_context_reset').map((group) => group.evidence_group_id),
              weak_signals: groups.filter((group) => !(group?.independent === true && group?.strength === 'strong')).map((group) => group?.evidence_group_id).filter(Boolean),
              observed_state_delta: stateDelta.observed,
              grounded_state_reset: Boolean(groundedReset),
              continuity_strength: continuity,
              continuity_evidence: continuity === 'strong' ? ['same_continuous_interaction'] : [],
              deterministic_positive_rescue_eligible: Boolean(candidate.deterministic_positive_rescue_eligible),
              deterministic_positive_rescue_used: Boolean(candidate.deterministic_positive_rescue_used),
              pre_alignment_boundary: messageIndex,
              final_boundary_index: sceneAudit.final_break_indices.includes(messageIndex) ? messageIndex : null,
              final_disposition: candidate.terminal_break_disposition ?? candidate.terminal_disposition ?? null,
              final_reason: candidate.gate_reason_code ?? null,
              false_negative_risk: continuity === 'strong' ? 'low' : groundedReset && candidate.decision && candidate.terminal_break_disposition !== 'accepted_final_break' ? 'high' : 'unknown',
            };
          });
          // Keep source provenance and terminal disposition separate.  In
          // particular, a provider's `break=false` is an input observation,
          // never a final-scene explanation once deterministic strong evidence
          // has accepted a boundary.  This compact audit is intentionally
          // text-free so long-chat replays can be reviewed safely.
          const finalBoundarySet = new Set(sceneAudit.final_break_indices);
          sceneAudit.candidate_source_outcomes = summarizeSceneCandidateSources(
            sceneAudit.candidate_dispositions ?? [],
            sceneAudit.final_break_indices,
          );
          sceneAudit.scene_boundary_source_audit = {
            accepted_boundaries: (sceneAudit.candidate_dispositions ?? [])
              .filter((candidate) => finalBoundarySet.has(candidate.message_index ?? candidate.candidate_id))
              .map((candidate) => ({
                message_index: candidate.message_index ?? candidate.candidate_id ?? null,
                provider_proposal: candidate.decision === true ? 'break' : 'no_break',
                proposal_sources: candidate.proposal_sources ?? (candidate.decision ? ['provider'] : []),
                terminal_disposition: candidate.terminal_break_disposition ?? 'accepted_final_break',
                final_source: candidate.deterministic_positive_rescue_used
                  ? 'deterministic_positive_rescue'
                  : candidate.decision === true ? 'provider_grounded_gate'
                    : 'deterministic_grounded_gate',
                final_reason: candidate.gate_reason_code ?? 'accepted_final_break',
              })),
            rejected_provider_breaks: sceneAudit.scene_rejected_break_audit.records
              .filter((record) => record.final_false_negative_risk === 'high')
              .slice(0, 12)
              .map((record) => ({
                message_index: record.message_index,
                terminal_disposition: 'rejected_deterministic_gate',
                final_reason: record.review_reason,
                final_false_negative_risk: record.final_false_negative_risk,
              })),
            accepted_boundary_count: sceneAudit.final_break_indices.length,
            high_risk_rejection_count: sceneAudit.scene_rejected_break_audit.high_risk_false_negative_count,
          };
          sceneAudit.total_nonfinal_ai_breaks = sceneAudit.deterministic_gate_rejections
            + sceneAudit.post_gate_minimum_length_rejections
            + sceneAudit.post_gate_coalescing_rejections
            + (sceneAudit.break_terminal_outcomes.removed_duplicate ?? 0)
            + (sceneAudit.break_terminal_outcomes.removed_during_final_assembly ?? 0);
          sceneAudit.terminal_break_accounting_reconciled = sceneAudit.initial_ai_break_proposals === Object.values(sceneAudit.break_terminal_outcomes)
            .reduce((total, count) => total + Number(count ?? 0), 0);
          // New history records use the structural definition of scene count;
          // `generated` remains a separate count of successfully saved scene
          // summaries for backwards-compatible diagnostics.
          sceneAudit.boundary_count = sceneAudit.final_break_indices.length;
          sceneAudit.scene_count = sceneAudit.boundary_count + 1;
          const priorSceneAudits = [
            ...(catchUpContext.chatMetadata?.[META_KEY]?.scene_stability_history ?? []),
            catchUpContext.chatMetadata?.[META_KEY]?.catch_up_diagnostics?.sceneDetection,
          ].filter(Boolean);
          const comparablePriorRun = [...priorSceneAudits].reverse().find((priorSceneAudit) => (
            priorSceneAudit?.run_signature === sceneAudit.scene_detection_run_signature
            || priorSceneAudit?.scene_detection_run_signature === sceneAudit.scene_detection_run_signature
          ) && priorSceneAudit?.prompt_shape_hash === sceneAudit.prompt_shape_hash
            && priorSceneAudit?.model_identifier === sceneAudit.model_identifier
            && priorSceneAudit?.connection_profile_identifier === sceneAudit.connection_profile_identifier
            && JSON.stringify(priorSceneAudit?.task_sampling_settings) === JSON.stringify(sceneAudit.task_sampling_settings)) ?? null;
          const stabilityTolerance = Math.max(1, Math.min(4, Number(settings.scene_comparison_tolerance ?? 2)));
          sceneAudit.boundary_comparison = compareSceneBoundaryRuns(
            comparablePriorRun,
            sceneAudit,
            stabilityTolerance,
          );
          sceneAudit.scene_stability_history = analyzeSceneStabilityHistory(
            priorSceneAudits,
            sceneAudit,
            stabilityTolerance,
          );
          delete sceneAudit.ai_decisions;
          delete sceneAudit.ai_disposition_by_id;
          runResult.sceneDetection = { ...sceneAudit, retained: loadSceneHistory().length, injected: Math.min(loadSceneHistory().length, settings.scene_inject_count ?? 5) };
          ctrl.sceneMessageBuffer = [];
          ctrl.sceneBufferLastIndex = -1;
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
          updateFinalizationEta('scene detection and summaries', { completed: true });
        }

        // Extract arcs once against the complete, consolidated chat after the
        // scene and epistemic passes. This is intentionally not per chunk:
        // otherwise a later chunk can create or resolve identities after the
        // staged final reconciliation has consumed an earlier partial graph.
        if (settings.arcs_enabled && !isFreshStart()) {
          updateFinalizationEta('story-arc extraction');
          setStatusMessage('Extracting and resolving story arcs...');
          await extractArcs(allMessages, characterName, null, {
            arcResolutionStats: runResult.arcResolution,
            arcPipeline: runResult.arcPipeline,
            arcExtraction: runResult.arcExtraction,
            fullCoverage: true,
          }).catch((err) => {
            recordCatchUpError('arc extraction error (final)', err, 'arcs');
          });
          updateFinalizationEta('story-arc extraction', { completed: true });
        }

        // Short-term compaction runs once at the end - it uses the real token
        // count to decide what to include, so chunking doesn't apply.
        if (settings.compaction_enabled) {
          updateFinalizationEta('short-term memory extraction');
          setStatusMessage('Extracting short-term memories...');
          await runCompaction({ includeLastMessage: true })
            .then((summary) => {
              if (summary) {
                injectSummary(summary);
                updateShortTermUI(summary);
              }
            })
            .catch((err) => {
              recordCatchUpError('compaction error', err);
          });
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
          updateFinalizationEta('short-term memory extraction', { completed: true });
        }
      }

      // Generate character & world profiles once at the end of a completed run.
      // Skipped on cancel - partial data may produce low-quality profiles.
      if (!ctrl.catchUpCancelled && settings.profiles_enabled) {
        for (const name of catchUpProfileCharacterNames) {
          updateFinalizationEta(`profile generation for ${name}`);
          setStatusMessage(`Generating character & world profiles for ${name}...`);
          runResult.profiles.profiles_attempted++;
          let profileTerminal = null;
          const profiles = await generateProfiles(name, null, {
            throwOnFailure: true,
            onTerminal: (detail) => { profileTerminal = detail; },
          }).catch((err) => {
            recordCatchUpError(`${name} profile generation error`, err, 'profiles');
            return null;
          });
          if (profileTerminal) runResult.profiles.attempts.push(profileTerminal);
          if (profileTerminal?.format_correction_attempted && profileTerminal?.profile_coverage_outcome !== 'saved_after_format_correction') {
            runResult.profiles.malformed_output++;
            runResult.profiles.malformed_output_details.push(profileTerminal);
          }
          if (!['saved_initial', 'saved_after_format_correction'].includes(profileTerminal?.profile_coverage_outcome)) {
            updateFinalizationEta(`profile generation for ${name}`, { completed: true });
            continue;
          }
          // Update UI with the selected character's profiles - other characters'
          // profiles are stored but only the active character is displayed.
          if (profiles && name === characterName) {
            injectProfiles(name);
            updateProfilesUI(profiles);
          }
          if (profiles) {
            const selfTargetRejections = profiles.profile_relationship_self_targets_rejected ?? [];
            runResult.profiles.profile_relationship_self_targets_rejected.records.push(...selfTargetRejections);
            runResult.profiles.profile_relationship_self_targets_rejected.count += selfTargetRejections.length;
            runResult.profiles.family_role_pipeline_traces.push(...(profiles.family_role_pipeline_trace ?? []).map((trace) => ({
              ...trace,
              profile_owner: trace.profile_owner ?? String(name).toLowerCase(),
            })));
            runResult.profiles.family_coreference_traces.push(...(profiles.family_role_pipeline_trace ?? []).flatMap((trace) =>
              (trace.family_coreference_trace ?? []).map((entry) => ({ owner: trace.profile_owner, target: trace.relationship_target, ...entry }))));
            runResult.profiles.sibling_role_persistence_summary.push(...(profiles.family_role_pipeline_trace ?? [])
              .filter((trace) => ['sister', 'brother', 'sibling'].includes(trace.selected_role))
              .map((trace) => ({
                profile_owner: trace.profile_owner,
                relationship_target: trace.relationship_target,
                role: trace.selected_role,
                persisted: Boolean(trace.typed_role_fact_persisted),
                reload_verified: Boolean(trace.typed_role_fact_reload_verified),
              })));
            runResult.profiles.family_role_persistence_summary.push(...(profiles.family_role_pipeline_trace ?? []).map((trace) => ({
              owner: trace.profile_owner,
              target: trace.relationship_target,
              role: trace.selected_role,
              source: trace.selected_source_class,
              persisted: Boolean(trace.typed_role_fact_persisted),
              reload_verified: Boolean(trace.typed_role_fact_reload_verified),
              profile_lookup_verified: Boolean(trace.typed_role_fact_found_by_profile_lookup),
              terminal_outcome: trace.terminal_outcome,
              unresolved_reason: trace.parent_role_source_audit?.unresolved_reason ?? null,
            })));
            runResult.profiles.family_role_trace_validation_failures.push(...(profiles.family_role_pipeline_trace ?? [])
              .filter((trace) => !trace.trace_validation?.passed)
              .map((trace) => ({ owner: trace.profile_owner, target: trace.relationship_target, failures: trace.trace_validation.failures })));
            if (profiles.family_role_evidence_deduplication) runResult.profiles.family_role_evidence_deduplication.push(profiles.family_role_evidence_deduplication);
            if (profiles.relationship_history_counts) runResult.profiles.relationship_history_counts.push({ profile_owner: String(name).toLowerCase(), ...profiles.relationship_history_counts });
            runResult.profiles.profiles_parsed++;
            runResult.profiles.profiles_saved++;
            runResult.profiles.sections_parsed++;
            for (const section of ['character_state', 'world_state', 'relationship_matrix']) {
              if (profiles[section]) runResult.profiles.sections_detected[section]++;
            }
            runResult.profiles.stale_fields_dropped += profiles.stale_field_rejections?.length ?? 0;
            runResult.profiles.speculative_fields_dropped += profiles.speculative_field_rejections?.length ?? 0;
            runResult.profiles.unsupported_fields_dropped += profiles.field_grounding_rejections?.length ?? 0;
            // field_validation is the sole accumulator.  Legacy summary
            // counters below are derived from it, preventing the same field
            // disposition from being counted once here and once in the loop.
            for (const [field, value] of Object.entries(profiles.field_validation ?? {})) {
              runResult.profiles.fields[field] = (runResult.profiles.fields[field] ?? 0) + Number(value ?? 0);
            }
            runResult.profiles.prior_fields_preserved = runResult.profiles.fields.preserved_prior;
            runResult.profiles.relationship_conflicts_dropped = runResult.profiles.fields.dropped_conflict;
            runResult.profiles.relationship_conflict_details.push(...(profiles.relationship_field_details ?? []));
            for (const outcome of profiles.profile_descriptor_terminal_outcomes ?? []) {
              const key = String(outcome.disposition ?? '');
              if (key in runResult.profiles.descriptor_outcomes) runResult.profiles.descriptor_outcomes[key]++;
            }
            for (const outcome of profiles.profile_field_terminal_outcomes ?? []) {
              const key = String(outcome.field_terminal_outcome ?? '');
              if (key in runResult.profiles.field_outcomes) runResult.profiles.field_outcomes[key]++;
            }
            const placeholderTokens = new Set(['unknown', 'none', 'n/a', 'not specified', 'unsure', 'unclear']);
            const fieldOutcomes = profiles.profile_field_terminal_outcomes ?? [];
            const descriptorOutcomes = profiles.profile_descriptor_terminal_outcomes ?? [];
            const quality = runResult.profiles.profile_relationship_quality_breakdown;
            const droppedFields = fieldOutcomes.filter((entry) => entry.field_terminal_outcome === 'dropped_no_supported_descriptors');
            const placeholderOnlyFields = droppedFields.filter((entry) => (entry.rejected_descriptors ?? entry.generated_descriptors ?? []).length > 0
              && (entry.rejected_descriptors ?? entry.generated_descriptors ?? []).every((value) => placeholderTokens.has(String(value).trim().toLowerCase())));
            quality.fields_dropped_placeholder_only += placeholderOnlyFields.length;
            quality.fields_dropped_no_supported_descriptors += droppedFields.length - placeholderOnlyFields.length;
            quality.fields_dropped_conflict += fieldOutcomes.filter((entry) => entry.field_terminal_outcome === 'dropped_conflict').length;
            quality.descriptors_rejected_unsupported += descriptorOutcomes.filter((entry) => entry.disposition === 'rejected_unsupported').length;
            quality.descriptors_rejected_placeholder += descriptorOutcomes.filter((entry) => entry.disposition === 'rejected_placeholder').length;
            quality.roles_unresolved += fieldOutcomes.filter((entry) => !entry.canonical_relationship_type).length;
            quality.canonical_roles_preserved += fieldOutcomes.filter((entry) => entry.canonical_relationship_type && (entry.field_terminal_outcome === 'dropped_no_supported_descriptors' || entry.field_terminal_outcome === 'not_generated_role_structurally_present')).length;
            runResult.profiles.relationship_descriptor_rejections += descriptorOutcomes.filter((entry) => entry.disposition === 'rejected_unsupported').length;
            runResult.profiles.relationship_field_rejections += droppedFields.length - placeholderOnlyFields.length;
            runResult.profiles.relationship_dropped_field_descriptor_count += droppedFields.reduce((total, entry) => total + (entry.rejected_descriptors?.length ?? entry.generated_descriptors?.length ?? 0), 0);
            runResult.profiles.speculativeCurrentFieldsDropped = runResult.profiles.speculative_fields_dropped;
            runResult.profiles.relationshipConflictsDropped = runResult.profiles.relationship_conflicts_dropped;
            runResult.profiles.preservedPriorFields = runResult.profiles.prior_fields_preserved;
          }
          updateFinalizationEta(`profile generation for ${name}`, { completed: true });
        }
        // If the selected character wasn't in the group (edge case), inject
        // whatever profiles exist for them anyway.
        if (!catchUpCharacterNames.includes(characterName)) {
          injectProfiles(characterName);
        }
        // Terminal profile records are the single source of truth for section
        // diagnostics. Do not increment this aggregate independently while
        // parsing profiles, or a preserved/partial profile can skew totals.
        runResult.profiles.sections_detected = runResult.profiles.attempts.reduce((totals, attempt) => ({
          character_state: totals.character_state + Number(Boolean(attempt.character_state_detected)),
          world_state: totals.world_state + Number(Boolean(attempt.world_state_detected)),
          relationship_matrix: totals.relationship_matrix + Number(Boolean(attempt.relationship_matrix_detected)),
        }), { character_state: 0, world_state: 0, relationship_matrix: 0 });
        runResult.profiles.terminal_accounting = summarizeProfileTerminalCoverage(runResult.profiles.attempts);
      }

      // Re-injection and panel refresh are presentation-only. Isolate every
      // task so a DOM, prompt-slot, or embedding problem cannot abort the
      // staged data commit near the end of a long run.
      await runNonfatalPresentationTask('Long-term memory injection', () => injectMemories(characterName));
      await runNonfatalPresentationTask('Relationship History injection', () => injectRelationshipHistory(characterName));
      await runNonfatalPresentationTask('Session memory injection', () => injectSessionMemories());
      await runNonfatalPresentationTask('Scene History injection', () => injectSceneHistory());
      await runNonfatalPresentationTask('Story Arc injection', () => injectArcs());
      await runNonfatalPresentationTask('State Ledger injection', () => injectStateLedger());
      await runNonfatalPresentationTask('Perspectives & Secrets injection', () => {
        resetEpistemicWarnFlag();
        return injectEpistemicKnowledge(characterName, characterName, false, true, true);
      });
      await runNonfatalPresentationTask('Profile injection', () => injectProfiles(characterName));
      await runNonfatalPresentationTask('Entity Registry refresh', () => updateEntityPanel(characterName));
      await runNonfatalPresentationTask('Long-term memory panel refresh', () => updateLongTermUI(characterName));
      await runNonfatalPresentationTask('Relationship History panel refresh', () => updateRelationshipHistoryUI(characterName));
      await runNonfatalPresentationTask('Perspectives & Secrets panel refresh', () => updateEpistemicUI(characterName));
      await runNonfatalPresentationTask('Session memory panel refresh', () => updateSessionUI());
      await runNonfatalPresentationTask('Scene History panel refresh', () => updateScenesUI());
      await runNonfatalPresentationTask('Story Arc panel refresh', () => updateArcsUI());
      await runNonfatalPresentationTask('Profile panel refresh', () => updateProfilesUI(loadProfiles(characterName)));
      // Catch-up can surface first-name variants that only become resolvable
      // after the full roster and extracted evidence are available.
      const reconciliationSnapshot = {
        metadata: structuredClone(catchUpContext.chatMetadata?.[META_KEY] ?? {}),
        settings: structuredClone(extension_settings[MODULE_NAME] ?? {}),
      };
      let reconciliation;
      runResult.finalReconciliation.attempted = 1;
      try {
        updateFinalizationEta('final identity reconciliation and save');
        setStatusMessage('Finalizing identity reconciliation and saving memory tiers...');
        reconciliation = await runFinalIntegrityReconciliation(characterName);
        if (reconciliation.integrity_audit?.status === 'unsafe') {
          const error = new Error('Unsafe canonical identity merge was rejected during final reconciliation.');
          error.sme_failure_stage = 'identity_integrity';
          // Diagnostics describe a proposal/audit, not staged chat state.
          // Preserve a compact copy if a genuinely structural integrity
          // failure requires rolling the staged mutations back.
          error.sme_reconciliation_diagnostics = {
            identity_outcomes: structuredClone(reconciliation.identity_outcomes ?? []),
            integrity_audit: structuredClone(reconciliation.integrity_audit ?? null),
            persona_roster_size: reconciliation.persona_roster_size ?? 0,
            rejected_unsafe_merges: structuredClone(reconciliation.integrity_audit?.rejected_unsafe_merges ?? []),
          };
          throw error;
        }
        runResult.finalReconciliation.completed = 1;
        updateFinalizationEta('final identity reconciliation and save', { completed: true });
      } catch (err) {
        // Roll back only the partially-applied reconciliation edits while
        // preserving scenes, profiles, and every earlier validated tier.
        // The final staged transaction still protects the later chat save.
        catchUpContext.chatMetadata[META_KEY] = reconciliationSnapshot.metadata;
        extension_settings[MODULE_NAME] = reconciliationSnapshot.settings;
        recordCatchUpError('final reconciliation error', err, 'identity');
        runResult.finalReconciliation.rolled_back = true;
        runResult.finalReconciliation.failure_stage = err?.sme_failure_stage ?? 'final_reconciliation';
        runResult.finalReconciliation.error_class = err?.name ?? 'Error';
        runResult.finalReconciliation.error_message = String(err?.message ?? err ?? 'Unknown reconciliation error').replace(/\s+/g, ' ').slice(0, 300);
        const retained = err?.sme_reconciliation_diagnostics ?? null;
        reconciliation = {
          // A rollback reverses durable changes, not the compact evidence of
          // why the final audit rejected them. Export it so the failed
          // candidate can be diagnosed without retaining prompts or chat text.
          matched: [], merged: [], skipped: retained?.rejected_unsafe_merges ?? [], unmatched: [], card_local_reports: [],
          identity_outcomes: retained?.identity_outcomes ?? [],
          persona_roster_size: retained?.persona_roster_size ?? 0,
          participant_lists_rewritten: 0, resolved_review_items_removed: 0,
          integrity_audit: retained?.integrity_audit ?? { stale_entity_references: [], status: 'degraded' }, quarantined_arc_summaries: 0,
        };
        updateFinalizationEta('final identity reconciliation and save', { completed: true });
      }
      runResult.identityResolution = {
        matched: reconciliation.matched.length,
        merged: reconciliation.merged.length,
        needs_review: reconciliation.skipped.length,
        unmatched: reconciliation.unmatched.length,
        quarantined_arc_summaries: reconciliation.quarantined_arc_summaries,
      };
      const deduplicatedTerminalOutcomes = [...(reconciliation.identity_outcomes ?? [])].filter(Boolean).reduce((records, outcome) => {
        // A source record ID is only unique within its store. Preserve one
        // physical terminal record per scoped observation; a different
        // terminal decision for the same composite key is a real conflict.
        const key = makeTerminalObservationKey(outcome.source_store, outcome.source_record_id);
        if (!key) return records;
        const prior = records.get(key);
        if (!prior) records.set(key, { ...outcome, terminal_key: key, source_record_ids: [...new Set((outcome.source_record_ids ?? []).filter(Boolean))] });
        else {
          prior.source_record_ids = [...new Set([...(prior.source_record_ids ?? []), ...(outcome.source_record_ids ?? [])].filter(Boolean))];
          prior._conflicting_terminal_outcomes ??= [];
          if (`${prior.terminal_outcome}|${prior.canonical_target_id ?? prior.targetId ?? prior.canonicalName ?? ''}` !== `${outcome.terminal_outcome}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`) prior._conflicting_terminal_outcomes.push(outcome);
        }
        return records;
      }, new Map());
      const sourceRecordKeys = new Set((reconciliation.identity_outcomes ?? [])
        .map((outcome) => makeTerminalObservationKey(outcome.source_store, outcome.source_record_id))
        .filter(Boolean));
      const terminalsBySource = new Map();
      const missingSourceTerminals = [];
      for (const outcome of deduplicatedTerminalOutcomes.values()) {
        const sourceId = String(outcome.source_record_id ?? '').trim();
        if (!sourceId) { missingSourceTerminals.push(outcome); continue; }
        const sourceKey = makeTerminalObservationKey(outcome.source_store, sourceId);
        (terminalsBySource.get(sourceKey) ?? terminalsBySource.set(sourceKey, []).get(sourceKey)).push(outcome);
      }
      const conflictingTerminalRecords = [
        ...missingSourceTerminals.map((outcome) => ({ candidate: outcome.candidate ?? null, source_store: outcome.source_store ?? null, reason: 'missing_source_record_id' })),
        ...[...terminalsBySource.entries()].flatMap(([sourceKey, outcomes]) => {
          const distinct = new Set(outcomes.map((outcome) => `${outcome.terminal_outcome ?? ''}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`));
          return distinct.size > 1 ? [{ source_key: sourceKey, outcomes: [...distinct] }] : [];
        }),
      ];
      const finalTerminalRecords = [...terminalsBySource.values()]
        .filter((outcomes) => new Set(outcomes.map((outcome) => `${outcome.terminal_outcome ?? ''}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`)).size === 1)
        .map(([outcome]) => outcome);
      const finalTerminalKeys = new Set(finalTerminalRecords.map((outcome) => outcome.terminal_key ?? makeTerminalObservationKey(outcome.source_store, outcome.source_record_id)).filter(Boolean));
      const missingTerminalKeys = [...sourceRecordKeys].filter((key) => !finalTerminalKeys.has(key));
      const unexpectedTerminalKeys = [...finalTerminalKeys].filter((key) => !sourceRecordKeys.has(key));
      runResult.identityResolution.source_records_total = sourceRecordKeys.size;
      runResult.identityResolution.terminal_records_total = terminalsBySource.size;
      runResult.identityResolution.source_terminal_keys = [...sourceRecordKeys].slice(0, 100);
      runResult.identityResolution.final_terminal_keys = [...finalTerminalKeys].slice(0, 100);
      runResult.identityResolution.missing_terminal_keys = missingTerminalKeys.slice(0, 100);
      runResult.identityResolution.unexpected_terminal_keys = unexpectedTerminalKeys.slice(0, 100);
      runResult.identityResolution.duplicate_source_keys = [];
      runResult.identityResolution.duplicate_terminal_keys = [];
      runResult.identityResolution.terminal_reconciled = missingTerminalKeys.length === 0 && unexpectedTerminalKeys.length === 0 && conflictingTerminalRecords.length === 0;
      runResult.identityResolution.duplicate_terminal_records_removed = Math.max(0, (reconciliation.identity_outcomes ?? []).length - deduplicatedTerminalOutcomes.size);
      runResult.identityResolution.conflicting_terminal_records = conflictingTerminalRecords;
      runResult.identityResolutionDetails = {
        matched: reconciliation.matched.map(({ name, canonicalName, reason_code }) => ({ candidate: name, decision: 'matched', target: canonicalName, reason_code })),
        merged: reconciliation.merged.map(({ name, canonicalName, reason_code }) => ({ candidate: name, decision: 'merged', target: canonicalName, reason_code })),
        needs_review: reconciliation.skipped.map(({ name, reason, reason_code }) => ({ candidate: name, decision: 'needs_review', reason, reason_code })),
        unmatched: reconciliation.unmatched.map(({ name, reason, reason_code }) => ({ candidate: name, decision: 'unmatched', reason, reason_code })),
        // Initial extraction decisions may be useful for debugging, but only
        // these final terminal records determine completion quality.
        extraction_stage: [],
        final_reconciliation_stage: reconciliation.identity_outcomes ?? [],
        final_terminal_records: [...finalTerminalRecords.values()],
        terminal_outcomes: [...finalTerminalRecords.values()],
        target_selection_traces: reconciliation.target_selection_traces ?? [],
      };
      const logicalReviewItems = [...finalTerminalRecords.values()]
        .filter((outcome) => ['unsafe_identity_merge_rejected', 'exact_target_name_mismatch', 'stored_card_id_name_conflict'].includes(outcome.reason_code))
        .reduce((items, outcome) => {
          const sourceIdentity = outcome.source_card_id ?? outcome.source_persona_id ?? outcome.source_record_id;
          const targetIdentity = outcome.proposed_target_card_id ?? outcome.target_card_id ?? outcome.proposed_target_record_id ?? outcome.targetId ?? 'none';
          const key = `${sourceIdentity}::${targetIdentity}::${outcome.reason_code}`;
          const item = items.get(key) ?? {
            source_identity: sourceIdentity,
            proposed_target_identity: targetIdentity,
            reason_code: outcome.reason_code,
            affected_source_records: [], affected_stores: [], observation_count: 0,
          };
          item.observation_count++;
          item.affected_source_records.push(outcome.source_record_id);
          item.affected_stores.push(outcome.source_store);
          items.set(key, item);
          return items;
        }, new Map());
      runResult.identityResolution.logical_review_items = [...logicalReviewItems.values()].map((item) => ({
        ...item,
        affected_source_records: [...new Set(item.affected_source_records.filter(Boolean))],
        affected_stores: [...new Set(item.affected_stores.filter(Boolean))],
      }));
      runResult.finalReconciliation.persona_aliases_merged = reconciliation.merged.filter((entry) => entry.reason_code === 'unique_active_persona_first_name').length;
      runResult.finalReconciliation.card_local_entities_merged = reconciliation.card_local_reports?.reduce((count, report) => count + report.merged.length, 0) ?? 0;
      runResult.finalReconciliation.relationship_pairs_merged = (reconciliation.relationship_pairs_merged ?? 0) + reconciliation.merged.filter((entry) => entry.reason_code === 'canonical_duplicate_merge').length;
      // Count only records actually removed from durable storage; detecting or
      // renaming a review label is not equivalent to completing cleanup.
      runResult.finalReconciliation.synthetic_parentheticals_removed = reconciliation.durable_entities_removed ?? 0;
      runResult.finalReconciliation.identity_decision_duplicates_removed = reconciliation.identity_decision_duplicates_removed ?? 0;
      runResult.finalReconciliation.persona_roster_size = reconciliation.persona_roster_size ?? 0;
      runResult.finalReconciliation.participant_lists_rewritten = reconciliation.participant_lists_rewritten ?? 0;
      runResult.finalReconciliation.resolved_review_items_removed = reconciliation.resolved_review_items_removed ?? 0;
      runResult.finalReconciliation.integrity_audit = reconciliation.integrity_audit ?? null;
      // The catch-up path records a local stabilization audit. Keep it under
      // its own explicit name so exported diagnostics do not imply that the
      // user has already run the optional Developer command.
      runResult.finalReconciliation.stabilization = reconciliation.idempotence ?? null;
      runResult.finalReconciliation.idempotence = reconciliation.idempotence ?? null;
      runResult.finalReconciliation.final_state_audit = reconciliation.final_state_audit ?? reconciliation.integrity_audit ?? null;
      runResult.finalReconciliation.final_state_consistency = reconciliation.final_state_consistency ?? null;
      runResult.finalReconciliation.duration_ms = reconciliation.duration_ms ?? null;
      runResult.finalReconciliation.stale_entity_references = reconciliation.integrity_audit?.stale_entity_references?.length ?? 0;
      runResult.finalReconciliation.unsafe_merge_candidates = reconciliation.integrity_audit?.unsafe_merge_candidates ?? 0;
      runResult.finalReconciliation.unsafe_merge_candidates_rejected = reconciliation.integrity_audit?.unsafe_merge_candidates_rejected ?? 0;
      runResult.finalReconciliation.safe_merge_candidates_completed = reconciliation.integrity_audit?.safe_merge_candidates_completed ?? 0;
      runResult.finalReconciliation.review_items_created = reconciliation.integrity_audit?.review_items_created ?? 0;
      runResult.identity_review.created_this_run = reconciliation.integrity_audit?.review_items_created ?? 0;
      runResult.identity_review.resolved_this_run = reconciliation.resolved_review_items_removed ?? 0;
      runResult.identity_review.removed_as_duplicate = reconciliation.identity_decision_duplicates_removed ?? 0;
      runResult.identity_review.remaining_at_end = reconciliation.integrity_audit?.identity_review_items ?? runResult.identity_review.existing_at_start;
      runResult.finalReconciliation.personaRosterSize = runResult.finalReconciliation.persona_roster_size;
      runResult.finalReconciliation.personaAliasesMerged = runResult.finalReconciliation.persona_aliases_merged;
      runResult.finalReconciliation.cardLocalEntitiesMerged = runResult.finalReconciliation.card_local_entities_merged;
      runResult.finalReconciliation.relationshipPairsMerged = runResult.finalReconciliation.relationship_pairs_merged;
      runResult.finalReconciliation.participantListsRewritten = runResult.finalReconciliation.participant_lists_rewritten;
      runResult.finalReconciliation.syntheticParentheticalsRemoved = runResult.finalReconciliation.synthetic_parentheticals_removed;
      // Finalize the one canonical arc outcome before evaluating quality.
      // Compatibility aliases are derived from it, never maintained as a
      // separately-updated second state.
      normalizeArcExtractionDiagnostics(runResult.arcExtraction);
      if (!runResult.arcExtraction.terminal_outcome && runResult.arcExtraction.request_completed > 0) {
        runResult.arcExtraction.terminal_outcome = runResult.arcExtraction.parsed_candidates > 0
          ? 'completed_with_candidates'
          : 'completed_no_candidates';
        runResult.arcExtraction.terminalOutcome = runResult.arcExtraction.terminal_outcome;
      }
      const qualityReasons = [];
      // Extraction coverage is independent of candidate quality: a window is
      // covered only when it completed itself or every deterministic child
      // window completed. This prevents a context-overflow split from being
      // reported as clean merely because later tiers succeeded.
      for (const tier of ['longterm', 'session']) {
        const coverage = runResult.extractionCoverage[tier];
        coverage.summary = summarizeExtractionCoverage(coverage.records);
        if (!coverage.summary.coverage_complete) {
          qualityReasons.push({
            code: `${tier}_extraction_coverage_incomplete`,
            tier: tier === 'longterm' ? 'long-term' : 'session',
            message: `${coverage.summary.unresolved_ranges} ${tier === 'longterm' ? 'long-term' : 'session'} source window${coverage.summary.unresolved_ranges === 1 ? '' : 's'} could not be covered within the provider context limit.`,
            unresolved_range_ids: coverage.summary.unresolved_range_ids,
          });
        }
      }
      const sessionFailureRatio = runResult.sessionExtraction.emitted > 0
        ? runResult.sessionExtraction.missingProvenance / runResult.sessionExtraction.emitted
        : 0;
      const sessionTerminalTotal = Object.entries(runResult.sessionExtraction.terminalDispositions ?? {})
        // `provider_or_parser_error` can represent already-parsed candidates
        // whose later verification failed. `provider_returned_none` is only a
        // request-level outcome and therefore has no candidate to reconcile.
        .filter(([name]) => name !== 'provider_returned_none')
        .reduce((total, [, count]) => total + Number(count ?? 0), 0);
      runResult.sessionExtraction.terminalTotal = sessionTerminalTotal;
      runResult.sessionExtraction.terminalReconciled = sessionTerminalTotal === runResult.sessionExtraction.emitted;
      if (!runResult.sessionExtraction.terminalReconciled) qualityReasons.push({
        code: 'session_terminal_dispositions_unreconciled',
        tier: 'session',
        message: `${runResult.sessionExtraction.emitted} parsed candidates but ${sessionTerminalTotal} terminal dispositions.`,
      });
      if (sessionFailureRatio > 0.5) qualityReasons.push({
        code: 'session_provenance_quarantine_majority',
        tier: 'session',
        message: `${runResult.sessionExtraction.validated} validated, ${runResult.sessionExtraction.missingProvenance} quarantined for missing citations.`,
      });
      if (runResult.sessionExtraction.malformedOutput > 0) qualityReasons.push({
        code: 'session_malformed_provider_output',
        tier: 'session',
        message: `${runResult.sessionExtraction.malformedOutput} session extraction response${runResult.sessionExtraction.malformedOutput === 1 ? '' : 's'} contained no parseable structured records.`,
      });
      if (runResult.arcPipeline.classifiedResolved >= 2 && runResult.arcPipeline.persisted === 0) qualityReasons.push({
        code: 'resolved_arcs_without_persisted_summaries',
        tier: 'arcs',
        message: `${runResult.arcPipeline.classifiedResolved} arcs resolved but no summaries persisted.`,
      });
      if ((runResult.sceneDetection?.heuristic_fallback_candidates ?? 0) > 0) qualityReasons.push({
        code: 'scene_detection_candidate_fallbacks',
        tier: 'scenes',
        message: `${runResult.sceneDetection.heuristic_fallback_candidates} scene-boundary candidate${runResult.sceneDetection.heuristic_fallback_candidates === 1 ? '' : 's'} required deterministic heuristic fallback${runResult.sceneDetection.malformed_batches ? ` after ${runResult.sceneDetection.malformed_batches} malformed batch${runResult.sceneDetection.malformed_batches === 1 ? '' : 'es'}` : ''}.`,
      });
      if (runResult.sceneDetection?.request_counters_reconciled === false) qualityReasons.push({
        code: 'scene_request_counters_unreconciled',
        tier: 'scenes',
        message: 'Scene provider request counters did not reconcile; scene records were preserved for diagnostics.',
      });
      if (runResult.finalReconciliation.error) qualityReasons.push({
        code: 'final_reconciliation_failed',
        tier: 'identity',
        message: 'Final canonical reconciliation failed and was rolled back; validated tier data was preserved.',
      });
      const profileQuality = runResult.profiles.profile_relationship_quality_breakdown;
      const profileTerminalAccounting = runResult.profiles.terminal_accounting;
      if (profileTerminalAccounting?.pending_profiles > 0) qualityReasons.push({
        code: 'profile_generation_pending',
        tier: 'profiles',
        severity: 'notice',
        message: `${profileTerminalAccounting.pending_profiles} profile${profileTerminalAccounting.pending_profiles === 1 ? ' is' : 's are'} pending a future generation after a malformed response; no model-generated facts were saved for those cards.`,
      });
      if ((profileTerminalAccounting?.unresolved_profiles ?? 0) > 0 || profileTerminalAccounting?.terminal_reconciled === false) qualityReasons.push({
        code: 'profile_terminal_coverage_incomplete',
        tier: 'profiles',
        message: profileTerminalAccounting?.terminal_reconciled === false
          ? 'Profile generation terminal accounting did not reconcile.'
          : `${profileTerminalAccounting.unresolved_profiles} profile generation attempt${profileTerminalAccounting.unresolved_profiles === 1 ? '' : 's'} ended without usable or pending coverage.`,
      });
      if (profileQuality.fields_dropped_no_supported_descriptors > 0) qualityReasons.push({
        code: 'profile_relationship_fields_unsupported',
        tier: 'profiles',
        severity: 'notice',
        message: `${profileQuality.fields_dropped_no_supported_descriptors} unsupported model-generated relationship field${profileQuality.fields_dropped_no_supported_descriptors === 1 ? '' : 's'} contained unsupported descriptors and ${profileQuality.fields_dropped_no_supported_descriptors === 1 ? 'was' : 'were'} dropped; canonical profile values were preserved.`,
      });
      if (profileQuality.fields_dropped_placeholder_only > 0) qualityReasons.push({
        code: 'profile_relationship_placeholders_dropped',
        tier: 'profiles',
        severity: 'notice',
        message: `${profileQuality.fields_dropped_placeholder_only} placeholder-only relationship field${profileQuality.fields_dropped_placeholder_only === 1 ? ' was' : 's were'} ignored.`,
      });
      if (profileQuality.descriptors_rejected_unsupported > 0) qualityReasons.push({
        code: 'profile_relationship_descriptors_unsupported',
        tier: 'profiles',
        severity: 'notice',
        message: `${profileQuality.descriptors_rejected_unsupported} unsupported model-generated relationship descriptor${profileQuality.descriptors_rejected_unsupported === 1 ? ' was' : 's were'} rejected; supported and canonical values were preserved.`,
      });
      if (runResult.profiles.family_role_trace_validation_failures.length > 0) qualityReasons.push({
        code: 'family_role_trace_inconsistent',
        tier: 'profiles',
        message: `${runResult.profiles.family_role_trace_validation_failures.length} family-role trace${runResult.profiles.family_role_trace_validation_failures.length === 1 ? '' : 's'} reported inconsistent persistence evidence; no additional relationship role was inferred.`,
      });
      const identityFailures = runResult.identityResolution.logical_review_items?.length ?? 0;
      if (identityFailures > 0) qualityReasons.push({
        code: 'identity_reconciliation_failure_volume',
        tier: 'identity',
        message: `${identityFailures} unsafe identity merge pattern${identityFailures === 1 ? '' : 's'} blocked across ${runResult.identityResolution.logical_review_items.reduce((count, item) => count + item.observation_count, 0)} store observations.`,
      });
      if ((reconciliation.integrity_audit?.stale_entity_references?.length ?? 0) > 0) qualityReasons.push({
        code: 'stale_entity_references_remaining',
        tier: 'identity',
        count: reconciliation.integrity_audit.stale_entity_references.length,
        message: `${reconciliation.integrity_audit.stale_entity_references.length} entity reference${reconciliation.integrity_audit.stale_entity_references.length === 1 ? '' : 's'} remain after reconciliation.`,
      });
      const entityLinkRepairs = reconciliation.integrity_audit?.entity_link_repairs ?? {};
      const repairs = runResult.sessionExtraction;
      // The terminal-record pipeline is authoritative. Legacy aggregate
      // counters intentionally describe overlapping stages (for example a
      // recovered record is also a completed repair), so adding them produces
      // a false quality failure even when every emitted candidate reconciles.
      const citationPipeline = repairs.session_citation_pipeline;
      const repairTerminalTotal = citationPipeline?.terminal_candidate_count ?? 0;
      repairs.repairTerminalReconciled = citationPipeline
        ? Boolean(citationPipeline.terminal_dispositions_reconciled)
        : ((repairs.repairAccepted ?? 0) + (repairs.repairProviderError ?? 0) + (repairs.repairReturnedNone ?? 0) + (repairs.repairMalformed ?? 0) + (repairs.repairStillInvalid ?? 0) + (repairs.repairSemanticallyUnsupported ?? 0)) === (repairs.repairAttempts ?? 0);
      if (!repairs.repairTerminalReconciled) qualityReasons.push({
        code: 'session_citation_repair_counters_unreconciled',
        tier: 'session',
        message: citationPipeline
          ? `${citationPipeline.unaccounted_candidate_ids?.length ?? 0} citation-repair candidates lack a terminal disposition.`
          : `${repairs.repairAttempts ?? 0} citation-repair candidates but ${repairTerminalTotal} repair terminal outcomes.`,
      });
      const requiredIdentityInvariants = [
        // Keep snapshot capture, roster construction, and identity validity
        // separate. A historical avatar filename is an opaque stable key and
        // must never make a populated Aaron-style runtime snapshot look absent.
        ['active_persona_snapshot_present', Boolean(runResult.runtimeContext?.active_persona?.canonical_name), 'active_persona_snapshot_missing'],
        ['active_persona_roster_entry_present', !runResult.runtimeContext?.active_persona?.canonical_name || runResult.finalReconciliation.persona_roster_size > 0, 'active_persona_roster_entry_missing'],
        ['active_persona_stable_id_present', Boolean(runResult.runtimeContext?.active_persona?.stable_persona_id), 'active_persona_invalid'],
        ['deterministic_persona_aliases_resolved', !runResult.runtimeContext?.active_persona?.canonical_name || !(reconciliation.integrity_audit?.persona_aliases?.persona_aliases_unresolved), 'A deterministic active-persona alias remains unresolved.'],
        ['unresolved_duplicate_canonical_entities', !(reconciliation.integrity_audit?.duplicate_canonical_entities?.length), 'Duplicate canonical entity records remain after reconciliation.'],
        ['relationship_pair_keys_canonical', !(reconciliation.integrity_audit?.relationship_pair_key_issues?.length), 'Relationship History contains a non-canonical pair key.'],
        ['relationship_history_integrity_completed', !(reconciliation.integrity_audit?.relationship_integrity_errors?.length), 'Relationship History integrity could not evaluate one or more pair keys.'],
        ['no_deterministic_synthetic_identities', !(reconciliation.integrity_audit?.synthetic_identity_remaining?.length), 'A deterministic synthetic parenthetical identity remains in durable storage.'],
        ['unsafe_identity_merge_blocked', !(reconciliation.integrity_audit?.blocked_unsafe_identity_merges?.length), 'An unsafe identity merge was blocked; the affected candidate remains separate for review.'],
        ['identity_terminal_totals_reconcile', runResult.identityResolution.terminal_reconciled, 'Final identity terminal records were duplicated or did not reconcile.'],
        ['review_records_deduplicated', !(reconciliation.integrity_audit?.duplicate_review_records?.length), 'Duplicate identity review records remain.'],
        ['session_dispositions_reconcile', runResult.sessionExtraction.terminalReconciled, 'Session candidate terminal dispositions did not reconcile.'],
        ['arc_extraction_terminal_outcome_present', !settings.arcs_enabled || Boolean(runResult.arcExtraction.terminalOutcome), 'Arc extraction has no terminal diagnostic outcome.'],
        ['profile_terminal_accounting_reconciles', !settings.profiles_enabled || Boolean(runResult.profiles?.terminal_accounting?.terminal_reconciled), 'Profile terminal accounting did not reconcile.'],
        ['profile_coverage_complete', !settings.profiles_enabled || (runResult.profiles?.terminal_accounting?.unresolved_profiles ?? 0) === 0, 'A profile attempt has neither usable nor safe pending coverage.'],
        ['integrity_audit_consistent', ['clean', 'repaired', 'degraded', 'unsafe', 'failed'].includes(reconciliation.integrity_audit?.status), 'Integrity audit returned an invalid status.'],
      ];
      for (const [code, passed, message] of requiredIdentityInvariants) {
        if (!passed) qualityReasons.push({ code, tier: 'identity', message });
      }
      const projectedOperationalStatus = ctrl.catchUpCancelled
        ? 'cancelled'
        : catchUpErrorCount > 0
          ? (runResult.completedChunks === 0 && runResult.failedChunks > 0 ? 'failed' : 'partial')
          : 'completed';
      const maintenanceActions = {
        entity_links_repaired: entityLinkRepairs.actual_logical_mutations_this_run ?? 0,
        entity_link_store_mutations: entityLinkRepairs.actual_physical_store_mutations_this_run ?? entityLinkRepairs.physical_store_mutations_this_run ?? 0,
        duplicate_wrapper_observations_suppressed: entityLinkRepairs.duplicate_observations_suppressed ?? 0,
        recreated_links_repaired: entityLinkRepairs.recreated_after_prior_repair ?? 0,
      };
      const auditStatus = reconciliation.integrity_audit?.status ?? 'failed';
      const finalState = reconciliation.integrity_audit?.final_state ?? {
        stale_references: reconciliation.integrity_audit?.stale_entity_references?.length ?? 0,
        unsafe_merges: reconciliation.integrity_audit?.blocked_unsafe_identity_merges?.length ?? 0,
        duplicate_canonical_entities: reconciliation.integrity_audit?.duplicate_canonical_entities?.length ?? 0,
        relationship_integrity_errors: reconciliation.integrity_audit?.relationship_integrity_errors?.length ?? 0,
        unresolved_review_items_created_this_run: reconciliation.integrity_audit?.review_items_created ?? 0,
      };
      finalState.integrity_clean ??= finalState.stale_references === 0
        && finalState.unsafe_merges === 0
        && finalState.duplicate_canonical_entities === 0
        && finalState.relationship_integrity_errors === 0;
      runResult.finalReconciliation.final_state = finalState;
      const finalIntegrityStatus = finalState.integrity_clean === true
        || (['clean', 'repaired'].includes(auditStatus)
        && (reconciliation.integrity_audit?.stale_entity_references?.length ?? 0) === 0)
        ? 'clean'
        : auditStatus;
      const qualityDegradingReasons = qualityReasons.filter((reason) => reason.severity !== 'notice');
      const qualityNotices = qualityReasons.filter((reason) => reason.severity === 'notice');
      runResult.quality = {
        status: qualityDegradingReasons.length ? 'degraded' : 'clean',
        operational_status: projectedOperationalStatus,
        final_integrity_status: finalIntegrityStatus,
        data_quality_status: qualityDegradingReasons.length ? 'degraded' : 'clean',
        generation_quality_status: qualityDegradingReasons.length ? 'degraded' : 'clean',
        maintenance_actions: maintenanceActions,
        maintenance_actions_performed: maintenanceActions.entity_links_repaired,
        reasons: qualityReasons,
        notices: qualityNotices,
      };
      await runNonfatalPresentationTask('Unified memory injection', () => maybeInjectUnified());
      await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
      const completedTimingSample = !ctrl.catchUpCancelled
        && finalizationTiming.started_at
        && finalizationTiming.completed_units >= finalizationTiming.planned_units
        ? {
          schema_version: 1,
          signature: timingSignature,
          completed: true,
          recorded_at: Date.now(),
          message_count: total,
          chunk_ms_per_message: total > 0
            ? Math.round((finalizationTiming.started_at - catchUpTiming.started_at) / total)
            : null,
          finalization_ms: Date.now() - finalizationTiming.started_at,
          finalization_units: finalizationTiming.planned_units,
          finalization_ms_per_unit: Math.round((Date.now() - finalizationTiming.started_at) / finalizationTiming.planned_units),
          finalization_phase_durations: finalizationTiming.phase_durations,
        }
        : null;
      if (completedTimingSample) {
        settings.catch_up_timing_history = [
          ...(settings.catch_up_timing_history ?? []),
          completedTimingSample,
        ].slice(-12);
      }
      saveSettingsDebounced();

      // Persist the final diagnostics with the same staged commit. The status
      // is a pre-commit projection; a failed final commit is then recorded and
      // reflected in the user-visible completion status below.
      const projectedStatus = projectedOperationalStatus;
      // Compact exportable diagnostics deliberately exclude chat text and raw provider output while retaining run-level failure information.
      const diagnostics = {
        version: 1,
        created_at: Date.now(),
        status: projectedStatus,
        operational_status: projectedStatus,
        chunks: runResult.chunks,
        sceneDetection: runResult.sceneDetection ?? null,
        tiers: runResult.extractionFailuresByTier,
        identityResolution: runResult.identityResolution ?? null,
        identityResolutionDetails: runResult.identityResolutionDetails ?? null,
        persistence_failures: runResult.saveFailures,
        retried_requests: runResult.retriedRequests,
        errors: catchUpErrorCount,
        error_details: runResult.errors,
        warnings: runResult.warnings,
        warnings_suppressed: runResult.warningsSuppressed,
        pre_run_state_audit: preRunFreshStartAudit ? {
          ...preRunFreshStartAudit,
          available: true,
          pre_run_reset_audit_id: preRunFreshStartAudit.audit_id ?? null,
          observed_by_run_id: catchUpRunId,
        } : { available: false, clean: null, failure_reasons: ['no_fresh_start_audit_available'] },
        fresh_start_postcondition_audit: preRunFreshStartAudit ? {
          ...preRunFreshStartAudit,
          available: true,
          pre_run_reset_audit_id: preRunFreshStartAudit.audit_id ?? null,
          observed_by_run_id: catchUpRunId,
        } : { available: false, clean: null, failure_reasons: ['no_fresh_start_audit_available'] },
        run_origin: {
          began_after_fresh_start: Boolean(preRunFreshStartAudit),
          pre_run_state_audit_available: Boolean(preRunFreshStartAudit),
          pre_run_state_clean: preRunFreshStartAudit?.clean ?? null,
        },
        parser_debris_cleanup: catchUpContext.chatMetadata?.[META_KEY]?.parser_debris_cleanup ?? null,
        arc_summary_verification: summarizeArcSummaryVerification(loadArcSummaries(), loadArcs()),
        arcResolution: summarizeArcStatusResolution(loadArcs(), runResult.arcResolution),
        arc_record_accounting: summarizeArcRecordAccounting(loadArcs(), runResult.arcExtraction),
        arc_status_traces: summarizeArcStatusTraces(loadArcs()),
        arcExtraction: runResult.arcExtraction,
        arcPipeline: runResult.arcPipeline,
        provider_failures: runResult.providerFailures,
        extraction_coverage: runResult.extractionCoverage,
        sessionExtraction: runResult.sessionExtraction,
        profiles: runResult.profiles,
        finalReconciliation: runResult.finalReconciliation,
        // Keep the automatic post-catch-up stabilization result distinct from
        // any separately persisted, user-triggered Developer check.
        automatic_stabilization: runResult.finalReconciliation?.stabilization ?? null,
        manual_idempotence: catchUpContext.chatMetadata?.[META_KEY]?.developer_idempotence_check ?? null,
        runtime_context: runResult.runtimeContext,
        imported_persona_recovery: (() => {
          const recovery = runResult.runtimeContext?.active_persona?.imported_persona_recovery;
          if (!recovery) return null;
          return {
            attempted: true,
            selected_persona_available: Boolean(runResult.runtimeContext?.active_persona?.canonical_name),
            resolution_method: recovery.source,
            user_message_count: recovery.user_message_count,
            valid_author_message_count: recovery.valid_author_message_count,
            candidate_count: recovery.candidate_count,
            candidate_support_count: recovery.candidate_support_count,
            candidate_support_ratio: recovery.candidate_support_ratio,
            competing_author_count: recovery.competing_author_count,
            rejection_reason: recovery.rejection_reason,
            selected_canonical_persona_id: runResult.runtimeContext?.active_persona?.stable_persona_id ?? null,
          };
        })(),
        historical_persona_recovery: (() => {
          const historical = runResult.runtimeContext?.historical_persona;
          const recovery = runResult.runtimeContext?.active_persona?.imported_persona_recovery;
          return {
            attempted: Boolean(recovery),
            current_live_persona_id: runResult.runtimeContext?.active_persona?.stable_persona_id ?? null,
            current_live_persona_name: runResult.runtimeContext?.active_persona?.canonical_name ?? null,
            imported_author_candidate: recovery?.canonical_name ?? null,
            imported_author_support_count: recovery?.candidate_support_count ?? 0,
            imported_author_support_ratio: recovery?.candidate_support_ratio ?? 0,
            historical_snapshot_created: Boolean(historical),
            historical_snapshot_id: historical?.stable_persona_id ?? null,
            historical_snapshot_reused: false,
            aliases_approved: historical?.approved_aliases ?? [],
            duplicate_entities_collapsed: runResult.finalReconciliation?.card_local_entities_merged ?? 0,
            relationship_pairs_rekeyed: runResult.finalReconciliation?.relationship_pairs_merged ?? 0,
            profile_targets_rewritten: runResult.finalReconciliation?.participant_lists_rewritten ?? 0,
            unresolved_reviews: runResult.identity_review?.remaining_at_end ?? 0,
            unresolved_review_categories: runResult.finalReconciliation?.integrity_audit?.identity_review_categories ?? {},
          };
        })(),
        quality: runResult.quality,
        timing_estimate: {
          signature: timingSignature,
          comparable_completed_runs: comparableTimingHistory.length,
          historical_chunk_ms_per_message: historicalChunkMsPerMessage,
          historical_finalization_ms_per_unit: historicalFinalizationMsPerUnit,
          recorded_completed_run: completedTimingSample,
        },
      };
      if (!catchUpContext.chatMetadata) catchUpContext.chatMetadata = {};
      if (!catchUpContext.chatMetadata[META_KEY]) catchUpContext.chatMetadata[META_KEY] = {};
      const sceneStabilityHistory = catchUpContext.chatMetadata[META_KEY].scene_stability_history ?? [];
      // Preserve raw normalized run records as history, while exporting the
      // separately computed canonical comparison object. Consumers must not
      // mistake the retained raw history array for the deduplicated analysis.
      diagnostics.scene_stability_analysis = runResult.sceneDetection?.scene_stability_history ?? null;
      const priorSceneRun = runResult.sceneDetection
        ? [...sceneStabilityHistory].reverse().find((run) => run?.scene_detection_run_signature === runResult.sceneDetection.scene_detection_run_signature
          && run?.prompt_shape_hash === runResult.sceneDetection.prompt_shape_hash
          && run?.model_identifier === runResult.sceneDetection.model_identifier
          && run?.connection_profile_identifier === runResult.sceneDetection.connection_profile_identifier
          && run?.task_settings_hash === diagnosticFingerprint(JSON.stringify(runResult.sceneDetection.task_sampling_settings ?? {}))) ?? null
        : null;
      if (runResult.sceneDetection) {
        const currentRequests = Number(runResult.sceneDetection.total_provider_requests ?? runResult.sceneDetection.scene_detector_model_request_count ?? 0);
        // Older retained snapshots did not serialize provider-request totals.
        // Missing is not zero: reporting a delta against it would invent a
        // regression where no historical metric exists.
        const priorHasRequestMetric = Boolean(priorSceneRun
          && Object.prototype.hasOwnProperty.call(priorSceneRun, 'total_provider_requests')
          && Number.isFinite(Number(priorSceneRun.total_provider_requests)));
        const priorRequests = priorHasRequestMetric ? Number(priorSceneRun.total_provider_requests) : null;
        diagnostics.scene_request_efficiency = {
          prior_provider_request_count: priorRequests,
          prior_request_run_id: priorSceneRun?.run_id ?? null,
          prior_request_count_available: priorRequests !== null,
          prior_request_compatibility_status: priorSceneRun ? (priorRequests === null ? 'prior_metrics_missing' : 'compatible') : 'no_prior_compatible_run',
          prior_request_unavailable_reason: priorRequests !== null ? null : (!priorSceneRun ? 'no_prior_compatible_run' : 'prior_metrics_missing'),
          current_provider_request_count: currentRequests,
          request_count_delta: priorRequests === null ? null : currentRequests - priorRequests,
          provider_partial_response_count: (runResult.sceneDetection.batch_attempts ?? []).filter((attempt) => attempt.partial_or_truncated).length,
          format_repair_count: Number(runResult.sceneDetection.format_repair_requests ?? 0),
          likely_request_regression_reason: !priorSceneRun ? 'no_comparable_prior_run'
            : priorRequests === null ? 'prior_request_metric_unavailable'
            : currentRequests <= priorRequests ? 'no_request_regression'
              : (runResult.sceneDetection.partial_retry_requests ?? 0) > 0 ? 'provider_partial_responses_required_bounded_retries'
                : (runResult.sceneDetection.format_repair_requests ?? 0) > 0 ? 'provider_format_repair_required'
                  : 'unclassified_request_increase',
        };
      }
      diagnostics.scene_stability_history = runResult.sceneDetection
        ? updateSceneStabilityHistory(sceneStabilityHistory, runResult.sceneDetection)
        : sceneStabilityHistory.slice(-5);
      diagnostics.request_efficiency_history = diagnostics.scene_stability_history.map((run) => ({
        run_id: run.run_id,
        total_provider_requests: run.total_provider_requests ?? null,
        root_requests: run.initial_batch_requests ?? null,
        retry_requests: run.partial_retry_requests === undefined ? null : Number(run.partial_retry_requests ?? 0) + Number(run.single_candidate_retry_requests ?? 0),
        format_repairs: run.format_repair_requests ?? null,
        partial_response_count: run.provider_partial_response_count ?? null,
        final_batch_ceiling: run.adaptive_batch_summary?.effective_ceiling_history?.at(-1) ?? null,
      })).slice(-5);
      // `repairs` is already used above for the session repair counters in
      // this catch-up scope. Keep integrity repair accounting distinct so the
      // module remains parseable during extension activation.
      const integrityRepairs = runResult.finalReconciliation?.integrity_audit?.entity_link_repairs ?? {};
      const priorRepairHistory = catchUpContext.chatMetadata[META_KEY].repair_history ?? [];
      const currentRepairSummary = {
        run_id: catchUpRunId,
        logical_mutations: integrityRepairs.actual_logical_mutations_this_run ?? 0,
        physical_mutations: integrityRepairs.actual_physical_store_mutations_this_run ?? 0,
        current_run_generated_invalid_links: integrityRepairs.invalid_links_created_current_run ?? 0,
        origin_unknown_repairs: integrityRepairs.origin_unknown_invalid_links_repaired ?? 0,
        recreated_after_prior_repair: integrityRepairs.recreated_after_prior_repair ?? 0,
      };
      const previousRepairSummary = priorRepairHistory.at(-1) ?? null;
      const repairVolumeDelta = previousRepairSummary
        ? currentRepairSummary.logical_mutations - Number(previousRepairSummary.logical_mutations ?? 0)
        : null;
      diagnostics.repair_history = [...priorRepairHistory.filter((entry) => entry?.run_id !== catchUpRunId), currentRepairSummary].slice(-5);
      diagnostics.repair_volume_changed = repairVolumeDelta !== null && repairVolumeDelta !== 0;
      diagnostics.repair_volume_delta = repairVolumeDelta;
      diagnostics.repair_volume_change_reason = repairVolumeDelta === null
        ? 'no_prior_comparable_repair_summary'
        : repairVolumeDelta === 0 ? 'unchanged_logical_repair_volume'
          : repairVolumeDelta > 0 ? 'increased_logical_repair_volume'
            : 'decreased_logical_repair_volume';
      catchUpContext.chatMetadata[META_KEY].last_catchup_run_id = catchUpRunId;
      delete catchUpContext.chatMetadata[META_KEY].active_catchup_run_id;
      // A final transaction is the completion boundary. Until it commits, the
      // checkpoint remains durable and resumable; a crash in late stages will
      // restart finalization from the last committed extraction chunk.
      if (ctrl.catchUpCancelled) {
        const checkpoint = catchUpContext.chatMetadata[META_KEY].catch_up_checkpoint;
        if (checkpoint) {
          checkpoint.status = 'awaiting_manual_resume';
          checkpoint.updated_at = Date.now();
        }
      } else delete catchUpContext.chatMetadata[META_KEY].catch_up_checkpoint;
      catchUpContext.chatMetadata[META_KEY].catch_up_diagnostics = diagnostics;
      catchUpContext.chatMetadata[META_KEY].scene_stability_history = diagnostics.scene_stability_history;
      catchUpContext.chatMetadata[META_KEY].request_efficiency_history = diagnostics.request_efficiency_history;
      catchUpContext.chatMetadata[META_KEY].repair_history = diagnostics.repair_history;

      // This is deliberately the last local reconciliation boundary before
      // the staged transaction is committed.  Earlier finalization builds
      // bounded history and diagnostic records and may cause a persistence
      // helper to materialize a legacy durable default.  Running only the
      // earlier reconciliation made the automatic result look stable even
      // though a subsequently-invoked Developer check could still repair
      // card-local, scene, session, or arc records.  The same reconciler is
      // therefore run against the actual pre-commit durable graph, after all
      // durable-reference-producing finalization work has completed.
      const preCommitAutomaticHash = durableStateHash(snapshotIdempotenceDurableState(catchUpContext.chatMetadata[META_KEY]));
      try {
        const preCommitAutomaticReconciliation = await runFinalIntegrityReconciliation(characterName);
        const postCommitAutomaticHash = preCommitAutomaticReconciliation.idempotence?.durable_state_hash_after_second_pass ?? null;
        const preCommitDependencyTrace = {
          stage: 'post_finalization_precommit',
          pipeline: 'automatic_post_catchup_stabilization',
          input_durable_hash: preCommitAutomaticHash,
          output_durable_hash: postCommitAutomaticHash,
          stable: preCommitAutomaticReconciliation.idempotence?.idempotent === true,
          passes: preCommitAutomaticReconciliation.idempotence?.automatic_stabilization_passes?.executed_passes ?? 0,
          changed_components: preCommitAutomaticReconciliation.idempotence?.automatic_stabilization_passes?.passes
            ?.flatMap((pass) => pass.changed_components ?? [])
            .map((entry) => entry.component) ?? [],
        };
        // Replace the provisional earlier audit with the one produced from
        // the true finalized state. Consumers consequently compare the manual
        // Developer command with the exact durable graph it will receive.
        runResult.finalReconciliation.integrity_audit = preCommitAutomaticReconciliation.integrity_audit ?? runResult.finalReconciliation.integrity_audit;
        runResult.finalReconciliation.final_state_audit = preCommitAutomaticReconciliation.final_state_audit ?? runResult.finalReconciliation.final_state_audit;
        runResult.finalReconciliation.stabilization = preCommitAutomaticReconciliation.idempotence ?? runResult.finalReconciliation.stabilization;
        runResult.finalReconciliation.idempotence = preCommitAutomaticReconciliation.idempotence ?? runResult.finalReconciliation.idempotence;
        runResult.finalReconciliation.final_state_consistency = preCommitAutomaticReconciliation.final_state_consistency ?? runResult.finalReconciliation.final_state_consistency;
        runResult.finalReconciliation.precommit_automatic_dependency_trace = preCommitDependencyTrace;
        diagnostics.finalReconciliation = runResult.finalReconciliation;
        diagnostics.automatic_stabilization = runResult.finalReconciliation.stabilization;
        diagnostics.post_automatic_finalization_dependency_trace = preCommitDependencyTrace;
      } catch (error) {
        // Do not let a local observability pass discard validated memories at
        // the end of a long run. Record the bounded failure, retain the
        // earlier reconciliation result, and let normal quality reporting
        // surface the problem.
        recordCatchUpError('post-finalization automatic reconciliation error', error, 'identity');
        diagnostics.post_automatic_finalization_dependency_trace = {
          stage: 'post_finalization_precommit', pipeline: 'automatic_post_catchup_stabilization',
          input_durable_hash: preCommitAutomaticHash, output_durable_hash: null,
          stable: false, passes: 0, changed_components: [], check_failed: true,
        };
      }
      latestExportDiagnostics = diagnostics;
      try {
        await retryTransientMemoryOperation(() => commitCatchUpTransaction(finalTransaction));
      } catch (err) {
        recordCatchUpError('final persistence error', err, null, true);
        diagnostics.status = 'partial';
        diagnostics.operational_status = 'partial';
        diagnostics.errors = catchUpErrorCount;
        diagnostics.persistence_failures = runResult.saveFailures;
        diagnostics.error_details = runResult.errors;
        diagnostics.final_persistence_error = String(err?.message ?? err ?? 'Unknown persistence error').replace(/\s+/g, ' ').slice(0, 300);
        // The transaction rollback removes saved metadata, but this session
        // copy remains available through Export Diagnostics.
        latestExportDiagnostics = diagnostics;
      } finally {
        finalTransaction = null;
      }

      if (ctrl.catchUpCancelled) {
        runResult.status = 'cancelled';
        setStatusMessage('Catch-up cancelled.');
        toastr.warning('Catch-up cancelled. Partial results have been saved.', 'Smart Memory Enhanced', {
          timeOut: 5000,
          positionClass: 'toast-bottom-right',
        });
      } else if (catchUpErrorCount > 0) {
        runResult.status = runResult.completedChunks === 0 && runResult.failedChunks > 0 ? 'failed' : 'partial';
        const persistenceDetail = runResult.saveFailures > 0
          ? `, ${runResult.saveFailures} persistence failure${runResult.saveFailures === 1 ? '' : 's'}`
          : '';
        const lateStageLabels = [...new Set(runResult.errors
          .map((entry) => entry.label)
          .filter((label) => !/\(chunk\)|chunk persistence/i.test(label)))];
        const lateStageDetail = lateStageLabels.length
          ? ` Late-stage failure${lateStageLabels.length === 1 ? '' : 's'}: ${lateStageLabels.join('; ')}.`
          : '';
        setStatusMessage(
          `Catch-up ${runResult.status}: ${runResult.completedChunks}/${runResult.totalChunks} chunks completed, ${runResult.failedChunks} failed${persistenceDetail}.${lateStageDetail}`,
        );
        toastr.warning(
          `Catch-up ${runResult.status}. ${runResult.failedChunks} chunk${runResult.failedChunks === 1 ? '' : 's'} failed${persistenceDetail} after ${runResult.retriedRequests} retr${runResult.retriedRequests === 1 ? 'y' : 'ies'}.${lateStageDetail}`,
          'Smart Memory Enhanced',
          { timeOut: 8000, positionClass: 'toast-bottom-right' },
        );
      } else {
        const sceneAudit = runResult.sceneDetection;
        const sceneSummary = sceneAudit
          ? ` Scenes: ${sceneAudit.candidates} detected, ${sceneAudit.generated} generated, ${sceneAudit.duplicates} duplicates, ${sceneAudit.failed} failed, ${sceneAudit.retained} archived, ${sceneAudit.injected} injected.`
          : '';
        const qualityDetail = runResult.quality.status === 'degraded'
          ? ` Data quality degraded: ${runResult.quality.reasons.map((reason) => reason.message).join(' ')}`
          : '';
        const profileGuardDetail = runResult.quality.status === 'clean' && runResult.quality.notices.length
          ? ` Profile safeguards: ${runResult.quality.notices.map((notice) => notice.message).join(' ')}`
          : '';
        const repairedLinks = runResult.quality.maintenance_actions_performed ?? 0;
        const repairStores = runResult.quality.maintenance_actions?.entity_link_store_mutations ?? 0;
        const maintenanceDetail = repairedLinks > 0
          ? ` ${repairedLinks} entity link${repairedLinks === 1 ? '' : 's'} repaired${repairStores > 1 ? ` across ${repairStores} durable store mutations` : ''}.`
          : '';
        setStatusMessage(`Catch-up complete.${qualityDetail}${profileGuardDetail}${maintenanceDetail}${sceneSummary}`);
        const notifier = runResult.quality.status === 'degraded' ? toastr.warning : toastr.success;
        notifier(`Full catch-up extraction finished.${qualityDetail}${profileGuardDetail}${maintenanceDetail}${sceneSummary}`, 'Smart Memory Enhanced', {
          timeOut: runResult.quality.status === 'degraded' ? 8000 : 4000,
          positionClass: 'toast-bottom-right',
        });
      }
      $('#sme_export_diagnostics').prop('disabled', false);
    } catch (err) {
      if (finalTransaction) rollbackCatchUpTransaction(finalTransaction);
      recordCatchUpError('run failure', err);
      showError('Catch-up', err);
      setStatusMessage('Catch-up failed.');
    } finally {
      // Completion must become observable before optional runtime cleanup.
      // A cleanup helper can fail after a long successful run; it must never
      // strand the UI on Cancel or leave the local idempotence guard locked.
      ctrl.extractionRunning = false;
      ctrl.compactionRunning = false;
      ctrl.catchUpCancelled = false;
      try {
        $('#sme_cancel_catch_up').hide().prop('disabled', false);
        $('#sme_catch_up').show().prop('disabled', false);
        $('#sme_run_idempotence_check').prop('disabled', false);
        $('#sme_catch_up_eta').hide().empty();
        refreshCatchUpRecoveryUI();
      } catch (cleanupErr) {
        console.warn('[Smart Memory Enhanced] Catch-up control cleanup warning:', cleanupErr);
      }
      try {
        if (finalizationEtaRefreshTimer) window.clearInterval(finalizationEtaRefreshTimer);
      } catch (cleanupErr) {
        console.warn('[Smart Memory Enhanced] Catch-up ETA cleanup warning:', cleanupErr);
      }
      try {
        clearCanonicalRuntimeContextSnapshot();
      } catch (cleanupErr) {
        console.warn('[Smart Memory Enhanced] Canonical runtime cleanup warning:', cleanupErr);
      }
      try {
        unsubscribeRetry();
      } catch (cleanupErr) {
        console.warn('[Smart Memory Enhanced] Retry listener cleanup warning:', cleanupErr);
      }
    }
  });

  $('#sme_cancel_catch_up').on('click', function () {
    ctrl.catchUpCancelled = true;
    $(this).prop('disabled', true);
    setStatusMessage('Cancelling...');
  });

  // ---- Clear Chat Context ---------------------------------------------
  $('#sme_clear_chat_context').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (
      !(await callGenericPopup(
        'Clear all Smart Memory Enhanced context for this chat?\n\nPerspectives & Secrets entries are also cleared.\nLong-term memories, relationship history, state cards, canon, and pinned arcs are not affected.',
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;

    const characterName = ctrl.getSelectedCharacterName();
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    try {
      await runStagedChatCleanup(context, async () => {
        delete context.chatMetadata[META_KEY].catch_up_checkpoint;
        delete context.chatMetadata[META_KEY].active_catchup_run_id;
        // Wipe short-term summary state.
        delete context.chatMetadata[META_KEY].summary;
        delete context.chatMetadata[META_KEY].summaryEnd;
        delete context.chatMetadata[META_KEY].summaryUpdated;

        // Clear the other chat-scoped tiers.
        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearSceneHistory();
        await clearArcs();
        await clearArcSummaries();
        await clearProfiles();
        // Chat-Local Only stores are part of this chat, not reusable character
        // history. Forget This Chat must remove them for every group member.
        clearChatLocalCharacterData(context);
        // Epistemic knowledge is extension_settings-scoped (persists across chats)
        // and is intentionally NOT cleared here - same reasoning as state ledger.
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Forget This Chat persistence failed:', err);
      setStatusMessage('Chat context was not cleared because the chat could not be saved.');
      toastr.error('Could not save the cleared chat context. Please try again.', 'Smart Memory Enhanced');
      return;
    }

    // Clearing chatMetadata means loadAndInjectSummary will clear the slot.
    loadAndInjectSummary();
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectProfiles(characterName);
    injectStateLedger();
    injectEpistemicKnowledge(characterName, characterName);

    updateShortTermUI(null);
    updateEpistemicUI(characterName);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateProfilesUI(null);
    updateEntityPanel(characterName);
    updateTokenDisplay();
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
    setCatchUpErrorCount(0);
    refreshCatchUpRecoveryUI();
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sme_fresh_start_button').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    const freshStartContext = getContext();
    const freshStartCharacterNames = (() => {
      if (!freshStartContext.groupId) return characterName ? [characterName] : [];
      const group = freshStartContext.groups?.find((entry) => entry.id === freshStartContext.groupId);
      if (!group) return characterName ? [characterName] : [];
      // A Fresh Start resets the chat, so it covers every group card—not just
      // members currently enabled for live reply generation. Disabled cards
      // can still own previously stored Full or Chat-Local data.
      return group.members
        .map((avatar) => freshStartContext.characters.find((card) => card.avatar === avatar)?.name)
        .filter(Boolean);
    })();
    const nameLabel = freshStartCharacterNames.length > 1
      ? `${freshStartCharacterNames.length} group characters`
      : characterName ? `"${characterName}"` : 'this character';
    if (
      !(await callGenericPopup(
        `Fresh Start for ${nameLabel} - this will permanently delete all Smart Memory Enhanced data for this character and chat.\n\nThis cannot be undone. Continue?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;

    // Clear all chat-scoped tiers.
    const context = freshStartContext;
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    try {
      await runStagedChatCleanup(context, async () => {
        // Group token rows represent every group member's personal stores.
        // Fresh Start therefore clears each member, not merely the
        // card currently selected in the settings selector.
        for (const memberName of freshStartCharacterNames) {
          clearCharacterMemories(memberName);
          clearRelationshipHistory(memberName);
          clearEpistemicKnowledge(memberName);
          clearCanon(memberName);
          await clearProfiles(memberName);
          clearCharacterDurableDataForFreshStart(memberName);
        }

        delete context.chatMetadata[META_KEY].summary;
        delete context.chatMetadata[META_KEY].summaryEnd;
        delete context.chatMetadata[META_KEY].summaryUpdated;
        delete context.chatMetadata[META_KEY].lastExtractCutoff;

        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearSceneHistory();
        await clearArcs();
        await clearArcSummaries();
        await clearStateLedger();
        // These stores belong to this chat, so keeping another group
        // member's local data would leave an apparently uncleared bar.
        clearChatLocalCharacterData(context);
        const resetMetadataResult = clearFreshStartRunMetadata(context, freshStartCharacterNames);
        // Save a compact postcondition in the same transaction as the
        // destructive reset.  This makes a failed or incomplete reset visible
        // before a costly historical rebuild is started.
        const clearedMetadata = context.chatMetadata[META_KEY] ?? {};
        const remainingStores = {
          long_term_summary: Boolean(clearedMetadata.summary),
          session_memories: (clearedMetadata.sessionMemories ?? []).length,
          scenes: (clearedMetadata.sceneHistory ?? []).length,
          arcs: (clearedMetadata.arcs ?? []).length,
          arc_summaries: (clearedMetadata.arcSummaries ?? []).length,
          state_ledger: Object.keys(clearedMetadata.stateLedger ?? {}).length,
          developer_check: Boolean(clearedMetadata.developer_idempotence_check),
          catchup_diagnostics: Boolean(clearedMetadata.catch_up_diagnostics),
        };
        clearedMetadata.fresh_start_postcondition_audit = {
          schema_version: 2,
          audit_id: generateMemoryId(),
          performed_at: Date.now(),
          chat_scope_hash: diagnosticFingerprint(JSON.stringify({ chat_id: context.chatId ?? null, group_id: context.groupId ?? null })),
          transaction_committed: true,
          available: true,
          completed: true,
          scene_history_runs_remaining: remainingStores.scenes,
          catch_up_run_history_remaining: Number(Boolean(clearedMetadata.last_catchup_run_id)),
          citation_repair_history_remaining: Number(Boolean(clearedMetadata.repair_history)),
          developer_result_remaining: remainingStores.developer_check,
          cached_diagnostics_remaining: remainingStores.catchup_diagnostics,
          parser_cleanup_state_remaining: Number(Boolean(clearedMetadata.parser_debris_cleanup)),
          current_chat_redirects_remaining: Object.keys(clearedMetadata.entity_redirects ?? {}).length,
          current_chat_identity_reviews_remaining: resetMetadataResult.current_chat_identity_reviews_remaining,
          current_chat_identity_reviews_removed: resetMetadataResult.identity_reviews_removed,
          arc_run_history_remaining: Number(Boolean(clearedMetadata.arc_run_history)),
          stabilization_history_remaining: Number(Boolean(clearedMetadata.scene_stability_history)),
          repair_recurrence_history_remaining: Number(Boolean(clearedMetadata.repair_history)),
          other_run_scoped_records_remaining: 0,
          preserved_reusable_global_records: true,
          preserved_reusable_card_records: true,
          remaining_store_counts: remainingStores,
          clean: !remainingStores.long_term_summary && Object.entries(remainingStores)
            .filter(([key]) => key !== 'long_term_summary')
          .every(([, value]) => value === 0 || value === false)
            && resetMetadataResult.current_chat_identity_reviews_remaining === 0,
          failure_reasons: [],
        };
        if (!clearedMetadata.fresh_start_postcondition_audit.clean) {
          clearedMetadata.fresh_start_postcondition_audit.failure_reasons = Object.entries(remainingStores)
          .filter(([, value]) => value !== 0 && value !== false)
            .map(([key]) => `${key}_remaining`);
          if (resetMetadataResult.current_chat_identity_reviews_remaining > 0) {
            clearedMetadata.fresh_start_postcondition_audit.failure_reasons.push('current_chat_identity_reviews_remaining');
          }
        }
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Fresh Start persistence failed:', err);
      setStatusMessage('Fresh Start was not saved. Nothing was cleared. Please try again.');
      toastr.error('Could not save Fresh Start. Nothing was cleared.', 'Smart Memory Enhanced');
      return;
    }
    // Character-scoped stores live in extension settings. Do not schedule that
    // separate persistence write until the chat transaction has committed.
    if (freshStartCharacterNames.length) saveSettingsDebounced();
    // Dismiss any open recap modal.
    $('#sme_recap_overlay').remove();

    // Clear all injection slots.
    loadAndInjectSummary();
    await injectMemories(characterName);
    injectRelationshipHistory(characterName);
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectEpistemicKnowledge(characterName, characterName);
    injectCanon(characterName);
    injectProfiles(characterName);
    injectStateLedger();

    updateShortTermUI(null);
    updateLongTermUI(characterName);
    updateRelationshipHistoryUI(characterName);
    updateEpistemicUI(characterName);
    updateFreshStartUI(isFreshStart());
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateCanonUI(characterName);
    updateProfilesUI(null);
    updateTokenDisplay();
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
    setCatchUpErrorCount(0);
    refreshCatchUpRecoveryUI();
    // The completed reset audit is exportable even before the next Memorize
    // Chat run, so users can verify the clean starting point first.
    $('#sme_export_diagnostics').prop('disabled', !getExportableDiagnostics());
    setStatusMessage('Fresh start complete.');
    toastr.success(`All memories cleared for ${nameLabel}.`, 'Smart Memory Enhanced', {
      timeOut: 4000,
      positionClass: 'toast-bottom-right',
    });
  });

  // ---- Embedding deduplication ----------------------------------------

  /**
   * Shows or hides source-specific UI elements based on the current embedding_source setting.
   * Ollama shows the model dropdown + refresh button + keep-in-memory.
   * OpenAI Compatible shows a plain model text field and hides Ollama-only controls.
   */
  function applyEmbeddingSourceUI() {
    const src = extension_settings[MODULE_NAME].embedding_source ?? 'ollama';
    const isOllama = src === 'ollama';
    $('#sme_embedding_model_ollama_row').toggle(isOllama);
    $('#sme_embedding_model_openai_row').toggle(!isOllama);
    $('#sme_embedding_api_key_row').toggle(!isOllama);
    $('#sme_embedding_keep_row').toggle(isOllama);
    $('#sme_embedding_install_hint_ollama').toggle(isOllama);
    $('#sme_embedding_install_hint_openai').toggle(!isOllama);
    if (!isOllama) {
      // Sync the OpenAI model text field with the stored setting.
      $('#sme_embedding_model_openai').val(extension_settings[MODULE_NAME].embedding_model ?? '');
      // Show whether a key is stored - never populate the field with the actual value.
      $('#sme_embedding_api_key')
        .val('')
        .attr('placeholder', hasEmbeddingApiKey() ? '(key stored)' : 'sk-...');
    }
  }

  $('#sme_embedding_enabled')
    .prop('checked', s.embedding_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_enabled = $(this).prop('checked');
      $('#sme_embedding_config').toggle(extension_settings[MODULE_NAME].embedding_enabled);
      // Reset failure flag so the next attempt gets a clean slate.
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
    });
  $('#sme_embedding_config').toggle(s.embedding_enabled);

  $('#sme_embedding_source')
    .val(s.embedding_source ?? 'ollama')
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_source = $(this).val();
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      applyEmbeddingSourceUI();
      saveSettingsDebounced();
      if (extension_settings[MODULE_NAME].embedding_source === 'ollama') {
        refreshEmbeddingModels();
      }
    });

  $('#sme_embedding_url')
    .val(s.embedding_url ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_url = $(this).val().trim();
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
      if ((extension_settings[MODULE_NAME].embedding_source ?? 'ollama') === 'ollama') {
        refreshEmbeddingModels();
      }
    });

  // Embedding model dropdown - saves on selection change.
  $('#sme_embedding_model').on('change', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // Manual text fallback - shown when Ollama is not reachable from the browser.
  $('#sme_embedding_model_manual').on('input', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val().trim();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // OpenAI Compatible model text field.
  $('#sme_embedding_model_openai').on('input', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val().trim();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // OpenAI Compatible embedding API key field - stored in extension_settings.
  $('#sme_embedding_api_key').on('change', function () {
    const value = $(this).val().trim();
    saveEmbeddingApiKey(value);
    $(this)
      .val('')
      .attr('placeholder', hasEmbeddingApiKey() ? '(key stored)' : 'sk-...');
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
  });

  applyEmbeddingSourceUI();

  // Refresh button and auto-load on settings open (Ollama only).
  $('#sme_embedding_refresh').on('click', () => refreshEmbeddingModels());
  if (s.embedding_enabled && (s.embedding_source ?? 'ollama') === 'ollama') {
    refreshEmbeddingModels();
  }

  $('#sme_embedding_keep')
    .prop('checked', s.embedding_keep)
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_keep = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_embedding_test').on('click', async function () {
    const $btn = $(this);
    const $result = $('#sme_embedding_test_result');
    $btn.prop('disabled', true);
    $result.text('Testing...');
    try {
      const map = await getEmbeddingBatch(['smart memory test']);
      if (map.size > 0) {
        $result.html('<span style="color: var(--green, #5a8)">Connected</span>');
        clearEmbeddingFailed();
        updateEmbeddingNotice();
      } else {
        $result.html(
          '<span style="color: var(--warning, #ca6)">No response - check URL and model name</span>',
        );
      }
    } catch {
      $result.html(
        '<span style="color: var(--warning, #ca6)">Connection failed - is Ollama running?</span>',
      );
    } finally {
      $btn.prop('disabled', false);
    }
  });

  // "Set up embeddings" link in the notice scrolls to the dedup section.
  $('#sme_embedding_notice_link').on('click', function (e) {
    e.preventDefault();
    const $dedup = $('#sme_embedding_enabled').closest('details');
    if ($dedup.length) {
      $dedup.prop('open', true);
      $dedup[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  updateEmbeddingNotice();

  // ---- Profiles -------------------------------------------------------
  $('#sme_profiles_enabled')
    .prop('checked', s.profiles_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].profiles_enabled) {
        setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectProfiles(ctrl.getSelectedCharacterName());
      }
    });

  const $profilesThresholdVal = $('#sme_profiles_stale_threshold_value');
  const formatProfilesThreshold = (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`);
  $profilesThresholdVal.text(formatProfilesThreshold(s.profiles_stale_threshold_minutes ?? 30));
  $('#sme_profiles_stale_threshold')
    .val(s.profiles_stale_threshold_minutes ?? 30)
    .on('input', function () {
      const v = Number($(this).val());
      $profilesThresholdVal.text(formatProfilesThreshold(v));
      extension_settings[MODULE_NAME].profiles_stale_threshold_minutes = v;
      saveSettingsDebounced();
    });

  const $regenEveryVal = $('#sme_profiles_regen_every_value');
  const formatRegenEvery = (v) => (v === 0 ? 'extraction only' : `${v} msg${v === 1 ? '' : 's'}`);
  $regenEveryVal.text(formatRegenEvery(s.profiles_regen_every ?? 0));
  $('#sme_profiles_regen_every')
    .val(s.profiles_regen_every ?? 0)
    .on('input', function () {
      const v = Number($(this).val());
      $regenEveryVal.text(formatRegenEvery(v));
      extension_settings[MODULE_NAME].profiles_regen_every = v;
      saveSettingsDebounced();
    });

  $('#sme_profiles_regenerate').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No active character - profiles need a character.', 'Smart Memory Enhanced', {
        timeOut: 3000,
        positionClass: 'toast-bottom-right',
      });
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating profiles...');
    try {
      const profiles = await generateProfiles(characterName);
      if (profiles) {
        injectProfiles(characterName);
        updateProfilesUI(profiles);
        setStatusMessage('Profiles updated.');
      } else {
        setStatusMessage('Profile generation returned no output.');
      }
    } catch (err) {
      showError('Profile generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  const $profilesBudgetVal = $('#sme_profiles_inject_budget_value');
  $('#sme_profiles_inject_budget')
    .val(s.profiles_inject_budget ?? 400)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].profiles_inject_budget = val;
      $profilesBudgetVal.text(val + ' tokens');
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });
  $profilesBudgetVal.text((s.profiles_inject_budget ?? 400) + ' tokens');

  const currentProfilesPosition = s.profiles_position ?? extension_prompt_types.IN_PROMPT;
  $(`input[name="sme_profiles_position"][value="${currentProfilesPosition}"]`).prop('checked', true);
  $('input[name="sme_profiles_position"]').on('change', function () {
    extension_settings[MODULE_NAME].profiles_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
    injectProfiles(ctrl.getSelectedCharacterName());
  });

  $('#sme_profiles_depth')
    .val(s.profiles_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].profiles_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  $('#sme_profiles_role')
    .val(s.profiles_role ?? extension_prompt_roles.SYSTEM)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  updateProfilesUI(loadProfiles(ctrl.getSelectedCharacterName()));

  // ---- Entity graph -------------------------------------------------------
  $('#sme_open_graph_btn').on('click', () => {
    showMemoryGraph(ctrl.getSelectedCharacterName());
  });

  // ---- Continuity checker ---------------------------------------------
  $('#sme_auto_check')
    .prop('checked', s.continuity_auto_check)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_check = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_auto_repair')
    .prop('checked', s.continuity_auto_repair)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_repair = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Notifications --------------------------------------------------
  $('#sme_show_activity_indicator')
    .prop('checked', s.show_activity_indicator ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].show_activity_indicator = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Developer / debug ----------------------------------------------
  $('#sme_verbose_logging')
    .prop('checked', s.verbose_logging)
    .on('change', function () {
      extension_settings[MODULE_NAME].verbose_logging = $(this).prop('checked');
      $('#sme_scene_stability').toggle($(this).prop('checked'));
      saveSettingsDebounced();
    });
  const renderIdempotenceResult = (result) => {
    const panel = $('#sme_idempotence_result');
    if (!result || typeof result !== 'object') {
      panel.hide().empty();
      return;
    }
    const normalized = normalizeIdempotenceResult(result);
    const currentSemanticHash = durableStateHash(idempotenceDurableState(getContext().chatMetadata?.[META_KEY] ?? {}));
    const evaluatedSemanticHash = normalized.evaluated_semantic_hash ?? normalized.durable_state_hash_after_second_pass ?? null;
    const staleResult = Boolean(evaluatedSemanticHash && evaluatedSemanticHash !== currentSemanticHash);
    const passed = normalized.idempotent === true && !staleResult;
    const unresolved = normalized.attention_required === true;
    const firstLogical = Number(normalized.first_pass_logical_mutations ?? 0);
    const firstPhysical = Number(normalized.first_pass_physical_mutations ?? 0);
    const secondLogical = Number(normalized.second_pass_logical_mutations ?? 0);
    const secondPhysical = Number(normalized.second_pass_physical_mutations ?? 0);
    const stale = Number(normalized.stale_references_after_second_pass ?? 0);
    const recreated = Number(normalized.recreated_after_prior_repair ?? 0);
    const staleSummary = Array.isArray(normalized.stale_reference_summary) ? normalized.stale_reference_summary : [];
    panel
      .removeClass('sme_idempotence_pass sme_idempotence_attention')
      .addClass(passed ? 'sme_idempotence_pass' : 'sme_idempotence_attention')
      .empty()
      .append($('<strong>').text(staleResult ? 'Idempotence check is stale' : passed ? 'Idempotence check passed' : unresolved ? 'Idempotence check needs attention' : 'Idempotence check incomplete'))
      .append($('<div>').text(`First pass: ${firstLogical} logical and ${firstPhysical} physical changes.`))
      .append($('<div>').text(`Second pass: ${secondLogical} logical and ${secondPhysical} physical changes; ${stale} stale references; ${recreated} recreated links.`))
      .append($('<small>').text(passed
        ? (normalized.maintenance_needed_on_first_pass
          ? 'The first pass performed maintenance; the second pass made no durable changes, so canonical reconciliation is stable.'
          : `The finalized state is stable.${normalized.metadata_only_changes ? ' Diagnostic metadata changed only.' : ''}`)
        : 'Do not start a long generation yet. Export diagnostics or inspect the current chat state before retrying.'))
      .show();
    if (staleResult) panel.append($('<small>').text('The durable state changed after this check. Run the Developer idempotence check again before treating this result as current.'));
    if (unresolved && normalized.attention_reasons?.length) {
      panel.append($('<div>').append($('<strong>').text('Attention reason: ')).append(document.createTextNode(normalized.attention_reasons.join(', '))));
    }
    if (unresolved && normalized.durable_state_change_summary?.changed_top_level_stores?.length) {
      panel.append($('<div>').append($('<strong>').text('Durable stores changed: ')).append(document.createTextNode(normalized.durable_state_change_summary.changed_top_level_stores.join(', '))));
    }
    if (staleSummary.length) {
      const list = $('<ul class="sme_idempotence_stale_summary">');
      for (const item of staleSummary) list.append($('<li>').text(`${item.count} × ${item.store} → ${item.field} (${item.reason})`));
      panel.append($('<div>').append($('<strong>').text('Remaining reference categories:')).append(list));
    }
  };

  // Fresh Start is an explicit destructive reset, not an ordinary policy-aware
  // write. Read-only and disabled policies must not leave old personal stores
  // behind; retain only the policy setting itself for the next chat.
  const clearCharacterDurableDataForFreshStart = (characterName) => {
    const characters = extension_settings[MODULE_NAME]?.characters;
    const existing = characters?.[characterName];
    if (!existing) return;
    const policy = existing.memory_policy;
    if (policy) characters[characterName] = { memory_policy: policy };
    else delete characters[characterName];
  };
  const restoredIdempotenceContext = getContext();
  const restoredIdempotence = restoredIdempotenceContext.chatMetadata?.[META_KEY]?.developer_idempotence_check;
  if (restoredIdempotence) {
    const normalized = normalizeIdempotenceResult(restoredIdempotence);
    if (JSON.stringify(normalized) !== JSON.stringify(restoredIdempotence) && restoredIdempotenceContext.chatMetadata) {
      restoredIdempotenceContext.chatMetadata[META_KEY].developer_idempotence_check = normalized;
      saveChatMetadata(restoredIdempotenceContext).catch((error) => smLog('[Smart Memory Enhanced] Could not persist migrated idempotence result:', error));
    }
    renderIdempotenceResult(normalized);
  } else renderIdempotenceResult(null);
  $('#sme_run_idempotence_check').on('click', async function () {
    const button = $(this);
    // This local developer operation touches the same durable stores as
    // catch-up, so it must not overlap an active Memorize Chat run.
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      setStatusMessage('Select a character before running the integrity check.');
      return;
    }
    button.prop('disabled', true);
    setStatusMessage('Running developer idempotence check...');
    try {
      const reconciliation = await runFinalIntegrityReconciliation(characterName, { forceIdempotenceCheck: true });
      const context = getContext();
      if (context.chatMetadata) {
        context.chatMetadata[META_KEY] ??= {};
        const runnerResult = normalizeIdempotenceResult(reconciliation.idempotence);
        context.chatMetadata[META_KEY].developer_idempotence_check = runnerResult;
        await saveChatMetadata(context);
        const persistedResult = normalizeIdempotenceResult(context.chatMetadata[META_KEY].developer_idempotence_check);
        const restoredResult = normalizeIdempotenceResult(getContext().chatMetadata?.[META_KEY]?.developer_idempotence_check ?? persistedResult);
        // A manual check is local-only, but its result must be visible through
        // the same diagnostics export consumers use after a catch-up run.
        const exportReport = latestExportDiagnostics ?? context.chatMetadata[META_KEY].catch_up_diagnostics ?? null;
        const exportedResult = normalizeIdempotenceResult(restoredResult);
        const lifecycle = {
          runner_result: runnerResult.idempotent,
          persisted_result: persistedResult.idempotent,
          restored_result: restoredResult.idempotent,
          exported_result: exportedResult.idempotent,
          renderer_result: exportedResult.idempotent,
          values_consistent: [runnerResult.idempotent, persistedResult.idempotent, restoredResult.idempotent, exportedResult.idempotent].every((value) => value === runnerResult.idempotent),
        };
        const finalResult = normalizeIdempotenceResult({
          ...exportedResult,
          audit_type: 'manual_developer_idempotence_check',
          is_manual_developer_check: true,
          automatic_stabilization: false,
          evaluated_durable_hash: exportedResult.durable_state_hash_after_second_pass ?? null,
          evaluated_semantic_hash: exportedResult.durable_state_hash_after_second_pass ?? null,
          evaluated_scene_history_hash: exportedResult.scene_history_hashes?.after_second_pass?.semantic_history_hash ?? null,
          evaluated_at: Date.now(),
          idempotence_result_lifecycle: lifecycle,
        });
        context.chatMetadata[META_KEY].developer_idempotence_check = finalResult;
        if (exportReport && typeof exportReport === 'object') {
          exportReport.developer_idempotence_check = finalResult;
          exportReport.manual_idempotence = finalResult;
          exportReport.automatic_stabilization ??= exportReport.finalReconciliation?.stabilization
            ?? exportReport.finalReconciliation?.automatic_stabilization
            ?? null;
          exportReport.finalReconciliation ??= {};
          // Retain the historical compatibility field for existing consumers,
          // but never replace the named automatic stabilization record.
          exportReport.finalReconciliation.manual_idempotence = finalResult;
          exportReport.finalReconciliation.idempotence = finalResult;
          exportReport.finalReconciliation.final_state_consistency ??= {};
          Object.assign(exportReport.finalReconciliation.final_state_consistency, {
            developer_check_semantic_hash: finalResult.evaluated_semantic_hash ?? null,
            restored_panel_semantic_hash: finalResult.evaluated_semantic_hash ?? null,
            developer_check_integrity_status: finalResult.attention_required ? 'needs_attention' : 'clean',
            restored_panel_integrity_status: finalResult.attention_required ? 'needs_attention' : 'clean',
            developer_result_current: finalResult.idempotent === true,
            developer_stale_reference_count: Number(finalResult.stale_references_after_second_pass ?? 0),
            restored_panel_stale_reference_count: Number(finalResult.stale_references_after_second_pass ?? 0),
            interpretation_consistent: finalResult.idempotence_result_lifecycle_mismatch !== true,
            mismatch_fields: finalResult.idempotence_result_lifecycle_mismatch ? ['idempotence_result_lifecycle'] : [],
          });
          Object.assign(exportReport.finalReconciliation.final_state_consistency, buildFinalStateConsistency({
            automatic: exportReport.automatic_stabilization,
            manual: finalResult,
            currentHash: durableStateHash(idempotenceDurableState(context.chatMetadata[META_KEY])),
          }));
          latestExportDiagnostics = exportReport;
          context.chatMetadata[META_KEY].catch_up_diagnostics = exportReport;
        }
        await saveChatMetadata(context);
      }
      const savedResult = context.chatMetadata?.[META_KEY]?.developer_idempotence_check ?? reconciliation.idempotence;
      renderIdempotenceResult(savedResult);
      $('#sme_export_diagnostics').prop('disabled', !getExportableDiagnostics());
      const result = normalizeIdempotenceResult(savedResult).idempotent === true ? 'passed' : 'found remaining changes';
      setStatusMessage(`Developer idempotence check ${result}.`);
    } catch (error) {
      smLog('[Smart Memory Enhanced] Developer idempotence check failed:', error);
      renderIdempotenceResult({ idempotent: null });
      setStatusMessage('Developer idempotence check failed. See the browser console.');
    } finally {
      button.prop('disabled', false);
      // A developer check never owns catch-up controls. Repair a stale
      // Cancel presentation only when there is no actual background run.
      if (!ctrl.extractionRunning && !ctrl.compactionRunning) {
        $('#sme_cancel_catch_up').hide().prop('disabled', false);
        $('#sme_catch_up').show();
        ctrl.catchUpCancelled = false;
      }
    }
  });
  $('#sme_scene_comparison_tolerance')
    .val(s.scene_comparison_tolerance)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_comparison_tolerance = Math.max(1, Math.min(4, parseInt($(this).val(), 10) || 2));
      $(this).val(extension_settings[MODULE_NAME].scene_comparison_tolerance);
      saveSettingsDebounced();
    });

  $('#sme_auto_tune_budgets')
    .prop('checked', s.auto_tune_budgets ?? false)
    .on('change', function () {
      extension_settings[MODULE_NAME].auto_tune_budgets = $(this).prop('checked');
      saveSettingsDebounced();
      if ($(this).prop('checked')) autoTuneBudgets(ctrl.getSelectedCharacterName());
    });

  // Hides per-tier injection position/depth/role blocks when either unified
  // injection or macro mode is active - those controls have no effect in either mode.
  // Budget and template blocks stay visible: they still affect content trimming and
  // formatting even when placement is handled externally.
  function applyInjectionOverrideUI() {
    const cur = extension_settings[MODULE_NAME];
    const unified = cur.unified_injection ?? false;
    const macros = cur.macros_enabled ?? false;
    const hide = unified || macros;
    const advanced = (cur.settings_mode ?? 'simple') === 'advanced';
    // Per-tier position/depth/role blocks are advanced-only and hidden by override modes.
    // Both conditions must be met to show them: advanced mode on and no override active.
    // Exclude sme_unified_position - it belongs to the unified block's own settings.
    $('[name$="_position"]:not([name="sme_unified_position"]), #sme_longterm_triggered_depth')
      .closest('.sm-block')
      .toggle(!hide && advanced);
    // Unified sub-settings are only relevant when unified injection is on,
    // macro mode is off, and advanced mode is active.
    $('#sme_unified_settings').toggle(unified && !macros && advanced);
  }

  $('#sme_unified_injection')
    .prop('checked', s.unified_injection ?? false)
    .on('change', function () {
      const enabled = $(this).prop('checked');
      extension_settings[MODULE_NAME].unified_injection = enabled;
      saveSettingsDebounced();
      applyInjectionOverrideUI();
      if (enabled) {
        injectUnified();
      } else {
        // Restore individual slots from stored data so the normal path
        // resumes immediately without waiting for the next generation.
        const characterName = ctrl.getSelectedCharacterName();
        clearUnifiedSlot();
        const summary = loadAndInjectSummary();
        updateShortTermUI(summary);
        injectMemories(characterName);
        injectSessionMemories();
        injectSceneHistory();
        injectArcs();
        injectCanon(characterName);
        injectProfiles(characterName);
      }
      updateTokenDisplay();
    });
  $('[name="sme_unified_position"]')
    .filter(`[value="${s.unified_position ?? 2}"]`)
    .prop('checked', true);
  $('[name="sme_unified_position"]').on('change', function () {
    extension_settings[MODULE_NAME].unified_position = Number($(this).val());
    saveSettingsDebounced();
    maybeInjectUnified();
  });

  $('#sme_unified_depth')
    .val(s.unified_depth ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].unified_depth = Number($(this).val());
      saveSettingsDebounced();
      maybeInjectUnified();
    });

  $('#sme_unified_role')
    .val(s.unified_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].unified_role = Number($(this).val());
      saveSettingsDebounced();
      maybeInjectUnified();
    });

  const refreshPeriod = s.injection_refresh_period ?? 1;
  $('#sme_injection_refresh_period')
    .val(refreshPeriod)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      $('#sme_injection_refresh_period_value').text(val);
      extension_settings[MODULE_NAME].injection_refresh_period = val;
      saveSettingsDebounced();
    });
  $('#sme_injection_refresh_period_value').text(refreshPeriod);

  $('#sme_macros_enabled')
    .prop('checked', s.macros_enabled ?? false)
    .on('change', function () {
      const enabled = $(this).prop('checked');
      extension_settings[MODULE_NAME].macros_enabled = enabled;
      saveSettingsDebounced();
      applyInjectionOverrideUI();
    });
  applyInjectionOverrideUI();

  $('#sme_check_continuity').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    $(this).prop('disabled', true);
    setStatusMessage('Checking continuity...');
    $('#sme_continuity_result').hide().empty();
    try {
      const contradictions = await checkContinuity(characterName);
      if (contradictions.length === 0) {
        $('#sme_continuity_result')
          .addClass('sme_continuity_clean')
          .removeClass('sme_continuity_warn')
          .text('No contradictions found.')
          .show();
        setStatusMessage('Continuity OK.');
      } else {
        const $result = $('#sme_continuity_result')
          .addClass('sme_continuity_warn')
          .removeClass('sme_continuity_clean');
        $result.empty();
        $result.append('<b>Contradictions found:</b>');
        const $ul = $('<ul>');
        contradictions.forEach((c) => $ul.append($('<li>').text(c)));
        $result.append($ul).show();
        setStatusMessage(
          `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found.`,
        );

        // If auto-repair is on, generate a corrective note and inject it for
        // the next AI turn. The note is cleared automatically once that response
        // is rendered by onCharacterMessageRendered.
        if (extension_settings[MODULE_NAME].continuity_auto_repair) {
          setStatusMessage('Generating repair...');
          try {
            const note = await generateRepair(contradictions, characterName);
            injectRepair(note);
            const $repairBlock = $('<div class="sme_repair_queued">');
            $repairBlock.append($('<p>').text('Correction queued for next response:'));
            $repairBlock.append($('<p class="sme_repair_note">').text(note));
            const $cancel = $(
              '<button class="menu_button sme_repair_cancel">Cancel correction</button>',
            );
            $cancel.on('click', () => {
              clearRepair();
              $repairBlock.remove();
              setStatusMessage('Correction cancelled.');
            });
            $repairBlock.append($cancel);
            $result.append($repairBlock);
            setStatusMessage('Correction queued.');
            toastr.info('Correction queued for next response.', 'Smart Memory Enhanced');
          } catch (repairErr) {
            console.error('[Smart Memory Enhanced] Repair generation failed:', repairErr);
            setStatusMessage('Repair failed - see console.');
          }
        }
      }
    } catch (err) {
      showError('Continuity check', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_about').on('click', async function () {
    // Populate version from manifest.json so it stays in sync automatically.
    try {
      const manifest = await fetch(
        '/scripts/extensions/third-party/Smart-Memory/manifest.json',
      ).then((r) => r.json());
      $('#sme_about_version').text(manifest.version ?? '');
    } catch {
      $('#sme_about_version').text('');
    }
    const $modal = $('#sme_about_modal').clone().show();
    // Remove IDs from the clone so they do not duplicate the hidden template's IDs in the DOM.
    $modal.find('[id]').addBack('[id]').removeAttr('id');
    await callGenericPopup($modal[0], POPUP_TYPE.DISPLAY, '', {
      wide: false,
      large: false,
    });
  });
}

function summarizeArcSummaryVerification(summaries = [], arcs = []) {
  // New historical arcs are verified as durable records even when they do not
  // need a separate resolved-arc prose summary. Older summary records remain
  // included for backward-compatible review accounting.
  const verifiedArcs = (arcs ?? []).filter((arc) => arc?.verification);
  const result = { total: verifiedArcs.length || summaries.length, supported: 0, pending_review: 0, rejected: 0, legacy_unverified: 0, preverification: {} };
  for (const arc of verifiedArcs) {
    const outcome = arc.verification?.outcome;
    if (outcome === 'supported') result.supported++;
    else if (outcome === 'rejected') result.rejected++;
    else result.pending_review++;
  }
  if (verifiedArcs.length) return result;
  for (const summary of summaries) {
    if (summary.validation_status === 'approved' || summary.semantic_support === 'supported' || summary.semantic_support === 'user_approved') result.supported++;
    else if (summary.validation_status === 'rejected' || summary.semantic_support === 'unsupported') result.rejected++;
    else result.pending_review++;
    if (summary.verification_state === 'legacy_unverified') result.legacy_unverified++;
    if (summary.deterministic_rejection_reason) {
      result.preverification[summary.deterministic_rejection_reason] = (result.preverification[summary.deterministic_rejection_reason] ?? 0) + 1;
    }
  }
  return result;
}

function summarizeArcStatusResolution(arcs = [], fallback = {}) {
  const result = { open: 0, resolved: 0, abandoned: 0, superseded: 0, reopened: 0, uncertain: 0 };
  if (!arcs.length) return { ...result, ...fallback };
  for (const arc of arcs) {
    const status = String(arc?.status ?? (arc?.resolved ? 'resolved' : 'open')).toLowerCase();
    if (status in result) result[status]++;
    else result.uncertain++;
  }
  return result;
}

function summarizeArcRecordAccounting(arcs = [], extraction = {}) {
  const status = summarizeArcStatusResolution(arcs);
  const verification = summarizeArcSummaryVerification([], arcs);
  const authoritative = arcs.length;
  const lifecycleTotal = Object.values(status).reduce((total, value) => total + value, 0);
  const verificationTotal = verification.supported + verification.pending_review + verification.rejected;
  const staged = Number(extraction.staged_records ?? extraction.persisted_final_arcs ?? 0);
  const rejectedBeforePersistence = Number(extraction.rejected_before_persistence ?? 0);
  return {
    raw_candidates: Number(extraction.parsed_candidates ?? 0),
    consolidated_candidates: Number(extraction.consolidated_candidates ?? 0),
    staged_records: staged,
    rejected_before_persistence: rejectedBeforePersistence,
    authoritative_records: authoritative,
    open: status.open,
    resolved: status.resolved,
    abandoned: status.abandoned,
    superseded: status.superseded,
    reopened: status.reopened,
    uncertain: status.uncertain,
    verification_supported: verification.supported,
    verification_pending_review: verification.pending_review,
    verification_rejected: verification.rejected,
    retired_intermediate_records: 0,
    duplicate_versions_removed: Number(extraction.duplicate_candidates_merged ?? 0),
    unaccounted_records: Math.max(0, authoritative - lifecycleTotal) + Math.max(0, authoritative - verificationTotal),
    accounting_reconciled: lifecycleTotal === authoritative && verificationTotal === authoritative && staged === authoritative + rejectedBeforePersistence,
  };
}

/** Compact, text-free lifecycle evidence for every authoritative arc. */
function summarizeArcStatusTraces(arcs = []) {
  const byFinalStatus = summarizeArcStatusResolution(arcs);
  const coverage = ['abandoned', 'superseded', 'reopened', 'uncertain'].map((status) => ({
    status,
    evidence_candidates_found: arcs.filter((arc) => arc?.arc_status_trace?.[`${status === 'superseded' ? 'supersession' : status}_evidence_count`] > 0).length,
    matched_to_existing_arcs: byFinalStatus[status] ?? 0,
    authoritative_records_created: byFinalStatus[status] ?? 0,
    zero_count_reason: (byFinalStatus[status] ?? 0) ? null : 'no_source_evidence',
  }));
  return {
    total: arcs.length,
    by_final_status: byFinalStatus,
    records: arcs.map((arc) => {
      const trace = arc?.arc_status_trace ?? {};
      return {
        arc_id: arc?.id ?? null,
        logical_signature_hash: diagnosticFingerprint(String(arc?.content ?? '')),
        initial_status: trace.initial_status ?? 'open',
        final_status: arc?.status ?? (arc?.resolved ? 'resolved' : 'open'),
        creation_evidence_count: trace.creation_evidence_count ?? 0,
        continuation_evidence_count: trace.continuation_evidence_count ?? 0,
        resolution_evidence_count: trace.resolution_evidence_count ?? 0,
        abandonment_evidence_count: trace.abandonment_evidence_count ?? 0,
        supersession_evidence_count: trace.supersession_evidence_count ?? 0,
        reopening_evidence_count: trace.reopening_evidence_count ?? 0,
        contradictory_evidence_count: trace.contradictory_evidence_count ?? 0,
        latest_evidence_position: arc?.last_status_change_index ?? null,
        terminal_reason_code: arc?.status_reason_code ?? trace.terminal_reason ?? null,
        active_for_injection: !arc?.resolved && ['open', 'reopened'].includes(arc?.status ?? 'open'),
        // Lifecycle status answers whether later chat evidence advanced an
        // arc; summary verification answers whether the stored arc itself is
        // grounded.  They are related but not interchangeable.
        lifecycle_evidence_status: trace.verification_outcome ?? 'unavailable',
        summary_verification_status: arc?.verification?.outcome ?? 'unavailable',
      };
    }),
    zero_status_coverage: coverage,
  };
}
