import { sourceWindowFingerprint } from './extraction-window-utils.js';

export const TARGETED_REPLAY_SCHEMA_VERSION = 2;

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
      original_attempt_id: obligation?.original_attempt_id ?? null,
      repair_attempt_id: obligation?.repair_attempt_id ?? null,
      original_run_id: obligation?.run_id ?? providerSummary?.run_id ?? null,
    };
  });
}

export function createTargetedReplayCheckpoint(candidates, {
  chatId = null, configurationSignature = null, runId = null, now = Date.now(),
  prior = null, selectionReason = 'operator_selected_terminal_malformed_obligations',
  originalRunId = null, statusClassificationBefore = null,
} = {}) {
  const canResume = prior?.status === 'in_progress'
    && prior?.chat_id === chatId
    && prior?.configuration_signature === configurationSignature;
  const priorTargets = new Map((canResume ? prior.targets : []).map((target) => [target.root_obligation_id, target]));
  const replayRunId = canResume ? prior.replay_run_id : runId ?? `targeted-replay-${now}`;
  return {
    schema_version: TARGETED_REPLAY_SCHEMA_VERSION,
    replay_run_id: replayRunId,
    invocation_id: `${replayRunId}-invocation-${Number(prior?.invocation_count ?? 0) + 1}`,
    invocation_count: Number(prior?.invocation_count ?? 0) + 1,
    chat_id: chatId,
    configuration_signature: configurationSignature,
    selection_reason: selectionReason,
    selected_obligation_ids: candidates.map((candidate) => candidate.root_obligation_id),
    original_run_id: originalRunId,
    status_classification_before: statusClassificationBefore,
    status: 'in_progress',
    created_at: canResume ? prior.created_at : now,
    resumed_interrupted_invocation: canResume,
    updated_at: now,
    targets: candidates.map((candidate) => {
      const previous = priorTargets.get(candidate.root_obligation_id);
      return {
        root_obligation_id: candidate.root_obligation_id,
        tier: candidate.tier, owner: candidate.owner,
        source_range: candidate.source_range,
        source_fingerprint: candidate.source_fingerprint,
        original_attempt_id: candidate.original_attempt_id ?? null,
        repair_attempt_id: candidate.repair_attempt_id ?? null,
        original_run_id: candidate.original_run_id ?? originalRunId,
        terminal_outcome: previous?.terminal_outcome === 'completed' ? 'completed' : 'pending',
        attempts: Number(previous?.attempts ?? 0),
        added_memories: Number(previous?.added_memories ?? 0),
        restored_in_flight_as_pending: previous?.terminal_outcome === 'running',
        provider_outcome: previous?.provider_outcome ?? 'not_started',
        parse_repair_outcome: previous?.parse_repair_outcome ?? 'not_started',
        persistence_outcome: previous?.persistence_outcome ?? 'not_started',
      };
    }),
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
    invocation_id: checkpoint?.invocation_id ?? null,
    invocation_count: checkpoint?.invocation_count ?? 0,
    selection_reason: checkpoint?.selection_reason ?? null,
    selected_obligation_ids: checkpoint?.selected_obligation_ids ?? [],
    original_run_id: checkpoint?.original_run_id ?? null,
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
      original_attempt_id: target.original_attempt_id ?? null,
      repair_attempt_id: target.repair_attempt_id ?? null,
      original_run_id: target.original_run_id ?? null,
      provider_outcome: target.provider_outcome ?? null,
      parse_repair_outcome: target.parse_repair_outcome ?? null,
      persistence_outcome: target.persistence_outcome ?? null,
      restored_in_flight_as_pending: Boolean(target.restored_in_flight_as_pending),
    })),
    before_unresolved_count: checkpoint?.before_unresolved_count ?? null,
    after_unresolved_count: checkpoint?.after_unresolved_count ?? null,
    recovered_obligation_ids: checkpoint?.recovered_obligation_ids ?? [],
    still_unresolved_obligation_ids: checkpoint?.still_unresolved_obligation_ids ?? [],
    status_classification_before: checkpoint?.status_classification_before ?? null,
    status_classification_after: checkpoint?.status_classification_after ?? null,
  };
}
