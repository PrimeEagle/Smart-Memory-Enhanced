/** Grounding helpers for newly extracted memories. */
import { normalizeMemoryProvenance, prepareRecordForValidation, validateMemoryAncestry } from './record-validation.js';

const SEMANTIC_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'among', 'because', 'before', 'being', 'between', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'some', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'through', 'very', 'were', 'what', 'when', 'which', 'with', 'would', 'your', 'you', 'the', 'and', 'for', 'are', 'was', 'his', 'her', 'she', 'him', 'its', 'our', 'but', 'not', 'who', 'had', 'has', 'been', 'will', 'can', 'did', 'does', 'then', 'them', 'out', 'all', 'any', 'one', 'two', 'three',
]);

function meaningfulTerms(text) {
  return new Set((String(text ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
    .filter((term) => term.length >= 4 && !SEMANTIC_STOP_WORDS.has(term)));
}

/**
 * A deliberately conservative citation sanity check. It does not attempt to
 * prove a claim true; it only detects citations whose source text shares no
 * meaningful term with the generated record. Empty/unreadable source messages
 * are left to normal provenance validation rather than falsely quarantined.
 */
export function validateCitationSemanticSupport(memory, sourceMessages = []) {
  const claimTerms = meaningfulTerms(memory?.content);
  const evidenceTerms = meaningfulTerms(sourceMessages.map((message) => message?.mes ?? message?.content ?? '').join('\n'));
  if (claimTerms.size === 0 || evidenceTerms.size === 0) return { checked: false, supported: true, overlap: [] };
  const overlap = [...claimTerms].filter((term) => evidenceTerms.has(term));
  if (overlap.length > 0) return { checked: true, supported: true, overlap };
  memory.grounding_status = 'ungrounded';
  memory.validation_status = 'needs_review';
  memory.validation_issues = [...new Set([...(memory.validation_issues ?? []), 'Cited source messages have no meaningful term overlap with this generated claim.'])];
  return { checked: true, supported: false, overlap: [] };
}

export function applyDirectProvenance(memories, recentMessages, chatWindowStart, originalMessageIndices = null) {
  const sourceIndices = recentMessages.map((_, index) => originalMessageIndices?.[index] ?? (chatWindowStart + index));
  for (const memory of memories) {
    prepareRecordForValidation(memory, {
      originalMessageIndices,
      sourceOffset: chatWindowStart,
      sourceLength: recentMessages.length,
      indicesAreRelative: true,
    });
    if (memory.grounding_status === 'ungrounded') continue;
    const citedMessages = recentMessages.filter((_, index) => memory.source_message_indices.includes(sourceIndices[index]));
    validateCitationSemanticSupport(memory, citedMessages);
  }
  return memories;
}

export function validateGeneratedMemoryRecord(memory, memoryStore = []) {
  normalizeMemoryProvenance(memory);
  const ancestry = validateMemoryAncestry(memory.id, memory.parent_memory_ids, memoryStore);
  memory.parent_memory_ids = ancestry.parentIds;
  if (!ancestry.valid) {
    memory.grounding_status = 'ungrounded';
    memory.validation_status = 'needs_review';
    memory.validation_issues = [...new Set([...(memory.validation_issues ?? []), ...ancestry.issues])];
  }
  return ancestry;
}

export function isGrounded(memory) {
  // Legacy records predate provenance and remain readable. A user can also
  // explicitly approve a reviewed record, which is then safe to propagate.
  return memory?.grounding_status !== 'ungrounded' || memory?.validation_status === 'approved';
}
