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
import { buildSceneDetectPrompt, buildSceneDetectBatchPrompt, buildSceneSummaryPrompt } from './prompts.js';
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
  const diagnostics = { requests_sent: 0, batched_requests: 0, malformed_batches: 0, retried_batches: 0, fallback_boundaries: 0, boundary_confidences: {} };
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    try {
      diagnostics.requests_sent++;
      if (batch.length > 1) diagnostics.batched_requests++;
      const response = await generateMemoryExtract(applyPromptOverride(buildSceneDetectBatchPrompt(batch), PROMPT_TASKS.SCENE_SUMMARY), { responseLength: Math.max(32, batch.length * 16), temperature: 0 });
      const parsed = new Map();
      for (const match of String(response ?? '').matchAll(/^\s*\[(\d+)\]\s*(YES|NO)\s+confidence\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/gim)) parsed.set(Number(match[1]), { decision: match[2] === 'YES', confidence: Number(match[3]) });
      if (parsed.size !== batch.length || batch.some((candidate) => !parsed.has(candidate.candidate_index))) throw new Error('Malformed scene-boundary batch response.');
      for (const candidate of batch) {
        const decision = parsed.get(candidate.candidate_index);
        result.set(candidate.candidate_index, decision.decision);
        diagnostics.boundary_confidences[candidate.candidate_index] = decision.confidence;
      }
    } catch (error) {
      diagnostics.malformed_batches++;
      for (const candidate of batch) {
        diagnostics.fallback_boundaries++;
        result.set(candidate.candidate_index, detectSceneBreakHeuristic(candidate.message));
      }
      options.onError?.(error, batch);
    }
  }
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
