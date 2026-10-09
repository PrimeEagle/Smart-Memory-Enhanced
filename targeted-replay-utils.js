import { sourceWindowFingerprint } from './extraction-window-utils.js';

export const TARGETED_REPLAY_SCHEMA_VERSION = 1;

const integer = (value) => Number.isInteger(Number(value)) ? Number(value) : null;

/** Builds privacy-safe, exact replay candidates from unresolved obligations. */
export function buildTargetedReplayCandidates(providerSummary, {
  chat = [], chatId = null, configurationSignature = null, allowedOwners = null,
} = {}) {
  return (providerSummary?.terminal_unresolved_obligations ?? []).map((obligation) => {
    const start = integer(obligation?.source_range?.start);
    const end = integer(obligation?.source_range?.end);
    const owner = String(obligation?.owner ?? '').trim();
    const sourceMessages = start !== null && end !== null && end >= start
      ? chat.slice(start, end + 1)
        .map((message, offset) => ({ ...message, __sme_original_index: start + offset }))
        .filter((message) => message?.mes && !message?.is_system)
      : [];
    const actualFingerprint = sourceMessages.length ? sourceWindowFingerprint(sourceMessages) : null;
    const reasons = [];
    if (obligation?.tier !== 'longterm') reasons.push('unsupported_tier');
    if (!obligation?.targeted_replay_eligible) reasons.push('obligation_not_replay_eligible');
    if (!owner) reasons.push('owner_missing');
    if (allowedOwners && !allowedOwners.includes(owner)) reasons.push('owner_not_in_current_chat_scope');
    if (start === null || end === null || end < start) reasons.push('invalid_source_range');
    if (!sourceMessages.length) reasons.push('source_range_empty');
    if (integer(obligation?.source_range?.message_count) !== null
      && integer(obligation.source_range.message_count) !== sourceMessages.length) reasons.push('source_message_count_mismatch');
    if (!obligation?.source_fingerprint) reasons.push('source_fingerprint_missing');
    if (actualFingerprint && obligation?.source_fingerprint !== actualFingerprint) reasons.push('source_fingerprint_mismatch');
    if (!chatId) reasons.push('chat_identity_missing');
    if (obligation?.chat_id && chatId && obligation.chat_id !== chatId) reasons.push('chat_identity_mismatch');
    if (obligation?.configuration_signature && configurationSignature
      && obligation.configuration_signature !== configurationSignature) reasons.push('provider_configuration_changed');
    return {
      schema_version: TARGETED_REPLAY_SCHEMA_VERSION,
      root_obligation_id: obligation?.root_obligation_id ?? null,
      tier: obligation?.tier ?? null,
      owner,
      source_range: start === null || end === null ? null : {
        start, end, message_count: sourceMessages.length,
      },
      source_fingerprint: obligation?.source_fingerprint ?? null,
      current_source_fingerprint: actualFingerprint,
      chat_id: chatId,
      configuration_signature: configurationSignature,
      original_configuration_signature: obligation?.configuration_signature ?? null,
      configuration_validation: obligation?.configuration_signature
        ? 'matched_current_configuration' : 'unavailable_for_legacy_obligation',
      eligible: reasons.length === 0,
      rejection_reasons: reasons,
      source_messages: sourceMessages,
      prior_authoritative_memory_preserved: obligation?.prior_authoritative_memory_preserved !== false,
      malformed_reason: obligation?.malformed_reason ?? null,
    };
  });
}

export function createTargetedReplayCheckpoint(candidates, {
  chatId = null, configurationSignature = null, runId = null, now = Date.now(),
} = {}) {
  return {
    schema_version: TARGETED_REPLAY_SCHEMA_VERSION,
    replay_run_id: runId ?? `targeted-replay-${now}`,
    chat_id: chatId,
    configuration_signature: configurationSignature,
    status: 'in_progress',
    created_at: now,
    updated_at: now,
    targets: candidates.map((candidate) => ({
      root_obligation_id: candidate.root_obligation_id,
      tier: candidate.tier, owner: candidate.owner,
      source_range: candidate.source_range,
      source_fingerprint: candidate.source_fingerprint,
      terminal_outcome: 'pending', attempts: 0, added_memories: 0,
    })),
  };
}

export function updateTargetedReplayCheckpoint(checkpoint, rootObligationId, patch = {}, now = Date.now()) {
  return {
    ...checkpoint,
    updated_at: now,
    targets: (checkpoint?.targets ?? []).map((target) => target.root_obligation_id === rootObligationId
      ? { ...target, ...patch, attempts: Number(target.attempts ?? 0) + (patch.attempted ? 1 : 0), attempted: undefined }
      : target),
  };
}

export function summarizeTargetedReplayCheckpoint(checkpoint) {
  const targets = checkpoint?.targets ?? [];
  const count = (outcome) => targets.filter((target) => target.terminal_outcome === outcome).length;
  return {
    schema_version: checkpoint?.schema_version ?? TARGETED_REPLAY_SCHEMA_VERSION,
    replay_run_id: checkpoint?.replay_run_id ?? null,
    status: checkpoint?.status ?? 'not_run',
    requested: targets.length,
    completed: count('completed') + count('completed_no_candidates'),
    failed: count('failed'),
    pending: count('pending') + count('running'),
    added_memories: targets.reduce((sum, target) => sum + Number(target.added_memories ?? 0), 0),
    targets: targets.map((target) => ({
      root_obligation_id: target.root_obligation_id,
      tier: target.tier, owner: target.owner, source_range: target.source_range,
      source_fingerprint: target.source_fingerprint, terminal_outcome: target.terminal_outcome,
      attempts: target.attempts, added_memories: target.added_memories,
      normalized_error_type: target.normalized_error_type ?? null,
    })),
  };
}
