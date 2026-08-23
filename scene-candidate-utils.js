/**
 * Pure admission policy for scene-detector candidates.
 *
 * Provider calls are expensive, so a group-chat seam must have grounded
 * transition support before a legacy lexical heuristic can nominate it.  The
 * final deterministic gate remains the authority on whether an admitted seam
 * actually becomes a scene boundary.
 */
export function evaluateSceneCandidateAdmission({
  isGroupChat = false,
  heuristic = false,
  strongTransition = false,
  moderateTransition = false,
  deterministicStrongAdmission = false,
  directContinuation = false,
  currentWeakSignal = false,
  previousWeakSignal = false,
  speakerChanged = false,
} = {}) {
  const grounded = Boolean(deterministicStrongAdmission || strongTransition || moderateTransition);
  const sources = [];
  if (deterministicStrongAdmission) sources.push('strong_deterministic');
  if (strongTransition) sources.push('explicit_time_or_phase');
  if (moderateTransition) sources.push('combined_grounded_context');
  if (heuristic) sources.push('heuristic');
  if (speakerChanged) sources.push('speaker_churn');
  if (currentWeakSignal || previousWeakSignal) sources.push('weak_lexical_signal');

  // A legacy heuristic can be useful in a one-on-one chat, but in a group it
  // often fires on roleplay narration adjacent to ordinary speaker turnover.
  // Speaker / participant churn and weak lexical words are observations only;
  // none can independently create provider work.
  const groupHeuristicOnly = Boolean(isGroupChat && heuristic && !grounded);
  const admitted = !directContinuation
    && (grounded || (heuristic && !isGroupChat));
  const rejectionReason = directContinuation
    ? 'direct_continuation'
    : groupHeuristicOnly
      ? 'group_heuristic_without_grounded_transition'
      : 'no_independent_transition_support';
  return {
    admitted,
    rejection_reason: admitted ? null : rejectionReason,
    grounded_transition_support: grounded,
    group_heuristic_only: groupHeuristicOnly,
    source_categories: sources,
    composite_source: sources.filter((source) => source !== 'speaker_churn' && source !== 'weak_lexical_signal').length > 1
      ? 'combined'
      : sources[0] ?? 'none',
  };
}

/** Build a compact, text-free outcome audit from terminal provider results. */
export function summarizeSceneCandidateSources(dispositions = [], finalBoundaryIndices = []) {
  const sourceNames = ['strong_deterministic', 'heuristic', 'cadence', 'observed_location', 'participant_delta', 'channel', 'speaker_churn', 'combined'];
  const sources = Object.fromEntries(sourceNames.map((name) => [name, { provider_break: 0, provider_no_break: 0, final_accepted: 0, final_rejected: 0, continuity_veto: 0, final_reasons: {} }]));
  const accepted = new Set(finalBoundaryIndices);
  for (const candidate of dispositions) {
    const provenance = candidate?.selection_provenance ?? {};
    const categories = new Set(provenance.source_categories ?? []);
    if (provenance.composite_source === 'combined') categories.add('combined');
    if (!categories.size) continue;
    const finalAccepted = accepted.has(candidate.message_index ?? candidate.candidate_id);
    for (const category of categories) {
      const name = category === 'explicit_time_or_phase' || category === 'combined_grounded_context' ? 'strong_deterministic' : category;
      if (!sources[name]) continue;
      if (candidate.decision === true) sources[name].provider_break++;
      else sources[name].provider_no_break++;
      if (finalAccepted) sources[name].final_accepted++;
      else sources[name].final_rejected++;
      if (candidate.gate_reason_code === 'strong_continuity_veto') sources[name].continuity_veto++;
      const reason = candidate.gate_reason_code ?? candidate.terminal_break_disposition ?? 'not_finalized';
      sources[name].final_reasons[reason] = (sources[name].final_reasons[reason] ?? 0) + 1;
    }
  }
  return { schema_version: 1, sources };
}
