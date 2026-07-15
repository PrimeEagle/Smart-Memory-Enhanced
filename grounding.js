/** Grounding helpers for newly extracted memories. */
export function applyDirectProvenance(memories, recentMessages, chatWindowStart) {
  for (const memory of memories) {
    const claimedIndices = memory.source_message_indices ?? [];
    const indices = [...new Set(claimedIndices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < recentMessages.length,
    ))];
    const hasMalformedClaim = claimedIndices.length > 0 && indices.length !== claimedIndices.length;
    if (indices.length === 0 || hasMalformedClaim) {
      memory.grounding_status = 'ungrounded';
      memory.source_messages = [];
      memory.validation_status = 'needs_review';
      memory.validation_issues = hasMalformedClaim
        ? ['One or more claimed source messages are outside this extraction chunk.']
        : ['No valid source messages were supplied.'];
      continue;
    }
    memory.grounding_status = 'direct';
    memory.source_message_indices = indices;
    memory.validation_status = 'validated';
    memory.validation_issues = [];
    memory.source_messages = indices.map((index) => {
      const absoluteIndex = chatWindowStart + index;
      return [absoluteIndex, absoluteIndex];
    });
  }
  return memories;
}

export function isGrounded(memory) {
  // Legacy records predate provenance and remain readable. A user can also
  // explicitly approve a reviewed record, which is then safe to propagate.
  return memory?.grounding_status !== 'ungrounded' || memory?.validation_status === 'approved';
}
