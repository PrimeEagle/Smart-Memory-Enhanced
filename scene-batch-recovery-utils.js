/** Builds bounded, content-free telemetry for an incomplete provider batch. */
export function describePartialProviderOmission({ rootBatchId, requestAttemptId, missingCandidateIds = [], truncationSuspected = false, parserNormalized = false } = {}) {
  return {
    root_batch_id: rootBatchId ?? null,
    request_attempt_id: requestAttemptId ?? null,
    cause: 'provider_omitted_candidate_decisions',
    omitted_candidate_ids: [...missingCandidateIds],
    truncation_suspected: truncationSuspected === true,
    parser_normalized: parserNormalized === true,
  };
}

/** Records the outcome of a bounded retry that requests only omitted IDs. */
export function describeTargetedProviderRecovery({ rootBatchId, parentRequestAttemptId, requestedCandidateIds = [], unresolvedCandidateIds = [] } = {}) {
  const requested = [...requestedCandidateIds];
  const unresolved = [...unresolvedCandidateIds];
  return {
    root_batch_id: rootBatchId ?? null,
    parent_request_attempt_id: parentRequestAttemptId ?? null,
    retry_type: requested.length === 1 ? 'single_candidate_retry' : 'partial_missing_retry',
    requested_candidate_ids: requested,
    recovered_candidate_count: requested.length - unresolved.length,
    unresolved_candidate_ids: unresolved,
    final_boundary_effect: 'determined_during_scene_assembly',
  };
}
