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
} from '../../../../script.js';
import { generateMemoryExtract } from './generate.js';
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
  if (!settings.session_enabled) return 0;
  const sessionDiagnostics = options.sessionDiagnostics;
  let parsedCandidateCount = 0;
  let terminalCandidateCount = 0;
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

    if (!chatHistory.trim()) return 0;

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

    const response = await generateMemoryExtract(
      applyPromptOverride(
        buildSessionExtractionPrompt(chatHistory, existingText, longtermText, formatCanonicalRosterForPrompt(buildCanonicalCharacterRoster(getContext()))),
        PROMPT_TASKS.SESSION_EXTRACTION,
        characterName,
      ),
      { responseLength: settings.session_response_length ?? 500 },
    );

    smLog('[Smart Memory Enhanced] Session extraction response:', response);

    if (!response || response.trim().toUpperCase() === 'NONE') {
      if (sessionDiagnostics) sessionDiagnostics.providerReturnedNone = (sessionDiagnostics.providerReturnedNone ?? 0) + 1;
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
    const parsedCandidates = parseSessionOutput(response);
    // Stable within-request IDs make citation repair an association task rather
    // than a best-effort text match. They are transient and never persisted in
    // a memory record or exported with memory text.
    for (const [index, candidate] of parsedCandidates.entries()) {
      // The diagnostics object lives for the full catch-up run, so its
      // monotonically increasing sequence avoids reusing session-1/session-2
      // in every chunk. This is required for a true one-terminal-record-per-
      // candidate audit across a long imported chat.
      const sequence = sessionDiagnostics
        ? (sessionDiagnostics._citation_candidate_sequence = Number(sessionDiagnostics._citation_candidate_sequence ?? 0) + 1)
        : index + 1;
      candidate._citation_candidate_id ??= `session-${sequence}`;
    }
    const initiallyParsedCount = parsedCandidates.length;
    const terminalRecords = new Map();
    const recordTerminalCandidate = (candidate, disposition, reason = null) => {
      const candidateId = candidate?._citation_candidate_id;
      if (!candidateId || terminalRecords.has(candidateId)) return false;
      terminalRecords.set(candidateId, { candidate_id: candidateId, terminal_disposition: disposition, reason });
      return true;
    };
    parsedCandidateCount = initiallyParsedCount;
    // A non-empty provider response that yields no structured records is not
    // the same as an intentional NONE. Keep the catch-up running, but expose
    // it as a parser-quality failure instead of reporting a clean empty pass.
    if (initiallyParsedCount === 0) {
      if (sessionDiagnostics) sessionDiagnostics.malformedOutput = (sessionDiagnostics.malformedOutput ?? 0) + 1;
      smLog('[Smart Memory Enhanced] Session extraction returned no parseable structured records.');
      return 0;
    }
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
      const uncitedLines = uncitedCandidates.map((candidate) => {
        const entities = (candidate._raw_entity_names ?? []).length ? `:entity=${candidate._raw_entity_names.join(',')}` : '';
        candidate._citation_claim_hash ??= stableCitationClaimHash(candidate);
        return `[${candidate.type}:${candidate.importance}:${candidate.expiration}:candidate_id=${candidate._citation_candidate_id}:claim_hash=${candidate._citation_claim_hash}${entities}] ${candidate.content}`;
      }).join('\n');
      const repairPrompt = `[SESSION CITATION REPAIR - Output structured data only.]\n\nThe following session-memory items were already extracted from the numbered source excerpt below, but their required citations were omitted. Return exactly one line per supplied candidate_id. Preserve candidate_id and claim_hash exactly. The original stored candidate is authoritative: its claim will never be replaced from your response. Add :sources= with one or more supporting indices from the excerpt inside every bracket. Do not add, remove, reword, or combine memories; do not reorder them. Output NONE only if none can be cited.\n\nSOURCE EXCERPT:\n${chatHistory}\n\nITEMS TO CITE:\n${uncitedLines}\n\nOutput only corrected bracketed memory lines.`;
      const parseRepairAssociations = (raw) => {
        const bracketed = parseSessionOutput(raw);
        if (bracketed.length) return bracketed;
        const records = [];
        const append = (id, sources, claimHash = null) => {
          const normalizedId = String(id ?? '').trim().replace(/^['"]|['"]$/g, '');
          const indices = [...new Set((Array.isArray(sources) ? sources : String(sources ?? '').split(/[\s,]+/))
            .map((value) => Number(value)).filter(Number.isInteger))];
          if (normalizedId && indices.length) records.push({ _citation_candidate_id: normalizedId, _citation_claim_hash: claimHash ? String(claimHash).trim() : null, source_message_indices: indices, _repair_association_only: true });
        };
        for (const line of String(raw ?? '').split(/\r?\n/)) {
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) for (const item of parsed) append(item?.candidate_id, item?.citations ?? item?.sources, item?.claim_hash);
            else append(parsed?.candidate_id, parsed?.citations ?? parsed?.sources, parsed?.claim_hash);
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
          const parsedRepair = parseRepairAssociations(repairedResponse);
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
              else if (original) { invalidCitations++; recordRepairReason('empty_citation_set'); }
              else { unmatchedCandidates++; recordRepairReason(candidate._citation_claim_hash ? 'claim_hash_unmatched' : candidateId ? 'candidate_id_unmatched' : 'provider_record_malformed'); }
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
        rejected_after_association_by_reason: cumulativeValidation.terminal_reason_counts,
        persisted: priorPostAssociation.persisted + acceptedAfterRepair,
        accounting_reconciled: (priorPostAssociation.associated_valid + repairRecovered) === (priorPostAssociation.accepted_after_validation + acceptedAfterRepair) + (priorPostAssociation.rejected_after_association + postAssociationRejected),
      };
      sessionDiagnostics.claim_hash_association = {
        hashes_sent: repairEligibleCount,
        hashes_returned: parsedCandidates.filter((candidate) => candidate._citation_claim_hash).length,
        exact_hash_matches: claimHashRecoveries,
        normalized_hash_matches: 0,
        missing_hashes: Math.max(0, repairEligibleCount - parsedCandidates.filter((candidate) => candidate._citation_claim_hash).length),
        unknown_hashes: repairValidation.terminal_reason_counts.claim_hash_unmatched ?? 0,
        ambiguous_hashes: 0,
        recoveries_attempted: repairEligibleCount,
        recoveries_completed: claimHashRecoveries,
      };
    }
    if (incoming.length === 0) return 0;

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
      if (!abortCheck?.()) await saveSessionEntityRegistry(entityRegistry);
    }

    // Newly retired active memories move to the retired pool.
    let updatedRetired = [...retiredMemories, ...existing.filter((m) => newlyRetiredIds.has(m.id))];

    // Cap the retired pool - same reason as longterm.js.
    if (updatedRetired.length > MAX_RETIRED_POOL) {
      updatedRetired = updatedRetired.slice(updatedRetired.length - MAX_RETIRED_POOL);
    }

    const added = finalActive.filter((m) => !existingKeys.has(`${m.type}|${m.content}`)).length;
    if (abortCheck?.()) return 0;
    await saveSessionMemories([...finalActive, ...updatedRetired]);

    return added;
  } catch (err) {
    if (sessionDiagnostics) {
      sessionDiagnostics.providerFailures = (sessionDiagnostics.providerFailures ?? 0) + 1;
      // A request can fail after its initial response was parsed (for example,
      // during embedding verification). Give every affected parsed candidate
      // a terminal outcome so diagnostics still reconcile exactly.
      recordDisposition('provider_or_parser_error', Math.max(0, parsedCandidateCount - terminalCandidateCount));
    }
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
