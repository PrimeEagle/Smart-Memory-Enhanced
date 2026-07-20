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
 * Long-term memory: per-character persistent facts stored in extension_settings.
 *
 * Memories survive across all sessions and are injected at the start of every
 * new chat with the same character. A fresh-start flag in chatMetadata suppresses
 * extraction for a specific chat while keeping injection active.
 *
 * loadCharacterMemories       - returns the stored memory array for a character
 * saveCharacterMemories       - persists the memory array for a character
 * clearCharacterMemories      - deletes all memories for a character
 * formatMemoriesForPrompt     - formats the memory array as [type] content lines
 * extractAndStoreMemories     - runs extraction against recent messages and merges results;
 *                               also populates activation triggers and relationship deltas
 * consolidateMemories         - evaluates unprocessed entries against the stable consolidated base per type
 * injectMemories              - pushes memories into the prompt via setExtensionPrompt;
 *                               memories whose triggers match the current turn are injected a second
 *                               time into PROMPT_KEY_TRIGGERED closer to the prompt
 * loadRelationshipHistory     - returns the relationship history map for a character
 * saveRelationshipHistory     - persists the relationship history map for a character
 * clearRelationshipHistory    - deletes the relationship history for a character
 * injectRelationshipHistory   - pushes relevant relationship state into the prompt via PROMPT_KEY_RELATIONSHIPS
 * isFreshStart                - returns whether the current chat has fresh-start enabled
 * setFreshStart               - toggles the fresh-start flag and saves chatMetadata
 * getReadOnlyStartIndex       - returns the chat index at which read-only mode was last enabled
 * setReadOnlyStartIndex       - stores or clears the read-only window start index (also stores/clears readOnlyStartTime)
 * getReadOnlyStartTime        - returns the Unix ms timestamp at which read-only mode was last enabled
 *
 * Internal helpers (not exported):
 * shouldInjectMemory          - returns 'full' or 'secondhand' based on witnessed_by vs responding character
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
  saveSettingsDebounced,
  getCurrentChatId,
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
import { applyPromptOverride, PROMPT_TASKS } from './prompt-config.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { saveChatMetadata } from './catchup-transaction.js';
import {
  estimateTokens,
  MODULE_NAME,
  PROMPT_KEY_LONG,
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_RELATIONSHIPS,
  MEMORY_TYPES,
  META_KEY,
  MAX_RETIRED_POOL,
} from './constants.js';
import {
  applyGraphDefaults,
  loadCharacterEntityRegistry,
  saveCharacterEntityRegistry,
  resolveEntityNames,
  reconcileCanonicalEntityRegistry,
  reconcileEntityRegistry,
} from './graph-migration.js';
import { applyDirectProvenance, isGrounded, validateGeneratedMemoryRecord } from './grounding.js';
import { flattenConsolidationProvenance, isGeneratedRecordApproved, validateGeneratedRecord } from './record-validation.js';
import { buildCanonicalCharacterRoster, buildStableRelationshipPair, formatCanonicalRosterForPrompt, resolveCanonicalCharacterName } from './canonical-entities.js';
import {
  buildExtractionPrompt,
  buildLongtermConsolidationPrompt,
  buildSupersessionConfirmPrompt,
  buildTriggerGenerationPrompt,
  buildRelationshipDeltaPrompt,
} from './prompts.js';
import {
  parseExtractionOutput,
  parseTriggerResponse,
  parseRelationshipDeltaResponse,
} from './parsers.js';
import {
  prioritizeMemories,
  hybridPrioritize,
  extractTurnEntityMentions,
  reconcileTypeEntries,
  selectProtectedMemories,
  sortByTimeline,
  trimByPriority,
  keywordSet,
  filterTriggersByFrequency,
} from './memory-utils.js';
import { batchVerify, getEmbeddingBatch, getHardwareProfile } from './embeddings.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { getSceneParticipants } from './scenes.js';
import { reportTierTrimStats } from './trim-stats.js';

// Maximum new entries accepted per type per extraction pass.
// Profile B (hosted) uses a higher cap because hosted models extract more
// reliably and rarely over-fire on a single type the way small local models can.
function maxNewPerType() {
  return getHardwareProfile() === 'b' ? 4 : 2;
}

function incomingPriorityScore(mem) {
  const typeBonus =
    mem.type === 'relationship'
      ? 30
      : mem.type === 'fact'
        ? 20
        : mem.type === 'preference'
          ? 10
          : 0;
  return (mem.importance ?? 2) * 100 + typeBonus + (mem.ts ?? 0) / 1e13;
}

/**
 * Filters a list of candidate memories against existing ones, removing
 * near-duplicates and entries that fail basic quality checks. Identifies
 * supersessions (state-change updates that should retire an existing memory).
 *
 * All texts are embedded in a single batch API call so nomic-embed-text only
 * needs to load once per verification pass rather than once per candidate.
 * Falls back to Jaccard word-overlap when embeddings are unavailable.
 *
 * @param {Array} candidates - Newly extracted memory objects to evaluate.
 * @param {Array} existing   - Active (non-retired) memories to compare against.
 * @returns {Promise<{verified: Array, superseded: Map<string, string>, confirmed: Set<string>}>}
 *   verified  - Candidates that passed dedup and should be added.
 *   superseded - Map from candidate content (lowercase) to the id of the
 *                existing memory it replaces.
 *   confirmed  - Set of existing memory ids re-extracted this pass (still true).
 */
async function verifyLongtermCandidates(candidates, existing) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { verified: [], superseded: new Map(), confirmed: new Set() };
  }

  const bannedPhrases = ['maybe', 'might be', 'possibly', 'i think', 'perhaps', 'seems like'];
  const seen = new Set();

  // Apply quality filters before embedding - no point embedding entries we'll discard.
  const filtered = candidates.filter((mem) => {
    const text = String(mem.content || '').trim();
    if (text.length < 8 || text.length > 280) return false;
    const lower = text.toLowerCase();
    if (bannedPhrases.some((p) => lower.includes(p))) return false;
    const key = `${mem.type}|${lower}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (filtered.length === 0) return { verified: [], superseded: new Map(), confirmed: new Set() };

  // Batch-embed all candidates and existing memories in one API call.
  const { passed, superseded, confirmed, uncertain } = await batchVerify(filtered, existing);

  // Method B: for pairs that scored above the same-topic threshold but had no
  // state-change pattern, ask the model directly. Runs sequentially - Ollama
  // serializes requests anyway and parallel calls risk OOM on 8GB VRAM.
  for (const pair of uncertain) {
    // Skip if a pattern already resolved this candidate as a supersession.
    if (superseded.has(pair.candText)) continue;
    try {
      const prompt = buildSupersessionConfirmPrompt(pair.candObj.content, pair.existingContent);
      const raw = await generateMemoryExtract(applyPromptOverride(prompt, PROMPT_TASKS.LONGTERM_EXTRACTION), { responseLength: 20 });
      const answer = raw
        .trim()
        .toUpperCase()
        .split(/\s/)[0]
        .replace(/[^A-Z]/g, '');
      if (answer === 'UPDATE') {
        superseded.set(pair.candText, pair.existingId);
        smLog(
          `[Smart Memory Enhanced] Method B supersession: "${pair.candObj.content.slice(0, 60)}" replaces id ${pair.existingId}`,
        );
      }
    } catch (err) {
      // Non-fatal: if B fails, the candidate is treated as a new independent memory.
      smLog(
        `[Smart Memory Enhanced] Method B confirmation failed for "${pair.candText.slice(0, 60)}": ${err.message}`,
      );
    }
  }

  const verified = filtered.filter((m) =>
    passed.has(
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  );
  return { verified, superseded, confirmed };
}

// ---- Storage helpers ----------------------------------------------------

export const CHARACTER_MEMORY_POLICIES = Object.freeze({
  FULL: 'full',
  CHAT_LOCAL: 'chat_local',
  READ_ONLY: 'read_only',
  DISABLED: 'disabled',
});

export function getCharacterMemoryPolicy(characterName) {
  return extension_settings[MODULE_NAME]?.characters?.[characterName]?.memory_policy ?? CHARACTER_MEMORY_POLICIES.FULL;
}

export function setCharacterMemoryPolicy(characterName, policy) {
  if (!Object.values(CHARACTER_MEMORY_POLICIES).includes(policy) || !characterName) return;
  const settings = extension_settings[MODULE_NAME];
  settings.characters ??= {};
  settings.characters[characterName] = {
    ...(settings.characters[characterName] ?? {}),
    memory_policy: policy,
  };
}

function loadChatLocalMemories(characterName) {
  return getContext().chatMetadata?.[META_KEY]?.card_local_memories?.[characterName] ?? [];
}

async function saveChatLocalMemories(characterName, memories) {
  const context = getContext();
  context.chatMetadata ??= {};
  context.chatMetadata[META_KEY] ??= {};
  context.chatMetadata[META_KEY].card_local_memories ??= {};
  context.chatMetadata[META_KEY].card_local_memories[characterName] = memories;
  await saveChatMetadata(context);
}

/**
 * Returns the memory array for a character, or an empty array if none exist.
 * Migrates legacy entries (no consolidated flag) to consolidated: true on load
 * so existing memories are treated as the stable base.
 * @param {string} characterName
 * @returns {Array<{type: string, content: string, ts: number, consolidated: boolean}>}
 */
export function loadCharacterMemories(characterName) {
  if (!characterName) return [];
  const chars = extension_settings[MODULE_NAME].characters;
  const memories = getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL
    ? loadChatLocalMemories(characterName)
    : chars?.[characterName]?.memories ?? [];
  // Migrate: entries without the consolidated flag are pre-existing stable memories.
  // Entries without an importance score default to 2 (medium).
  // applyGraphDefaults is a safety net for entries that predate the one-shot
  // migration pass. It is non-destructive and only generates a new id when one
  // is truly absent (e.g. a rollback/downgrade scenario).
  return memories.map((m) =>
    applyGraphDefaults({
      ...m,
      consolidated: m.consolidated ?? true,
      importance: m.importance ?? 2,
      expiration: m.expiration ?? 'permanent',
      confidence: m.confidence ?? 0.7,
      persona_relevance: m.persona_relevance ?? (m.type === 'relationship' ? 3 : 1),
      intimacy_relevance: m.intimacy_relevance ?? (m.type === 'preference' ? 3 : 1),
      retrieval_count: m.retrieval_count ?? 0,
      // Fall back to 0 (not Date.now()) when both fields are absent so legacy
      // entries don't receive an artificial recency boost in memoryUtilityScore.
      last_confirmed_ts: m.last_confirmed_ts ?? m.ts ?? 0,
    }),
  );
}

/**
 * Persists the memory array for a character into extension_settings.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 * @param {Array<{type: string, content: string, ts: number}>} memories
 */
export function saveCharacterMemories(characterName, memories) {
  if (!characterName || !Array.isArray(memories)) return;
  if ([CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return;
  for (const memory of memories) validateGeneratedMemoryRecord(memory, memories);
  if (getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL) {
    saveChatLocalMemories(characterName, memories).catch((err) => smLog('[Smart Memory Enhanced] Failed to save chat-local memories:', err));
    return;
  }
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  // Spread the existing character object so the entity registry and any other
  // fields stored alongside memories (e.g. entities, canon) are preserved.
  const existing = extension_settings[MODULE_NAME].characters[characterName] ?? {};
  extension_settings[MODULE_NAME].characters[characterName] = {
    ...existing,
    memories,
    lastUpdated: Date.now(),
  };
}

/**
 * Removes all stored memories for a character.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 */
export function clearCharacterMemories(characterName) {
  if (!characterName) return;
  if ([CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return;
  if (getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL) {
    const context = getContext();
    if (context.chatMetadata?.[META_KEY]?.card_local_memories) delete context.chatMetadata[META_KEY].card_local_memories[characterName];
    saveChatMetadata(context).catch((err) => smLog('[Smart Memory Enhanced] Failed to clear chat-local memories:', err));
    return;
  }
  if (extension_settings[MODULE_NAME].characters?.[characterName]) {
    delete extension_settings[MODULE_NAME].characters[characterName];
  }
}

// ---- Relationship history storage ---------------------------------------

/**
 * Returns the relationship history map for a character, or an empty object
 * if none exists yet. Keys are "subject→target" strings; values are
 * { descriptors: string[], magnitude: string, updatedAt: number }.
 * @param {string} characterName
 * @returns {Object}
 */
export function loadRelationshipHistory(characterName) {
  if (!characterName) return {};
  const raw = getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL
    ? getContext().chatMetadata?.[META_KEY]?.card_local_relationships?.[characterName] ?? {}
    : extension_settings[MODULE_NAME].characters?.[characterName]?.relationship_history ?? {};
  // Normalize entries still in the old flat format { descriptors: string[], magnitude: string }
  // to the current per-descriptor format { descriptors: Array<{word, magnitude}> }.
  // This is a read-time safety net in case the schema migration did not run yet.
  const normalized = {};
  for (const [key, state] of Object.entries(raw)) {
    const descs = state.descriptors ?? [];
    if (descs.length > 0 && typeof descs[0] === 'string') {
      const fallbackMag = state.magnitude ?? 'medium';
      normalized[key] = {
        descriptors: descs.map((w) => ({ word: w, magnitude: fallbackMag })),
        updatedAt: state.updatedAt ?? Date.now(),
      };
    } else {
      normalized[key] = state;
    }
  }
  return normalized;
}

/**
 * Persists a relationship history map for a character into extension_settings.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 * @param {Object} history - Map of "subject→target" keys to state objects.
 */
export function saveRelationshipHistory(characterName, history) {
  if (!characterName || typeof history !== 'object') return;
  if ([CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return;
  if (getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL) {
    const context = getContext();
    context.chatMetadata ??= {}; context.chatMetadata[META_KEY] ??= {};
    (context.chatMetadata[META_KEY].card_local_relationships ??= {})[characterName] = history;
    saveChatMetadata(context).catch((err) => smLog('[Smart Memory Enhanced] Failed to save chat-local relationships:', err));
    return;
  }
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  const existing = extension_settings[MODULE_NAME].characters[characterName] ?? {};
  extension_settings[MODULE_NAME].characters[characterName] = {
    ...existing,
    relationship_history: history,
  };
}

/**
 * Returns stable storage identifiers and readable labels for a relationship
 * pair. Character-card identities use immutable card IDs; discovered entities
 * retain a normalized name key until they have a card identity.
 */
export function getRelationshipHistoryPair(subject, target, roster = buildCanonicalCharacterRoster(getContext())) {
  const pair = buildStableRelationshipPair(subject, target, roster);
  return {
    key: pair.key,
    subject: { displayName: pair.subject.displayName, cardId: pair.subject.canonicalId, storageId: pair.subject.storageId },
    target: { displayName: pair.target.displayName, cardId: pair.target.canonicalId, storageId: pair.target.storageId },
  };
}

/** Returns readable pair labels for both ID-backed and legacy storage keys. */
export function getRelationshipHistoryPairDisplay(key, state = {}) {
  if (state.subject_name && state.target_name) {
    return { subject: state.subject_name, target: state.target_name };
  }
  const [subject, target] = key.split('→').map((part) => part.trim());
  return { subject, target };
}

export function reconcileRelationshipHistoryCanonicalNames(characterName) {
  const history = loadRelationshipHistory(characterName);
  const roster = buildCanonicalCharacterRoster(getContext());
  const reconciled = {};
  let changed = false;
  for (const [key, state] of Object.entries(history)) {
    const { subject, target } = getRelationshipHistoryPairDisplay(key, state);
    if (!subject || !target) { reconciled[key] = state; continue; }
    const pair = getRelationshipHistoryPair(subject, target, roster);
    const canonicalState = {
      ...state,
      subject_name: pair.subject.displayName,
      target_name: pair.target.displayName,
      subject_canonical_card_id: pair.subject.cardId,
      target_canonical_card_id: pair.target.cardId,
    };
    reconciled[pair.key] = reconciled[pair.key] ?? canonicalState;
    changed ||= pair.key !== key || JSON.stringify(canonicalState) !== JSON.stringify(state);
  }
  if (changed) saveRelationshipHistory(characterName, reconciled);
  return changed;
}

/**
 * Redirects relationship-history references when an entity is manually merged.
 * Pair storage is rebuilt so both the display labels and its stable key point
 * to the surviving entity.
 */
export function remapRelationshipHistoryEntity(characterName, sourceName, targetName) {
  const history = loadRelationshipHistory(characterName);
  const source = String(sourceName).trim().toLowerCase();
  const remapped = {};
  let changed = false;
  for (const [key, state] of Object.entries(history)) {
    const labels = getRelationshipHistoryPairDisplay(key, state);
    const subject = labels.subject.toLowerCase() === source ? targetName : labels.subject;
    const target = labels.target.toLowerCase() === source ? targetName : labels.target;
    const pair = getRelationshipHistoryPair(subject, target);
    const nextState = {
      ...state,
      subject_name: pair.subject.displayName,
      target_name: pair.target.displayName,
      subject_canonical_card_id: pair.subject.cardId,
      target_canonical_card_id: pair.target.cardId,
    };
    const existing = remapped[pair.key];
    remapped[pair.key] = existing
      ? { ...nextState, descriptors: [...(existing.descriptors ?? []), ...(nextState.descriptors ?? [])] }
      : nextState;
    changed ||= pair.key !== key || subject !== labels.subject || target !== labels.target;
  }
  if (changed) saveRelationshipHistory(characterName, remapped);
  return changed;
}

/**
 * Removes the relationship history for a character from extension_settings.
 * Caller must call saveSettingsDebounced() afterwards.
 * @param {string} characterName
 */
export function clearRelationshipHistory(characterName) {
  if (!characterName) return;
  if ([CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return;
  if (getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.CHAT_LOCAL) {
    const context = getContext();
    if (context.chatMetadata?.[META_KEY]?.card_local_relationships) delete context.chatMetadata[META_KEY].card_local_relationships[characterName];
    saveChatMetadata(context).catch((err) => smLog('[Smart Memory Enhanced] Failed to clear chat-local relationships:', err));
    return;
  }
  const char = extension_settings[MODULE_NAME].characters?.[characterName];
  if (char) delete char.relationship_history;
}

// ---- Formatting ---------------------------------------------------------

/**
 * Formats the memory array into [type] content lines for prompt injection
 * or for passing to the extraction prompt as existing context.
 * @param {Array<{type: string, content: string}>} memories
 * @returns {string}
 */
export function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  return sortByTimeline(memories)
    .map((m) => `[${m.type}] ${m.content}`)
    .join('\n');
}

// ---- Extraction ---------------------------------------------------------

/**
 * Merges new memories into the existing set, skipping near-duplicates and
 * trimming to the configured maximum.
 *
 * Duplicate detection uses word-overlap (Jaccard-like): if more than 70% of
 * the words in the new memory also appear in an existing memory, it is
 * considered a duplicate and dropped. This is intentionally conservative -
 * false negatives (keeping a near-duplicate) are less harmful than false
 * positives (discarding genuinely new information).
 *
 * When the merged total exceeds maxTotal, the oldest entries are dropped
 * (splice from the front) to keep the most recent memories.
 *
 * @param {Array} existing - Currently stored memories.
 * @param {Array} incoming - Newly extracted memories to merge in.
 * @param {number} maxTotal - Hard cap on the total number of memories to keep.
 * @returns {Array} The merged memory array.
 */
/**
 * Merges new memories into the existing set with two layers of churn control:
 *
 * 1. Per-type extraction cap: at most maxNewPerType() entries per type are
 *    accepted per pass (2 on Profile A, 4 on Profile B). Prevents a burst of
 *    similar events from flooding one type while the rest accumulate normally.
 *
 * 2. Per-type storage cap: derived from maxTotal / number of types (rounded up).
 *    When a new entry would push a type over its cap, the lowest-priority entry
 *    of that type is evicted first so the total stays balanced. Cloud users who
 *    raise maxTotal get proportionally larger per-type budgets automatically.
 *
 * @param {Array} existing - Currently stored memories.
 * @param {Array} incoming - Newly extracted memories (already deduped by verifyLongtermCandidates).
 * @param {number} maxTotal - Hard cap on total stored memories (from settings).
 * @returns {Array} The merged memory array.
 */
function mergeMemories(existing, incoming, maxTotal) {
  const merged = [...existing];

  // Per-type cap derived from the overall max - equal split across all types.
  // At 25 total -> 7 per type (ceil(25/4)), at 50 -> 13, at 100 -> 25.
  const perTypeCap = Math.ceil(maxTotal / MEMORY_TYPES.length);

  // Track how many new entries we've accepted per type this pass.
  const addedPerType = new Map();

  // Sort incoming by priority so when we hit the per-type cap we keep the best.
  const sorted = [...incoming].sort((a, b) => incomingPriorityScore(b) - incomingPriorityScore(a));

  for (const mem of sorted) {
    const typeAdded = addedPerType.get(mem.type) ?? 0;
    if (typeAdded >= maxNewPerType()) continue;

    // If this type is already at the per-type storage cap, evict the
    // lowest-priority existing entry of this type before adding the new one -
    // but only if the new entry actually outscores the one we'd displace.
    // Without this guard a burst of low-priority new entries could displace
    // high-priority existing ones that are far more valuable to keep.
    const typeEntries = merged.filter((m) => m.type === mem.type);
    if (typeEntries.length >= perTypeCap) {
      const prioritized = prioritizeMemories(typeEntries);
      // Last entry in prioritized is lowest priority.
      const toEvict = prioritized[prioritized.length - 1];
      if (incomingPriorityScore(mem) <= incomingPriorityScore(toEvict)) continue;
      const evictIdx = merged.findIndex(
        (m) => m.type === toEvict.type && m.content === toEvict.content,
      );
      if (evictIdx >= 0) merged.splice(evictIdx, 1);
    }

    merged.push(mem);
    addedPerType.set(mem.type, typeAdded + 1);
  }

  // Final safety trim to maxTotal in case types were already over cap before
  // this pass (e.g. migrating from an older version without the cap).
  if (merged.length > maxTotal) {
    const prioritized = prioritizeMemories(merged);
    merged.splice(0, merged.length, ...prioritized);
    merged.splice(maxTotal);
  }

  return merged;
}

/**
 * Extracts memorable facts from recent chat messages via the model and merges
 * them into the character's stored memories. Safe to fire-and-forget.
 * @param {string} characterName
 * @param {Array} recentMessages - Last N message objects from context.chat.
 * @returns {Promise<number>} Count of new memories added (0 on failure or nothing found).
 */
export async function extractAndStoreMemories(characterName, recentMessages, statusFn = null, options = {}) {
  const settings = extension_settings[MODULE_NAME];
  const policy = getCharacterMemoryPolicy(characterName);
  if (!settings.longterm_enabled || !characterName || policy === CHARACTER_MEMORY_POLICIES.DISABLED || policy === CHARACTER_MEMORY_POLICIES.READ_ONLY) return 0;

  try {
    const chatHistory = recentMessages
      .filter((m) => m.mes && !m.is_system)
      .map((m, index) => `[${index}] ${m.name}: ${m.mes}`)
      .join('\n\n');

    if (!chatHistory.trim()) return 0;

    const existingMemories = loadCharacterMemories(characterName);

    // Separate active from retired memories. Verification and merge operate only
    // on active entries; retired ones are preserved in storage for history but
    // should not be compared against (or count toward type caps during merge).
    const activeMemories = existingMemories.filter((m) => !m.superseded_by);
    const retiredMemories = existingMemories.filter((m) => m.superseded_by);

    // Only show active memories as context in the extraction prompt.
    const existingText = formatMemoriesForPrompt(activeMemories);

    const response = await generateMemoryExtract(
      applyPromptOverride(
        buildExtractionPrompt(chatHistory, existingText, characterName, formatCanonicalRosterForPrompt(buildCanonicalCharacterRoster(getContext()))),
        PROMPT_TASKS.LONGTERM_EXTRACTION,
        characterName,
      ),
      {
        responseLength: settings.longterm_response_length || 600,
      },
    );

    smLog(`[Smart Memory Enhanced] Raw extraction response for "${characterName}":`, response);

    if (!response || response.trim().toUpperCase() === 'NONE') return 0;

    const parsed = parseExtractionOutput(response);
    if (parsed.length === 0) {
      smLog('[Smart Memory Enhanced] Extraction response produced no parseable lines. Check format above.');
      return 0;
    }

    // Source citations belong to the numbered extraction window.  Translate
    // and validate them before candidate verification so every later pipeline
    // stage works on final, original-chat provenance rather than parser-time
    // placeholder status.
    const provenanceContext = getContext();
    const provenanceChatLength = provenanceContext.chat?.length ?? 1;
    const provenanceWindowEnd = Math.max(0, provenanceChatLength - 2);
    const provenanceWindowStart = Math.max(0, provenanceWindowEnd - recentMessages.length + 1);
    const provenanceOriginalIndices = recentMessages.map((message) => message.__sme_original_index).every(Number.isInteger)
      ? recentMessages.map((message) => message.__sme_original_index)
      : null;
    applyDirectProvenance(parsed, recentMessages, provenanceWindowStart, provenanceOriginalIndices);

    const {
      verified: newMemories,
      superseded: supersessionMap,
      confirmed: confirmedIds,
    } = await verifyLongtermCandidates(parsed, activeMemories);
    if (newMemories.length === 0) {
      smLog(
        `[Smart Memory Enhanced] All ${parsed.length} extracted candidates were duplicates of existing memories.`,
      );
      return 0;
    }

    // Tag each new memory with the source message range and chat ID so users
    // can jump back to the passage that prompted the extraction.
    const context = getContext();
    const chatLen = context.chat?.length ?? 1;
    const sourceChatId = getCurrentChatId() ?? null;
    // Derive the characters present in this extraction window so the injection
    // path can downgrade memories the responding character did not witness.
    const witnessedBy = getSceneParticipants(recentMessages);
    for (const mem of newMemories) {
      mem.source_chat_id = sourceChatId;
      mem.witnessed_by = witnessedBy;
      validateGeneratedMemoryRecord(mem, activeMemories);
    }
    if (options.dryRun) {
      return {
        dryRun: true,
        parsed: parsed.length,
        candidates: newMemories.map((memory) => ({ type: memory.type, content: memory.content, grounding_status: memory.grounding_status, validation_status: memory.validation_status, validation_issues: memory.validation_issues ?? [] })),
      };
    }

    const maxMemories = settings.longterm_max_memories || 25;
    // Merge new memories into the active set. Result includes both existing
    // active entries and the newly accepted candidates.
    const merged = mergeMemories(activeMemories, newMemories, maxMemories);

    // Apply supersession links. For each candidate that supersedes an existing
    // memory: mark the old memory as retired (superseded_by + valid_to) and
    // link the new memory back to it (supersedes + valid_from).
    const messageIndex = Math.max(0, chatLen - 1);

    const newlyRetiredIds = new Set();
    for (const [candText, oldId] of supersessionMap) {
      // Find the new memory in the merged active set.
      const newMem = merged.find(
        (m) =>
          String(m.content || '')
            .toLowerCase()
            .trim() === candText,
      );
      // Find the old memory in the active set (it may not be in merged if evicted).
      const oldMem = activeMemories.find((m) => m.id === oldId);

      // Guard: newMem must be a different object with different content.
      // merged includes both active existing memories and new candidates, so
      // find() could return the existing memory when content strings match -
      // which would create a self-supersession chain of identical nodes.
      const newText = String(newMem?.content || '')
        .toLowerCase()
        .trim();
      const oldText = String(oldMem?.content || '')
        .toLowerCase()
        .trim();
      if (
        newMem &&
        oldMem &&
        !oldMem.superseded_by &&
        newMem.id !== oldMem.id &&
        newText !== oldText
      ) {
        // Link new -> old.
        if (!newMem.supersedes) newMem.supersedes = [];
        if (!newMem.supersedes.includes(oldId)) newMem.supersedes.push(oldId);
        newMem.valid_from = newMem.valid_from ?? messageIndex;

        // Retire old memory.
        oldMem.superseded_by = newMem.id;
        oldMem.valid_to = messageIndex;
        newlyRetiredIds.add(oldId);

        smLog(
          `[Smart Memory Enhanced] Supersession: "${oldMem.content.slice(0, 60)}" retired by "${newMem.content.slice(0, 60)}"`,
        );
      }
    }

    // Remove newly retired entries from the active merged set - they move to
    // the retired pool so they stay in storage but are excluded from injection.
    const finalActive = merged.filter((m) => !newlyRetiredIds.has(m.id));

    // Confidence decay pass.
    // Confirmed memories (re-extracted this pass) get a small confidence boost
    // and reset their unconfirmed counter. All other active memories increment
    // their unconfirmed counter; once it reaches the threshold, confidence
    // decays slightly. Importance does not decay - only confidence (recall
    // freshness) does, so impactful memories remain prioritised even as they fade.
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

    // Profile B only: populate LLM-suggested triggers for newly added memories.
    // Noun-derived triggers (Profile A) are redundant with direct content matching
    // and add no signal - the scoring path handles Profile A via content overlap.
    // LLM-suggested triggers add genuine value by capturing synonyms and contextual
    // cues not present in the memory text itself, scored at a higher bonus per hit.
    // Runs sequentially to avoid OOM on limited VRAM (Ollama serialises anyway).
    const existingKeys = new Set(activeMemories.map((m) => `${m.type}|${m.content}`));
    if (getHardwareProfile() === 'b' || settings.longterm_triggers_enabled) {
      for (const mem of finalActive) {
        // Skip if triggers are already present - covers both new memories with
        // triggers derived this pass and existing memories that survived consolidation
        // with their triggers intact. Existing memories that lost triggers through
        // consolidation (no triggers field) are NOT skipped, allowing recovery.
        if (Array.isArray(mem.triggers) && mem.triggers.length > 0) continue;
        try {
          const triggerPrompt = buildTriggerGenerationPrompt(mem.content);
          const triggerResponse = await generateMemoryExtract(applyPromptOverride(triggerPrompt, PROMPT_TASKS.LONGTERM_EXTRACTION, characterName), {
            responseLength: 60,
          });
          const raw = parseTriggerResponse(triggerResponse, mem.content);
          mem.triggers = filterTriggersByFrequency(raw, finalActive);
          smLog(
            `[Smart Memory Enhanced] Triggers for "${mem.content.slice(0, 50)}": ${mem.triggers.join(', ')}`,
          );
        } catch (err) {
          smLog(`[Smart Memory Enhanced] Trigger generation failed: ${err.message}`);
          mem.triggers = [];
        }
      }
    }

    // Load once so relationship validation and the subsequent promotion pass
    // consult the same current entity types.
    const entityRegistry = loadCharacterEntityRegistry(characterName);
    // This same history is first updated by relationship extraction and then
    // consulted by the independent-evidence entity-promotion pass below.
    // Keep it in the extraction scope rather than the inner extraction block.
    const relHistory = loadRelationshipHistory(characterName);

    // Relationship delta extraction: runs after memory extraction so newly
    // added memories are already in finalActive and entity names are known.
    // Sequential like trigger generation to avoid OOM on limited VRAM.
    {
      // Build the current-state string from stored history for the prompt baseline.
      // Format: "pair: word(magnitude), word(magnitude)" so the model sees existing magnitudes.
      const stateLines = Object.entries(relHistory)
        .map(([pair, state]) => {
          const descStr = (state.descriptors ?? [])
            .map((d) => `${d.word}(${d.magnitude})`)
            .join(', ');
          const labels = getRelationshipHistoryPairDisplay(pair, state);
          return `${labels.subject} → ${labels.target}: ${descStr}`;
        })
        .join('\n');

      // Extract the character card description for seeding new pairs.
      const relContext = getContext();
      const cardChar = relContext.characters?.find((c) => c.name === characterName);
      const cardExcerpt = cardChar?.description ?? '';

      try {
        if (statusFn) statusFn(`Extracting relationship history for ${characterName}...`);
        const relPrompt = buildRelationshipDeltaPrompt(
          chatHistory,
          stateLines,
          cardExcerpt,
          formatCanonicalRosterForPrompt(buildCanonicalCharacterRoster(getContext())),
        );
        const relResponse = await generateMemoryExtract(applyPromptOverride(relPrompt, PROMPT_TASKS.RELATIONSHIPS, characterName), { responseLength: 300 });
        const deltas = parseRelationshipDeltaResponse(relResponse);

        // Only store pairs where the character is one of the parties.
        if (deltas.length > 0) {
          const canonicalRoster = buildCanonicalCharacterRoster(getContext());
          const knownEntityType = (name) => {
            const normalized = String(name ?? '').trim().toLowerCase();
            return entityRegistry.find((entity) =>
              entity.name?.trim().toLowerCase() === normalized ||
              (entity.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized),
            )?.type ?? null;
          };
          const relationshipSources = recentMessages.map((message) => Number.isInteger(message.__sme_original_index)
            ? message.__sme_original_index : getContext().chat.indexOf(message)).filter((index) => Number.isInteger(index) && index >= 0);
          for (const { subject: rawSubject, target: rawTarget, updates, removals } of deltas) {
            const looksLikeCharacterName = (name) => {
              const normalized = String(name ?? '').trim();
              return /^[A-Z][A-Za-z]*(?:[ -][A-Z][A-Za-z]*){0,3}$/.test(normalized) &&
                !/\b(?:apartment|room|house|home|office|street|city|town|running|walking|sleeping)\b/i.test(normalized);
            };
            if (!looksLikeCharacterName(rawSubject) || !looksLikeCharacterName(rawTarget)) {
              smLog(`[Smart Memory Enhanced] Relationship pair skipped: both parties must be named characters (${rawSubject} -> ${rawTarget}).`);
              continue;
            }
            const subjectType = knownEntityType(rawSubject);
            const targetType = knownEntityType(rawTarget);
            if ([subjectType, targetType].some((type) => type && type !== 'unknown' && type !== 'character')) {
              smLog(`[Smart Memory Enhanced] Relationship pair skipped: a known participant is not a character (${rawSubject} -> ${rawTarget}).`);
              continue;
            }
            const subjectResult = resolveCanonicalCharacterName(rawSubject, canonicalRoster);
            const targetResult = resolveCanonicalCharacterName(rawTarget, canonicalRoster);
            if (!['resolved', 'unresolved'].includes(subjectResult.status) || !['resolved', 'unresolved'].includes(targetResult.status)) {
              smLog(`[Smart Memory Enhanced] Relationship pair skipped due to unsafe identity: ${rawSubject} -> ${rawTarget}`);
              continue;
            }
            const pair = getRelationshipHistoryPair(rawSubject, rawTarget, canonicalRoster);
            const subject = pair.subject.storageId;
            const target = pair.target.storageId;
            const key = `${subject}→${target}`;
            const existing = relHistory[key] ?? { descriptors: [], updatedAt: Date.now() };

            // Build a word->magnitude map from the current stored state.
            const descMap = new Map((existing.descriptors ?? []).map((d) => [d.word, d.magnitude]));

            // Apply removals first, then add/update.
            for (const word of removals) descMap.delete(word);
            for (const { word, magnitude } of updates) descMap.set(word, magnitude);

            // Enforce a hard cap of 6 descriptors per pair. When over the cap,
            // drop the lowest-magnitude entries first to preserve the most significant ones.
            const MAG_RANK = { high: 2, medium: 1, low: 0 };
            const REL_DESCRIPTOR_CAP = 6;
            if (descMap.size > REL_DESCRIPTOR_CAP) {
              const sorted = Array.from(descMap.entries()).sort(
                (a, b) => (MAG_RANK[b[1]] ?? 0) - (MAG_RANK[a[1]] ?? 0),
              );
              descMap.clear();
              for (const [w, m] of sorted.slice(0, REL_DESCRIPTOR_CAP)) descMap.set(w, m);
            }

            const relationshipRecord = {
              descriptors: Array.from(descMap.entries()).map(([word, magnitude]) => ({
                word,
                magnitude,
              })),
              subject_name: pair.subject.displayName,
              target_name: pair.target.displayName,
              subject_canonical_card_id: pair.subject.cardId,
              target_canonical_card_id: pair.target.cardId,
              updatedAt: Date.now(),
            };
            relationshipRecord.source_message_indices = [...new Set([
              ...(existing.source_message_indices ?? []),
              ...relationshipSources,
            ])].sort((a, b) => a - b);
            relationshipRecord.last_update_source_indices = relationshipSources;
            relationshipRecord.parent_memory_ids = [];
            validateGeneratedRecord(relationshipRecord);
            relationshipRecord.evidence_ranges = relationshipRecord.source_messages;
            relHistory[key] = relationshipRecord;
          }
          saveRelationshipHistory(characterName, relHistory);
          smLog(`[Smart Memory Enhanced] Relationship deltas applied: ${deltas.length} pair(s)`);
        }
      } catch (err) {
        smLog(`[Smart Memory Enhanced] Relationship extraction failed: ${err.message}`);
      }
    }

    // Resolve entity names to ids for any new memories that carried
    // _raw_entity_names through the pipeline. The entity registry is loaded,
    // updated in place, then persisted alongside the memories.
    for (const mem of finalActive) {
      if (isGrounded(mem) && Array.isArray(mem._raw_entity_names)) {
        resolveEntityNames(mem, mem._raw_entity_names, messageIndex, entityRegistry);
      }
    }
    // Relationship History is independently grounded evidence. Its named
    // character pair can introduce a real NPC even when primary extraction
    // did not retain a matching memory record.
    for (const [pairKey, relationship] of Object.entries(relHistory)) {
      if (!isGeneratedRecordApproved(relationship)) continue;
      const relationshipEntityRecord = {
        id: `relationship:${pairKey}`,
        grounding_status: relationship.grounding_status,
        validation_status: relationship.validation_status,
        source_message_indices: relationship.source_message_indices ?? [],
      };
      resolveEntityNames(
        relationshipEntityRecord,
        [relationship.subject_name, relationship.target_name].filter(Boolean).map((name) => `${name}/character`),
        messageIndex,
        entityRegistry,
      );
    }
    // Reconcile after every extraction pass, not just after consolidation.
    // Local models often omit the :entity= tag even when the entity is clearly
    // named in the memory content. The substring pass here catches those misses
    // immediately so memories don't float as isolated nodes until the next
    // consolidation cycle (which may never come for small memory sets).
    if (entityRegistry.length > 0) {
      // Apply the same roster-scoped resolver to existing variants (including
      // persona first names) before repairing ordinary memory links.
      reconcileCanonicalEntityRegistry(entityRegistry, getContext(), finalActive);
      reconcileEntityRegistry(entityRegistry, finalActive);
      saveCharacterEntityRegistry(characterName, entityRegistry);
    }

    // Newly retired active memories are moved to the retired pool.
    let updatedRetired = [
      ...retiredMemories,
      ...activeMemories.filter((m) => newlyRetiredIds.has(m.id)),
    ];

    // Cap the retired pool so it does not grow unbounded when consolidation is
    // disabled. Drop the oldest entries (from the front) to stay within the limit.
    if (updatedRetired.length > MAX_RETIRED_POOL) {
      updatedRetired = updatedRetired.slice(updatedRetired.length - MAX_RETIRED_POOL);
    }

    // Count new entries that made it into the final active set.
    const added = finalActive.filter((m) => !existingKeys.has(`${m.type}|${m.content}`)).length;

    // Save: final active set + all retired memories (history is preserved).
    saveCharacterMemories(characterName, [...finalActive, ...updatedRetired]);

    smLog(
      `[Smart Memory Enhanced] Saved ${added} new memories for "${characterName}". Active: ${finalActive.length}, Retired: ${updatedRetired.length}`,
    );
    return added;
  } catch (err) {
    console.error('[Smart Memory Enhanced] Memory extraction failed:', err);
    throw err;
  }
}

// How many unprocessed entries of a single type must accumulate before
// consolidation fires for that type.
//
// User-configurable via settings panel; defaults preserve earlier tuned values.
const DEFAULT_CONSOLIDATION_THRESHOLDS = {
  fact: 4,
  relationship: 3,
  preference: 3,
  event: 4,
};

function getConsolidationThresholds(settings) {
  return {
    fact: Math.max(
      2,
      settings.longterm_consolidation_threshold_fact ?? DEFAULT_CONSOLIDATION_THRESHOLDS.fact,
    ),
    relationship: Math.max(
      2,
      settings.longterm_consolidation_threshold_relationship ??
        DEFAULT_CONSOLIDATION_THRESHOLDS.relationship,
    ),
    preference: Math.max(
      2,
      settings.longterm_consolidation_threshold_preference ??
        DEFAULT_CONSOLIDATION_THRESHOLDS.preference,
    ),
    event: Math.max(
      2,
      settings.longterm_consolidation_threshold_event ?? DEFAULT_CONSOLIDATION_THRESHOLDS.event,
    ),
  };
}

/**
 * Runs a consolidation pass on the stored memories for a character.
 *
 * New approach: maintains a stable consolidated base per memory type. When
 * enough unprocessed entries accumulate for a given type, the model evaluates
 * only that batch against the base for that type - it may drop duplicates, fold
 * new details into existing base entries, or add genuinely new entries. The
 * base itself is never rewritten, only extended.
 *
 * Consolidation fires per-type independently - a burst of new [fact] entries
 * does not trigger [relationship] consolidation.
 *
 * @param {string} characterName
 * @param {boolean} [force=false] - If true, consolidate all types regardless of threshold.
 *   Used by the catch-up final pass to flush any entries that never accumulated enough
 *   to hit the threshold during per-chunk consolidation.
 * @returns {Promise<number>} Number of memories removed by consolidation (0 on no change or failure).
 */
export async function consolidateMemories(characterName, force = false) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.consolidation_enabled || !characterName) return 0;
  const thresholds = getConsolidationThresholds(settings);

  const memories = loadCharacterMemories(characterName);
  let totalRemoved = 0;
  let dirty = false;

  for (const type of MEMORY_TYPES) {
    // Exclude retired memories from consolidation - they've already been
    // replaced and should not be re-evaluated or re-injected.
    const base = memories.filter((m) => m.type === type && m.consolidated && !m.superseded_by && isGrounded(m));
    const unprocessed = memories.filter(
      (m) => m.type === type && !m.consolidated && !m.superseded_by && isGrounded(m),
    );

    const threshold = thresholds[type] ?? DEFAULT_CONSOLIDATION_THRESHOLDS.fact;
    if (!force && unprocessed.length < threshold) continue;
    if (unprocessed.length === 0) continue;

    try {
      const baseText = formatMemoriesForPrompt(base);
      const batchText = formatMemoriesForPrompt(unprocessed);

      const response = await generateMemoryExtract(
        applyPromptOverride(buildLongtermConsolidationPrompt(type, baseText, batchText), PROMPT_TASKS.LONGTERM_EXTRACTION, characterName),
        { responseLength: Math.max(400, (base.length + unprocessed.length) * 60) },
      );

      smLog(`[Smart Memory Enhanced] Consolidation response for [${type}]:`, response);

      if (!response || response.trim().toUpperCase() === 'NONE') {
        // Model found nothing to add - mark unprocessed as consolidated as-is.
        unprocessed.forEach((m) => (m.consolidated = true));
        dirty = true;
        continue;
      }

      // Parse the model's output - these are the entries to add/update in the base.
      const incoming = parseExtractionOutput(response);

      // Mark all incoming as consolidated since they've been through the process.
      const promoted = incoming.map((m) => ({ ...m, consolidated: true }));

      // Reconcile promoted entries with the base so "updated" base entries
      // replace older variants instead of being appended as duplicates.
      const reconciledType = await reconcileTypeEntries(
        base,
        promoted,
        0.7,
        [...base, ...unprocessed],
        getEmbeddingBatch,
      );

      // Carry source provenance forward without retaining references to the
      // temporary candidates that this transaction is about to replace.
      const allInputs = [...base, ...unprocessed];
      const mostRecentChatId =
        unprocessed.find((m) => Array.isArray(m.source_messages) && m.source_messages.length > 0)
          ?.source_chat_id ?? null;
      const otherTypes = memories.filter((m) => m.type !== type);
      const finalStore = [...otherTypes, ...reconciledType];
      for (const entry of reconciledType) {
        const match = allInputs.find((m) => m.id === entry.id);
        const evidence = match ? [match] : allInputs.filter(isGrounded);
        flattenConsolidationProvenance(entry, evidence, finalStore);
        if (match?.source_messages?.length) {
          entry.source_chat_id = match.source_chat_id ?? null;
        } else if (entry.source_message_indices.length) {
          entry.source_chat_id = mostRecentChatId;
        }
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
        `[Smart Memory Enhanced] [${type}] consolidation: ${unprocessed.length} unprocessed -> ${promoted.length} promoted. Base: ${base.length}. Removed: ${Math.max(0, removed)}.`,
      );
    } catch (err) {
      console.error(`[Smart Memory Enhanced] Consolidation failed for type [${type}]:`, err);
      // On failure, mark unprocessed as consolidated so they don't block future passes.
      // Set dirty before the forEach so a mid-loop error still triggers the save.
      dirty = true;
      unprocessed.forEach((m) => (m.consolidated = true));
    }
  }

  const maxMemories = settings.longterm_max_memories || 25;
  const finalMemories = sortByTimeline(trimByPriority(memories, maxMemories));
  if (dirty || finalMemories.length !== memories.length) {
    // Repair entity registry links after consolidation - consolidation replaces
    // memories with new IDs, leaving the registry with stale memory_id refs.
    // reconcileEntityRegistry prunes those stale IDs and re-links by name match.
    const entityRegistry = loadCharacterEntityRegistry(characterName);
    if (entityRegistry.length > 0) {
      reconcileEntityRegistry(entityRegistry, finalMemories);
      saveCharacterEntityRegistry(characterName, entityRegistry);
    }

    saveCharacterMemories(characterName, finalMemories);
  }

  return totalRemoved;
}

// ---- Injection ----------------------------------------------------------

/**
 * Injects the character's stored memories into the prompt.
 * Clears the injection slot if fresh-start is active, no character is set,
 * or the character has no memories yet.
 * @param {string} characterName
 * @param {boolean} [updateTelemetry=false] - If true, increment retrieval_count for injected memories.
 *   Only pass true from the post-extraction path (one real AI response turn). All other callers
 *   (chat load, settings change, etc.) leave telemetry unchanged to avoid inflating the signal.
 */
/**
 * Determines how a memory should be handled during injection based on its
 * witnessed_by field relative to the responding character.
 *
 * - 'full'      : inject normally (character was present, or legacy entry with no witness data)
 * - 'secondhand': character was not present; caller applies secondhand framing or omits
 *
 * Legacy entries (witnessed_by empty or absent) are always treated as 'full' so
 * memories written before this system existed are unaffected.
 *
 * @param {Object} memory - Long-term memory entry.
 * @param {string} respondingChar - Name of the character being injected for.
 * @returns {'full'|'secondhand'}
 */
function shouldInjectMemory(memory, respondingChar) {
  if (!memory.witnessed_by || memory.witnessed_by.length === 0) return 'full';
  if (memory.witnessed_by.includes(respondingChar)) return 'full';
  return 'secondhand';
}

export async function injectMemories(characterName, updateTelemetry = false) {
  const settings = extension_settings[MODULE_NAME];
  const policy = getCharacterMemoryPolicy(characterName);

  if (!settings.longterm_enabled || !characterName || policy === CHARACTER_MEMORY_POLICIES.DISABLED) {
    setMacroContent(MACRO_NAMES.longterm, '');
    setMacroContent(MACRO_NAMES.triggered, '');
    setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
    setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_LONG);
    return;
  }

  // Only inject active memories - retired ones (superseded_by set) are kept in
  // storage for history but must not appear in the prompt.
  const memories = loadCharacterMemories(characterName).filter(
    (m) => !m.superseded_by && isGrounded(m),
  );
  if (memories.length === 0) {
    setMacroContent(MACRO_NAMES.longterm, '');
    setMacroContent(MACRO_NAMES.triggered, '');
    setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
    setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_LONG);
    return;
  }

  // Trim to token budget using hybrid scoring when current-turn context is
  // available. On chat load (updateTelemetry=false) there is no "current turn"
  // to read entity mentions from, so plain utility scoring is used instead.
  const budget = settings.longterm_inject_budget ?? 500;
  const fullTokens = estimateTokens(memories.map((m) => `- ${m.content}`).join('\n'));
  const protectedSet = new Set(
    selectProtectedMemories(memories, ['relationship', 'preference', 'fact']),
  );

  let trimmed;
  if (updateTelemetry) {
    // Post-extraction path: we have a fresh AI response to extract entity
    // mentions from. Build turn context for the hybrid scorer.
    const context = getContext();
    const lastMessages = (context.chat ?? []).slice(-2);
    const turnMentions = extractTurnEntityMentions(lastMessages);
    const entityRegistry = loadCharacterEntityRegistry(characterName);
    const recentTextForScorer = lastMessages
      .map((m) => m.mes || '')
      .join(' ')
      .toLowerCase();
    trimmed = await hybridPrioritize(memories, {
      turnMentions,
      entityRegistry,
      floorTypes: ['relationship', 'fact'],
      embedFn: getEmbeddingBatch,
      lastTurnText: lastMessages[lastMessages.length - 1]?.mes ?? '',
      w5: getHardwareProfile() === 'b' ? 0.6 : 0.2,
      recentText: recentTextForScorer,
    });
  } else {
    trimmed = prioritizeMemories(memories);
  }
  // Use the injection format for budget estimation so the check matches what is actually injected.
  while (
    trimmed.length > 1 &&
    estimateTokens(trimmed.map((m) => `- ${m.content}`).join('\n')) > budget
  ) {
    let idx = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (!protectedSet.has(trimmed[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      trimmed.splice(idx, 1);
    } else {
      break;
    }
  }

  // Diversity floor: cap entries per type so a flood of near-duplicate
  // variants of one type (e.g. many preference entries about the same topic)
  // cannot crowd out other types entirely. Cap is proportional to budget so
  // larger budgets allow more entries per type without being too restrictive.
  // Formula: max(2, floor(budget / 150)) gives 2 at 200 tokens, 3 at 500, 6 at 900.
  const perTypeCap = Math.max(2, Math.floor(budget / 150));
  const typeCount = new Map();
  const diversified = trimmed.filter((m) => {
    const count = typeCount.get(m.type) ?? 0;
    if (count >= perTypeCap) return false;
    typeCount.set(m.type, count + 1);
    return true;
  });
  trimmed.splice(0, trimmed.length, ...diversified);

  // Only update retrieval telemetry when called from a real AI response turn.
  // Skipping on chat load, settings changes etc. prevents the signal from
  // saturating too quickly and becoming meaningless.
  // Load the full (unfiltered) array so retired memories are preserved - the
  // filtered 'memories' variable only contains active entries and saving it
  // would permanently delete the retired pool.
  if (updateTelemetry) {
    const recalled = new Set(trimmed.map((m) => `${m.type}|${m.content}`));
    const allMemories = loadCharacterMemories(characterName);
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
    saveCharacterMemories(characterName, updated);
    saveSettingsDebounced();
  }

  // Build recentText for contextual matching: last few messages lowercased.
  // Used both here for the injection split and passed to hybridPrioritize above.
  const recentContext = getContext();
  const recentMsgs = (recentContext.chat ?? []).slice(-4);
  const recentText = recentMsgs
    .map((m) => m.mes || '')
    .join(' ')
    .toLowerCase();
  // Significant words only (4+ chars) to avoid spurious matches on short words.
  const recentWords = new Set(recentText.split(/\W+/).filter((w) => w.length >= 4));

  // Split trimmed into contextually relevant and regular memories.
  // A memory is considered contextually relevant when at least one significant
  // content word (3+ chars, non-stopword) appears in the recent turn text, OR
  // when any LLM-suggested trigger (Profile B) matches. Relevant memories are
  // placed at the end of the main block and also injected into the secondary
  // PROMPT_KEY_TRIGGERED slot closer to the prompt.
  const triggeredSet = new Set(
    trimmed.filter((m) => {
      // LLM-suggested triggers (Profile B): check first.
      if (Array.isArray(m.triggers) && m.triggers.some((t) => recentWords.has(t))) return true;
      // Content-word overlap (all profiles): any significant content word in recent turn.
      return [...keywordSet(m.content)].some((w) => recentWords.has(w));
    }),
  );
  const regular = trimmed.filter((m) => !triggeredSet.has(m));
  const triggered = trimmed.filter((m) => triggeredSet.has(m));
  const ordered = [...regular, ...triggered];

  // Format for injection: plain bullet list without [type] tags.
  // The [type] format is kept in formatMemoriesForPrompt for the extraction/consolidation
  // pipeline - those prompts need it. The RP model does not, and bracket notation
  // bleeds into story output when the model sees it repeatedly in context.
  //
  // Witnessed-by filter: memories the responding character did not witness are
  // downgraded to secondhand framing (opt-in, default on) or omitted entirely.
  // Legacy entries with no witnessed_by data are always injected normally.
  const template =
    settings.longterm_template || 'Memories from previous conversations:\n{{memories}}';
  const memoryLines = [];
  for (const m of ordered) {
    const witness = shouldInjectMemory(m, characterName);
    if (witness === 'full') {
      memoryLines.push(`- ${m.content}`);
    } else if (settings.epistemic_secondhand_framing !== false) {
      memoryLines.push(`- [secondhand] ${m.content}`);
    }
    // When epistemic_secondhand_framing is false, non-witnessed memories are omitted.
  }
  const memoryText = memoryLines.join('\n');
  const content = template.replace('{{memories}}', memoryText);

  reportTierTrimStats(PROMPT_KEY_LONG, estimateTokens(content), fullTokens);
  setMacroContent(MACRO_NAMES.longterm, content);
  if (isMacroActive(MACRO_NAMES.longterm)) {
    setExtensionPrompt(PROMPT_KEY_LONG, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_LONG);
    // PROMPT_KEY_TRIGGERED always uses setExtensionPrompt - macros do not cover it.
    // Fall through to the triggered injection block below.
  } else {
    setExtensionPrompt(
      PROMPT_KEY_LONG,
      content,
      settings.longterm_position ?? extension_prompt_types.IN_PROMPT,
      settings.longterm_depth ?? 2,
      false,
      settings.longterm_role ?? extension_prompt_roles.SYSTEM,
    );
  }

  // Secondary injection for contextually triggered memories, placed closer to
  // the prompt. Supports both setExtensionPrompt (depth-based) and macro mode
  // via {{smartmemory-enhanced-triggered}}. Cleared when no triggers fire.
  // Apply the same witnessed-by filter as the main block.
  if (triggered.length > 0) {
    const triggeredLines = [];
    for (const m of triggered) {
      const witness = shouldInjectMemory(m, characterName);
      if (witness === 'full') {
        triggeredLines.push(`- ${m.content}`);
      } else if (settings.epistemic_secondhand_framing !== false) {
        triggeredLines.push(`- [secondhand] ${m.content}`);
      }
    }
    if (triggeredLines.length === 0) {
      setMacroContent(MACRO_NAMES.triggered, '');
      setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', extension_prompt_types.NONE, 0);
      return;
    }
    const triggeredText = triggeredLines.join('\n');
    const triggeredContent = template.replace('{{memories}}', triggeredText);
    setMacroContent(MACRO_NAMES.triggered, triggeredContent);
    if (isMacroActive(MACRO_NAMES.triggered)) {
      setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', extension_prompt_types.NONE, 0);
    } else {
      setExtensionPrompt(
        PROMPT_KEY_TRIGGERED,
        triggeredContent,
        extension_prompt_types.IN_CHAT,
        settings.longterm_triggered_depth ?? 4,
        false,
        settings.longterm_role ?? extension_prompt_roles.SYSTEM,
      );
    }
  } else {
    setMacroContent(MACRO_NAMES.triggered, '');
    setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', extension_prompt_types.NONE, 0);
  }
}

// ---- Relationship history injection ------------------------------------

/**
 * Injects the current relationship history for a character into the prompt.
 * Only pairs whose names appear in the recent chat messages or are currently
 * in the active group are included - dormant relationships are not injected.
 *
 * Clears the slot when relationships are disabled, the character is unknown,
 * or no relevant pairs exist.
 *
 * @param {string|null} characterName - Current character name.
 * @param {boolean} [updateTelemetry=false] - Whether to update the token usage bar.
 */
export function injectRelationshipHistory(characterName, updateTelemetry = false) {
  const settings = extension_settings[MODULE_NAME];

  const clear = () => {
    setMacroContent(MACRO_NAMES.relationships, '');
    setExtensionPrompt(PROMPT_KEY_RELATIONSHIPS, '', extension_prompt_types.NONE, 0);
    if (updateTelemetry) updateRelationshipTelemetry(0);
  };

  if (!settings.relationships_enabled || !characterName || getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.DISABLED) return clear();

  const history = loadRelationshipHistory(characterName);
  const pairs = Object.entries(history).filter(([, state]) => isGeneratedRecordApproved(state));
  if (pairs.length === 0) return clear();

  // Build a set of names mentioned in recent messages to filter relevant pairs.
  const context = getContext();
  const recentMsgs = (context.chat ?? []).slice(-10);
  const recentText = recentMsgs
    .map((m) => m.mes || '')
    .join(' ')
    .toLowerCase();

  // Also include names of characters currently in a group chat.
  const groupNames = new Set();
  if (context.groupId) {
    const group = context.groups?.find((g) => g.id === context.groupId);
    if (group) {
      for (const avatarId of group.members ?? []) {
        const c = context.characters?.find((ch) => ch.avatar === avatarId);
        if (c?.name) groupNames.add(c.name.toLowerCase());
      }
    }
  }

  // A pair is relevant if either name appears in recent text or current group.
  const relevant = pairs.filter(([key]) => {
    const labels = getRelationshipHistoryPairDisplay(key, history[key]);
    const displaySubject = labels.subject.toLowerCase();
    const displayTarget = labels.target.toLowerCase();
    const [subject, target] = key.split('→').map((s) => s.trim().toLowerCase());
    return (
      recentText.includes(displaySubject) ||
      recentText.includes(displayTarget) ||
      groupNames.has(displaySubject) ||
      groupNames.has(displayTarget)
    );
  });

  if (relevant.length === 0) return clear();

  const budget = settings.relationships_inject_budget ?? 250;
  const fullRelLines = relevant.map(
    ([key, state]) =>
      `${getRelationshipHistoryPairDisplay(key, state).subject} → ${getRelationshipHistoryPairDisplay(key, state).target}: ${(state.descriptors ?? []).map((d) => `${d.word}(${d.magnitude})`).join(', ')}`,
  );
  const fullTokens = estimateTokens(fullRelLines.join('\n'));
  const lines = [];
  let tokens = 0;
  for (const [key, state] of relevant) {
    const labels = getRelationshipHistoryPairDisplay(key, state);
    const line = `${labels.subject} → ${labels.target}: ${(state.descriptors ?? []).map((d) => `${d.word}(${d.magnitude})`).join(', ')}`;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > budget) break;
    lines.push(line);
    tokens += lineTokens;
  }

  if (lines.length === 0) return clear();

  const template = settings.relationships_template || 'Relationship history:\n{{relationships}}';
  const content = template.replace('{{relationships}}', lines.join('\n'));
  reportTierTrimStats(PROMPT_KEY_RELATIONSHIPS, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.relationships, content);
  if (isMacroActive(MACRO_NAMES.relationships)) {
    setExtensionPrompt(PROMPT_KEY_RELATIONSHIPS, '', extension_prompt_types.NONE, 0);
    if (updateTelemetry) updateRelationshipTelemetry(estimateTokens(content));
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_RELATIONSHIPS,
    content,
    settings.relationships_position ?? extension_prompt_types.IN_CHAT,
    settings.relationships_depth ?? 5,
    false,
    settings.relationships_role ?? extension_prompt_roles.SYSTEM,
  );

  if (updateTelemetry) updateRelationshipTelemetry(estimateTokens(content));
}

/**
 * Stub called when relationship telemetry needs updating.
 * The actual token bar update is wired in ui.js via the updateTelemetry callback.
 * This is a no-op here - the token bar is updated by the caller passing updateTelemetry=true
 * which triggers the ui.js side via the existing telemetry refresh path.
 * @param {number} _tokens
 */
function updateRelationshipTelemetry(_tokens) {
  // Telemetry is handled by the existing refreshTokenBar call in index.js
  // after each injection cycle. No separate wiring needed here.
}

// ---- Fresh-start helpers ------------------------------------------------

/**
 * Returns whether the current chat has fresh-start enabled.
 * When true, long-term memories are not injected for this chat.
 * @returns {boolean}
 */
export function isFreshStart() {
  const context = getContext();
  return context.chatMetadata?.[META_KEY]?.freshStart === true;
}

/**
 * Toggles the fresh-start flag for the current chat and saves chatMetadata.
 * @param {boolean} value
 */
export async function setFreshStart(value) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  context.chatMetadata[META_KEY].freshStart = value;
  await saveChatMetadata(context);
}

/**
 * Returns the chat message index at which read-only mode was last enabled,
 * or null if not set. Used to determine which messages to ghost on disable.
 * @returns {number|null}
 */
export function getReadOnlyStartIndex() {
  const context = getContext();
  const val = context.chatMetadata?.[META_KEY]?.readOnlyStartIndex;
  return typeof val === 'number' ? val : null;
}

/**
 * Stores or clears the read-only window start index.
 * When enabling (index is a number), also records the current Unix ms timestamp
 * so session memories accumulated during the window can be purged by time on disable.
 * When disabling (index is null), clears both the index and the timestamp.
 * @param {number|null} index
 */
export async function setReadOnlyStartIndex(index) {
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  if (index === null) {
    delete context.chatMetadata[META_KEY].readOnlyStartIndex;
    delete context.chatMetadata[META_KEY].readOnlyStartTime;
  } else {
    context.chatMetadata[META_KEY].readOnlyStartIndex = index;
    context.chatMetadata[META_KEY].readOnlyStartTime = Date.now();
  }
  await saveChatMetadata(context);
}

/**
 * Returns the Unix ms timestamp at which read-only mode was last enabled,
 * or null if not set. Used to purge session memories that leaked in during
 * a read-only window when the mode is disabled.
 * @returns {number|null}
 */
export function getReadOnlyStartTime() {
  const context = getContext();
  const val = context.chatMetadata?.[META_KEY]?.readOnlyStartTime;
  return typeof val === 'number' ? val : null;
}
