/** Grounding helpers for newly extracted memories. */
export function applyDirectProvenance(memories, recentMessages, chatWindowStart) {
  for (const memory of memories) {
    const indices = (memory.source_message_indices ?? []).filter(
      (index) => Number.isInteger(index) && index >= 0 && index < recentMessages.length,
    );
    if (indices.length === 0) {
      memory.grounding_status = 'ungrounded';
      memory.source_messages = [];
      continue;
    }
    memory.grounding_status = 'direct';
    memory.source_message_indices = indices;
    memory.source_messages = indices.map((index) => {
      const absoluteIndex = chatWindowStart + index;
      return [absoluteIndex, absoluteIndex];
    });
  }
  return memories;
}

export function isGrounded(memory) {
  // Legacy records predate provenance and remain readable. Only records
  // explicitly classified as ungrounded are quarantined from propagation.
  return memory?.grounding_status !== 'ungrounded';
}
