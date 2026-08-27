/** Pure validation for durable, crash-safe Memorize Chat checkpoints. */
export function normalizeCatchUpCheckpoint(checkpoint) {
  if (!checkpoint || !['in_progress', 'awaiting_manual_resume'].includes(checkpoint.status)) return null;
  const total = Number(checkpoint.source_message_count);
  const offset = Number(checkpoint.next_source_offset);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(offset) || offset < 0 || offset > total) return null;
  return { ...checkpoint, source_message_count: total, next_source_offset: offset };
}

/**
 * Verifies that the exact original source window is still available.
 * A resumed rebuild must never silently consume messages appended afterward
 * or skip/duplicate a changed historical window.
 */
export function validateCatchUpResumeSource(checkpoint, messages = []) {
  const normalized = normalizeCatchUpCheckpoint(checkpoint);
  if (!normalized) return { valid: false, reason: 'missing_or_invalid_checkpoint' };
  if (messages.length < normalized.source_message_count) {
    return { valid: false, reason: 'source_window_shorter_than_checkpoint' };
  }
  if (normalized.source_message_count > 0) {
    const boundary = messages[normalized.source_message_count - 1];
    if (boundary?.__sme_original_index !== normalized.source_last_original_index) {
      return { valid: false, reason: 'source_window_boundary_changed' };
    }
  }
  return {
    valid: true,
    source_message_count: normalized.source_message_count,
    resume_offset: normalized.next_source_offset,
  };
}
