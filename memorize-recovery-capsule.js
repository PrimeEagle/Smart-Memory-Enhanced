/** Durable, privacy-preserving recovery inputs for one exact obligation leaf. */

export const MEMORIZE_RECOVERY_CAPSULE_SCHEMA_VERSION = 1;

const uniqueStrings = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value ?? '').trim()).filter(Boolean))];

function normalizedRange(value = {}) {
  const start = Number(value.start ?? value.source_start_index);
  const end = Number(value.end ?? value.source_end_index);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  return Object.freeze({ start, end, message_count: Number(value.message_count) || end - start + 1 });
}

export function createMemorizeRecoveryCapsule(input = {}) {
  const sourceRange = normalizedRange(input.source_range);
  if (!input.logical_run_id || !input.obligation_leaf_id || !sourceRange
    || !String(input.source_fingerprint ?? '').trim()) {
    throw Object.assign(new Error('Recovery capsule requires an exact run, leaf, source range, and fingerprint.'), {
      code: 'SME_INVALID_RECOVERY_CAPSULE_IDENTITY',
    });
  }
  const privatePayloadAvailable = input.private_fragment_payload_available === true;
  const sourceBackedAvailable = input.source_backed_regeneration_available !== false;
  return Object.freeze({
    schema_version: MEMORIZE_RECOVERY_CAPSULE_SCHEMA_VERSION,
    logical_run_id: String(input.logical_run_id),
    obligation_leaf_id: String(input.obligation_leaf_id),
    root_obligation_id: String(input.root_obligation_id ?? input.obligation_leaf_id),
    tier: String(input.tier ?? ''),
    owner: input.owner ?? null,
    source_range: sourceRange,
    source_fingerprint: String(input.source_fingerprint),
    accepted_candidate_fingerprints: Object.freeze(uniqueStrings(input.accepted_candidate_fingerprints)),
    durable_record_ids: Object.freeze(uniqueStrings(input.durable_record_ids)),
    durable_record_candidate_map: Object.freeze({ ...(input.durable_record_candidate_map ?? {}) }),
    rejected_fragment_ids: Object.freeze(uniqueStrings(input.rejected_fragment_ids)),
    recovery_stage: input.recovery_stage ?? 'source_backed_regeneration',
    protocol: input.protocol ?? null,
    producing_attempt_id: input.producing_attempt_id ?? null,
    provider_profile_signature: input.provider_profile_signature ?? null,
    private_fragment_payload_available: privatePayloadAvailable,
    source_backed_regeneration_available: sourceBackedAvailable,
    regeneration_recipe: Object.freeze({
      kind: 'verified_source_window_regeneration',
      source_range: sourceRange,
      source_fingerprint: String(input.source_fingerprint),
      exclude_candidate_fingerprints: Object.freeze(uniqueStrings(
        input.regeneration_recipe?.exclude_candidate_fingerprints
          ?? input.accepted_candidate_fingerprints)),
      exclude_durable_record_ids: Object.freeze(uniqueStrings(
        input.regeneration_recipe?.exclude_durable_record_ids ?? input.durable_record_ids)),
      dedupe_required: true,
      verify_source_fingerprint: true,
    }),
    created_at: Number(input.created_at) || Date.now(),
  });
}

export function assessMemorizeRecoveryCapsule(capsule = null) {
  if (!capsule) return Object.freeze({ executable: false,
    reason_code: 'missing_recovery_capsule', next_action: null });
  if (capsule.private_fragment_payload_available === true) return Object.freeze({
    executable: true,
    reason_code: 'private_fragment_payload_available',
    next_action: 'recover_unresolved_partial_output_fragments',
    provider_call_required: true,
  });
  if (capsule.source_backed_regeneration_available === true
    && capsule.regeneration_recipe?.verify_source_fingerprint === true
    && capsule.source_range && capsule.source_fingerprint) return Object.freeze({
    executable: true,
    reason_code: 'private_payload_missing_source_backed_regeneration_available',
    next_action: 'regenerate_unresolved_from_verified_source',
    provider_call_required: true,
  });
  return Object.freeze({
    executable: false,
    reason_code: 'private_payload_and_verified_source_unavailable',
    next_action: 'restore_source_or_private_recovery_payload',
    provider_call_required: false,
  });
}

/**
 * Resolve source-backed regeneration without retaining private provider text.
 * The caller owns source loading; this function verifies identity and returns
 * a bounded immutable request recipe.
 */
export async function materializeSourceBackedRecovery(capsule, loadSourceWindow,
  fingerprintSourceWindow) {
  const assessment = assessMemorizeRecoveryCapsule(capsule);
  if (!assessment.executable || assessment.next_action !== 'regenerate_unresolved_from_verified_source') {
    return Object.freeze({ status: 'blocked', ...assessment });
  }
  const messages = await loadSourceWindow(capsule.source_range);
  if (!Array.isArray(messages) || messages.length !== capsule.source_range.message_count) {
    return Object.freeze({ status: 'blocked', executable: false,
      reason_code: 'verified_source_window_unavailable', next_action: 'restore_source_window' });
  }
  const fingerprint = await fingerprintSourceWindow(messages);
  if (fingerprint !== capsule.source_fingerprint) return Object.freeze({
    status: 'blocked', executable: false,
    reason_code: 'source_window_fingerprint_mismatch', next_action: 'restore_matching_source_window',
  });
  return Object.freeze({
    status: 'ready', executable: true,
    next_action: 'regenerate_unresolved_from_verified_source',
    source_messages: Object.freeze([...messages]),
    source_range: capsule.source_range,
    source_fingerprint: fingerprint,
    exclusions: Object.freeze({
      candidate_fingerprints: capsule.accepted_candidate_fingerprints,
      durable_record_ids: capsule.durable_record_ids,
    }),
    rejected_fragment_ids: capsule.rejected_fragment_ids,
    producing_attempt_id: capsule.producing_attempt_id,
  });
}

