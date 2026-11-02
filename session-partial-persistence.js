/** Identity-backed verification for committed partial Session records. */
export function verifyPersistedPartialSessionRecords(memories = [], recoveryState = null, range = {}) {
  const expectedIds = new Set((recoveryState?.durably_persisted_record_ids
    ?? recoveryState?.accepted_record_ids ?? []).map(String));
  const expectedCount = expectedIds.size || Number(recoveryState?.durable_partial_record_count ?? 0);
  const start = Number(range.start);
  const end = Number(range.end);
  const candidates = memories.filter((memory) => {
    if (expectedIds.size && expectedIds.has(String(memory?.id))) return true;
    return (memory?.source_message_indices ?? []).some((index) => Number(index) >= start && Number(index) <= end);
  });
  const verified = expectedIds.size
    ? candidates.filter((memory) => expectedIds.has(String(memory?.id)))
    : candidates.slice(-expectedCount);
  return {
    verified: expectedIds.size > 0
      ? verified.length === expectedIds.size && [...expectedIds]
        .every((id) => verified.some((memory) => String(memory?.id) === id))
      : expectedCount === 0 || verified.length >= expectedCount,
    expected_count: expectedCount,
    verified_count: verified.length,
    record_ids: verified.map((memory) => memory.id).filter(Boolean),
    reconstruction: expectedIds.size ? 'durable_record_ids' : 'durable_count_with_source_provenance',
  };
}
