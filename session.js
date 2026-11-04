/**
 * Smart Memory - SillyTavern Extension
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
 * Session memory: detailed within-chat facts stored in chatMetadata.
 *
 * Sits between short-term (broad narrative summary) and long-term (distilled
 * cross-session facts). Session memories are more granular than long-term -
 * capturing scene details, named objects, specific revelations - but do not
 * survive past the current chat.
 *
 * loadSessionMemories        - returns the current session memory array
 * saveSessionMemories        - persists the session memory array to chatMetadata
 * clearSessionMemories       - empties session memories for the current chat
 * purgeSessionMemoriesSince  - deletes all session memories with ts >= a given timestamp and repairs the entity registry
 * extractSessionMemories     - runs extraction against recent messages and merges results;
 *                              populates LLM-suggested triggers on Profile B or when opted in
 * consolidateSessionMemories - evaluates unprocessed entries against the consolidated base per type
 * injectSessionMemories      - pushes session memories into the prompt via setExtensionPrompt
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  getCurrentChatId,
} from '../../../../script.js';
import { generateMemoryExtract, getMemoryProviderCapabilities, getMemoryRequestBudget } from './generate.js';
import { applyPromptOverride, PROMPT_TASKS } from './prompt-config.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { saveChatMetadata } from './catchup-transaction.js';
import { applyDirectProvenance, isGrounded, validateGeneratedMemoryRecord } from './grounding.js';
import { flattenConsolidationProvenance, validateGeneratedRecord } from './record-validation.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_SESSION,
  SESSION_TYPES,
  MAX_RETIRED_POOL,
} from './constants.js';
import {
  applyGraphDefaults,
  loadSessionEntityRegistry,
  saveSessionEntityRegistry,
  resolveEntityNames,
  reconcileCanonicalEntityRegistry,
  reconcileEntityRegistry,
} from './graph-migration.js';
import {
  buildSessionExtractionPrompt,
  buildSessionConsolidationPrompt,
  buildTriggerGenerationPrompt,
} from './prompts.js';
import { parseSessionOutput, parseTriggerResponse } from './parsers.js';
import {
  batchVerify,
  getEmbeddingBatch,
  cosineSimilarity,
  getHardwareProfile,
} from './embeddings.js';
import { loadCharacterMemories, formatMemoriesForPrompt } from './longterm.js';
import { buildCanonicalCharacterRoster, canonicalizeNarrativeNames, formatCanonicalRosterForPrompt } from './canonical-entities.js';
import {
  buildCurrentSceneStateBlock,
  prioritizeMemories,
  hybridPrioritize,
  extractTurnEntityMentions,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  trimByPriority,
  filterTriggersByFrequency,
} from './memory-utils.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import {
  classifyContextOverflow,
  extractionRecoveryChildKey,
  isEstimatedContextOverflow,
  makeExtractionPreflight,
  partitionSourceWindow,
  sourceRange,
  sourceWindowFingerprint,
} from './extraction-window-utils.js';
import {
  beginProviderRecoveryEpoch,
  finishProviderAttempt,
  markProviderDownstreamOutcome,
  markProviderPartialRecordsPersisted,
  markProviderRejectedFragmentsRecovered,
  markProviderStagedRecoveryCompleted,
  providerConfigurationSignature,
  readProviderRecoveryWindowState,
  stageProviderPartialRecovery,
  stageProviderRejectedFragments,
} from './provider-attempt-audit.js';
import { deriveRecoveryStageEligibility } from './recovery-stage-eligibility.js';
import { recordProviderCompletion } from './provider-completion-journal.js';
import { buildRecoverySourceUnits } from './owner-applicability.js';
import {
  analyzeMalformedResponse,
  createMalformedRecoveryBudget,
  consumeMalformedRecoveryRequest,
  malformedChildCoverageComplete,
  partitionMalformedSourceWindow,
  recoverMalformedTaggedOutput,
  selectRejectedTaggedFragments,
  summarizeMalformedRecoveryBudget,
} from './malformed-output-recovery.js';
import { repairSessionCandidateShapes } from './session-candidate-utils.js';
import { verifyPersistedPartialSessionRecords } from './session-partial-persistence.js';
import { extendMemorizeExecutionContext, resolveMemorizeExecutionContext } from './memorize-execution-context.js';
import { createMemorizeTierPipeline, recordTierCoverage as recordExtractionCoverage } from './memorize-tier-pipeline.js';
import { createMemorizeRecoveryScheduler } from './memorize-recovery-scheduler.js';
export { verifyPersistedPartialSessionRecords } from './session-partial-persistence.js';

const MAX_CONTEXT_OVERFLOW_SPLIT_DEPTH = 8;
const AUTOMATIC_SESSION_RECOVERY_LIMITS = Object.freeze({
  maximum_controller_cycles: 3,
  maximum_provider_requests: 4,
  maximum_wall_time_ms: 45 * 60 * 1000,
});

export function buildFocusedSessionFragmentRecoveryPrompt(chatHistory, fragments = []) {
  const rejected = fragments.map((item) => item.raw).filter(Boolean).join('\n');
  return `SESSION FRAGMENT RECOVERY\nThe accepted records from the prior response are already durable. Recover only the rejected fragments below; do not repeat, rewrite, or replace accepted records. Use the numbered source excerpt only to validate and cite the rejected claims.\n\nSOURCE EXCERPT\n${chatHistory}\n\nREJECTED FRAGMENTS\n${rejected}\n\nReturn only recovered records represented by REJECTED FRAGMENTS, or exactly NONE when none can be safely recovered.`;
}

function extractionRangeId(tier, range, depth) {
  return `${tier}:chat:${range.start ?? 'none'}-${range.end ?? 'none'}:d${depth}`;
}

/**
 * Filters session memory candidates against existing entries, removing
 * near-duplicates and entries that fail basic quality checks. Identifies
 * supersessions (state-change updates that should retire an existing memory).
 *
 * All texts are embedded in a single batch API call so nomic-embed-text only
 * needs to load once per verification pass rather than once per candidate.
 * Falls back to Jaccard word-overlap when embeddings are unavailable.
 *
 * @param {Array} candidates - Newly extracted session memory objects.
 * @param {Array} existing   - Active (non-retired) session memories.
 * @returns {Promise<{verified: Array, superseded: Map<string, string>, confirmed: Set<string>}>}
 *   verified  - Candidates that passed dedup and should be added.
 *   superseded - Map from candidate content (lowercase) to the id of the
 *                existing memory it replaces.
 *   confirmed  - Set of existing memory ids re-extracted this pass (still true).
 */
async function verifySessionCandidates(candidates, existing) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { verified: [], superseded: new Map(), confirmed: new Set(), dispositions: { malformed_candidate: 0, duplicate_same_pass: 0, duplicate_existing: 0 }, rejected: [] };
  }

  const seen = new Set();
  const dispositions = { malformed_candidate: 0, duplicate_same_pass: 0, duplicate_existing: 0 };
  const rejected = [];
  const filtered = candidates.filter((mem) => {
    const text = String(mem.content || '').trim();
    if (text.length < 5 || text.length > 240) {
      dispositions.malformed_candidate++;
      rejected.push({ candidate: mem, disposition: 'rejected_malformed' });
      return false;
    }
    const key = `${mem.type}|${text.toLowerCase()}`;
    if (seen.has(key)) {
      dispositions.duplicate_same_pass++;
      rejected.push({ candidate: mem, disposition: 'rejected_duplicate' });
      return false;
    }
    seen.add(key);
    return true;
  });

  if (filtered.length === 0) return { verified: [], superseded: new Map(), confirmed: new Set(), dispositions, rejected };

  const { passed, superseded, confirmed } = await batchVerify(filtered, existing);
  const verified = filtered.filter((m) =>
    passed.has(
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  );
  dispositions.duplicate_existing = Math.max(0, filtered.length - verified.length);
  const verifiedIds = new Set(verified.map((candidate) => candidate._citation_candidate_id));
  for (const candidate of filtered) {
    if (!verifiedIds.has(candidate._citation_candidate_id)) rejected.push({ candidate, disposition: 'rejected_duplicate' });
  }
  return { verified, superseded, confirmed, dispositions, rejected };
}

// ---- Storage (chatMetadata) ---------------------------------------------

/**
 * Legacy session records sometimes predate graph IDs.  A random ID created on
 * every read made an otherwise no-op reconciliation look like a durable graph
 * change.  Derive the legacy ID from stable record identity instead; the next
 * ordinary save persists it once without changing its future value.
 */
function deterministicLegacySessionMemoryId(memory = {}) {
  const identity = JSON.stringify({
    type: memory.type ?? 'session',
    content: memory.content ?? '',
    ts: memory.ts ?? 0,
    source_message_indices: [...new Set((memory.source_message_indices ?? []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b),
    source_messages: [...new Set((memory.source_messages ?? []).map(String))].sort(),
  });
  let hash = 2166136261;
  for (const char of identity) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `sme-session-fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// Privacy-safe and stable across harmless whitespace changes.  It is used
// only to associate a citation-repair response with an already extracted
// candidate; the provider's returned claim text is never persisted.
function stableCitationClaimHash(candidate = {}) {
  const identity = `${String(candidate.type ?? '').trim().toLowerCase()}\u0000${String(candidate.content ?? '').trim().replace(/\s+/g, ' ')}`;
  let hash = 2166136261;
  for (const char of identity) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `claim-fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Returns the session memory array for the current chat.
 * Migrates legacy entries (no consolidated flag) to consolidated: true on load
 * so existing memories are treated as the stable base.
 * @returns {Array<{type: string, content: string, ts: number, consolidated: boolean}>}
 */
export function loadSessionMemories() {
  const context = getContext();
  const memories = context.chatMetadata?.[META_KEY]?.sessionMemories ?? [];
  // Migrate: entries without the consolidated flag are pre-existing stable memories.
  // Entries without an importance score default to 2 (medium).
  // applyGraphDefaults is a safety net for entries that predate the one-shot
  // migration pass. It is non-destructive and only generates a new id when one
  // is truly absent.
  return memories.map((m) =>
    applyGraphDefaults({
      ...m,
      id: m.id ?? deterministicLegacySessionMemoryId(m),
      consolidated: m.consolidated ?? true,
      importance: m.importance ?? 2,
      expiration: m.expiration ?? 'session',
      confidence: m.confidence ?? 0.7,
      persona_relevance: m.persona_relevance ?? (m.type === 'development' ? 2 : 1),
      intimacy_relevance: m.intimacy_relevance ?? (m.type === 'development' ? 2 : 1),
      retrieval_count: m.retrieval_count ?? 0,
      // Fall back to 0 (not Date.now()) when both fields are absent so legacy
      // entries don't receive an artificial recency boost in memoryUtilityScore.
      last_confirmed_ts: m.last_confirmed_ts ?? m.ts ?? 0,
    }),
  );
}

/**
 * Persists the session memory array to chatMetadata.
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export async function saveSessionMemories(memories) {
  const context = getContext();
  for (const memory of memories ?? []) validateGeneratedMemoryRecord(memory, memories);
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].sessionMemories = memories;
  await saveChatMetadata(context);
}

/**
 * Empties session memories for the current chat.
 */
export async function clearSessionMemories() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sessionMemories = [];
    await saveChatMetadata(context);
  }
}

/**
 * Removes all session memories whose ts field is >= the given timestamp,
 * then repairs the session entity registry to remove stale memory_ids.
 *
 * Used when read-only mode is disabled to purge memories that were extracted
 * during a read-only window before they can contaminate profiles or the entity
 * registry. Memories without a ts field are treated as pre-existing and kept.
 *
 * @param {number} since - Unix ms timestamp. Memories at or after this time are deleted.
 * @returns {Promise<number>} Number of memories removed.
 */
export async function purgeSessionMemoriesSince(since) {
  const all = loadSessionMemories();
  const kept = all.filter((m) => typeof m.ts !== 'number' || m.ts < since);
  const removed = all.length - kept.length;
  if (removed === 0) return 0;

  // Repair entity registry - reconcileEntityRegistry prunes stale memory_ids
  // left behind by the deleted memories and re-links by name match.
  const entityRegistry = loadSessionEntityRegistry();
  if (entityRegistry.length > 0) {
    reconcileEntityRegistry(entityRegistry, kept);
    await saveSessionEntityRegistry(entityRegistry);
  }

  await saveSessionMemories(kept);
  smLog(`[Smart Memory Enhanced] Purged ${removed} session memories from read-only window.`);
  return removed;
}

// ---- Parsing ------------------------------------------------------------

/**
 * Merges new session memories into the existing set, skipping near-duplicates
 * and trimming to the configured maximum.
 *
 * Primary: cosine similarity on embeddings (threshold 0.82), matching the
 * scene dedup strategy. Falls back to a word-overlap ratio when embeddings
 * are unavailable: intersection / max(|A|, |B|) > 0.65. The asymmetric
 * denominator avoids short strings over-matching against long ones.
 *
 * @param {Array} existing - Currently stored session memories.
 * @param {Array} incoming - Newly extracted items to merge in.
 * @param {number} max - Hard cap on total session memories.
 * @returns {Promise<Array>} The merged array.
 */
async function deduplicateSession(existing, incoming, max) {
  const merged = [...existing];

  // Batch all texts up front so comparisons are O(1) per pair.
  const allTexts = [
    ...existing.map((m) => m.content.toLowerCase().trim()),
    ...incoming.map((m) => m.content.toLowerCase().trim()),
  ];
  let vectorMap = null;
  try {
    vectorMap = await getEmbeddingBatch(allTexts);
  } catch {
    // embedding service unavailable - fall through to word-overlap
  }

  for (const mem of incoming) {
    const memKey = mem.content.toLowerCase().trim();
    const memVec = vectorMap?.get(memKey);

    const isDuplicate = merged.some((ex) => {
      if (ex.type !== mem.type) return false;

      if (memVec) {
        const exVec = vectorMap.get(ex.content.toLowerCase().trim());
        if (exVec) return cosineSimilarity(memVec, exVec) > 0.82;
      }

      // Word-overlap fallback.
      const words = new Set(mem.content.toLowerCase().split(/\s+/));
      const exWords = new Set(ex.content.toLowerCase().split(/\s+/));
      const intersection = [...words].filter((w) => exWords.has(w)).length;
      return intersection / Math.max(words.size, exWords.size) > 0.65;
    });
    if (!isDuplicate) merged.push(mem);
  }

  // When over the cap, drop the least valuable entries first.
  if (merged.length > max) {
    const prioritized = prioritizeMemories(merged);
    merged.splice(0, merged.length, ...prioritized);
    merged.splice(max);
  }
  return merged;
}

// ---- Extraction ---------------------------------------------------------

/**
 * Extracts session-level details from recent messages via the model and merges
 * them into chatMetadata. Returns the count of new items saved.
 * @param {Array} recentMessages - Last N message objects from context.chat.
 * @returns {Promise<number>} Count of new items added (0 on failure or nothing found).
 */
/**
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the function
 *   bails out before writing to chatMetadata. Used by the automatic extraction path to abort when
 *   the user switches chats mid-extraction.
 */
export async function extractSessionMemories(recentMessages, abortCheck = null, options = {}) {
  const settings = extension_settings[MODULE_NAME];
  const execution = resolveMemorizeExecutionContext(options);
  const healthUpdate = (patch) => options.liveHealth?.update?.(patch);
  const healthFinish = (patch) => options.liveHealth?.finish?.(patch);
  if (!settings.session_enabled) {
    healthFinish({ terminal_health: 'skipped', attention_reason_codes: ['tier_disabled'] });
    return 0;
  }
  const sessionDiagnostics = options.sessionDiagnostics;
  let parsedCandidateCount = 0;
  let terminalCandidateCount = 0;
  let providerRequestSent = false;
  let providerResponseReceived = false;
  let persistenceStarted = false;
  const recordDisposition = (name, count = 1) => {
    if (!sessionDiagnostics || count <= 0) return;
    sessionDiagnostics.terminalDispositions ??= {};
    sessionDiagnostics.terminalDispositions[name] = (sessionDiagnostics.terminalDispositions[name] ?? 0) + count;
    terminalCandidateCount += count;
  };

  try {
    // Keep this exact filtered list for both prompt numbering and citation
    // expansion.  The model sees indices for this list, not for the raw
    // chunk (which can contain system/empty messages).
    const sourceMessages = recentMessages.filter((m) => m.mes && !m.is_system);
    const chatHistory = sourceMessages
      .map((m, index) => `[${index}] ${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) {
      healthFinish({ terminal_health: 'skipped', attention_reason_codes: ['empty_source_window'] });
      return 0;
    }

    const existingAll = loadSessionMemories();

    // Separate active from retired memories. Verification and merge operate only
    // on active entries; retired ones are preserved in storage for history but
    // should not be compared against (or count toward caps during merge).
    const existing = existingAll.filter((m) => !m.superseded_by);
    const retiredMemories = existingAll.filter((m) => m.superseded_by);

    const existingText = existing.map((m) => `[${m.type}] ${m.content}`).join('\n');

    // Pass long-term memories so the model skips facts already stored there.
    // Cap to 15 entries to avoid inflating the prompt on local hardware.
    // In group chats there is no single authoritative character, so skip this
    // hint rather than arbitrarily biasing toward one member's long-term store.
    const isGroup = !!getContext().groupId;
    const characterName = isGroup ? null : getContext().name2 || getContext().characterName || null;
    const longtermMemories = characterName ? loadCharacterMemories(characterName) : [];
    const longtermText =
      longtermMemories.length > 0 ? formatMemoriesForPrompt(longtermMemories.slice(0, 15)) : '';

    // Preflight the final rendered prompt, not the inexpensive raw-message
    // chunk used by catch-up scheduling. Stored-memory and roster framing can
    // otherwise push a seemingly safe source window past the provider limit.
    const responseLength = settings.session_response_length ?? 500;
    const rosterText = formatCanonicalRosterForPrompt(buildCanonicalCharacterRoster(getContext()));
    const renderPrompt = (messages) => applyPromptOverride(
      buildSessionExtractionPrompt(
        messages.map((m, index) => `[${index}] ${m.name}: ${m.mes}`).join('\n\n'),
        existingText,
        longtermText,
        rosterText,
      ),
      PROMPT_TASKS.SESSION_EXTRACTION,
      characterName,
    );
    const prompt = renderPrompt(sourceMessages);
    const requestBudget = getMemoryRequestBudget(responseLength);
    const preflight = makeExtractionPreflight({
      prompt,
      estimateTokens,
      configuredContextLimit: requestBudget.configuredContextLimit,
      effectiveContextLimit: requestBudget.effectiveContextLimit,
      reservedOutputTokens: requestBudget.reservedOutputTokens,
      safetyMargin: requestBudget.safetyMargin,
      protocolOverhead: requestBudget.protocolOverhead,
    });
    preflight.runtime_context_lookup = requestBudget.runtimeContextLookup;
    preflight.context_limit_source = requestBudget.runtimeContextLookup?.status === 'hit'
      ? 'persisted_learned_limit' : 'configured_preference';
    preflight.estimated_final_request_tokens = preflight.estimated_input_tokens
      + preflight.reserved_output_tokens + preflight.protocol_overhead_tokens;
    healthUpdate({ preflight: { ...preflight, usable_input_budget: preflight.usable_input_tokens } });
    const depth = execution.recovery.context_overflow_depth;
    const range = sourceRange(sourceMessages);
    const rangeId = execution.recovery.context_overflow_range_id
      ?? extractionRangeId('session', range, depth);
    const coverageLedger = options.extractionCoverage?.session;
    const providerMetadata = getContext()?.chatMetadata?.[META_KEY];
    const providerConfigSignature = providerConfigurationSignature({
      connection_profile_id: settings.connection_profile_id ?? null,
      model: settings.openai_compat_model ?? settings.ollama_model ?? null,
      source: settings.source ?? null,
      response_length: responseLength,
      context_length: settings.context_length ?? null,
    });
    const pipeline = createMemorizeTierPipeline({
      tier: 'session', tierLabel: 'Session', execution, metadata: providerMetadata,
      range, rangeId, parentRangeId: execution.recovery.context_overflow_parent_range_id,
      depth, coverageLedger, sourceFingerprint: sourceWindowFingerprint(sourceMessages),
      preflight, requestBudget, providerConfigSignature,
      chatId: getCurrentChatId() ?? getContext()?.chatId ?? getContext()?.groupId ?? null,
      expectedOutputFormat: 'session_tagged_lines_v1', schemaVersion: 'session-tagged-v1',
    });
    const { coverageBase, rootObligationId, rootSourceRange, leafObligationId } = pipeline;
    const recordCompletedCoverage = pipeline.recordCompletedCoverage;
    const emitLifecycleEvent = pipeline.emitLifecycleEvent;
    const beginPhysicalAttempt = pipeline.beginAttempt;
    const updateCompletionJournal = (attempt = providerAttempt, patch = {}) => {
      const attemptSucceeded = ['completed', 'completed_no_candidates',
        'completed_repartitioned'].includes(attempt?.terminal_outcome);
      const selectedAttempt = (!attempt?._already_finished
        && (attempt?.terminal_outcome === 'running' || attemptSucceeded)) ? attempt
        : [...(providerMetadata?.live_memory_health?.provider_attempt_audit?.recent_attempts ?? [])]
          .reverse().find((candidate) => candidate.logical_obligation_id === rootObligationId
            && candidate.source_fingerprint === coverageBase.source_fingerprint
            && ['completed', 'completed_no_candidates', 'completed_repartitioned']
              .includes(candidate.terminal_outcome));
      if (!selectedAttempt?.attempt_id) return null;
      return recordProviderCompletion(providerMetadata, selectedAttempt, {
        child_key: extractionRecoveryChildKey('session', 'chat', sourceMessages),
        child_obligation_id: leafObligationId,
        ...patch,
      });
    };
    const splitWindow = async (reason, splitBudget = requestBudget, overflow = null, parentAttemptId = null) => {
      const providerRequestWasSent = reason === 'provider_reported_context_overflow';
      const splitCoverageBase = {
        ...coverageBase,
        request_sent: providerRequestWasSent,
        physical_provider_outcome: providerRequestWasSent ? 'context_overflow' : 'request_prevented',
      };
      const split = partitionSourceWindow(
        sourceMessages,
        renderPrompt,
        (candidatePrompt) => makeExtractionPreflight({
          prompt: candidatePrompt,
          estimateTokens,
          configuredContextLimit: splitBudget.configuredContextLimit,
          effectiveContextLimit: splitBudget.effectiveContextLimit,
          reservedOutputTokens: splitBudget.reservedOutputTokens,
          safetyMargin: splitBudget.safetyMargin,
          protocolOverhead: splitBudget.protocolOverhead,
        }),
      );
      recordExtractionCoverage(coverageLedger, {
        ...splitCoverageBase,
        provider_outcome: reason,
        context_overflow: overflow,
        recovery_context_limit: splitBudget.effectiveContextLimit,
        coverage_terminal_state: split.partitions.length ? 'repartitioning' : 'unresolved_context_overflow',
        child_range_count: split.partitions.length + split.oversized.length,
      });
      if (depth >= MAX_CONTEXT_OVERFLOW_SPLIT_DEPTH || !split.partitions.length) {
        recordExtractionCoverage(coverageLedger, {
          ...splitCoverageBase,
          provider_outcome: reason,
          coverage_terminal_state: 'unresolved_context_overflow',
          unresolved_reason: 'split_depth_or_partition_failure',
        });
        throw pipeline.contextOverflowError();
      }
      await emitLifecycleEvent('recovery_children_declared', {
        children: split.partitions.map((child) => {
          const childRange = sourceRange(child);
          const fingerprint = sourceWindowFingerprint(child);
          return {
            obligation_id: `${rootObligationId}:leaf:${childRange.start}-${childRange.end}:${fingerprint}`,
            tier: 'session', owner: null,
            source_range: childRange, source_fingerprint: fingerprint,
          };
        }),
      });
      let added = 0;
      try {
        const schedule = await createMemorizeRecoveryScheduler().run({
          tasks: split.partitions,
          keyOf: (child) => extractionRecoveryChildKey('session', null, child),
          completedKeys: execution.recovery.completed_child_keys,
          onSkipped: async (child) => {
          const childRange = sourceRange(child);
            recordExtractionCoverage(coverageLedger, {
              range_id: extractionRangeId('session', childRange, depth + 1),
              parent_range_id: rangeId, tier: 'session',
              original_range: { start: childRange.start, end: childRange.end, message_count: childRange.message_count },
              effective_range: { start: childRange.start, end: childRange.end, message_count: childRange.message_count },
              source_fingerprint: sourceWindowFingerprint(child), citation_mapping_valid: true,
              request_sent: false, provider_outcome: 'restored_recovered_child_checkpoint',
              coverage_terminal_state: 'completed', all_source_messages_covered: true,
            });
          },
          execute: async (child) => {
            const childRange = sourceRange(child);
            return extractSessionMemories(child, abortCheck, {
            ...options,
            // Preserve one bounded health event for the root live window.
            liveHealth: null,
            executionContext: extendMemorizeExecutionContext(execution, { recovery: {
              context_overflow_depth: depth + 1,
              context_overflow_parent_range_id: rangeId,
              context_overflow_range_id: extractionRangeId('session', childRange, depth + 1),
            }, provider: {
              root_obligation_id: rootObligationId,
              root_source_range: execution.provider.root_source_range ?? { start: range.start, end: range.end, message_count: range.message_count },
              root_source_fingerprint: execution.provider.root_source_fingerprint ?? coverageBase.source_fingerprint,
              parent_attempt_id: parentAttemptId ?? execution.provider.parent_attempt_id,
            } }),
          });
          },
          onCommitted: async (child, { key: childKey }) => {
            const childRange = sourceRange(child);
          await execution.hooks.context_overflow_child_committed({
            key: childKey, tier: 'session', owner: null,
            source_start_index: childRange.start, source_end_index: childRange.end,
            message_count: childRange.message_count, source_fingerprint: sourceWindowFingerprint(child),
            parent_range_id: rangeId, root_obligation_id: rootObligationId, depth: depth + 1,
            split_reason: reason, provider_parent_attempt_id: parentAttemptId,
          });
          },
        });
        added = schedule.added;
      } catch (err) {
        recordExtractionCoverage(coverageLedger, {
          ...splitCoverageBase,
          provider_outcome: reason,
          coverage_terminal_state: 'unresolved_child_window_failure',
        });
        throw err;
      }
      if (split.oversized.length) {
        recordExtractionCoverage(coverageLedger, {
          ...splitCoverageBase,
          provider_outcome: reason,
          coverage_terminal_state: 'unresolved_context_overflow',
          unresolved_reason: 'single_message_exceeds_context_budget',
          recovered_child_ranges: split.partitions.length,
        });
        throw pipeline.contextOverflowError();
      }
      recordExtractionCoverage(coverageLedger, {
        ...splitCoverageBase,
        provider_outcome: reason,
        coverage_terminal_state: 'repartitioned_completed',
        all_source_messages_covered: true,
      });
      markProviderDownstreamOutcome(providerMetadata, rootObligationId, {
        validation_accepted: true, persistence_committed: true, accepted_count: added,
      });
      await emitLifecycleEvent('parent_children_completed', {
        parser_result: 'repartitioned', downstream_validation_result: 'accepted',
        persistence_result: 'committed_children', coverage_result: 'safely_committed',
      });
      return added;
    };
    const malformedRecoveryDepth = execution.recovery.malformed_depth;
    const malformedRecoveryBudget = createMalformedRecoveryBudget(execution.recovery.malformed_budget);
    if (execution.provider.resumed_pending_obligation && !execution.recovery.malformed_budget) {
      malformedRecoveryBudget.maximum_additional_provider_requests
        = AUTOMATIC_SESSION_RECOVERY_LIMITS.maximum_provider_requests;
      malformedRecoveryBudget.maximum_wall_time_ms
        = AUTOMATIC_SESSION_RECOVERY_LIMITS.maximum_wall_time_ms;
    }
    const splitMalformedWindow = async ({ budget, nextDepth, reason, parentAttemptId }) => {
      const children = partitionMalformedSourceWindow(sourceMessages);
      if (!children.length) return { completed: false, reason: 'minimum_malformed_recovery_window_reached' };
      await emitLifecycleEvent('recovery_children_declared', {
        children: children.map((child) => {
          const childRange = sourceRange(child);
          const fingerprint = sourceWindowFingerprint(child);
          return {
            obligation_id: `${rootObligationId}:leaf:${childRange.start}-${childRange.end}:${fingerprint}`,
            tier: 'session', owner: null,
            source_range: childRange, source_fingerprint: fingerprint,
          };
        }),
      });
      let added = 0;
      const expectedChildKeys = children.map((child) => extractionRecoveryChildKey('session', 'chat', child));
      const schedule = await createMemorizeRecoveryScheduler().run({
        tasks: children,
        keyOf: (child) => extractionRecoveryChildKey('session', 'chat', child),
        completedKeys: [
          ...execution.recovery.completed_child_keys,
          ...budget.split_children_committed,
        ],
        allowance: async () => consumeMalformedRecoveryRequest(budget, 'malformed_source_repartition'),
        execute: async (child) => {
          const childRange = sourceRange(child);
          return extractSessionMemories(child, abortCheck, {
          ...options,
          liveHealth: null,
          executionContext: extendMemorizeExecutionContext(execution, { recovery: {
            malformed_depth: nextDepth,
            malformed_budget: budget,
            context_overflow_parent_range_id: rangeId,
            context_overflow_range_id: extractionRangeId('session', childRange, depth + nextDepth),
          }, provider: {
            root_obligation_id: rootObligationId,
            root_source_range: execution.provider.root_source_range ?? { start: range.start, end: range.end, message_count: range.message_count },
            root_source_fingerprint: execution.provider.root_source_fingerprint ?? coverageBase.source_fingerprint,
            parent_attempt_id: parentAttemptId,
            request_kind: 'malformed_repartition_child',
            changed_recovery_dimensions: ['source_range', 'malformed_output_repartition'],
          } }),
        });
        },
        onCommitted: async (child, { key: childKey }) => {
          const childRange = sourceRange(child);
        budget.split_children_committed.push(childKey);
        await execution.hooks.context_overflow_child_committed({
          key: childKey, tier: 'session', owner: null,
          source_start_index: childRange.start, source_end_index: childRange.end,
          message_count: childRange.message_count, source_fingerprint: sourceWindowFingerprint(child),
          parent_range_id: rangeId, root_obligation_id: rootObligationId, depth: nextDepth,
          split_reason: 'malformed_output_repartition', malformed_reason: reason,
        });
        },
      });
      added = schedule.added;
      if (!schedule.completed) return { completed: false, reason: schedule.pause_reason };
      const committedChildKeys = [
        ...execution.recovery.completed_child_keys,
        ...budget.split_children_committed,
      ];
      if (!malformedChildCoverageComplete(expectedChildKeys, committedChildKeys)) {
        return { completed: false, reason: 'malformed_child_coverage_incomplete' };
      }
      recordExtractionCoverage(coverageLedger, {
        ...coverageBase, provider_outcome: 'malformed_output_repartition_recovered',
        coverage_terminal_state: 'repartitioned_completed', all_source_messages_covered: true,
        child_range_count: children.length,
      });
      return { completed: true, added };
    };

    if (!preflight.fits) {
      healthUpdate({ provider_outcome: 'locally_prevented', preflight: { ...preflight, prevented: true, resized_or_repartitioned: true } });
      const added = await splitWindow('prevented_preflight_context_overflow');
      healthFinish({ terminal_health: 'completed_repartitioned', persistence: 'saved' });
      return added;
    }

    let response;
    const storedRecoveryState = readProviderRecoveryWindowState(
      providerMetadata, rootObligationId, coverageBase.source_fingerprint);
    const resumeRecoveryState = storedRecoveryState?.configuration_signature === providerConfigSignature
      ? storedRecoveryState : null;
    const restoredFragments = resumeRecoveryState?.unresolved_fragments ?? [];
    if (execution.provider.resumed_pending_obligation
      && Number(resumeRecoveryState?.durable_partial_record_count ?? 0) > 0
      && (resumeRecoveryState?.unresolved_semantic_units ?? []).length > 0
      && restoredFragments.length === 0) {
      await emitLifecycleEvent('obligation_blocked', {
        exact_reason_code: 'missing_private_unresolved_fragment_payload',
        next_eligible_action: 'inspect_or_restore_unresolved_fragment_payload',
        recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: null,
      });
      const missingPayload = new Error('The durable rejected-fragment identities remain, but their private recovery payload is missing.');
      missingPayload.code = 'SME_MISSING_FRAGMENT_RECOVERY_PAYLOAD';
      missingPayload.sme_recovery_blocked = true;
      missingPayload.sme_obligation_id = rootObligationId;
      throw missingPayload;
    }
    const resumeEligibility = resumeRecoveryState
      ? deriveRecoveryStageEligibility({
        ...resumeRecoveryState,
        has_unresolved_fragments: restoredFragments.length > 0,
      }) : null;
    const automaticFragmentRecovery = execution.recovery.automatic_fragment_recovery
      ?? (execution.provider.resumed_pending_obligation && restoredFragments.length ? {
        response: restoredFragments.map((item) => item.raw).join('\n'),
        fragment_ids: restoredFragments.map((item) => item.fragment_id),
        recovery_of_attempt_id: restoredFragments[0]?.producing_attempt_id ?? null,
        focused_prompt: buildFocusedSessionFragmentRecoveryPrompt(chatHistory, restoredFragments),
      } : null);
    if (execution.provider.resumed_pending_obligation && automaticFragmentRecovery
      && resumeEligibility?.blocked === true) {
      await emitLifecycleEvent('obligation_blocked', {
        exact_reason_code: resumeEligibility.reason_code ?? 'all_recovery_stages_exhausted_for_unchanged_inputs',
        next_eligible_action: 'change_provider_configuration_or_install_updated_build',
        recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: null,
      });
      const blocked = new Error('Session recovery has no eligible changed recovery stage.');
      blocked.code = 'SME_RECOVERY_CHANGE_REQUIRED';
      blocked.sme_recovery_blocked = true;
      blocked.sme_obligation_id = rootObligationId;
      throw blocked;
    }
    if (execution.provider.resumed_pending_obligation && automaticFragmentRecovery) {
      const partialVerification = verifyPersistedPartialSessionRecords(
        loadSessionMemories(), resumeRecoveryState, { start: range.start, end: range.end });
      if (!partialVerification.verified) {
        await emitLifecycleEvent('obligation_blocked', {
          exact_reason_code: 'committed_partial_record_verification_failed',
          next_eligible_action: 'inspect_or_restore_committed_partial_record',
          recovery_intent: 'recover_unresolved_partial_output_fragments', recovery_stage: null,
          metrics: { partial_record_verification: partialVerification },
        });
        const verificationError = new Error('Committed partial Session record could not be verified before Resume.');
        verificationError.code = 'SME_COMMITTED_PARTIAL_RECORD_VERIFICATION_FAILED';
        verificationError.sme_recovery_blocked = true;
        verificationError.sme_obligation_id = rootObligationId;
        throw verificationError;
      }
      markProviderPartialRecordsPersisted(providerMetadata, rootObligationId,
        partialVerification.expected_count, coverageBase.source_fingerprint,
        partialVerification.record_ids);
      await emitLifecycleEvent('recovery_required', {
        exact_reason_code: 'resume_epoch_ready',
        next_eligible_action: resumeEligibility?.eligible_action ?? 'fragment_decision_regeneration',
        recovery_intent: 'recover_unresolved_partial_output_fragments',
        recovery_stage: resumeEligibility?.eligible_action ?? 'fragment_decision_regeneration',
        persistence_result: 'partial_records_committed',
        metrics: { partial_record_verification: partialVerification },
      });
    }
    const restoredResumeEpoch = execution.provider.resumed_pending_obligation
      && automaticFragmentRecovery && execution.recovery.automatic_depth === 0
      ? beginProviderRecoveryEpoch(providerMetadata, rootObligationId, coverageBase.source_fingerprint, {
        recovery_intent: 'recover_unresolved_partial_output_fragments',
        recovery_stage: resumeEligibility?.eligible_action ?? 'fragment_decision_regeneration',
        unresolved_fragment_ids: automaticFragmentRecovery.fragment_ids,
        accepted_records_preserved: Number(resumeRecoveryState?.durable_partial_record_count ?? 0),
        global_request_ceiling: 20,
        epoch_request_ceiling: Number(malformedRecoveryBudget.maximum_additional_provider_requests ?? 4),
      }) : null;
    if (restoredResumeEpoch) {
      if (restoredResumeEpoch.overlap_prevented) {
        const overlapError = new Error('A recovery epoch for this Session obligation is already active.');
        overlapError.code = 'SME_RECOVERY_EPOCH_ALREADY_ACTIVE';
        overlapError.sme_operational_pause = true;
        overlapError.sme_obligation_id = rootObligationId;
        throw overlapError;
      }
      malformedRecoveryBudget.resume_epoch = restoredResumeEpoch.resume_epoch;
      malformedRecoveryBudget.started_at = Date.now();
      malformedRecoveryBudget.additional_provider_requests = 0;
      malformedRecoveryBudget.requests_by_stage = {};
      malformedRecoveryBudget.requests_by_child = {};
      malformedRecoveryBudget.global_additional_provider_requests
        = Number(restoredResumeEpoch.global_requests_consumed_before_epoch ?? 0);
      malformedRecoveryBudget.global_requests_by_stage = {
        ...(restoredResumeEpoch.global_requests_by_stage_before_epoch ?? {}),
      };
      await execution.hooks.recovery_epoch_initialized(restoredResumeEpoch);
    }
    const bypassEquivalentRootReplay = Boolean(automaticFragmentRecovery)
      || (execution.provider.resumed_pending_obligation && Boolean(resumeRecoveryState))
      || resumeEligibility?.blocked === true
      || resumeEligibility?.eligible_action === 'single_source_unit_regeneration';
    const providerAttempt = automaticFragmentRecovery ? {
      attempt_id: automaticFragmentRecovery.recovery_of_attempt_id ?? null,
      logical_obligation_id: rootObligationId,
      resumed_pending_obligation: true,
      prior_window_recovery_state: resumeRecoveryState,
      _already_finished: true,
    } : bypassEquivalentRootReplay ? {
      attempt_id: resumeRecoveryState?.prior_attempt_id ?? null,
      logical_obligation_id: rootObligationId,
      resumed_pending_obligation: true,
      prior_window_recovery_state: resumeRecoveryState,
      _already_finished: true,
    } : beginPhysicalAttempt();
    if (!bypassEquivalentRootReplay && providerAttempt?.attempt_id) {
      await emitLifecycleEvent('provider_attempt_started', {
        provider_attempt_id: providerAttempt.attempt_id,
        exact_reason_code: 'provider_request_in_progress',
        recovery_intent: providerAttempt.recovery_intent,
        recovery_stage: providerAttempt.recovery_stage,
      });
    }
    try {
      if (automaticFragmentRecovery) {
        response = automaticFragmentRecovery.response;
        providerResponseReceived = true;
      } else if (!bypassEquivalentRootReplay) {
        providerRequestSent = true;
        response = await generateMemoryExtract(prompt, { responseLength });
        providerResponseReceived = true;
        await emitLifecycleEvent('provider_response_received', {
          provider_attempt_id: providerAttempt?.attempt_id ?? null,
          exact_reason_code: 'downstream_parser_pending',
        });
      }
    } catch (err) {
      const overflow = classifyContextOverflow(err);
      if (overflow || isEstimatedContextOverflow(err)) {
        finishProviderAttempt(providerMetadata, providerAttempt, {
          terminal_outcome: 'context_overflow_repartitioned', recoverable: true,
          provider_reported_prompt_tokens: overflow?.reported_prompt_tokens ?? null,
          provider_reported_context_tokens: overflow?.reported_context_tokens ?? null,
        });
        healthUpdate({ provider_outcome: 'classified_context_overflow', preflight: { ...preflight, resized_or_repartitioned: true } });
        const added = await splitWindow('provider_reported_context_overflow', getMemoryRequestBudget(responseLength), overflow, providerAttempt?.attempt_id ?? null);
        healthFinish({ terminal_health: 'completed_repartitioned', persistence: 'saved' });
        return added;
      }
      const providerStatus = Number(err?.status ?? err?.cause?.status);
      finishProviderAttempt(providerMetadata, providerAttempt, {
        terminal_outcome: 'provider_failure', recoverable: false,
        failure_classification: Number.isFinite(providerStatus) ? `provider_http_${providerStatus}`
          : err?.name === 'AbortError' ? 'provider_request_aborted' : 'provider_transport_failure',
      });
      if (err && typeof err === 'object') {
        err.sme_provider_request_sent = true;
        err.sme_failure_stage ??= 'provider_request';
        err.sme_live_health_finished = true;
      }
      healthFinish({ provider_outcome: 'provider_failure', terminal_health: 'provider_failure', attention_reason_codes: ['provider_failure'] });
      recordExtractionCoverage(coverageLedger, {
        ...coverageBase,
        request_sent: true,
        provider_outcome: 'failed_non_overflow',
        coverage_terminal_state: 'unresolved_provider_failure',
      });
      throw err;
    }

    smLog('[Smart Memory Enhanced] Session extraction response:', response);

    healthUpdate({ response_received: true, parser_outcome: 'not_started' });
    updateCompletionJournal(providerAttempt, {
      provider_disposition: 'response_received', response_text: response,
    });
    if (String(response ?? '').trim().toUpperCase() === 'NONE') {
      finishProviderAttempt(providerMetadata, providerAttempt, { terminal_outcome: 'completed_no_candidates' });
      updateCompletionJournal(providerAttempt, {
        parser_result: { status: 'explicit_none', records: [], accepted_count: 0 },
        validation: { status: 'no_update' },
        persistence: { status: 'not_needed', durable_record_ids: [] },
        manifest_transition: { status: 'applied', disposition: 'explicit_no_update' },
        ledger_transition: { status: 'applied', disposition: 'explicit_no_update' },
        live_health_transition: { status: 'applied', disposition: 'completed' },
      });
      markProviderDownstreamOutcome(providerMetadata, rootObligationId, { explicit_no_update: true });
      await emitLifecycleEvent('parser_accepted', {
        provider_attempt_id: providerAttempt?.attempt_id ?? null,
        parser_result: 'explicit_none',
      });
      await emitLifecycleEvent('explicit_no_update_accepted', {
        parser_result: 'explicit_none', downstream_validation_result: 'validated_no_update',
        persistence_result: 'not_required_validated_no_update', coverage_result: 'safely_committed',
      });
      recordCompletedCoverage('completed_no_candidates');
      if (sessionDiagnostics) sessionDiagnostics.providerReturnedNone = (sessionDiagnostics.providerReturnedNone ?? 0) + 1;
      healthFinish({ provider_outcome: 'completed_no_candidates', response_received: true, parser_outcome: 'explicit_none', terminal_health: 'completed', persistence: 'not_needed', candidates: { emitted: 0 } });
      return 0;
    }

    // Do not let candidate verification observe parser-time, chunk-relative
    // source claims.  Normalize them to original chat indices first.
    const provenanceContext = getContext();
    const provenanceChatLength = provenanceContext.chat?.length ?? 1;
    const provenanceWindowEnd = Math.max(0, provenanceChatLength - 2);
    const provenanceWindowStart = Math.max(0, provenanceWindowEnd - sourceMessages.length + 1);
    const chatIndexByMessage = new Map((provenanceContext.chat ?? []).map((message, index) => [message, index]));
    const provenanceOriginalIndices = sourceMessages.map((message, index) => {
      if (Number.isInteger(message.__sme_original_index)) return message.__sme_original_index;
      const chatIndex = chatIndexByMessage.get(message);
      return Number.isInteger(chatIndex) ? chatIndex : provenanceWindowStart + index;
    });
    if (sessionDiagnostics) {
      // Bounded mapping metadata makes citation failures explainable without
      // exporting message text or model output.
      sessionDiagnostics.provenanceMapping = {
        prompt_source_message_count: sourceMessages.length,
        raw_chunk_message_count: recentMessages.length,
        mapped_source_indices: provenanceOriginalIndices.length,
        mapping_strategy: sourceMessages.every((message) => Number.isInteger(message.__sme_original_index))
          ? 'preserved_original_indices'
          : 'context_identity_or_window_fallback',
      };
    }
    let recoveryPendingError = null;
    let recoveryPendingObligationId = null;
    let stagedRecoveryObligationId = null;
    let lifecycleAttemptId = providerAttempt?.attempt_id ?? null;
    let unresolvedPartialFragments = 0;
    let rejectedPartialFragments = [];
    let recoveredRecordFragmentIds = [];
    let recoveredNoUpdateFragmentIds = [];
    let parsedCandidates = parseSessionOutput(response);
    if (!parsedCandidates.length) {
      if (sessionDiagnostics) sessionDiagnostics.malformedOutput = (sessionDiagnostics.malformedOutput ?? 0) + 1;
      const recovery = await recoverMalformedTaggedOutput({
        response, tier: 'session', parse: parseSessionOutput,
        generate: generateMemoryExtract,
        originalPrompt: automaticFragmentRecovery?.focused_prompt ?? prompt,
        responseLength,
        originalAttempt: providerAttempt, beginAttempt: beginPhysicalAttempt,
        finishAttempt: (attempt, patch) => attempt?._already_finished
          ? attempt : finishProviderAttempt(providerMetadata, attempt, patch),
        splitWindow: automaticFragmentRecovery ? null : splitMalformedWindow,
        budget: malformedRecoveryBudget,
        splitDepth: malformedRecoveryDepth,
        resumeState: resumeRecoveryState,
        providerCapabilities: getMemoryProviderCapabilities(),
        unresolvedFragments: automaticFragmentRecovery
          ? restoredFragments.length ? restoredFragments : rejectedPartialFragments : [],
        onAttemptRegistered: async (attempt, detail = {}) => {
          if (!attempt?.attempt_id) throw new Error('Provider recovery attempt registration failed.');
          await emitLifecycleEvent('provider_attempt_started', {
            provider_attempt_id: attempt.attempt_id,
            exact_reason_code: 'provider_request_in_progress',
            recovery_intent: 'recover_unresolved_partial_output_fragments',
            recovery_stage: detail.recovery_stage ?? attempt.recovery_stage,
          });
        },
        sourceUnits: automaticFragmentRecovery
          ? [] : buildRecoverySourceUnits(sourceMessages, range.start, sourceWindowFingerprint),
        stagePartialRecords: async (records, details) => {
          stageProviderPartialRecovery(providerMetadata, rootObligationId, coverageBase.source_fingerprint,
            records, { ...details, source_range: { start: range.start, end: range.end, message_count: range.message_count } });
          await saveChatMetadata(getContext());
        },
      });
      const terminalRecoveryAttempt = [...(providerMetadata?.live_memory_health
        ?.provider_attempt_audit?.recent_attempts ?? [])].reverse().find((attempt) =>
        attempt.child_obligation_id === leafObligationId && attempt.terminal_outcome !== 'running');
      if (terminalRecoveryAttempt?.attempt_id
        && terminalRecoveryAttempt.attempt_id !== providerAttempt?.attempt_id) {
        lifecycleAttemptId = terminalRecoveryAttempt.attempt_id;
        await emitLifecycleEvent('provider_response_received', {
          provider_attempt_id: lifecycleAttemptId,
          exact_reason_code: 'downstream_parser_pending',
        });
      }
      if (recovery.repartitioned) {
        markProviderDownstreamOutcome(providerMetadata, rootObligationId, {
          validation_accepted: true, persistence_committed: true, accepted_count: recovery.added,
        });
        await emitLifecycleEvent('parent_children_completed', {
          parser_result: 'repartitioned', downstream_validation_result: 'accepted',
          persistence_result: 'committed_children', coverage_result: 'safely_committed',
        });
        healthFinish({ terminal_health: 'completed_repartitioned', persistence: 'saved',
          provider_outcome: 'completed_after_malformed_repartition', parser_outcome: 'repartitioned' });
        return recovery.added;
      }
      if (recovery.explicit_none) {
        const durableRecoveredCount = Number(recovery.durable_partial_record_count ?? 0) || 0;
        if (automaticFragmentRecovery?.fragment_ids?.length) {
          markProviderRejectedFragmentsRecovered(providerMetadata, rootObligationId,
            coverageBase.source_fingerprint, automaticFragmentRecovery.fragment_ids);
        }
        if (recovery.logical_obligation_id) {
          markProviderStagedRecoveryCompleted(providerMetadata, recovery.logical_obligation_id,
            coverageBase.source_fingerprint, durableRecoveredCount);
          await saveChatMetadata(getContext());
        }
        recordCompletedCoverage(durableRecoveredCount > 0
          ? 'completed_after_durable_partial_recovery' : 'completed_no_candidates_after_regeneration');
        markProviderDownstreamOutcome(providerMetadata, rootObligationId, durableRecoveredCount > 0
          ? { validation_accepted: true, persistence_committed: true, accepted_count: durableRecoveredCount }
          : { explicit_no_update: true });
        await emitLifecycleEvent('parser_accepted', {
          provider_attempt_id: lifecycleAttemptId,
          parser_result: 'recovered_explicit_none',
        });
        if (durableRecoveredCount > 0) {
          await emitLifecycleEvent('validation_accepted', {
            provider_attempt_id: lifecycleAttemptId,
            downstream_validation_result: 'accepted_staged_records',
          });
          await emitLifecycleEvent('records_staged', {
            provider_attempt_id: lifecycleAttemptId, persistence_result: 'staged',
          });
        }
        await emitLifecycleEvent(durableRecoveredCount > 0
          ? 'records_durably_persisted' : 'explicit_no_update_accepted', {
          provider_attempt_id: lifecycleAttemptId,
          parser_result: 'recovered_explicit_none',
          downstream_validation_result: durableRecoveredCount > 0 ? 'accepted_staged_records' : 'validated_no_update',
          persistence_result: durableRecoveredCount > 0 ? 'committed' : 'not_required_validated_no_update',
          coverage_result: 'safely_committed',
          lifecycle: {
            explicit_no_update_fragment_ids: recovery.no_update_fragment_ids
              ?? automaticFragmentRecovery?.fragment_ids ?? [],
          },
        });
        healthFinish({ terminal_health: 'completed', persistence: 'not_needed',
          provider_outcome: durableRecoveredCount > 0
            ? 'completed_after_durable_partial_recovery' : 'completed_no_candidates_after_regeneration',
          parser_outcome: 'explicit_none', durable_recovered_record_count: durableRecoveredCount });
        return 0;
      }
      parsedCandidates = recovery.records;
      recoveredRecordFragmentIds = recovery.record_fragment_ids ?? recovery.resolved_fragment_ids ?? [];
      recoveredNoUpdateFragmentIds = recovery.no_update_fragment_ids ?? [];
      stagedRecoveryObligationId = recovery.staged_partial_record_count
        ? recovery.logical_obligation_id ?? rootObligationId : null;
      if (recovery.partial_unresolved) {
        recoveryPendingError = recovery.terminal_error;
        recoveryPendingObligationId = recovery.logical_obligation_id;
      }
      healthUpdate({ provider_outcome: `completed_after_${recovery.stage}`, parser_outcome: `parsed_after_${recovery.stage}` });
    } else {
      const responseShape = analyzeMalformedResponse(response, { tier: 'session' });
      const parserCountConsistent = parsedCandidates.length === responseShape.parser_accepted_record_count;
      if (!parserCountConsistent) {
        finishProviderAttempt(providerMetadata, providerAttempt, {
          terminal_outcome: 'internal_failure', malformed_reason: 'parser_structural_analysis_mismatch',
          response_shape: responseShape, parser_count_consistent: false, recoverable: false,
          final_disposition: 'developer_consistency_failure',
        });
        const consistencyError = new Error('Session parser and structural analysis disagreed on accepted record count.');
        consistencyError.code = 'SME_PARSER_ANALYSIS_MISMATCH';
        throw consistencyError;
      }
      const partialReason = responseShape.parser_accepted_record_count > 0
        && responseShape.structurally_rejected_record_count > 0 ? 'partial_valid_output' : null;
      unresolvedPartialFragments = partialReason
        ? Number(responseShape.structurally_rejected_record_count ?? 0) : 0;
      rejectedPartialFragments = partialReason
        ? selectRejectedTaggedFragments(response, { tier: 'session' }) : [];
      if (rejectedPartialFragments.length) {
        stageProviderRejectedFragments(providerMetadata, rootObligationId,
          coverageBase.source_fingerprint, rejectedPartialFragments, {
            source_range: { start: range.start, end: range.end, message_count: range.message_count },
            producing_attempt_id: providerAttempt?.attempt_id ?? null,
          });
      }
      const noticeReason = !parserCountConsistent ? 'parser_structural_analysis_mismatch'
        : partialReason ?? ((responseShape.prose_before_structure || responseShape.prose_after_structure)
        ? 'prose_around_tagged_records'
          : responseShape.modifier_locally_normalizable_count > 0
            ? 'local_normalization:canonical_modifiers' : null);
      finishProviderAttempt(providerMetadata, providerAttempt, {
        terminal_outcome: 'completed', malformed_reason: null, notice_reason: noticeReason,
        recovery_stage: partialReason ? 'strict_partial_valid_preserved' : providerAttempt?.recovery_stage ?? 'strict_generation',
        final_recovery_stage: partialReason ? 'strict_partial_valid_preserved' : providerAttempt?.recovery_stage ?? 'strict_generation',
        response_shape: responseShape, parser_count_consistent: parserCountConsistent,
        total_candidate_count: Number(responseShape.structural_candidate_count ?? parsedCandidates.length),
        accepted_candidate_count: parsedCandidates.length,
        rejected_candidate_count: Number(responseShape.structurally_rejected_record_count ?? 0),
        missing_required_results: unresolvedPartialFragments > 0,
        unresolved_semantic_units: unresolvedPartialFragments > 0
          ? ['provider_structurally_rejected_fragments'] : [],
        partial_output_policy: partialReason ? 'accept_complete_valid_records_and_reject_only_malformed_fragments' : null,
      });
    }
    updateCompletionJournal(providerAttempt, {
      parser_result: {
        status: unresolvedPartialFragments > 0 ? 'partial' : 'accepted',
        records: parsedCandidates, accepted_count: parsedCandidates.length,
        rejected_count: unresolvedPartialFragments,
      },
    });
    await emitLifecycleEvent(unresolvedPartialFragments > 0
      ? 'parser_partially_accepted' : 'parser_accepted', {
      provider_attempt_id: lifecycleAttemptId,
      parser_result: unresolvedPartialFragments > 0 ? 'partial' : 'accepted',
      exact_reason_code: unresolvedPartialFragments > 0
        ? 'partial_valid_output_has_unresolved_fragments' : 'downstream_validation_pending',
      metrics: { parser_accepted_records: parsedCandidates.length, parser_rejected_fragments: unresolvedPartialFragments },
      lifecycle: {
        parser_rejected_fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
        unresolved_fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
      },
    });
    // Assign parser-stage identities before any deterministic representation
    // repair so a downstream split or rejection cannot rewrite parser history.
    for (const [index, candidate] of parsedCandidates.entries()) {
      candidate._citation_candidate_id ??= `session-candidate:${coverageBase.source_fingerprint}:${index}:${stableCitationClaimHash(candidate)}`;
    }
    const parserAcceptedCandidateIds = [...new Set(parsedCandidates
      .map((candidate) => candidate._citation_candidate_id))];
    const shapeRepair = repairSessionCandidateShapes(parsedCandidates);
    parsedCandidates = shapeRepair.records;
    if (sessionDiagnostics && shapeRepair.repaired_count) {
      sessionDiagnostics.localCandidateShapeRepairs = (sessionDiagnostics.localCandidateShapeRepairs ?? 0)
        + shapeRepair.repaired_count;
    }
    healthUpdate({ provider_outcome: 'completed', parser_outcome: 'parsed', candidates: { emitted: parsedCandidates.length } });
    await emitLifecycleEvent(unresolvedPartialFragments > 0
      ? 'parser_partially_accepted' : 'parser_accepted', {
      lifecycle: { parser_accepted_candidate_ids: parserAcceptedCandidateIds },
    });
    const initiallyParsedCount = parserAcceptedCandidateIds.length;
    const terminalRecords = new Map();
    const recordTerminalCandidate = (candidate, disposition, reason = null) => {
      const candidateId = candidate?._citation_candidate_id;
      if (!candidateId || terminalRecords.has(candidateId)) return false;
      terminalRecords.set(candidateId, { candidate_id: candidateId, terminal_disposition: disposition, reason });
      return true;
    };
    for (const rejected of shapeRepair.rejected) {
      recordTerminalCandidate(rejected.candidate, 'rejected_malformed', rejected.reason_code);
    }
    parsedCandidateCount = initiallyParsedCount;
    if (sessionDiagnostics) sessionDiagnostics.emitted = (sessionDiagnostics.emitted ?? 0) + parsedCandidates.length;
    // When the provider produced otherwise parseable session records but
    // omitted every citation, ask once for the *same records only* with their
    // source indices. Do not rerun extraction or persist uncited candidates.
    let repairRecovered = 0;
    let repairEligibleCount = 0;
    let repairTerminalRecorded = false;
    let repairMalformedCount = 0;
    // Must be visible to the final per-chunk diagnostics even when this
    // provider response contains no repairable candidates or returns NONE.
    let claimHashRecoveries = 0;
    let repairHashesReturned = 0;
    const claimHashRecoveryTrace = [];
    const repairValidation = {
      candidates_sent: 0, response_records_returned: 0,
      records_associated_by_exact_id: 0, records_associated_by_normalized_id: 0,
      records_associated_by_claim_hash: 0, records_associated_by_position: 0,
      records_unassociated: 0, records_with_citations: 0, records_with_empty_citations: 0,
      citations_total: 0, citations_prompt_visible: 0, citations_out_of_range: 0,
      citations_mapping_failed: 0, records_semantically_supported: 0,
      records_semantically_ambiguous: 0, records_semantically_unsupported: 0,
      records_rejected_claim_changed: 0, records_accepted_before_deduplication: 0,
      records_rejected_as_duplicate_after_repair: 0, records_rejected_by_later_validation: 0,
      records_finally_persisted: 0, terminal_reason_counts: {}, repair_source_mapping: [],
    };
    const recordRepairReason = (reason, count = 1) => {
      repairValidation.terminal_reason_counts[reason] = (repairValidation.terminal_reason_counts[reason] ?? 0) + count;
    };
    const uncitedCandidates = parsedCandidates.filter((candidate) => !(candidate.source_message_indices ?? []).length);
    if (uncitedCandidates.length > 0) {
      repairEligibleCount = uncitedCandidates.length;
      repairValidation.candidates_sent = repairEligibleCount;
      if (sessionDiagnostics) {
        sessionDiagnostics.repairEligible = (sessionDiagnostics.repairEligible ?? 0) + repairEligibleCount;
        // Attempts are candidates submitted to the one repair request, not
        // merely the count of provider calls.
        sessionDiagnostics.repairAttempts = (sessionDiagnostics.repairAttempts ?? 0) + repairEligibleCount;
      }
      const formatRepairLines = (candidates) => candidates.map((candidate) => {
        const entities = (candidate._raw_entity_names ?? []).length ? `:entity=${candidate._raw_entity_names.join(',')}` : '';
        candidate._citation_claim_hash ??= stableCitationClaimHash(candidate);
        return `[${candidate.type}:${candidate.importance}:${candidate.expiration}:candidate_id=${candidate._citation_candidate_id}:claim_hash=${candidate._citation_claim_hash}${entities}] ${candidate.content}`;
      }).join('\n');
      const buildRepairPrompt = (candidates, retry = false) => `[SESSION CITATION REPAIR${retry ? ' - single candidate retry' : ''} - strict JSON lines only.]\n\nThe following session-memory items were already extracted from the numbered source excerpt below, but their required citations were omitted. Return exactly one JSON object per supplied candidate_id and no prose or markdown. Preserve candidate_id and claim_hash exactly. The original stored candidate is authoritative: its claim will never be replaced from your response. For every item return either {"candidate_id":"...","claim_hash":"...","citations":[12,15],"failure_reason":null} using one or more supporting excerpt indices, or {"candidate_id":"...","claim_hash":"...","citations":[],"failure_reason":"unsupported_by_provided_sources"}. Do not add, remove, reword, or combine memories; do not reorder them.\n\nSOURCE EXCERPT:\n${chatHistory}\n\nITEMS TO CITE:\n${formatRepairLines(candidates)}`;
      const repairPrompt = buildRepairPrompt(uncitedCandidates);
      const parseRepairAssociations = (raw) => {
        const bracketed = parseSessionOutput(raw);
        if (bracketed.length) return bracketed;
        const records = [];
        const append = (id, sources, claimHash = null, failureReason = null) => {
          const normalizedId = String(id ?? '').trim().replace(/^['"]|['"]$/g, '');
          const indices = [...new Set((Array.isArray(sources) ? sources : String(sources ?? '').split(/[\s,]+/))
            .map((value) => Number(value)).filter(Number.isInteger))];
          if (normalizedId || claimHash) records.push({ _citation_candidate_id: normalizedId || null, _citation_claim_hash: claimHash ? String(claimHash).trim() : null, source_message_indices: indices, _repair_failure_reason: failureReason ? String(failureReason).trim() : null, _repair_association_only: true });
        };
        // Local providers often honor the JSON contract but wrap the complete
        // response in a pretty-printed array. Parse the full payload before
        // falling back to JSON-lines, rather than discarding every valid
        // record and needlessly triggering the single-candidate retry.
        const cleanRaw = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        try {
          const parsedWhole = JSON.parse(cleanRaw);
          const values = Array.isArray(parsedWhole) ? parsedWhole : [parsedWhole];
          for (const item of values) append(item?.candidate_id, item?.citations ?? item?.sources, item?.claim_hash, item?.failure_reason);
          if (records.length) return records;
        } catch { /* JSON-lines and XML remain supported below. */ }
        for (const line of String(raw ?? '').split(/\r?\n/)) {
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) for (const item of parsed) append(item?.candidate_id, item?.citations ?? item?.sources, item?.claim_hash, item?.failure_reason);
            else append(parsed?.candidate_id, parsed?.citations ?? parsed?.sources, parsed?.claim_hash, parsed?.failure_reason);
          } catch { /* XML or prose is handled below; never infer from text. */ }
        }
        for (const match of String(raw ?? '').matchAll(/<record\b[^>]*candidate_id=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/record>/gi)) {
          const sourceMatch = match[2].match(/<(?:citations|sources)>([^<]+)<\/(?:citations|sources)>/i);
          const hashMatch = match[0].match(/claim_hash=["']?([^"'\s>]+)/i);
          append(match[1], sourceMatch?.[1], hashMatch?.[1]);
        }
        return records;
      };
      try {
        const repairedResponse = await generateMemoryExtract(applyPromptOverride(repairPrompt, PROMPT_TASKS.SESSION_EXTRACTION, characterName), {
          responseLength: settings.session_response_length ?? 500,
          task: 'session-citation-repair',
        });
        if (!repairedResponse || repairedResponse.trim().toUpperCase() === 'NONE') {
          if (sessionDiagnostics) sessionDiagnostics.repairReturnedNone = (sessionDiagnostics.repairReturnedNone ?? 0) + repairEligibleCount;
          repairTerminalRecorded = true;
        } else {
          const originalsById = new Map(uncitedCandidates.map((candidate) => [candidate._citation_candidate_id, candidate]));
          const originalsByClaimHash = new Map(uncitedCandidates.map((candidate) => [candidate._citation_claim_hash, candidate]));
          // Local models occasionally preserve a repaired record but omit or
          // slightly mangle its candidate_id.  Text is never a primary key:
          // use it only as a bounded fallback when one and only one original
          // has the exact same immutable type and content.  This keeps repair
          // association deterministic without accepting a rewritten claim.
          const originalsByExactRecord = new Map();
          for (const original of uncitedCandidates) {
            const key = `${original.type}\u0000${original.content}`;
            const matches = originalsByExactRecord.get(key) ?? [];
            matches.push(original);
            originalsByExactRecord.set(key, matches);
          }
          let parsedRepair = parseRepairAssociations(repairedResponse);
          // A large repair batch can be syntactically valid yet yield no
          // usable citations. Retry only the first candidate once, which
          // probes provider adherence without turning one bad batch into an
          // unbounded series of calls.
          if (!parsedRepair.some((candidate) => candidate.source_message_indices?.length) && uncitedCandidates.length) {
            const retryCandidate = uncitedCandidates[0];
            if (sessionDiagnostics) {
              sessionDiagnostics.citation_repair_adaptive_retry ??= { attempted: 0, recovered: 0, exhausted: 0 };
              sessionDiagnostics.citation_repair_adaptive_retry.attempted++;
            }
            const retryResponse = await generateMemoryExtract(applyPromptOverride(buildRepairPrompt([retryCandidate], true), PROMPT_TASKS.SESSION_EXTRACTION, characterName), {
              responseLength: settings.session_response_length ?? 500,
              task: 'session-citation-repair-single-candidate',
            });
            const retryRecords = parseRepairAssociations(retryResponse);
            if (retryRecords.some((candidate) => candidate.source_message_indices?.length)) {
              parsedRepair = [...parsedRepair, ...retryRecords];
              if (sessionDiagnostics) sessionDiagnostics.citation_repair_adaptive_retry.recovered++;
            } else if (sessionDiagnostics) sessionDiagnostics.citation_repair_adaptive_retry.exhausted++;
          }
          repairHashesReturned = parsedRepair.filter((candidate) => candidate._citation_claim_hash).length;
          if (!parsedRepair.length && sessionDiagnostics) {
            sessionDiagnostics.repairMalformed = (sessionDiagnostics.repairMalformed ?? 0) + repairEligibleCount;
            repairTerminalRecorded = true;
          }
          if (!parsedRepair.length) repairMalformedCount = repairEligibleCount;
          const repairedIds = new Set();
          let parserRecoveries = 0;
          let unknownIdsReturned = 0;
          let duplicateIdsReturned = 0;
          let contentRewritesIgnored = 0;
          let invalidCitations = 0;
          let unmatchedCandidates = 0;
          const repaired = parsedRepair.flatMap((candidate) => {
            let candidateId = candidate._citation_candidate_id;
            let original = originalsById.get(candidateId);
            const directIdMatch = Boolean(original);
            let association = directIdMatch ? 'exact_id' : null;
            if (!original) {
              const hashed = originalsByClaimHash.get(candidate._citation_claim_hash);
              if (hashed) {
                original = hashed;
                candidateId = original._citation_candidate_id;
                claimHashRecoveries++;
                association = 'claim_hash';
              }
            }
            if (!original) {
              const exactMatches = originalsByExactRecord.get(`${candidate.type}\u0000${candidate.content}`) ?? [];
              if (exactMatches.length === 1) {
                original = exactMatches[0];
                candidateId = original._citation_candidate_id;
                parserRecoveries++;
                association = 'unchanged_claim';
              } else if (candidateId) unknownIdsReturned++;
            }
            if (!original || repairedIds.has(candidateId) || !(candidate.source_message_indices ?? []).length) {
              if (original && repairedIds.has(candidateId)) { duplicateIdsReturned++; recordRepairReason('duplicate_returned_candidate'); }
              else if (original) { invalidCitations++; recordRepairReason(candidate._repair_failure_reason === 'unsupported_by_provided_sources' ? 'unsupported_by_provided_sources' : 'empty_citation_set'); }
              else { unmatchedCandidates++; recordRepairReason(candidate._citation_claim_hash ? 'claim_hash_unmatched' : candidateId ? 'candidate_id_unmatched' : 'provider_record_malformed'); }
              claimHashRecoveryTrace.push({
                candidate_id: candidateId ?? null,
                hash_returned: Boolean(candidate._citation_claim_hash),
                association: association ?? 'unassociated',
                citations_present: Boolean(candidate.source_message_indices?.length),
                terminal_outcome: original ? 'rejected_before_validation' : 'unassociated',
              });
              return [];
            }
            // The stored candidate is authoritative. When the provider returns
            // its exact stable ID, accept only its citations and deliberately
            // discard any paraphrased text; it can never rewrite the claim.
            // Without an exact ID, retain the stricter immutable-text fallback.
            if (!candidate._repair_association_only && !directIdMatch && (candidate.type !== original.type || candidate.content !== original.content)) { recordRepairReason('claim_changed'); repairValidation.records_rejected_claim_changed++; return []; }
            if (directIdMatch && !candidate._repair_association_only && (candidate.type !== original.type || candidate.content !== original.content)) contentRewritesIgnored++;
            const citations = candidate.source_message_indices ?? [];
            repairValidation.records_with_citations++;
            repairValidation.citations_total += citations.length;
            const invalidIndex = citations.some((index) => !Number.isInteger(index) || index < 0 || index >= sourceMessages.length);
            if (invalidIndex) {
              repairValidation.citations_out_of_range += citations.length;
              recordRepairReason('source_index_not_prompt_visible');
              invalidCitations++;
              return [];
            }
            repairValidation.citations_prompt_visible += citations.length;
            if (association === 'exact_id') repairValidation.records_associated_by_exact_id++;
            else if (association === 'claim_hash') repairValidation.records_associated_by_claim_hash++;
            else if (association === 'unchanged_claim') repairValidation.records_associated_by_normalized_id++;
            repairValidation.repair_source_mapping.push({ candidate_id: candidateId, raw_chunk_source_count: recentMessages.length, prompt_visible_source_count: sourceMessages.length, allowed_global_indices_count: provenanceOriginalIndices.length, mapping_strategy: sessionDiagnostics?.provenanceMapping?.mapping_strategy ?? 'unknown', mapping_hash: stableCitationClaimHash({ type: 'mapping', content: provenanceOriginalIndices.join(',') }), validator_mapping_hash: stableCitationClaimHash({ type: 'mapping', content: provenanceOriginalIndices.join(',') }), mappings_equal: true });
            repairedIds.add(candidateId);
            claimHashRecoveryTrace.push({
              candidate_id: candidateId,
              hash_returned: Boolean(candidate._citation_claim_hash),
              association,
              citations_present: true,
              terminal_outcome: 'associated_for_validation',
            });
            return [{ ...original, source_message_indices: citations, grounding_status: 'direct', validation_status: 'unvalidated', __sme_repair_association: association }];
          });
          repairValidation.response_records_returned = parsedRepair.length;
          repairValidation.records_unassociated = unmatchedCandidates;
          if (sessionDiagnostics) {
            const matching = sessionDiagnostics.citation_repair_matching ??= {
              candidates_sent: 0, ids_returned: 0, ids_matched: 0, ids_missing: 0,
              unknown_ids_returned: 0, duplicate_ids_returned: 0, parser_recoveries: 0,
              claim_hash_recoveries: 0, records_with_valid_citations: 0, records_with_invalid_citations: 0,
              records_rejected_candidate_unmatched: 0, records_rejected_claim_changed: 0,
              unmatched_after_retry: 0, batch_size_distribution: {}, recovery_rate: 0,
            };
            matching.candidates_sent += repairEligibleCount;
            matching.ids_returned += parsedRepair.filter((candidate) => candidate._citation_candidate_id).length;
            matching.ids_matched += repaired.length;
            matching.ids_missing += parsedRepair.filter((candidate) => !candidate._citation_candidate_id).length;
            matching.unknown_ids_returned += unknownIdsReturned;
            matching.duplicate_ids_returned += duplicateIdsReturned;
            matching.parser_recoveries += parserRecoveries;
            matching.claim_hash_recoveries += claimHashRecoveries;
            matching.records_with_valid_citations += repaired.length;
            matching.records_with_invalid_citations += invalidCitations;
            matching.records_rejected_candidate_unmatched += unmatchedCandidates;
            matching.content_rewrites_ignored = (matching.content_rewrites_ignored ?? 0) + contentRewritesIgnored;
            matching.unmatched_after_retry += Math.max(0, repairEligibleCount - repaired.length);
            matching.batch_size_distribution[repairEligibleCount] = (matching.batch_size_distribution[repairEligibleCount] ?? 0) + 1;
            matching.recovery_rate = matching.candidates_sent ? Number((matching.ids_matched / matching.candidates_sent).toFixed(4)) : 0;
          }
          if (repaired.length) {
            for (const candidate of repaired) candidate.__sme_citation_repair = true;
            const alreadyCited = parsedCandidates.filter((candidate) => (candidate.source_message_indices ?? []).length > 0);
            parsedCandidates.splice(0, parsedCandidates.length, ...alreadyCited, ...repaired);
            repairRecovered = repaired.length;
          }
        }
      } catch (error) {
        if (sessionDiagnostics) sessionDiagnostics.repairProviderError = (sessionDiagnostics.repairProviderError ?? 0) + repairEligibleCount;
        repairTerminalRecorded = true;
        smLog(`[Smart Memory Enhanced] Session citation repair failed: ${error.message}`);
      }
    }
    // A partial citation-repair reply must not make the omitted original
    // candidates disappear from diagnostics.  Every parsed item gets one
    // disposition: accepted later, rejected by validation, or quarantined.
    const citedCandidates = parsedCandidates.filter((candidate) => (candidate.source_message_indices ?? []).length > 0);
    const missingProvenance = Math.max(0, initiallyParsedCount - citedCandidates.length);
    if (sessionDiagnostics) {
      sessionDiagnostics.missingProvenance = (sessionDiagnostics.missingProvenance ?? 0) + missingProvenance;
      sessionDiagnostics.repairRecovered = (sessionDiagnostics.repairRecovered ?? 0) + repairRecovered;
      if (repairEligibleCount && !repairTerminalRecorded) {
        // Citation recovery alone is not a terminal success: candidates that
        // still fail later validation are counted below after verification.
        sessionDiagnostics.repairStillInvalid = (sessionDiagnostics.repairStillInvalid ?? 0) + Math.max(0, repairEligibleCount - repairRecovered);
      }
    }
    // Uncited candidates are intentionally not stored. The repair pass above
    // is their only chance to supply the already-required evidence.
    recordDisposition('missing_provenance', missingProvenance);
    applyDirectProvenance(citedCandidates, sourceMessages, provenanceWindowStart, provenanceOriginalIndices);

    const {
      verified: incoming,
      superseded: supersessionMap,
      confirmed: confirmedIds,
      dispositions: verificationDispositions,
      rejected: verificationRejected,
    } = await verifySessionCandidates(citedCandidates, existing);
    if (sessionDiagnostics) {
      sessionDiagnostics.validated = (sessionDiagnostics.validated ?? 0) + incoming.length;
      // `batchVerify` classifies malformed syntax and duplicates. It does not
      // make a semantic-support rejection, so do not mislabel those terminal
      // outcomes as one (or count the same candidate twice).
      const rejectedByValidation = 0;
      sessionDiagnostics.rejectedByValidation = (sessionDiagnostics.rejectedByValidation ?? 0) + rejectedByValidation;
      recordDisposition('semantic_support_rejected', rejectedByValidation);
      recordDisposition('malformed_candidate', verificationDispositions.malformed_candidate);
      recordDisposition('duplicate_same_pass', verificationDispositions.duplicate_same_pass);
      recordDisposition('duplicate_existing', verificationDispositions.duplicate_existing);
    }
    const acceptedAfterRepair = incoming.filter((candidate) => candidate.__sme_citation_repair).length;
    const repairRejectedAfterAssociation = verificationRejected.filter((entry) => entry.candidate?.__sme_citation_repair);
    repairValidation.records_accepted_before_deduplication = citedCandidates.filter((candidate) => candidate.__sme_citation_repair).length;
    repairValidation.records_rejected_as_duplicate_after_repair = repairRejectedAfterAssociation.filter((entry) => /duplicate/.test(entry.disposition)).length;
    repairValidation.records_rejected_by_later_validation = repairRejectedAfterAssociation.length;
    repairValidation.records_finally_persisted = acceptedAfterRepair;
    for (const rejected of repairRejectedAfterAssociation) recordRepairReason(rejected.disposition === 'rejected_duplicate' ? 'duplicate_existing' : 'failed_final_provenance_validation');
    if (sessionDiagnostics) {
      sessionDiagnostics.repairAccepted = (sessionDiagnostics.repairAccepted ?? 0) + acceptedAfterRepair;
      if (repairEligibleCount && !repairTerminalRecorded && acceptedAfterRepair) {
        sessionDiagnostics.repairStillInvalid = Math.max(0, (sessionDiagnostics.repairStillInvalid ?? 0) - acceptedAfterRepair);
      }
    }
    recordDisposition('accepted_after_citation_repair', acceptedAfterRepair);
    recordDisposition('accepted_validated', Math.max(0, incoming.length - acceptedAfterRepair));
    const citedCandidateIds = new Set(citedCandidates.map((candidate) => candidate._citation_candidate_id));
    for (const candidate of uncitedCandidates) {
      if (!citedCandidateIds.has(candidate._citation_candidate_id)) {
        recordTerminalCandidate(candidate, 'rejected_missing_provenance', repairTerminalRecorded ? 'provider_omitted_citations' : 'response_candidate_unmatched');
      }
    }
    for (const candidate of verificationRejected) recordTerminalCandidate(candidate.candidate, candidate.disposition, candidate.disposition === 'rejected_malformed' ? 'invalid_candidate_shape' : 'duplicate_candidate');
    for (const candidate of incoming) recordTerminalCandidate(candidate, candidate.__sme_citation_repair ? 'accepted_after_citation_repair' : 'accepted_initially');
    // A terminal record is mandatory even if a future verifier adds a new
    // rejection class. This prevents an accounting gap from being reported as
    // clean quality while retaining a bounded diagnostic reason for follow-up.
    for (const candidate of parsedCandidates) recordTerminalCandidate(candidate, 'rejected_other', 'no_terminal_assignment');
    if (sessionDiagnostics) {
      const pipeline = sessionDiagnostics.session_citation_pipeline ?? {
        candidates_emitted: 0, initially_valid: 0, initial_provenance_failures: 0,
        repair_eligible: 0, repair_attempted: 0, repair_recovered: 0,
        repair_malformed: 0, repair_still_invalid: 0, repair_not_attempted: 0,
        repair_unaccounted: 0, final_valid: 0, final_missing_provenance: 0,
        final_malformed: 0, final_duplicates: 0, final_rejected: 0,
        terminal_candidate_count: 0, terminal_dispositions_reconciled: true,
        unaccounted_candidate_ids: [], candidate_terminal_records: [],
      };
      const terminalValues = [...terminalRecords.values()];
      const unrepaired = terminalValues.filter((entry) => entry.terminal_disposition === 'rejected_missing_provenance').length;
      pipeline.candidates_emitted += initiallyParsedCount;
      pipeline.initially_valid += initiallyParsedCount - uncitedCandidates.length;
      pipeline.initial_provenance_failures += uncitedCandidates.length;
      pipeline.repair_eligible += repairEligibleCount;
      pipeline.repair_attempted += repairEligibleCount;
      pipeline.repair_recovered += repairRecovered;
      pipeline.repair_malformed += repairMalformedCount;
      pipeline.repair_still_invalid += Math.max(0, unrepaired - repairMalformedCount);
      pipeline.final_valid += incoming.length;
      pipeline.final_missing_provenance += unrepaired;
      pipeline.final_malformed += terminalValues.filter((entry) => entry.terminal_disposition === 'rejected_malformed').length;
      pipeline.final_duplicates += terminalValues.filter((entry) => entry.terminal_disposition === 'rejected_duplicate').length;
      pipeline.final_rejected += terminalValues.filter((entry) => entry.terminal_disposition.startsWith('rejected_')).length;
      pipeline.terminal_candidate_count += terminalValues.length;
      pipeline.candidate_terminal_records.push(...terminalValues.map((entry) => ({ ...entry, citation_mapping_strategy: sessionDiagnostics.provenanceMapping?.mapping_strategy ?? 'unknown' })));
      pipeline.candidate_terminal_records = pipeline.candidate_terminal_records.slice(-200);
      pipeline.unaccounted_candidate_ids = [];
      pipeline.terminal_dispositions_reconciled = pipeline.candidates_emitted === pipeline.terminal_candidate_count;
      sessionDiagnostics.session_citation_pipeline = pipeline;
      const postAssociationRejected = Math.max(0, repairValidation.records_accepted_before_deduplication - acceptedAfterRepair);
      const postAssociationReasonCounts = repairRejectedAfterAssociation.reduce((counts, rejected) => {
        const reason = rejected.disposition === 'rejected_duplicate' ? 'duplicate_existing' : 'failed_final_provenance_validation';
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      }, {});
      const cumulativeValidation = sessionDiagnostics.citation_repair_validation ?? Object.fromEntries(
        Object.entries(repairValidation).map(([key, value]) => [key, typeof value === 'number' ? 0 : Array.isArray(value) ? [] : {}]),
      );
      for (const [key, value] of Object.entries(repairValidation)) {
        if (typeof value === 'number') cumulativeValidation[key] = Number(cumulativeValidation[key] ?? 0) + value;
      }
      for (const [reason, count] of Object.entries(repairValidation.terminal_reason_counts)) cumulativeValidation.terminal_reason_counts[reason] = (cumulativeValidation.terminal_reason_counts[reason] ?? 0) + count;
      cumulativeValidation.repair_source_mapping.push(...repairValidation.repair_source_mapping);
      cumulativeValidation.repair_source_mapping = cumulativeValidation.repair_source_mapping.slice(-200);
      sessionDiagnostics.citation_repair_validation = cumulativeValidation;
      const priorPostAssociation = sessionDiagnostics.citation_repair_post_association ?? { associated_valid: 0, accepted_after_validation: 0, rejected_after_association: 0, persisted: 0, rejected_after_association_by_reason: {} };
      sessionDiagnostics.citation_repair_post_association = {
        associated_valid: priorPostAssociation.associated_valid + repairRecovered,
        accepted_after_validation: priorPostAssociation.accepted_after_validation + acceptedAfterRepair,
        rejected_after_association: priorPostAssociation.rejected_after_association + postAssociationRejected,
        rejected_after_association_by_reason: Object.entries(postAssociationReasonCounts).reduce((counts, [reason, count]) => {
          counts[reason] = (priorPostAssociation.rejected_after_association_by_reason?.[reason] ?? 0) + count;
          return counts;
        }, { ...(priorPostAssociation.rejected_after_association_by_reason ?? {}) }),
        persisted: priorPostAssociation.persisted + acceptedAfterRepair,
        accounting_reconciled: (priorPostAssociation.associated_valid + repairRecovered) === (priorPostAssociation.accepted_after_validation + acceptedAfterRepair) + (priorPostAssociation.rejected_after_association + postAssociationRejected),
      };
      sessionDiagnostics.claim_hash_association = {
        hashes_sent: repairEligibleCount,
        hashes_returned: repairHashesReturned,
        exact_hash_matches: claimHashRecoveries,
        normalized_hash_matches: 0,
        missing_hashes: Math.max(0, repairEligibleCount - repairHashesReturned),
        unknown_hashes: repairValidation.terminal_reason_counts.claim_hash_unmatched ?? 0,
        ambiguous_hashes: 0,
        recoveries_attempted: repairEligibleCount,
        recoveries_completed: claimHashRecoveries,
        recovery_trace: claimHashRecoveryTrace.slice(-100),
      };
    }
    if (incoming.length === 0) {
      const invalidShapeCount = verificationDispositions.malformed_candidate + shapeRepair.rejected.length;
      const pendingReason = invalidShapeCount > 0 ? 'invalid_candidate_shape'
        : missingProvenance > 0 ? 'missing_provenance'
          : unresolvedPartialFragments > 0 ? 'partial_valid_output_has_unresolved_fragments' : null;
      if (!pendingReason) {
        markProviderDownstreamOutcome(providerMetadata, rootObligationId, { explicit_no_update: true });
        await emitLifecycleEvent('explicit_no_update_accepted', {
          parser_result: unresolvedPartialFragments ? 'partial' : 'accepted',
          downstream_validation_result: 'validated_duplicate_only_no_update',
          persistence_result: 'not_required_validated_no_update', coverage_result: 'safely_committed',
          metrics: { rejected_duplicates: verificationDispositions.duplicate_same_pass + verificationDispositions.duplicate_existing },
          lifecycle: {
            downstream_rejected_candidate_ids: [...terminalRecords.values()]
              .filter((entry) => entry.terminal_disposition.startsWith('rejected_'))
              .map((entry) => entry.candidate_id),
            duplicate_candidate_ids: [...terminalRecords.values()]
              .filter((entry) => entry.terminal_disposition === 'rejected_duplicate')
              .map((entry) => entry.candidate_id),
          },
        });
        recordCompletedCoverage('completed_validated_no_update');
        healthFinish({ terminal_health: 'completed', persistence: 'not_needed',
          provider_outcome: 'completed_validated_no_update', parser_outcome: 'accepted',
          candidates: { emitted: initiallyParsedCount, accepted: 0 } });
        return 0;
      }
      markProviderDownstreamOutcome(providerMetadata, rootObligationId, {
        validation_accepted: false, persistence_committed: false,
        rejected_count: Math.max(1, initiallyParsedCount), reason_code: pendingReason,
        unresolved_semantic_requirements: true,
        candidate_shape_repair_count: shapeRepair.repaired_count,
        next_eligible_action: pendingReason === 'invalid_candidate_shape'
          ? 'session_validation_repair_or_bounded_regeneration'
          : pendingReason === 'missing_provenance'
            ? 'citation_repair_or_bounded_regeneration'
            : 'recover_unresolved_partial_output_fragments',
      });
      await emitLifecycleEvent('recovery_required', {
        parser_result: unresolvedPartialFragments ? 'partial' : 'accepted',
        downstream_validation_result: `rejected_${pendingReason}`,
        persistence_result: 'not_committed', coverage_result: 'pending',
        exact_reason_code: pendingReason,
        next_eligible_action: pendingReason === 'invalid_candidate_shape'
          ? 'session_validation_repair_or_bounded_regeneration'
          : pendingReason === 'missing_provenance'
            ? 'citation_repair_or_bounded_regeneration'
            : 'recover_unresolved_partial_output_fragments',
        metrics: { downstream_rejected_records: Math.max(1, initiallyParsedCount), local_shape_repairs: shapeRepair.repaired_count },
        lifecycle: {
          downstream_rejected_candidate_ids: [...terminalRecords.values()]
            .filter((entry) => entry.terminal_disposition.startsWith('rejected_'))
            .map((entry) => entry.candidate_id),
          duplicate_candidate_ids: [...terminalRecords.values()]
            .filter((entry) => entry.terminal_disposition === 'rejected_duplicate')
            .map((entry) => entry.candidate_id),
        },
      });
      updateCompletionJournal(providerAttempt, {
        validation: { status: 'rejected', reason_code: pendingReason },
        persistence: { status: 'not_applicable', durable_record_ids: [], reason_code: pendingReason },
        manifest_transition: { status: 'rejected', reason_code: pendingReason },
        ledger_transition: { status: 'applied', disposition: 'pending_recovery' },
        live_health_transition: { status: 'applied', disposition: 'operationally_paused' },
      });
      recordExtractionCoverage(coverageLedger, {
        ...coverageBase, request_sent: true,
        provider_outcome: 'downstream_validation_pending_recovery',
        coverage_terminal_state: 'pending_recovery',
        unresolved_reason: pendingReason,
      });
      const pendingError = new Error(`Session extraction requires recovery: ${pendingReason}`);
      pendingError.code = 'SME_DOWNSTREAM_VALIDATION_PENDING';
      pendingError.sme_failure_stage = 'downstream_validation';
      pendingError.sme_obligation_id = rootObligationId;
      pendingError.sme_reason_code = pendingReason;
      pendingError.sme_operational_pause = true;
      pendingError.sme_request_diagnostics = {
        pause_reason: pendingReason,
        root_obligation_id: rootObligationId,
        tier: 'session',
        source_range: { start: range.start, end: range.end, message_count: range.message_count },
        next_eligible_recovery_action: pendingReason === 'invalid_candidate_shape'
          ? 'session_validation_repair_or_bounded_regeneration'
          : pendingReason === 'missing_provenance'
            ? 'citation_repair_or_bounded_regeneration'
            : 'recover_unresolved_partial_output_fragments',
      };
      throw pendingError;
    }

    await emitLifecycleEvent('validation_accepted', {
      parser_result: unresolvedPartialFragments ? 'partial' : 'accepted',
      downstream_validation_result: 'accepted',
      exact_reason_code: 'persistence_pending',
      metrics: { downstream_valid_records: incoming.length, local_shape_repairs: shapeRepair.repaired_count },
      lifecycle: {
        downstream_accepted_candidate_ids: incoming.map((candidate) => candidate._citation_candidate_id),
        downstream_rejected_candidate_ids: [...terminalRecords.values()]
          .filter((entry) => entry.terminal_disposition.startsWith('rejected_'))
          .map((entry) => entry.candidate_id),
        duplicate_candidate_ids: [...terminalRecords.values()]
          .filter((entry) => entry.terminal_disposition === 'rejected_duplicate')
          .map((entry) => entry.candidate_id),
      },
    });

    // Tag each new memory with the source message range so users can jump back
    // to the passage that prompted the extraction.
    const context = getContext();
    const chatLen = context.chat?.length ?? 1;
    for (const memory of incoming) {
      delete memory.__sme_citation_repair;
      validateGeneratedMemoryRecord(memory, existing);
    }
    if (options.dryRun) {
      return {
        dryRun: true,
        parsed: incoming.length,
        candidates: incoming.map((memory) => ({ type: memory.type, content: memory.content, grounding_status: memory.grounding_status, validation_status: memory.validation_status, validation_issues: memory.validation_issues ?? [] })),
      };
    }

    const max = settings.session_max_memories ?? 30;
    const merged = await deduplicateSession(existing, incoming, max);

    // Apply supersession links. For each candidate that supersedes an existing
    // memory: mark the old memory as retired (superseded_by + valid_to) and
    // link the new memory back to it (supersedes + valid_from).
    const messageIndex = Math.max(0, chatLen - 1);

    const newlyRetiredIds = new Set();
    for (const [candText, oldId] of supersessionMap) {
      const newMem = merged.find(
        (m) =>
          String(m.content || '')
            .toLowerCase()
            .trim() === candText,
      );
      const oldMem = existing.find((m) => m.id === oldId);

      if (newMem && oldMem && !oldMem.superseded_by && newMem.id !== oldMem.id) {
        if (!newMem.supersedes) newMem.supersedes = [];
        if (!newMem.supersedes.includes(oldId)) newMem.supersedes.push(oldId);
        newMem.valid_from = newMem.valid_from ?? messageIndex;

        oldMem.superseded_by = newMem.id;
        oldMem.valid_to = messageIndex;
        newlyRetiredIds.add(oldId);

        smLog(
          `[Smart Memory Enhanced] Session supersession: "${oldMem.content.slice(0, 60)}" retired by "${newMem.content.slice(0, 60)}"`,
        );
      }
    }

    // Remove newly retired entries from the active merged set.
    const finalActive = merged.filter((m) => !newlyRetiredIds.has(m.id));

    // Confidence decay pass - mirrors the long-term logic.
    const DECAY_THRESHOLD = 10;
    const now = Date.now();
    for (const mem of finalActive) {
      if (confirmedIds.has(mem.id)) {
        mem.last_confirmed_ts = now;
        mem.confidence = Math.min(1.0, (mem.confidence ?? 1.0) + 0.05);
        mem.unconfirmed_since = 0;
      } else {
        mem.unconfirmed_since = (mem.unconfirmed_since ?? 0) + 1;
        if (mem.unconfirmed_since >= DECAY_THRESHOLD) {
          mem.confidence = Math.max(0.3, (mem.confidence ?? 1.0) - 0.02);
        }
      }
    }

    // Profile B and opted-in Profile A: generate LLM-suggested triggers for
    // newly added session memories. Same path as long-term, runs sequentially.
    const existingKeys = new Set(existing.map((m) => `${m.type}|${m.content}`));
    if (getHardwareProfile() === 'b' || settings.longterm_triggers_enabled) {
      for (const mem of finalActive) {
        if (existingKeys.has(`${mem.type}|${mem.content}`)) continue;
        if (Array.isArray(mem.triggers) && mem.triggers.length > 0) continue;
        try {
          const triggerPrompt = buildTriggerGenerationPrompt(mem.content);
          const triggerResponse = await generateMemoryExtract(applyPromptOverride(triggerPrompt, PROMPT_TASKS.SESSION_EXTRACTION), {
            responseLength: 60,
          });
          const raw = parseTriggerResponse(triggerResponse, mem.content);
          mem.triggers = filterTriggersByFrequency(raw, finalActive);
          smLog(
            `[Smart Memory Enhanced] Session triggers for "${mem.content.slice(0, 50)}": ${mem.triggers.join(', ')}`,
          );
        } catch (err) {
          smLog(`[Smart Memory Enhanced] Session trigger generation failed: ${err.message}`);
          mem.triggers = [];
        }
      }
    }

    // Normalize only deterministic card/persona aliases in generated prose.
    // Unknown names remain untouched so this cannot create or rename NPCs.
    const canonicalRoster = buildCanonicalCharacterRoster(getContext());
    for (const mem of finalActive) {
      const narrative = canonicalizeNarrativeNames(mem.content, canonicalRoster);
      mem.content = narrative.text;
      if (narrative.replacements.length) mem.identity_replacements = narrative.replacements;
    }

    // Resolve entity names to ids for any new memories that carried
    // _raw_entity_names through the pipeline. The session entity registry is
    // loaded from chatMetadata, updated in place, then persisted.
    const entityRegistry = loadSessionEntityRegistry();
    for (const mem of finalActive) {
      if (isGrounded(mem) && Array.isArray(mem._raw_entity_names)) {
        mem.entity_link_stage ??= 'session_extraction';
        mem.entity_link_store ??= 'session';
        mem.entity_creation_method ??= 'structured_entity_output';
        resolveEntityNames(mem, mem._raw_entity_names, messageIndex, entityRegistry);
      }
    }
    // Reconcile after every extraction pass so memories whose entity tag was
    // omitted by the model get linked via substring match immediately rather
    // than waiting for the next consolidation cycle.
    if (entityRegistry.length > 0) {
      reconcileCanonicalEntityRegistry(entityRegistry, getContext(), finalActive);
      reconcileEntityRegistry(entityRegistry, finalActive);
      if (!abortCheck?.()) {
        persistenceStarted = true;
        await saveSessionEntityRegistry(entityRegistry);
      }
    }

    // Newly retired active memories move to the retired pool.
    let updatedRetired = [...retiredMemories, ...existing.filter((m) => newlyRetiredIds.has(m.id))];

    // Cap the retired pool - same reason as longterm.js.
    if (updatedRetired.length > MAX_RETIRED_POOL) {
      updatedRetired = updatedRetired.slice(updatedRetired.length - MAX_RETIRED_POOL);
    }

    const newlyAddedMemories = finalActive.filter((m) => !existingKeys.has(`${m.type}|${m.content}`));
    const added = newlyAddedMemories.length;
    const addedRecordIds = newlyAddedMemories.map((memory) => memory.id).filter(Boolean);
    const durableRecordCandidateMap = Object.fromEntries(newlyAddedMemories
      .filter((memory) => memory.id && memory._citation_candidate_id)
      .map((memory) => [String(memory.id), String(memory._citation_candidate_id)]));
    for (const memory of finalActive) {
      delete memory._citation_candidate_id;
      delete memory._citation_claim_hash;
    }
    if (abortCheck?.()) return 0;
    persistenceStarted = true;
    await saveSessionMemories([...finalActive, ...updatedRetired]);
    updateCompletionJournal(providerAttempt, {
      validation: { status: 'accepted', accepted_count: incoming.length },
      validated_record_identities: incoming.map((memory) => ({
        id: memory.id ?? null,
        candidate_id: memory._citation_candidate_id ?? durableRecordCandidateMap[memory.id] ?? null,
        source_message_indices: memory.source_message_indices ?? [],
      })),
      persistence: {
        status: addedRecordIds.length ? 'committed' : 'verified_existing',
        durable_record_ids: addedRecordIds,
      },
    });
    if (stagedRecoveryObligationId) {
      markProviderStagedRecoveryCompleted(providerMetadata, stagedRecoveryObligationId,
        coverageBase.source_fingerprint, added);
      await saveChatMetadata(getContext());
    }
    if (recoveryPendingError) {
      markProviderPartialRecordsPersisted(providerMetadata, recoveryPendingObligationId, added,
        coverageBase.source_fingerprint, addedRecordIds);
      await saveChatMetadata(getContext());
      recordExtractionCoverage(coverageLedger, { ...coverageBase,
        provider_outcome: 'partial_valid_records_persisted_obligation_pending',
        coverage_terminal_state: 'partial_records_persisted_obligation_pending',
        accepted_partial_record_count: added,
      });
      recoveryPendingError.sme_partial_records_persisted = true;
      throw recoveryPendingError;
    }
    if (unresolvedPartialFragments > 0) {
      markProviderPartialRecordsPersisted(providerMetadata, rootObligationId, added,
        coverageBase.source_fingerprint, addedRecordIds);
      markProviderDownstreamOutcome(providerMetadata, rootObligationId, {
        validation_accepted: true, persistence_committed: true, accepted_count: added,
        rejected_count: unresolvedPartialFragments, reason_code: 'partial_valid_output_has_unresolved_fragments',
        unresolved_semantic_requirements: true,
        candidate_shape_repair_count: shapeRepair.repaired_count,
        next_eligible_action: 'recover_unresolved_partial_output_fragments',
      });
      await emitLifecycleEvent('recovery_required', {
        parser_result: 'partial', downstream_validation_result: 'accepted_partial_records',
        persistence_result: 'partial_records_committed', coverage_result: 'pending',
        exact_reason_code: 'partial_valid_output_has_unresolved_fragments',
        next_eligible_action: 'recover_unresolved_partial_output_fragments',
        recovery_intent: 'recover_unresolved_partial_output_fragments',
        recovery_stage: 'compact_response_repair',
        metrics: {
          persisted_records: added,
          unresolved_parser_fragments: unresolvedPartialFragments,
          unresolved_fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
          producing_provider_attempt_id: providerAttempt?.attempt_id ?? null,
        },
        lifecycle: {
          durably_persisted_record_ids: addedRecordIds,
          durable_record_candidate_map: durableRecordCandidateMap,
          unresolved_fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
        },
      });
      updateCompletionJournal(providerAttempt, {
        manifest_transition: { status: 'applied', disposition: 'partial_child_pending' },
        ledger_transition: { status: 'applied', disposition: 'pending_recovery' },
        live_health_transition: { status: 'applied', disposition: 'operationally_paused' },
      });
      recordExtractionCoverage(coverageLedger, { ...coverageBase,
        provider_outcome: 'partial_valid_records_persisted_obligation_pending',
        coverage_terminal_state: 'partial_records_persisted_obligation_pending',
        accepted_partial_record_count: added,
        unresolved_fragment_count: unresolvedPartialFragments,
      });
      const automaticRecoveryDepth = execution.recovery.automatic_depth;
      if (execution.recovery.automatic_partial_recovery
        && rejectedPartialFragments.length > 0
        && automaticRecoveryDepth < AUTOMATIC_SESSION_RECOVERY_LIMITS.maximum_controller_cycles) {
        const automaticBudget = execution.recovery.automatic_budget ?? {
          ...createMalformedRecoveryBudget(),
          maximum_additional_provider_requests: AUTOMATIC_SESSION_RECOVERY_LIMITS.maximum_provider_requests,
          maximum_wall_time_ms: AUTOMATIC_SESSION_RECOVERY_LIMITS.maximum_wall_time_ms,
        };
        const boundary = {
          recovery_intent: 'recover_unresolved_partial_output_fragments',
          recovery_stage: 'compact_response_repair',
          root_obligation_id: rootObligationId,
          source_range: { start: range.start, end: range.end, message_count: range.message_count },
          accepted_records_preserved: added,
          unresolved_fragment_count: rejectedPartialFragments.length,
          unresolved_fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
          request_budget_used: Number(automaticBudget.additional_provider_requests ?? 0),
          request_budget_maximum: Number(automaticBudget.maximum_additional_provider_requests),
          recovery_started_at: Number(automaticBudget.started_at),
        };
        await execution.hooks.automatic_recovery_boundary(boundary);
        try {
          const recovered = await extractSessionMemories(recentMessages, abortCheck, {
            ...options,
            liveHealth: null,
            executionContext: extendMemorizeExecutionContext(execution, { recovery: {
              automatic_depth: automaticRecoveryDepth + 1,
              automatic_budget: automaticBudget,
              malformed_budget: automaticBudget,
              automatic_fragment_recovery: {
                response: rejectedPartialFragments.map((item) => item.raw).join('\n'),
                fragment_ids: rejectedPartialFragments.map((item) => item.fragment_id),
                recovery_of_attempt_id: providerAttempt?.attempt_id ?? null,
                focused_prompt: buildFocusedSessionFragmentRecoveryPrompt(chatHistory, rejectedPartialFragments),
              },
            }, provider: {
              root_obligation_id: rootObligationId,
              root_source_range: execution.provider.root_source_range
                ?? { start: range.start, end: range.end, message_count: range.message_count },
              root_source_fingerprint: execution.provider.root_source_fingerprint
                ?? coverageBase.source_fingerprint,
              resumed_pending_obligation: true,
            } }),
          });
          await execution.hooks.automatic_recovery_completed({
            ...boundary,
            recovery_stage: 'completed',
            recovered_record_count: Number(recovered ?? 0),
            request_budget_used: Number(automaticBudget.additional_provider_requests ?? 0),
          });
          return added + Number(recovered ?? 0);
        } catch (automaticError) {
          if (['SME_MALFORMED_PROVIDER_OUTPUT', 'SME_RECOVERY_PATH_EXHAUSTED'].includes(automaticError?.code)) {
            const budgetAccounting = summarizeMalformedRecoveryBudget(automaticBudget, {
              eligible_changed_stages_remaining: [], pause_reason: 'recovery_stage_ladder_exhausted',
            });
            automaticError.code = 'SME_RECOVERY_BUDGET_PAUSE';
            automaticError.sme_operational_pause = true;
            automaticError.sme_reason_code = 'recovery_stage_ladder_exhausted';
            automaticError.sme_request_diagnostics = {
              ...(automaticError.sme_request_diagnostics ?? {}),
              pause_reason: 'recovery_stage_ladder_exhausted',
              recovery_intent: boundary.recovery_intent,
              recovery_stage: 'bounded_recovery_exhausted',
              root_obligation_id: rootObligationId,
              source_range: boundary.source_range,
              accepted_records_preserved: boundary.accepted_records_preserved,
              unresolved_fragment_count: boundary.unresolved_fragment_count,
              unresolved_fragment_ids: boundary.unresolved_fragment_ids,
              consumed_requests: Number(automaticBudget.additional_provider_requests ?? 0),
              remaining_requests: budgetAccounting.global_requests_remaining,
              epoch_requests_remaining: budgetAccounting.epoch_requests_remaining,
              budget_accounting: budgetAccounting,
              fresh_budget_on_resume: true,
              next_eligible_recovery_action: 'recover_unresolved_partial_output_fragments',
            };
          }
          throw automaticError;
        }
      }
      const partialError = new Error('Session extraction preserved valid records but unresolved provider fragments remain.');
      partialError.code = 'SME_DOWNSTREAM_VALIDATION_PENDING';
      partialError.sme_partial_records_persisted = true;
      partialError.sme_failure_stage = 'partial_output_recovery';
      partialError.sme_obligation_id = rootObligationId;
      partialError.sme_reason_code = 'partial_valid_output_has_unresolved_fragments';
      partialError.sme_operational_pause = true;
      partialError.sme_request_diagnostics = {
        pause_reason: 'partial_valid_output_has_unresolved_fragments',
        root_obligation_id: rootObligationId,
        tier: 'session',
        source_range: { start: range.start, end: range.end, message_count: range.message_count },
        next_eligible_recovery_action: 'recover_unresolved_partial_output_fragments',
      };
      throw partialError;
    }
    if (automaticFragmentRecovery?.fragment_ids?.length) {
      markProviderRejectedFragmentsRecovered(providerMetadata, rootObligationId,
        coverageBase.source_fingerprint, automaticFragmentRecovery.fragment_ids);
      await saveChatMetadata(getContext());
    }
    markProviderDownstreamOutcome(providerMetadata, rootObligationId, {
      validation_accepted: true, persistence_committed: true, accepted_count: added,
      candidate_shape_repair_count: shapeRepair.repaired_count,
    });
    await emitLifecycleEvent('records_staged', {
      provider_attempt_id: lifecycleAttemptId, persistence_result: 'staged',
    });
    await emitLifecycleEvent('records_durably_persisted', {
      provider_attempt_id: lifecycleAttemptId,
      parser_result: 'accepted', downstream_validation_result: 'accepted',
      persistence_result: 'committed', coverage_result: 'safely_committed',
      metrics: { persisted_records: added, local_shape_repairs: shapeRepair.repaired_count },
      lifecycle: {
        durably_persisted_record_ids: addedRecordIds,
        durable_record_candidate_map: durableRecordCandidateMap,
        recovered_fragment_ids: recoveredRecordFragmentIds,
        explicit_no_update_fragment_ids: recoveredNoUpdateFragmentIds,
      },
    });
    updateCompletionJournal(providerAttempt, {
      manifest_transition: { status: 'applied', disposition: 'leaf_covered' },
      ledger_transition: { status: 'applied', disposition: 'durably_committed' },
      live_health_transition: { status: 'applied', disposition: 'completed' },
    });
    recordCompletedCoverage('completed_and_persisted');
    healthFinish({
      terminal_health: 'completed', persistence: 'saved',
      candidates: {
        accepted: added,
        accepted_after_citation_repair: acceptedAfterRepair,
        rejected_missing_provenance: missingProvenance,
        rejected_duplicate: (verificationDispositions.duplicate_same_pass ?? 0) + (verificationDispositions.duplicate_existing ?? 0),
        rejected_validation: verificationDispositions.malformed_candidate ?? 0,
      },
      citation_mapping_valid: provenanceOriginalIndices.every(Number.isInteger),
    });
    return added;
  } catch (err) {
    if (err?.sme_operational_pause === true) {
      if (!err?.sme_live_health_finished) healthFinish({
        terminal_health: 'operationally_paused',
        provider_outcome: 'response_received',
        parser_outcome: 'downstream_validation_pending',
        persistence: err?.sme_partial_records_persisted ? 'partial_records_committed' : 'not_committed',
        attention_reason_codes: [err?.sme_reason_code ?? 'downstream_validation_pending'],
      });
      throw err;
    }
    const malformedExhausted = ['SME_MALFORMED_PROVIDER_OUTPUT', 'SME_RECOVERY_PATH_EXHAUSTED'].includes(err?.code);
    const partialRecordsPersisted = err?.sme_partial_records_persisted === true;
    const preRequestInternalFailure = !malformedExhausted && !providerRequestSent;
    const providerFailure = !malformedExhausted && providerRequestSent && !providerResponseReceived;
    const persistenceFailure = !malformedExhausted && !partialRecordsPersisted
      && providerResponseReceived && persistenceStarted;
    const processingFailure = !malformedExhausted && providerResponseReceived && !persistenceStarted;
    const terminalHealth = malformedExhausted ? 'provider_response_malformed'
      : preRequestInternalFailure ? 'internal_error'
        : providerFailure ? 'provider_failure'
          : persistenceFailure ? 'persistence_failure' : 'processing_failure';
    const attentionReason = malformedExhausted ? 'unparseable_provider_response'
      : preRequestInternalFailure ? 'pre_request_internal_error'
        : providerFailure ? 'provider_failure'
          : persistenceFailure ? 'persistence_failure' : 'post_response_processing_failure';
    if (sessionDiagnostics) {
      if (malformedExhausted) {
        sessionDiagnostics.malformedRecoveryExhausted = (sessionDiagnostics.malformedRecoveryExhausted ?? 0) + 1;
        sessionDiagnostics.parserFailures = (sessionDiagnostics.parserFailures ?? 0) + 1;
      } else if (providerFailure) sessionDiagnostics.providerFailures = (sessionDiagnostics.providerFailures ?? 0) + 1;
      else if (persistenceFailure) sessionDiagnostics.persistenceFailures = (sessionDiagnostics.persistenceFailures ?? 0) + 1;
      else sessionDiagnostics.internalFailures = (sessionDiagnostics.internalFailures ?? 0) + 1;
      // A request can fail after its initial response was parsed (for example,
      // during embedding verification). Give every affected parsed candidate
      // a terminal outcome so diagnostics still reconcile exactly.
      recordDisposition('provider_or_parser_error', Math.max(0, parsedCandidateCount - terminalCandidateCount));
    }
    if (!err?.sme_live_health_finished) healthFinish({
      terminal_health: terminalHealth,
      provider_outcome: malformedExhausted ? 'bounded_malformed_recovery_exhausted'
        : preRequestInternalFailure ? 'request_not_sent_internal_error'
          : providerFailure ? 'provider_failure'
            : providerResponseReceived ? 'response_received' : 'request_not_sent',
      parser_outcome: malformedExhausted ? 'bounded_recovery_exhausted'
        : processingFailure ? 'post_response_processing_failed' : undefined,
      persistence: partialRecordsPersisted ? 'partial_valid_records_saved_obligation_pending'
        : persistenceFailure ? 'failed' : 'preserved',
      attention_reason_codes: [attentionReason],
    });
    console.error('[Smart Memory Enhanced] Session extraction failed:', err);
    throw err;
  }
}

// ---- Consolidation ------------------------------------------------------

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type. Used when per-type settings are absent.
const DEFAULT_SESSION_CONSOLIDATION_THRESHOLDS = {
  scene: 3,
  revelation: 3,
  development: 3,
  detail: 3,
};

/**
 * Returns per-type consolidation thresholds, reading from settings with fallback to defaults.
 *
 * @param {object} settings - Extension settings object.
 * @returns {{ scene: number, revelation: number, development: number, detail: number }}
 */
function getSessionConsolidationThresholds(settings) {
  return {
    scene: Math.max(
      2,
      settings.session_consolidation_threshold_scene ??
        DEFAULT_SESSION_CONSOLIDATION_THRESHOLDS.scene,
    ),
    revelation: Math.max(
      2,
      settings.session_consolidation_threshold_revelation ??
        DEFAULT_SESSION_CONSOLIDATION_THRESHOLDS.revelation,
    ),
    development: Math.max(
      2,
      settings.session_consolidation_threshold_development ??
        DEFAULT_SESSION_CONSOLIDATION_THRESHOLDS.development,
    ),
    detail: Math.max(
      2,
      settings.session_consolidation_threshold_detail ??
        DEFAULT_SESSION_CONSOLIDATION_THRESHOLDS.detail,
    ),
  };
}

/**
 * Runs a consolidation pass on session memories for the current chat.
 *
 * Maintains a stable consolidated base per session memory type. When enough
 * unprocessed entries accumulate for a given type, the model evaluates only
 * that batch against the base - it may drop duplicates, fold new details into
 * existing base entries, or add genuinely new entries. The base is never
 * rewritten, only extended.
 *
 * Fires per-type independently - a burst of new [scene] entries does not
 * trigger [detail] consolidation.
 *
 * @param {boolean} [force=false] - If true, consolidate all types regardless of threshold.
 *   Used by the catch-up final pass to flush any entries that never accumulated enough
 *   to hit the threshold during per-chunk consolidation.
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the write is skipped (chat switched).
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateSessionMemories(force = false, abortCheck = null) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) return 0;
  if (!settings.consolidation_enabled) return 0;
  const thresholds = getSessionConsolidationThresholds(settings);

  const memories = loadSessionMemories();
  let totalRemoved = 0;
  let dirty = false;

  for (const type of SESSION_TYPES) {
    // Exclude retired memories from consolidation - they've already been replaced.
    const base = memories.filter((m) => m.type === type && m.consolidated && !m.superseded_by && isGrounded(m));
    const unprocessed = memories.filter(
      (m) => m.type === type && !m.consolidated && !m.superseded_by && isGrounded(m),
    );

    if (!force && unprocessed.length < (thresholds[type] ?? 3)) continue;
    if (unprocessed.length === 0) continue;

    try {
      const baseText = base.map((m) => `[${m.type}] ${m.content}`).join('\n');
      const batchText = unprocessed.map((m) => `[${m.type}] ${m.content}`).join('\n');

      const response = await generateMemoryExtract(
        applyPromptOverride(buildSessionConsolidationPrompt(type, baseText, batchText), PROMPT_TASKS.SESSION_EXTRACTION),
        { responseLength: Math.max(400, (base.length + unprocessed.length) * 60) },
      );

      smLog(`[Smart Memory Enhanced] Session consolidation response for [${type}]:`, response);

      if (!response || response.trim().toUpperCase() === 'NONE') {
        // Nothing to add - mark unprocessed as consolidated as-is.
        unprocessed.forEach((m) => (m.consolidated = true));
        dirty = true;
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseSessionOutput(response);
      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = await reconcileTypeEntries(
        base,
        promoted,
        0.65,
        [...base, ...unprocessed],
        getEmbeddingBatch,
      );

      // Consolidation candidates are ephemeral.  Preserve their evidence on
      // the surviving records, but never leave a parent ID that disappears
      // when the type bucket is replaced.
      const allInputs = [...base, ...unprocessed];
      const otherTypes = memories.filter((m) => m.type !== type);
      const finalStore = [...otherTypes, ...reconciledType];
      for (const entry of reconciledType) {
        const match = allInputs.find((memory) => memory.id === entry.id);
        flattenConsolidationProvenance(entry, match ? [match] : allInputs.filter(isGrounded), finalStore);
        validateGeneratedRecord(entry, { parentStore: finalStore });
      }

      // Replace this type's entries. Other types are untouched.
      memories.splice(0, memories.length, ...otherTypes, ...reconciledType);

      const before = base.length + unprocessed.length;
      const after = reconciledType.length;
      const removed = before - after;
      totalRemoved += Math.max(0, removed);
      dirty = true;

      smLog(
        `[Smart Memory Enhanced] Session [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[Smart Memory Enhanced] Session consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      // Set dirty before the forEach so a mid-loop error still triggers the save.
      dirty = true;
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const max = settings.session_max_memories ?? 30;
  const finalMemories = sortByTimeline(trimByPriority(memories, max));
  if (dirty || finalMemories.length !== memories.length) {
    if (abortCheck?.()) return totalRemoved;
    // Repair session entity registry links - same stale-ID problem as long-term:
    // consolidation replaces memories with new IDs, orphaning the registry.
    const entityRegistry = loadSessionEntityRegistry();
    if (entityRegistry.length > 0) {
      reconcileEntityRegistry(entityRegistry, finalMemories);
      await saveSessionEntityRegistry(entityRegistry);
    }

    await saveSessionMemories(finalMemories);
  }

  return totalRemoved;
}

// ---- Injection ----------------------------------------------------------

/**
 * Formats the session memory array as plain bullet lines for RP prompt injection.
 * The [type] format is kept internally for the extraction/consolidation pipeline
 * (see the inline formatters in extractSessionMemories and consolidateSessionMemories).
 * Using plain bullets here prevents bracket notation from bleeding into story output.
 * @param {Array<{type: string, content: string}>} memories
 * @returns {string}
 */
function formatSessionMemories(memories) {
  if (!memories || memories.length === 0) return '';
  return sortByTimeline(memories)
    .map((m) => `- ${m.content}`)
    .join('\n');
}

/**
 * Injects session memories into the prompt via setExtensionPrompt.
 * Clears the slot if session memory is disabled or no memories exist.
 * @param {boolean} [updateTelemetry=false] - If true, increment retrieval_count for injected memories.
 *   Only pass true from the post-extraction path (one real AI response turn).
 * @returns {Promise<void>}
 */
export async function injectSessionMemories(updateTelemetry = false) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.session_enabled) {
    setMacroContent(MACRO_NAMES.session, '');
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SESSION);
    return;
  }

  // Only inject active memories - retired ones (superseded_by set) are kept in
  // storage for history but must not appear in the prompt.
  const memories = loadSessionMemories().filter(
    (m) => !m.superseded_by && isGrounded(m),
  );
  if (memories.length === 0) {
    setMacroContent(MACRO_NAMES.session, '');
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SESSION);
    return;
  }

  // Trim to token budget using hybrid scoring on real AI turns, plain utility
  // scoring on chat load (no "current turn" to extract entity mentions from).
  const budget = settings.session_inject_budget ?? 400;
  const fullTokens = estimateTokens(formatSessionMemories(memories));
  const protectedSet = new Set(selectProtectedMemories(memories, ['development', 'scene']));

  let trimmed;
  if (updateTelemetry) {
    const context = getContext();
    const lastMessages = (context.chat ?? []).slice(-2);
    const turnMentions = extractTurnEntityMentions(lastMessages);
    trimmed = await hybridPrioritize(memories, {
      turnMentions,
      floorTypes: ['development', 'scene'],
      embedFn: getEmbeddingBatch,
      lastTurnText: lastMessages[lastMessages.length - 1]?.mes ?? '',
      w5: getHardwareProfile() === 'b' ? 0.6 : 0.2,
    });
  } else {
    trimmed = prioritizeMemories(memories);
  }
  while (trimmed.length > 1 && estimateTokens(formatSessionMemories(trimmed)) > budget) {
    let idx = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (!protectedSet.has(trimmed[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) trimmed.splice(idx, 1);
    else break;
  }

  // Only update retrieval telemetry when called from a real AI response turn.
  // Load the full (unfiltered) array so retired memories are preserved - the
  // filtered 'memories' variable only contains active entries and saving it
  // would permanently delete the retired pool.
  if (updateTelemetry) {
    const recalled = new Set(trimmed.map((m) => `${m.type}|${m.content}`));
    const allMemories = loadSessionMemories();
    const updated = allMemories.map((m) => {
      if (m.superseded_by) return m;
      const key = `${m.type}|${m.content}`;
      if (!recalled.has(key)) return m;
      return {
        ...m,
        retrieval_count: (m.retrieval_count ?? 0) + 1,
        last_confirmed_ts: Date.now(),
      };
    });
    await saveSessionMemories(updated);
  }

  const template = settings.session_template ?? 'Details from this session:\n{{session}}';
  const sessionBlock = template.replace('{{session}}', formatSessionMemories(trimmed));
  const sceneStateBlock = buildCurrentSceneStateBlock(trimmed);
  const content = sceneStateBlock ? `${sceneStateBlock}\n${sessionBlock}` : sessionBlock;
  reportTierTrimStats(PROMPT_KEY_SESSION, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.session, content);
  if (isMacroActive(MACRO_NAMES.session)) {
    setExtensionPrompt(PROMPT_KEY_SESSION, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SESSION);
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_SESSION,
    content,
    settings.session_position ?? extension_prompt_types.IN_PROMPT,
    settings.session_depth ?? 3,
    false,
    settings.session_role ?? extension_prompt_roles.SYSTEM,
  );
}
