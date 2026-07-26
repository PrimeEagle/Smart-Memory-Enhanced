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
 * Scene break detection and scene history management.
 *
 * Detects when a scene ends - via regex heuristics (default) or an AI yes/no
 * call (optional, off by default) - then generates a mini-summary of the
 * completed scene and appends it to the per-chat scene history in chatMetadata.
 *
 * detectSceneBreakHeuristic  - pattern-based scene break check (cheap, no model call); includes dawn/sleep/wake patterns
 * detectSceneBreakAI         - AI yes/no check for scene breaks; used when scene_ai_detect is enabled
 * loadSceneHistory           - returns the stored scene history array
 * saveSceneHistory           - persists the scene history array to chatMetadata
 * clearSceneHistory          - empties scene history for the current chat
 * summarizeScene             - generates a 2-3 sentence mini-summary of a scene
 * sceneSimilarity            - returns {score, semantic} between two scene summary strings
 * processSceneBreak          - orchestrates detection + summarization + dedup + storage
 * linkMemoriesToLastScene    - attaches memory ids to the most recent scene entry
 * injectSceneHistory         - pushes scene history into the prompt via setExtensionPrompt
 * getSceneParticipants       - derives the set of named characters present in a message window
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { applyPromptOverride, PROMPT_TASKS } from './prompt-config.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { saveChatMetadata } from './catchup-transaction.js';
import { estimateTokens, generateMemoryId, MODULE_NAME, META_KEY, PROMPT_KEY_SCENES } from './constants.js';
import { buildSceneDetectPrompt, buildSceneDetectBatchPrompt, buildSceneDetectBatchRepairPrompt, buildSceneSummaryPrompt } from './prompts.js';
import { detectSceneBreakHeuristic, parseSceneSummaryOutput } from './parsers.js';
import { smLog } from './logging.js';
import { getEmbeddingBatch, cosineSimilarity } from './embeddings.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import { normalizeSceneRecord, selectScenesForInjection, trimSceneArchive } from './scene-archive-utils.js';
import { isGeneratedRecordApproved, validateGeneratedRecord } from './record-validation.js';
import { loadCharacterEntityRegistry, recordIdentityReviewCandidate, resolveEntityNames, saveCharacterEntityRegistry } from './graph-migration.js';
import { buildCanonicalCharacterRoster, canonicalizeNarrativeNames, canonicalizeStructuredParticipants, deduplicateIdentityDecisions, findCanonicalParticipantsInText, formatCanonicalRosterForPrompt } from './canonical-entities.js';

// Re-export so index.js can import directly from scenes.js as before.
export { detectSceneBreakHeuristic };

// ---- Deduplication ------------------------------------------------------

/**
 * Jaccard word-overlap similarity between two scene summary strings.
 * Used as a fallback when embeddings are unavailable.
 * @param {string} a
 * @param {string} b
 * @returns {number} Similarity in [0, 1].
 */
function sceneJaccard(a, b) {
  const aWords = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const bWords = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let intersection = 0;
  for (const w of aWords) if (bWords.has(w)) intersection++;
  return intersection / (aWords.size + bWords.size - intersection);
}

/**
 * Semantic similarity between two scene summary strings.
 * Uses embeddings when available and falls back to Jaccard.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<{score: number, semantic: boolean}>}
 */
export async function sceneSimilarity(a, b) {
  const aText = String(a ?? '');
  const bText = String(b ?? '');
  const aKey = aText.toLowerCase().trim();
  const bKey = bText.toLowerCase().trim();
  try {
    const vectorMap = await getEmbeddingBatch([aKey, bKey]);
    const aVec = vectorMap.get(aKey);
    const bVec = vectorMap.get(bKey);
    if (aVec && bVec) {
      return { score: cosineSimilarity(aVec, bVec), semantic: true };
    }
  } catch (err) {
    // Scene deduplication is useful but never worth losing a multi-hour
    // catch-up run. The deterministic text fallback below remains safe.
    console.warn('[Smart Memory Enhanced] Scene similarity embeddings unavailable; using text fallback.', err);
  }
  return { score: sceneJaccard(aText, bText), semantic: false };
}

// ---- Heuristics ---------------------------------------------------------

/**
 * Asks the model whether the message contains a scene break.
 * More accurate than the heuristic but costs one model call per message.
 * Only used when scene_ai_detect is enabled in settings.
 * @param {string} messageText - The last AI message to inspect.
 * @param {string} [previousMessageText] - The preceding AI message for context.
 * @returns {Promise<boolean>}
 */
export async function detectSceneBreakAI(messageText, previousMessageText, onError = null) {
  try {
    const prompt = buildSceneDetectPrompt(messageText, previousMessageText);
    const response = await generateMemoryExtract(applyPromptOverride(prompt, PROMPT_TASKS.SCENE_SUMMARY), { responseLength: 5 });
    return response?.trim().toUpperCase().startsWith('YES') ?? false;
  } catch (err) {
    console.error('[Smart Memory Enhanced] AI scene break detection failed:', err);
    onError?.(err);
    return false;
  }
}

/** Evaluates multiple stable boundary candidates in one provider request. */
export async function detectSceneBreakAIBatch(candidates, options = {}) {
  const result = new Map();
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize ?? 12)));
  const lineage = options.lineage ?? { next_attempt_id: 1 };
  const diagnostics = { requests_sent: 0, batched_requests: 0, malformed_batches: 0, retried_batches: 0, repair_requests_sent: 0, repair_requests_succeeded: 0, repair_failures: 0, smaller_batch_retries: 0, fallback_boundaries: 0, initial_batch_requests: 0, partial_retry_requests: 0, single_candidate_retry_requests: 0, format_repair_requests: 0, total_provider_requests: 0, multi_candidate_requests: 0, adaptive_batch_adjustments: [], boundary_confidences: {}, batch_attempts: [], candidate_dispositions: [] };
  const parseBatch = (raw, requestedIds) => {
    const original = String(raw ?? '');
    const codeFencePresent = /^\s*```/m.test(original);
    let normalized = original.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const first = normalized.search(/[\[{]/); const last = Math.max(normalized.lastIndexOf('}'), normalized.lastIndexOf(']'));
    const leading = first > 0; const trailing = last >= 0 && last < normalized.length - 1; if (first >= 0 && last >= first) normalized = normalized.slice(first, last + 1);
    let value;
    let recoveredLegacyLines = false;
    try {
      value = JSON.parse(normalized);
    } catch {
      // Some local models follow the former line-oriented contract despite the
      // JSON instruction. Recover only fully-addressed, confidence-bearing
      // decisions; everything else remains candidate-local fallback below.
      const legacy = [...original.matchAll(/^\s*\[\s*(\d+)\s*\]\s*[:\-]?\s*(YES|NO|TRUE|FALSE)\b[^\n]*?\b(?:confidence|conf)\s*[=:]?\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/gim)]
        .map((match) => ({ candidate_id: Number(match[1]), break: /^(?:YES|TRUE)$/i.test(match[2]), confidence: Number(match[3]) }));
      if (!legacy.length) return { ok: false, raw_output_length: original.length, normalized_output_length: normalized.length, parser_path: ['trim', leading ? 'strip_preamble' : 'direct_json'], parse_error_code: 'invalid_json', top_level_shape: 'unrecognized', code_fence_present: codeFencePresent, leading_text_present: leading, trailing_text_present: trailing, first_keys: [] };
      value = { decisions: legacy };
      recoveredLegacyLines = true;
    }
    const decisions = Array.isArray(value) ? value : value?.decisions;
    if (!Array.isArray(decisions)) return { ok: false, raw_output_length: original.length, normalized_output_length: normalized.length, parser_path: ['json'], parse_error_code: 'missing_decisions_array', top_level_shape: Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'object' : typeof value, code_fence_present: codeFencePresent, leading_text_present: leading, trailing_text_present: trailing, first_keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 5) : [] };
    const requested = new Set(requestedIds); const valid = new Map(); const duplicates = []; const unknown = []; let invalid = 0;
    for (const item of decisions) {
      const id = Number(item?.candidate_id ?? item?.id); const flag = item?.break ?? item?.is_break ?? item?.scene_break;
      const bool = flag === true || flag === 'true' || flag === 'TRUE'; const no = flag === false || flag === 'false' || flag === 'FALSE'; const confidenceProvided = item && Object.prototype.hasOwnProperty.call(item, 'confidence'); const confidence = confidenceProvided ? Number(item.confidence) : null;
      if (!Number.isInteger(id) || !requested.has(id)) { unknown.push(item?.candidate_id ?? item?.id ?? null); invalid++; continue; }
      if (valid.has(id)) { duplicates.push(id); invalid++; continue; }
      if ((!bool && !no) || (confidenceProvided && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) { invalid++; continue; }
      valid.set(id, { decision: bool, confidence, confidence_missing: !confidenceProvided });
    }
    const missing = requestedIds.filter((id) => !valid.has(id));
    return { ok: true, valid, raw_output_length: original.length, normalized_output_length: normalized.length, parser_path: [recoveredLegacyLines ? 'legacy_indexed_lines' : leading ? 'strip_preamble' : 'direct_json', Array.isArray(value) ? 'wrap_array' : 'canonical_object'], candidate_ids_returned: decisions.map((item) => item?.candidate_id ?? item?.id ?? null), valid_decision_count: valid.size, invalid_decision_count: invalid, missing_candidate_ids: missing, duplicate_candidate_ids: duplicates, unknown_candidate_ids: unknown, reordered_ids: JSON.stringify([...valid.keys()]) !== JSON.stringify(requestedIds.filter((id) => valid.has(id))), truncated_output_suspected: missing.length > 0 && original.length > 20, top_level_shape: recoveredLegacyLines ? 'legacy_lines' : Array.isArray(value) ? 'array' : 'object', code_fence_present: codeFencePresent, leading_text_present: leading, trailing_text_present: trailing, first_keys: decisions[0] && typeof decisions[0] === 'object' ? Object.keys(decisions[0]).slice(0, 5) : [] };
  };
  let adaptiveBatchSize = batchSize;
  let consecutiveFullBatches = 0;
  for (let offset = 0; offset < candidates.length;) {
    const batch = candidates.slice(offset, offset + adaptiveBatchSize);
    const attemptType = options.attempt_type ?? 'initial_batch';
    const requestAttemptId = lineage.next_attempt_id++;
    const attempt = { batch_number: diagnostics.batch_attempts.filter((item) => item.attempt_type !== 'format_repair').length + 1, request_attempt_id: requestAttemptId, root_batch_id: options.root_batch_id ?? requestAttemptId, parent_attempt_id: options.parent_attempt_id ?? null, attempt_type: attemptType, split_depth: Number(options.split_depth ?? 0), candidate_ids_requested: batch.map((candidate) => candidate.candidate_index), candidate_count_requested: batch.length, requested_output_budget: Math.max(128, batch.length * 32), estimated_required_output_tokens: 32 + (batch.length * 24), request_completed: false, provider_error: null, returned_none: false, format_repair_attempted: false, format_repair_succeeded: false };
    try {
      diagnostics.requests_sent++;
      diagnostics.total_provider_requests++;
      if (attemptType === 'initial_batch') diagnostics.initial_batch_requests++;
      else if (attemptType === 'partial_missing_retry') diagnostics.partial_retry_requests++;
      else if (attemptType === 'single_candidate_retry') diagnostics.single_candidate_retry_requests++;
      if (batch.length > 1) diagnostics.multi_candidate_requests++;
      if (batch.length > 1) diagnostics.batched_requests++;
      // JSON needs enough space for every ID, boolean, and confidence. The
      // former 16-token allowance frequently cut off confidence fields or all
      // but the first item from local-model responses.
      const responseBudget = attempt.requested_output_budget;
      const response = await generateMemoryExtract(applyPromptOverride(buildSceneDetectBatchPrompt(batch), PROMPT_TASKS.SCENE_SUMMARY), { responseLength: responseBudget, temperature: 0 });
      attempt.request_completed = true; if (!response) { attempt.returned_none = true; throw new Error('Empty scene-boundary batch response.'); }
      let parsed = parseBatch(response, attempt.candidate_ids_requested); Object.assign(attempt, parsed);
      if (!parsed.ok) {
        // One formatting-only retry is intentionally bounded. It receives the
        // model's own malformed response and IDs, never the source chat again.
        attempt.format_repair_attempted = true;
        diagnostics.retried_batches++; diagnostics.repair_requests_sent++; diagnostics.requests_sent++; diagnostics.format_repair_requests++; diagnostics.total_provider_requests++;
        const repairAttempt = { request_attempt_id: lineage.next_attempt_id++, root_batch_id: attempt.root_batch_id, parent_attempt_id: attempt.request_attempt_id, attempt_type: 'format_repair', split_depth: attempt.split_depth, candidate_ids_requested: attempt.candidate_ids_requested, candidate_count_requested: batch.length, request_completed: false, provider_error: null, returned_none: false };
        try {
          const repaired = await generateMemoryExtract(applyPromptOverride(buildSceneDetectBatchRepairPrompt(response, attempt.candidate_ids_requested), PROMPT_TASKS.SCENE_SUMMARY), { responseLength: responseBudget, temperature: 0 });
          repairAttempt.request_completed = true;
          const repairedParsed = parseBatch(repaired, attempt.candidate_ids_requested);
          if (repairedParsed.ok) {
            parsed = repairedParsed; Object.assign(attempt, repairedParsed);
            attempt.format_repair_succeeded = true; diagnostics.repair_requests_succeeded++; repairAttempt.terminal_outcome = 'parsed_full';
          } else { diagnostics.repair_failures++; repairAttempt.terminal_outcome = 'malformed'; }
        } catch (error) { diagnostics.repair_failures++; repairAttempt.provider_error = String(error?.message ?? error); repairAttempt.terminal_outcome = 'provider_error'; }
        diagnostics.batch_attempts.push(repairAttempt);
      }
      if (!parsed.ok) throw new Error(parsed.parse_error_code);
      let smallerRetry = null;
      if (parsed.truncated_output_suspected && parsed.missing_candidate_ids.length && batch.length > 1) {
        const missingCandidates = batch.filter((candidate) => parsed.missing_candidate_ids.includes(candidate.candidate_index));
        diagnostics.smaller_batch_retries++;
        // Retrying only the missing tail with a smaller batch limits extra work
        // and avoids discarding decisions already validated from this response.
        smallerRetry = await detectSceneBreakAIBatch(missingCandidates, { batchSize: Math.max(1, Math.floor(batch.length / 2)), onError: options.onError, lineage, root_batch_id: attempt.root_batch_id, parent_attempt_id: attempt.request_attempt_id, split_depth: attempt.split_depth + 1, attempt_type: missingCandidates.length === 1 ? 'single_candidate_retry' : 'partial_missing_retry' });
        for (const [candidateId, decision] of smallerRetry.decisions) parsed.valid.set(candidateId, { decision, confidence: smallerRetry.diagnostics.boundary_confidences[candidateId] ?? null, retried: true });
        parsed.missing_candidate_ids = parsed.missing_candidate_ids.filter((candidateId) => !parsed.valid.has(candidateId));
        parsed.valid_decision_count = parsed.valid.size;
        for (const key of ['requests_sent', 'batched_requests', 'malformed_batches', 'retried_batches', 'repair_requests_sent', 'repair_requests_succeeded', 'repair_failures', 'smaller_batch_retries', 'fallback_boundaries', 'initial_batch_requests', 'partial_retry_requests', 'single_candidate_retry_requests', 'format_repair_requests', 'total_provider_requests', 'multi_candidate_requests']) diagnostics[key] += smallerRetry.diagnostics[key] ?? 0;
        Object.assign(diagnostics.boundary_confidences, smallerRetry.diagnostics.boundary_confidences);
        diagnostics.batch_attempts.push(...smallerRetry.diagnostics.batch_attempts);
        diagnostics.adaptive_batch_adjustments.push(...(smallerRetry.diagnostics.adaptive_batch_adjustments ?? []).map((adjustment) => ({
          ...adjustment,
          inherited_from_retry: true,
          root_batch_id: attempt.root_batch_id,
        })));
      }
      for (const candidate of batch) {
        const decision = parsed.valid.get(candidate.candidate_index);
        if (decision) { const retryDisposition = smallerRetry?.diagnostics.candidate_dispositions.find((item) => item.candidate_id === candidate.candidate_index); const source = decision.retried ? (retryDisposition?.source === 'heuristic-fallback' ? 'heuristic-fallback' : 'ai-batch-recovered') : 'ai-batch'; result.set(candidate.candidate_index, decision.decision); if (decision.confidence !== null) diagnostics.boundary_confidences[candidate.candidate_index] = decision.confidence; diagnostics.candidate_dispositions.push({ candidate_id: candidate.candidate_index, decision: decision.decision, source, ai_confidence: decision.confidence, confidence_missing: decision.confidence_missing ?? (decision.confidence === null), heuristic_score: retryDisposition?.heuristic_score ?? null, ai_result_disposition: retryDisposition?.ai_result_disposition ?? null, batch_number: attempt.batch_number, terminal_disposition: source === 'heuristic-fallback' ? (decision.decision ? 'fallback_break' : 'fallback_no_break') : decision.decision ? 'ai_break' : 'ai_no_break' }); }
        else { const fallback = detectSceneBreakHeuristic(candidate.message); const missing = parsed.missing_candidate_ids.includes(candidate.candidate_index); result.set(candidate.candidate_index, fallback); diagnostics.fallback_boundaries++; diagnostics.candidate_dispositions.push({ candidate_id: candidate.candidate_index, decision: fallback, source: 'heuristic-fallback', ai_confidence: null, heuristic_score: null, ai_result_disposition: missing ? 'missing_ai_decision' : 'invalid_ai_decision', batch_number: attempt.batch_number, terminal_disposition: fallback ? 'fallback_break' : 'fallback_no_break' }); }
      }
      attempt.terminal_outcome = smallerRetry ? 'recovered_after_smaller_batch_retry' : attempt.format_repair_succeeded ? 'recovered_after_repair_request' : parsed.parser_path?.includes('legacy_indexed_lines') ? 'recovered_after_normalization' : parsed.missing_candidate_ids.length ? 'parsed_partial' : 'parsed_full';
    } catch (error) {
      if (!attempt.provider_error && !attempt.returned_none) diagnostics.malformed_batches++;
      attempt.provider_error = attempt.request_completed ? null : String(error?.message ?? error);
      attempt.terminal_outcome = attempt.returned_none ? 'returned_none_all_fallback' : attempt.provider_error ? 'provider_error_all_fallback' : 'malformed_all_fallback';
      for (const candidate of batch) {
        diagnostics.fallback_boundaries++;
        const fallback = detectSceneBreakHeuristic(candidate.message); result.set(candidate.candidate_index, fallback);
        diagnostics.candidate_dispositions.push({ candidate_id: candidate.candidate_index, decision: fallback, source: 'heuristic-fallback', ai_confidence: null, heuristic_score: null, ai_result_disposition: attempt.provider_error ? 'provider_error_fallback' : attempt.returned_none ? 'missing_ai_decision' : 'invalid_ai_decision', batch_number: attempt.batch_number, terminal_disposition: fallback ? 'fallback_break' : 'fallback_no_break' });
      }
      options.onError?.(error, batch);
    }
    diagnostics.batch_attempts.push(attempt);
    offset += batch.length;
    const wasPartial = Boolean(attempt.truncated_output_suspected || attempt.terminal_outcome === 'parsed_partial' || attempt.terminal_outcome === 'recovered_after_smaller_batch_retry');
    if (wasPartial && adaptiveBatchSize > 4) {
      const previous = adaptiveBatchSize;
      adaptiveBatchSize = Math.max(4, Math.min(8, Math.floor(adaptiveBatchSize / 2)));
      consecutiveFullBatches = 0;
      diagnostics.adaptive_batch_adjustments.push({ reason: 'partial_or_truncated_response', previous_batch_size: previous, next_batch_size: adaptiveBatchSize });
    } else if (!wasPartial && attempt.terminal_outcome === 'parsed_full') {
      consecutiveFullBatches++;
      if (consecutiveFullBatches >= 3 && adaptiveBatchSize < batchSize) {
        const previous = adaptiveBatchSize;
        adaptiveBatchSize = Math.min(batchSize, adaptiveBatchSize + 2);
        consecutiveFullBatches = 0;
        diagnostics.adaptive_batch_adjustments.push({ reason: 'three_full_batches', previous_batch_size: previous, next_batch_size: adaptiveBatchSize });
      }
    }
  }
  const rootAttempts = diagnostics.batch_attempts.filter((item) => item.attempt_type === 'initial_batch');
  diagnostics.root_batch_summary = {
    root_batches_total: rootAttempts.length,
    root_batches_full_first_try: rootAttempts.filter((item) => item.terminal_outcome === 'parsed_full').length,
    root_batches_partial: rootAttempts.filter((item) => item.truncated_output_suspected || item.terminal_outcome === 'parsed_partial' || item.terminal_outcome === 'recovered_after_smaller_batch_retry').length,
    root_batches_repaired: rootAttempts.filter((item) => item.format_repair_attempted).length,
    root_batches_provider_error: rootAttempts.filter((item) => item.terminal_outcome === 'provider_error_all_fallback').length,
    root_batches_malformed: rootAttempts.filter((item) => item.terminal_outcome === 'malformed_all_fallback').length,
    root_batches_all_fallback: rootAttempts.filter((item) => /all_fallback$/.test(item.terminal_outcome ?? '')).length,
    candidates_evaluated: candidates.length,
    maximum_split_depth: Math.max(0, ...diagnostics.batch_attempts.map((item) => Number(item.split_depth ?? 0))),
    average_attempts_per_root_batch: rootAttempts.length ? Number((diagnostics.total_provider_requests / rootAttempts.length).toFixed(2)) : 0,
  };
  return { decisions: result, diagnostics };
}

// ---- Storage ------------------------------------------------------------

/**
 * Returns the scene history array for the current chat.
 * @returns {Array<{summary: string, ts: number}>}
 */
export function loadSceneHistory() {
  const context = getContext();
  return (context.chatMetadata?.[META_KEY]?.sceneHistory ?? []).map((scene) => normalizeSceneRecord(scene, generateMemoryId));
}

/**
 * Creates a scene record with stable source indices from the active chat.
 * Catch-up messages retain their original index on a non-persisted property;
 * normal chat messages are resolved directly against the current chat.
 */
export function createSceneRecord(summary, messages = [], details = {}) {
  const context = getContext();
  const roster = buildCanonicalCharacterRoster(context);
  const sourceMessageIndices = messages
    .map((message) => Number.isInteger(message.__sme_original_index)
      ? message.__sme_original_index
      : context.chat?.indexOf(message))
    .filter((index) => Number.isInteger(index) && index >= 0);
  const participantResolution = canonicalizeStructuredParticipants(
    details.character_participants,
    roster,
  );
  // A structured [CHARACTERS] list can be omitted by local models even when
  // a known card/persona is named plainly in the scene. Repair only those
  // roster-backed mentions; never infer an unknown NPC from free prose.
  const narrativeParticipants = findCanonicalParticipantsInText(summary, roster);
  const participantReferences = [...participantResolution.references, ...narrativeParticipants.references]
    .filter((reference, index, entries) => entries.findIndex((candidate) => candidate.entity_id === reference.entity_id && candidate.display_name_at_time === reference.display_name_at_time) === index);
  const narrativeResolution = canonicalizeNarrativeNames(summary, roster, { preserveHistoricalPersonaNames: true });
  const record = normalizeSceneRecord({
    id: generateMemoryId(),
    summary: narrativeResolution.text,
    ts: Date.now(),
    source_memory_ids: [],
    source_message_indices: sourceMessageIndices,
    ...details,
    character_participants: [...new Set([...participantResolution.names, ...narrativeParticipants.names])],
    participant_references: participantReferences,
    identity_rejections: deduplicateIdentityDecisions([...(details.identity_rejections ?? []), ...participantResolution.rejected], 'scene'),
    identity_replacements: deduplicateIdentityDecisions([...(details.identity_replacements ?? []), ...narrativeResolution.replacements], 'scene'),
  }, generateMemoryId);
  for (const rejection of record.identity_rejections ?? []) {
    recordIdentityReviewCandidate({
      status: 'rejected',
      candidateName: rejection.name,
      canonicalName: rejection.canonicalName,
      canonicalId: rejection.canonicalId,
      reason: `Scene participant: ${rejection.reason}`,
    }, { memoryId: record.id, entityType: 'character' });
  }
  return record;
}

/**
 * Persists the scene history array to chatMetadata.
 * @param {Array<{summary: string, ts: number}>} scenes
 */
export async function saveSceneHistory(scenes) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  const max = extension_settings[MODULE_NAME]?.scene_archive_max ?? 100;
  const metadata = context.chatMetadata[META_KEY];
  const previous = metadata.sceneHistory;
  const staged = trimSceneArchive(scenes.map((scene) => {
    const normalized = normalizeSceneRecord(scene, generateMemoryId);
    if (normalized.detected_by !== 'legacy') validateGeneratedRecord(normalized);
    return normalized;
  }), max);
  metadata.sceneHistory = staged;
  try {
    await saveChatMetadata(context);
  } catch (error) {
    // Do not leave a failed scene save visible as if it were committed.
    metadata.sceneHistory = previous;
    throw error;
  }
}

/**
 * Empties scene history for the current chat.
 */
export async function clearSceneHistory() {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    context.chatMetadata[META_KEY].sceneHistory = [];
    await saveChatMetadata(context);
  }
}

/**
 * Derives the set of named characters present in a message window.
 * Includes the AI character and any named user personas; excludes system messages.
 *
 * Note: NPCs invented mid-scene appear only in prose, not as message senders, so
 * they will not appear in this list. The extraction model reads the full prose and
 * catches them regardless - this list is a participant hint, not an exhaustive registry.
 *
 * @param {Object[]} messages - Chat message objects.
 * @returns {string[]} Deduplicated array of character names.
 */
export function getSceneParticipants(messages) {
  const names = new Set();
  for (const m of messages) {
    if (m.is_system) continue;
    if (m.name) names.add(m.name);
  }
  return [...names];
}

// ---- Scene summary ------------------------------------------------------

/**
 * Generates a 2-3 sentence narrative mini-summary of the messages in a completed scene.
 * The summary is stored in scene history and later injected as past-scene context.
 * @param {Array} sceneMessages - Message objects from the completed scene.
 * @returns {Promise<string|null>} The summary text, or null if generation failed.
 */
export async function summarizeScene(sceneMessages) {
  const settings = extension_settings[MODULE_NAME];
  try {
    const sceneText = sceneMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!sceneText.trim()) return null;

    // Truncate to 2000 chars to keep the prompt cost reasonable on local hardware.
    const roster = buildCanonicalCharacterRoster(getContext());
    const prompt = buildSceneSummaryPrompt(sceneText.slice(0, 2000), formatCanonicalRosterForPrompt(roster));

    const response = await generateMemoryExtract(applyPromptOverride(prompt, PROMPT_TASKS.SCENE_SUMMARY), {
      responseLength: settings.scene_summary_length ?? 200,
    });

    return parseSceneSummaryOutput(response);
  } catch (err) {
    console.error('[Smart Memory Enhanced] Scene summary failed:', err);
    throw err;
  }
}

// ---- Orchestration ------------------------------------------------------

/**
 * Checks the latest message for a scene break and, if found, summarizes
 * the completed scene and appends it to scene history.
 *
 * Uses AI detection if scene_ai_detect is enabled, otherwise heuristics.
 * Archives scenes independently from the smaller injected-scene subset.
 *
 * @param {string} lastMessageText - Text of the last AI message.
 * @param {Array} recentMessages - Messages accumulated since the last scene break.
 * @param {string} [previousAiMessage] - The preceding AI message for context (AI detection only).
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the write is skipped (chat switched).
 * @returns {Promise<boolean>} True if a scene break was detected and processed.
 */
export async function processSceneBreak(
  lastMessageText,
  recentMessages,
  previousAiMessage,
  abortCheck = null,
) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) return false;

  // Require a minimum number of messages in the buffer before accepting a
  // scene break. Without this, the heuristic can fire multiple times in quick
  // succession at the start of a new scene (e.g. several messages all
  // describing a morning wake-up), producing duplicate summaries of the same
  // opening beats before the scene has had a chance to develop.
  const minMessages = settings.scene_min_messages ?? 5;
  const nonSystemMessages = recentMessages.filter((m) => !m.is_system);
  if (nonSystemMessages.length < minMessages) {
    smLog(
      `[Smart Memory Enhanced] Scene break suppressed - only ${nonSystemMessages.length}/${minMessages} messages in buffer.`,
    );
    return false;
  }

  const isBreak = settings.scene_ai_detect
    ? await detectSceneBreakAI(lastMessageText, previousAiMessage)
    : detectSceneBreakHeuristic(lastMessageText);

  if (!isBreak) return false;

  smLog('[Smart Memory Enhanced] Scene break detected.');

  const sceneResult = await summarizeScene(recentMessages);
  if (!sceneResult?.summary) return false;
  const { summary, characterParticipants } = sceneResult;
  const participantResolution = canonicalizeStructuredParticipants(characterParticipants, buildCanonicalCharacterRoster(getContext()));

  const history = loadSceneHistory();

  // Skip if the new summary is too similar to any of the last three stored scenes.
  // Checking a small window guards against scene descriptions that repeat after
  // a few exchanges without triggering a break (e.g. slow-paced ERP scenes).
  // Uses semantic embeddings when available, falling back to Jaccard.
  // Cosine threshold 0.82 catches rephrased versions of the same scene that
  // Jaccard misses due to varied wording.
  const recentScenes = history.slice(-3);
  for (const candidate of recentScenes) {
    const { score, semantic } = await sceneSimilarity(summary, candidate.summary);
    const threshold = semantic ? 0.82 : 0.55;
    if (score >= threshold) {
      smLog(
        `[Smart Memory Enhanced] Scene summary too similar to a recent scene (${semantic ? 'semantic' : 'jaccard'} ${score.toFixed(3)}) - skipping duplicate.`,
      );
      return false;
    }
  }

  // source_memory_ids is populated after extraction via linkMemoriesToLastScene.
  const sceneRecord = createSceneRecord(summary, recentMessages, {
    detected_by: settings.scene_ai_detect ? 'ai' : 'heuristic',
    character_participants: participantResolution.names,
    identity_rejections: participantResolution.rejected,
  });
  history.push(sceneRecord);

  if (abortCheck?.()) return false;
  await saveSceneHistory(history);
  const characterName = getContext().name2 || getContext().characterName;
  if (characterName && isGeneratedRecordApproved(sceneRecord) && sceneRecord.character_participants?.length) {
    const registry = loadCharacterEntityRegistry(characterName);
    resolveEntityNames(
      sceneRecord,
      sceneRecord.character_participants.map((name) => `${name}/character`),
      Math.max(...(sceneRecord.source_message_indices ?? [0])),
      registry,
    );
    if (registry.length) saveCharacterEntityRegistry(characterName, registry);
  }
  return true;
}

// ---- Source memory linking ----------------------------------------------

/**
 * Attaches memory ids to the most recent scene entry in history.
 * Called after extraction so each scene knows which memories it produced.
 *
 * Only adds ids that are not already present to avoid duplicates when
 * multiple extraction passes run against the same scene.
 *
 * @param {string[]} memoryIds - Ids of memories extracted during this scene.
 * @returns {Promise<void>}
 */
export async function linkMemoriesToLastScene(memoryIds) {
  if (!memoryIds || memoryIds.length === 0) return;
  const history = loadSceneHistory();
  if (history.length === 0) return;

  const last = history[history.length - 1];
  if (!Array.isArray(last.source_memory_ids)) last.source_memory_ids = [];

  const existing = new Set(last.source_memory_ids);
  for (const id of memoryIds) {
    if (id && !existing.has(id)) {
      last.source_memory_ids.push(id);
      existing.add(id);
    }
  }

  await saveSceneHistory(history);
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects the scene history into the prompt via setExtensionPrompt.
 * Clears the slot if scene detection is disabled or no history exists.
 */
export function injectSceneHistory() {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.scene_enabled) {
    setMacroContent(MACRO_NAMES.scenes, '');
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SCENES);
    return;
  }

  const history = loadSceneHistory();
  if (history.length === 0) {
    setMacroContent(MACRO_NAMES.scenes, '');
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SCENES);
    return;
  }

  // Trim to token budget: drop oldest scenes (from the front) until we fit.
  // If a single scene still exceeds the budget, hard-truncate so the injection
  // is always within the cap regardless of individual summary length.
  const budget = settings.scene_inject_budget ?? 300;
  const injectionCandidates = selectScenesForInjection(
    history.filter(isGeneratedRecordApproved), settings.scene_inject_count ?? 5,
  );
  const fullText = injectionCandidates.map((sc, i) => `Scene ${i + 1}: ${sc.summary}`).join('\n');
  const fullTokens = estimateTokens(`Previous scenes:\n${fullText}`);
  const trimmed = [...injectionCandidates];
  while (trimmed.length > 1) {
    const text = trimmed.map((sc, i) => `Scene ${i + 1}: ${sc.summary}`).join('\n');
    if (estimateTokens(text) <= budget) break;
    trimmed.shift();
  }

  let text = trimmed.map((sc, i) => `Scene ${i + 1}: ${sc.summary}`).join('\n');
  if (estimateTokens(text) > budget) {
    const ratio = budget / estimateTokens(text);
    text = text.slice(0, Math.floor(text.length * ratio)).trim();
  }
  const content = `Previous scenes:\n${text}`;
  reportTierTrimStats(PROMPT_KEY_SCENES, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.scenes, content);
  if (isMacroActive(MACRO_NAMES.scenes)) {
    setExtensionPrompt(PROMPT_KEY_SCENES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_SCENES);
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_SCENES,
    content,
    settings.scene_position ?? extension_prompt_types.IN_PROMPT,
    settings.scene_depth ?? 6,
    false,
    settings.scene_role ?? extension_prompt_roles.SYSTEM,
  );
}
