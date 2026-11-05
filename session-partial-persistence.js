/** Identity-backed verification for committed partial Session records. */
export function shouldVerifyPersistedPartialSessionRecords({
  canonical_obligation = null,
  recovery_state = null,
  selected_range = null,
  selected_action = null,
} = {}) {
  if (canonical_obligation?.checkpoint_eligible === true) return false;
  if (!canonical_obligation || canonical_obligation.current_state !== 'pending_recovery') return false;
  if (!recovery_state?.resume_unresolved_obligation) return false;
  if (!(recovery_state?.unresolved_semantic_units ?? []).length) return false;
  if (!(recovery_state?.durably_persisted_record_ids
    ?? recovery_state?.accepted_record_ids ?? []).length) return false;
  if (!selected_action) return false;
  if (!canonical_obligation.obligation_id || !canonical_obligation.source_fingerprint) return false;
  if (String(recovery_state.root_obligation_id ?? '')
    !== String(canonical_obligation.obligation_id)) return false;
  if (String(recovery_state.source_fingerprint ?? '')
    !== String(canonical_obligation.source_fingerprint)) return false;
  if (recovery_state.selected_recovery_action
    && recovery_state.selected_recovery_action !== selected_action) return false;
  const start = Number(selected_range?.start);
  const end = Number(selected_range?.end);
  const canonicalRangeMatches = Number(canonical_obligation.source_range?.start) === start
    && Number(canonical_obligation.source_range?.end) === end;
  const recoveryRange = recovery_state.source_range;
  const recoveryRangeMatches = !recoveryRange
    || (Number(recoveryRange.start ?? recoveryRange.start_offset) === start
      && Number(recoveryRange.end ?? recoveryRange.end_offset) === end);
  return canonicalRangeMatches && recoveryRangeMatches;
}

export function verifyPersistedPartialSessionRecords(memories = [], recoveryState = null, range = {}) {
  const expectedIds = new Set((recoveryState?.durably_persisted_record_ids
    ?? recoveryState?.accepted_record_ids ?? []).map(String));
  const aliases = recoveryState?.durable_record_aliases ?? {};
  const resolvedExpectedIds = new Map([...expectedIds].map((id) =>
    [id, String(aliases[id] ?? id)]));
  const expectedCount = expectedIds.size;
  const candidates = memories.filter((memory) =>
    [...resolvedExpectedIds.values()].includes(String(memory?.id)));
  const verified = candidates.filter((memory) =>
    [...resolvedExpectedIds.values()].includes(String(memory?.id)));
  return {
    verified: expectedIds.size > 0
      && verified.length === expectedIds.size && [...resolvedExpectedIds.values()]
        .every((id) => verified.some((memory) => String(memory?.id) === id)),
    expected_count: expectedCount,
    verified_count: verified.length,
    record_ids: verified.map((memory) => memory.id).filter(Boolean),
    reconstruction: expectedIds.size
      ? Object.keys(aliases).length ? 'durable_record_ids_with_explicit_aliases' : 'durable_record_ids'
      : 'missing_durable_record_identity',
    aliases_applied: Object.fromEntries([...resolvedExpectedIds]
      .filter(([from, to]) => from !== to)),
  };
}
