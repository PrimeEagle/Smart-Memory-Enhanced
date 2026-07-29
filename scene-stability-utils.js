/** Compare bounded, text-free scene-boundary diagnostics from two equivalent runs. */
// Gate records existed before their result was stored structurally.  Never
// compare a legacy implementation hash (or an absent placeholder) with a
// structured result: that produces a false determinism violation.  This
// deliberately small, privacy-safe representation is the only one used by
// the determinism audit.
export function canonicalizeGateOutput(candidate = {}) {
  const gateResult = ['accepted', 'rejected'].includes(candidate.gate_result) ? candidate.gate_result : null;
  const disposition = typeof candidate.terminal_break_disposition === 'string'
    ? candidate.terminal_break_disposition : null;
  const reason = typeof candidate.gate_reason_code === 'string' ? candidate.gate_reason_code : null;
  const explicitlyExecuted = candidate.gate_executed === true || gateResult !== null;
  if (!explicitlyExecuted) {
    return {
      gate_output_schema_version: 1,
      gate_executed: false,
      gate_result: null,
      gate_reason_code: null,
      terminal_break_disposition: null,
      classification: candidate.gate_output_hash || candidate.gate_result !== undefined
        ? 'legacy_output_incomplete' : 'gate_not_executed',
      migration_source_version: candidate.gate_output_schema_version ?? null,
      migration_terminal_status: 'not_comparable',
      canonical_gate_output_hash: null,
    };
  }
  if (!gateResult || !disposition) {
    return {
      gate_output_schema_version: 1,
      gate_executed: true,
      gate_result: gateResult,
      gate_reason_code: reason,
      terminal_break_disposition: disposition,
      classification: 'legacy_output_incomplete',
      migration_source_version: candidate.gate_output_schema_version ?? null,
      migration_terminal_status: 'not_comparable',
      canonical_gate_output_hash: null,
    };
  }
  const migrated = candidate.gate_output_schema_version !== 1;
  const canonical = {
    gate_executed: true,
    gate_result: gateResult,
    gate_reason_code: reason,
    terminal_break_disposition: disposition,
  };
  return {
    gate_output_schema_version: 1,
    ...canonical,
    classification: migrated ? 'migrated_legacy_output' : 'comparable_canonical_output',
    migration_source_version: candidate.gate_output_schema_version ?? null,
    migration_terminal_status: migrated ? 'migrated' : 'current',
    canonical_gate_output_hash: JSON.stringify(canonical),
  };
}

export function compareSceneBoundaryRuns(previous, currentAudit = {}, tolerance = 2) {
  const currentIndices = currentAudit.final_break_indices ?? [];
  const currentSceneCount = currentAudit.generated ?? null;
  if (!previous) return { compared_to_prior: false, comparison_tolerance_messages: tolerance, breaks_added: currentIndices.length, breaks_removed: 0, breaks_shifted: 0, unchanged_breaks: 0, unchanged_boundaries: [], shifted_boundaries: [], added_boundaries: currentIndices, removed_boundaries: [], scene_count_stable: null, boundary_positions_exactly_stable: false, boundary_positions_materially_stable: false, decision_pipeline_stable: null, marginal_boundary_comparison: [] };
  const remainingPrevious = new Set(previous.final_break_indices ?? []);
  const unchanged = [];
  const added = [];
  for (const index of currentIndices) {
    if (remainingPrevious.delete(index)) unchanged.push(index);
    else added.push(index);
  }
  const shifted = [];
  const unmatchedAdded = [];
  for (const index of added) {
    const nearby = [...remainingPrevious].filter((prior) => Math.abs(prior - index) <= tolerance).sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || a - b)[0];
    if (nearby === undefined) unmatchedAdded.push(index);
    else { remainingPrevious.delete(nearby); shifted.push({ previous_index: nearby, current_index: index, offset: index - nearby }); }
  }
  const previousDispositions = new Map((previous.candidate_dispositions ?? []).map((item) => [item.message_index ?? item.candidate_id, item]));
  const currentDispositions = new Map((currentAudit.candidate_dispositions ?? []).map((item) => [item.message_index ?? item.candidate_id, item]));
  const previousContextHashes = new Map((previous.candidate_context_hashes ?? []).map((item) => [item.candidate_id, item.context_hash]));
  const currentContextHashes = new Map((currentAudit.candidate_context_hashes ?? []).map((item) => [item.candidate_id, item.context_hash]));
  const marginalRecord = (previousIndex, currentIndex, classification) => {
    const prior = previousDispositions.get(previousIndex);
    const current = currentDispositions.get(currentIndex);
    return {
      classification,
      candidate_id: current?.candidate_id ?? prior?.candidate_id ?? currentIndex ?? previousIndex,
      message_index: currentIndex ?? previousIndex,
      previous_message_index: previousIndex,
      current_message_index: currentIndex,
      previous_ai_decision: prior?.decision ?? null,
      current_ai_decision: current?.decision ?? null,
      previous_ai_confidence: prior?.ai_confidence ?? null,
      current_ai_confidence: current?.ai_confidence ?? null,
      previous_gate_result: prior?.gate_result ?? null,
      current_gate_result: current?.gate_result ?? null,
      previous_gate_reason: prior?.gate_reason_code ?? null,
      current_gate_reason: current?.gate_reason_code ?? null,
      previous_terminal_break_disposition: prior?.terminal_break_disposition ?? null,
      current_terminal_break_disposition: current?.terminal_break_disposition ?? null,
      // For shifted boundaries, compare each candidate to itself across runs;
      // comparing previous index 70 directly to current index 72 is not a
      // stability signal because they represent different candidate windows.
      previous_candidate_context_stable_across_runs: previousIndex !== null
        && previousContextHashes.has(previousIndex)
        && currentContextHashes.has(previousIndex)
        && previousContextHashes.get(previousIndex) === currentContextHashes.get(previousIndex),
      current_candidate_context_stable_across_runs: currentIndex !== null
        && previousContextHashes.has(currentIndex)
        && currentContextHashes.has(currentIndex)
        && previousContextHashes.get(currentIndex) === currentContextHashes.get(currentIndex),
      previous_candidate_prompt_stable_across_runs: previousIndex !== null && previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      current_candidate_prompt_stable_across_runs: currentIndex !== null && previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      cross_candidate_context_equal: previousIndex !== null && currentIndex !== null
        && previousContextHashes.has(previousIndex) && currentContextHashes.has(currentIndex)
        && previousContextHashes.get(previousIndex) === currentContextHashes.get(currentIndex),
      prompt_hash_equal: previous.prompt_shape_hash === currentAudit.prompt_shape_hash,
      model_equal: previous.model_identifier === currentAudit.model_identifier && previous.connection_profile_identifier === currentAudit.connection_profile_identifier,
      settings_equal: JSON.stringify(previous.task_sampling_settings ?? {}) === JSON.stringify(currentAudit.task_sampling_settings ?? {}),
    };
  };
  return {
    compared_to_prior: true,
    comparison_tolerance_messages: tolerance,
    breaks_added: unmatchedAdded.length,
    breaks_removed: remainingPrevious.size,
    breaks_shifted: shifted.length,
    unchanged_breaks: unchanged.length,
    unchanged_boundaries: unchanged,
    shifted_boundaries: shifted,
    added_boundaries: unmatchedAdded,
    removed_boundaries: [...remainingPrevious],
    scene_count_stable: Number.isInteger(currentSceneCount) && Number.isInteger(previous.generated) ? currentSceneCount === previous.generated : null,
    boundary_positions_exactly_stable: !shifted.length && !unmatchedAdded.length && !remainingPrevious.size,
    boundary_positions_materially_stable: !unmatchedAdded.length && !remainingPrevious.size,
    decision_pipeline_stable: (previous.malformed_batches ?? 0) === 0
      && (previous.fallback_boundaries ?? previous.heuristic_fallback_candidates ?? 0) === 0
      && (currentAudit.malformed_batches ?? 0) === 0
      && (currentAudit.fallback_boundaries ?? currentAudit.heuristic_fallback_candidates ?? 0) === 0
      && previous.prompt_shape_hash === currentAudit.prompt_shape_hash
      && previous.model_identifier === currentAudit.model_identifier
      && previous.connection_profile_identifier === currentAudit.connection_profile_identifier
      && JSON.stringify(previous.task_sampling_settings ?? {}) === JSON.stringify(currentAudit.task_sampling_settings ?? {}),
    marginal_boundary_comparison: [
      ...shifted.map((shift) => ({ ...marginalRecord(shift.previous_index, shift.current_index, 'shifted'), offset: shift.offset })),
      ...unmatchedAdded.map((index) => marginalRecord(null, index, 'added')),
      ...[...remainingPrevious].map((index) => marginalRecord(index, null, 'removed')),
    ],
  };
}

/** Analyze every retained run that is comparable to the current scene pass. */
export function analyzeSceneStabilityHistory(runs = [], currentAudit = {}, tolerance = 2) {
 const stableJson = (value) => JSON.stringify(value ?? {});
 const runSignature = (run) => run?.run_signature ?? run?.scene_detection_run_signature ?? null;
 const currentSignature = runSignature(currentAudit);
 // Treat the supplied history as prior-only. Some older callers persisted the
 // current audit in history before requesting analysis; retaining it here
 // would give the same run two chances to influence the statistics.
 const priorRuns = runs.filter(Boolean).filter((run) => !currentAudit?.run_id || String(run?.run_id ?? '') !== String(currentAudit.run_id));
 const isComparable = (run) => Boolean(run)
   && runSignature(run) === currentSignature
   && run.prompt_shape_hash === currentAudit.prompt_shape_hash
   && run.model_identifier === currentAudit.model_identifier
   && run.connection_profile_identifier === currentAudit.connection_profile_identifier
   && stableJson(run.task_sampling_settings) === stableJson(currentAudit.task_sampling_settings);
 const compatiblePriorRuns = priorRuns.filter(isComparable);
 const currentRunIncluded = isComparable(currentAudit);
 const compatible = currentRunIncluded ? [...compatiblePriorRuns, currentAudit] : compatiblePriorRuns;
 const deterministicLegacyId = (run, index) => {
   const seed = JSON.stringify([run?.created_at ?? run?.completed_at ?? null, runSignature(run), run?.final_break_indices ?? [], run?.scene_count ?? run?.generated ?? null, index]);
   let hash = 2166136261;
   for (let position = 0; position < seed.length; position++) hash = Math.imul(hash ^ seed.charCodeAt(position), 16777619);
   return `migrated-scene-run-${(hash >>> 0).toString(16)}`;
 };
 const fingerprint = (run) => {
   const payload = [
     runSignature(run), run?.prompt_shape_hash ?? null, run?.model_identifier ?? null,
     run?.connection_profile_identifier ?? null, stableJson(run?.task_sampling_settings),
     run?.candidate_context_hash_summary ?? null, run?.final_break_indices ?? [],
     run?.scene_count ?? run?.generated ?? null, run?.boundary_count ?? null,
   ];
   let hash = 2166136261;
   for (const character of JSON.stringify(payload)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
   return `scene-run-fingerprint-${(hash >>> 0).toString(16)}`;
 };
 const boundaryNormalizations = [];
 const identifiedRawRuns = compatible.map((run, index) => {
   const rawIndices = (run.final_break_indices ?? []).filter(Number.isInteger);
   const finalBreakIndices = [...new Set(rawIndices)].sort((a, b) => a - b);
   const runtimeId = Boolean(run.run_id);
   const knownCreatedAt = run.created_at ?? run.completed_at ?? null;
   const normalized = {
     ...run,
     run_id: runtimeId ? run.run_id : deterministicLegacyId(run, index),
     run_id_source: runtimeId ? (run.run_id_source ?? 'runtime') : 'migration_generated',
     record_source: run.record_source ?? (runtimeId ? 'runtime' : 'migration_generated'),
     _stable_input_order: index,
     created_at: knownCreatedAt,
     created_at_source: knownCreatedAt === null ? 'legacy_unknown' : (run.created_at_source ?? 'runtime'),
     final_break_indices: finalBreakIndices,
     boundary_count: Number.isInteger(run.boundary_count) ? run.boundary_count : finalBreakIndices.length,
     scene_count: Number.isInteger(run.scene_count) ? run.scene_count : (Number.isInteger(run.generated) ? run.generated : finalBreakIndices.length + 1),
     current_run: Boolean(currentRunIncluded && String(run.run_id ?? '') === String(currentAudit.run_id ?? '')),
   };
   boundaryNormalizations.push({
     run_id: normalized.run_id,
     raw_boundary_count: rawIndices.length,
     normalized_boundary_count: finalBreakIndices.length,
     duplicate_boundary_indices_removed: [...new Set(rawIndices.filter((index, position) => rawIndices.indexOf(index) !== position))],
   });
   return normalized;
 });
 // Deduplicate only the comparable input collection. Runtime IDs have the
 // strongest identity, migration records use their stable generated IDs, and
 // legacy compatibility imports fall back to a bounded structural fingerprint.
 const seenRunKeys = new Map();
 const duplicateRunRecordDetails = [];
 const duplicateRuntimeRunIds = [];
 const duplicateMigrationRunIds = [];
 const duplicateFingerprintRecords = [];
 const comparableRuns = [];
 for (const run of identifiedRawRuns) {
   const keyType = run.run_id_source === 'runtime' ? 'runtime_run_id'
     : run.run_id_source === 'migration_generated' ? 'migration_run_id' : 'record_fingerprint';
   const key = keyType === 'record_fingerprint' ? fingerprint(run) : String(run.run_id);
   if (!seenRunKeys.has(`${keyType}:${key}`)) {
     seenRunKeys.set(`${keyType}:${key}`, run);
     comparableRuns.push(run);
     continue;
   }
   const retained = seenRunKeys.get(`${keyType}:${key}`);
   if (keyType === 'runtime_run_id') duplicateRuntimeRunIds.push(key);
   else if (keyType === 'migration_run_id') duplicateMigrationRunIds.push(key);
   else duplicateFingerprintRecords.push(key);
   duplicateRunRecordDetails.push({
     duplicate_key: key,
     duplicate_key_type: keyType,
     retained_run_id: retained.run_id,
     removed_run_id: run.run_id,
     retained_record_source: retained.record_source,
     removed_record_source: run.record_source,
   });
 }
 // Prefer the explicit current audit if a historical record shares its ID.
 // This is deterministic and makes `current_run` an unambiguous property of
 // the canonical array used by every downstream summary.
 for (let index = comparableRuns.length - 1; index >= 0; index--) {
   if (!comparableRuns[index].current_run) continue;
   const duplicateIndex = comparableRuns.findIndex((run, candidateIndex) => candidateIndex !== index && run.run_id === comparableRuns[index].run_id);
   if (duplicateIndex >= 0) comparableRuns.splice(duplicateIndex, 1);
 }
 comparableRuns.sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')) || left._stable_input_order - right._stable_input_order);
 const identifiedRuns = comparableRuns;
 const counts = identifiedRuns.map((run) => Number(run.scene_count ?? run.generated ?? 0));
 const countFrequency = new Map();
 for (const count of counts) countFrequency.set(count, (countFrequency.get(count) ?? 0) + 1);
 const maxCountFrequency = Math.max(0, ...countFrequency.values());
 const sceneCountModes = [...countFrequency.entries()].filter(([, frequency]) => frequency === maxCountFrequency).map(([count]) => count).sort((a, b) => a - b);
 const exactFrequency = new Map();
 const observations = [];
 for (const run of identifiedRuns) {
   for (const index of new Set((run.final_break_indices ?? []).filter(Number.isInteger))) {
     exactFrequency.set(index, (exactFrequency.get(index) ?? 0) + 1);
     observations.push({ index, run_id: run.run_id });
   }
 }
 const entries = [...exactFrequency.entries()].sort((a, b) => a[0] - b[0]);
 const runCount = identifiedRuns.length;
 const exactBoundaries = (predicate) => entries.filter(([, count]) => predicate(count)).map(([index]) => index);
 const boundaryDetails = (indices) => indices.map((index) => {
   const runsPresent = identifiedRuns.filter((run) => run.final_break_indices.includes(index)).map((run) => run.run_id);
   return { boundary_index: index, runs_present: runsPresent, distinct_run_count: runsPresent.length, exact_observation_count: exactFrequency.get(index) ?? 0 };
 });
 const clusters = [];
 for (const observation of observations.sort((left, right) => left.index - right.index || left.run_id.localeCompare(right.run_id))) {
   const cluster = clusters.find((item) => observation.index - item.member_indices.at(-1) <= tolerance);
   if (cluster) cluster.member_indices.push(observation.index);
   else clusters.push({ cluster_id: `shift-${clusters.length + 1}`, member_indices: [observation.index], observations: [] });
   (cluster ?? clusters.at(-1)).observations.push(observation);
 }
 const detailedClusters = clusters.map((cluster) => {
   const uniqueIndices = [...new Set(cluster.member_indices)].sort((a, b) => a - b);
   const observationsByRun = Object.fromEntries(identifiedRuns.map((run) => [run.run_id,
     cluster.observations.filter((observation) => observation.run_id === run.run_id).map((observation) => observation.index).sort((a, b) => a - b)]));
   const runsPresent = Object.entries(observationsByRun).filter(([, indices]) => indices.length).map(([runId]) => runId);
   const exactIndexFrequencies = Object.fromEntries(uniqueIndices.map((index) => [index, exactFrequency.get(index) ?? 0]));
   return {
     cluster_id: cluster.cluster_id,
     member_indices: uniqueIndices,
     representative_index: uniqueIndices[Math.floor(uniqueIndices.length / 2)] ?? null,
     observation_count: cluster.observations.length,
     distinct_run_count: runsPresent.length,
     run_presence: runsPresent.length,
     runs_present: runsPresent,
     observations_by_run: observationsByRun,
     exact_index_frequencies: exactIndexFrequencies,
     maximum_offset: uniqueIndices.length ? uniqueIndices.at(-1) - uniqueIndices[0] : 0,
     minimum_index: uniqueIndices[0] ?? null,
     maximum_index: uniqueIndices.at(-1) ?? null,
     duplicate_observations_in_run: Object.entries(observationsByRun).filter(([, indices]) => indices.length > 1).map(([runId]) => runId),
   };
 });
 const clusterForIndex = (index) => detailedClusters.find((cluster) => cluster.member_indices.includes(index));
 const stableClusterBoundaries = detailedClusters.filter((cluster) => cluster.distinct_run_count === runCount && runCount > 0);
 const majorityClusterBoundaries = detailedClusters.filter((cluster) => cluster.distinct_run_count > runCount / 2);
 const marginalClusterBoundaries = detailedClusters.filter((cluster) => cluster.distinct_run_count > 0 && cluster.distinct_run_count <= runCount / 2);
 const oneOffClusterBoundaries = detailedClusters.filter((cluster) => cluster.distinct_run_count === 1);
 const pipelinesStable = identifiedRuns.every((run) => !(run.malformed_batches ?? 0) && !(run.fallback_boundaries ?? run.heuristic_fallback_candidates ?? 0));
 const candidateRecordsForRun = (run) => {
   const unique = new Map();
   for (const candidate of run?.candidate_dispositions ?? []) {
     const id = String(candidate?.candidate_id ?? candidate?.message_index ?? '');
     if (id) unique.set(id, candidate);
   }
   return [...unique.values()];
 };
 const declaredCandidateCount = (run, records) => {
   // The terminal candidate records are the authoritative declaration when
   // present. Older exports used `candidates` for scene counts, so never let
   // that compatibility field undercount a complete stored snapshot.
   if (records.length) return records.length;
   const declared = Number(run?.candidate_count ?? run?.candidate_count_per_run ?? run?.boundary_candidates_evaluated ?? 0);
   return Number.isInteger(declared) && declared >= 0 ? declared : 0;
 };
 const candidateRecordsByRun = new Map(identifiedRuns.map((run) => [run.run_id, candidateRecordsForRun(run)]));
 const candidateCountByRun = Object.fromEntries(identifiedRuns.map((run) => {
   const records = candidateRecordsByRun.get(run.run_id) ?? [];
   return [run.run_id, declaredCandidateCount(run, records)];
 }));
 const runsWithCandidateDetail = identifiedRuns.filter((run) => run.candidate_detail_available !== false
   && (candidateRecordsByRun.get(run.run_id) ?? []).length > 0);
 const runsWithoutCandidateDetail = identifiedRuns.filter((run) => !runsWithCandidateDetail.includes(run));
 const candidateHistoryComplete = runCount > 0 && runsWithoutCandidateDetail.length === 0;
 const candidateByRun = new Map();
 for (const run of identifiedRuns) {
   const contextByCandidate = new Map((run.candidate_context_hashes ?? []).map((item) => [String(item.candidate_id), item.context_hash ?? null]));
   for (const candidate of candidateRecordsByRun.get(run.run_id) ?? []) {
     const candidateId = String(candidate.candidate_id ?? candidate.message_index ?? '');
     if (!candidateId) continue;
     if (!candidateByRun.has(candidateId)) candidateByRun.set(candidateId, []);
     const canonicalGateOutput = canonicalizeGateOutput(candidate);
     candidateByRun.get(candidateId).push({
       run_id: run.run_id,
       message_index: candidate.message_index ?? candidate.candidate_id ?? null,
       ai_decision: typeof candidate.decision === 'boolean' ? candidate.decision : null,
       gate_result: candidate.gate_result ?? null,
       terminal_break_disposition: candidate.terminal_break_disposition ?? null,
       gate_reason_code: candidate.gate_reason_code ?? null,
       ai_confidence: candidate.ai_confidence ?? null,
       gate_input_hash: candidate.gate_input_hash ?? null,
       gate_output_schema_version: canonicalGateOutput.gate_output_schema_version,
       gate_output_classification: canonicalGateOutput.classification,
       gate_executed: canonicalGateOutput.gate_executed,
       canonical_gate_output: canonicalGateOutput,
       gate_output_hash: canonicalGateOutput.canonical_gate_output_hash,
       // Coalescing is a later final-assembly decision. It remains in the
       // canonical snapshot for traceability, but is not evidence that the
       // deterministic gate itself changed its decision.
       gate_decision_hash: canonicalGateOutput.gate_executed
         ? JSON.stringify([canonicalGateOutput.gate_result, canonicalGateOutput.gate_reason_code]) : null,
       context_hash: contextByCandidate.get(candidateId) ?? null,
     });
   }
 }
 const allRunCandidateStability = [...candidateByRun.entries()].map(([candidateId, decisions]) => {
   const unique = (field) => [...new Set(decisions.map((decision) => decision[field]).filter((value) => value !== null && value !== undefined))];
   const observedRuns = [...new Set(decisions.map((decision) => decision.run_id))];
   const aiValues = unique('ai_decision');
   const gateValues = unique('gate_result');
   const finalValues = unique('terminal_break_disposition');
   const contextValues = unique('context_hash');
   const comparableGateDecisions = decisions.filter((item) => item.gate_input_hash
     && ['comparable_canonical_output', 'migrated_legacy_output'].includes(item.gate_output_classification));
   const inputGroups = new Map();
   for (const decision of comparableGateDecisions) {
     if (!inputGroups.has(decision.gate_input_hash)) inputGroups.set(decision.gate_input_hash, new Set());
     inputGroups.get(decision.gate_input_hash).add(decision.gate_decision_hash ?? null);
   }
   // A result is meaningful only when every retained observation has an
   // executed, canonical output.  Partial historical snapshots remain useful
   // for general variance, but are excluded from determinism conclusions.
   const gateDeterminismViolation = comparableGateDecisions.length === decisions.length
     && [...inputGroups.values()].some((outputs) => outputs.size > 1);
   const enoughHistory = observedRuns.length === runCount;
   const aiDecisionStable = enoughHistory && aiValues.length <= 1;
   const gateOutcomeStable = enoughHistory && gateValues.length <= 1;
   const finalBoundaryStable = enoughHistory && finalValues.length <= 1;
   let classification = 'insufficient_history';
   if (enoughHistory && contextValues.length > 1) classification = 'input_changed';
   else if (enoughHistory && !aiDecisionStable) classification = 'ai_marginal';
   else if (enoughHistory && !gateOutcomeStable) classification = 'gate_marginal';
   else if (enoughHistory && !finalBoundaryStable) classification = 'final_assembly_marginal';
   else if (enoughHistory && finalValues[0] === 'accepted_final_break') classification = 'stable_break';
   else if (enoughHistory) classification = 'stable_no_break';
   return {
     candidate_id: candidateId,
     message_index: decisions[0]?.message_index ?? null,
     runs_observed: observedRuns,
     run_count: observedRuns.length,
     ai_break_count: decisions.filter((decision) => decision.ai_decision === true).length,
     ai_no_break_count: decisions.filter((decision) => decision.ai_decision === false).length,
     ai_decision_stable: aiDecisionStable,
     gate_accept_count: decisions.filter((decision) => decision.gate_result === 'accepted').length,
     gate_reject_count: decisions.filter((decision) => decision.gate_result === 'rejected').length,
     gate_outcome_stable: gateOutcomeStable,
     final_boundary_count: decisions.filter((decision) => decision.terminal_break_disposition === 'accepted_final_break').length,
     final_boundary_stable: finalBoundaryStable,
     confidence_values: unique('ai_confidence'),
     gate_reason_values: unique('gate_reason_code'),
     gate_input_hash_values: unique('gate_input_hash'),
     gate_output_hash_values: unique('gate_output_hash'),
     context_hash_stable: enoughHistory && contextValues.length <= 1,
     prompt_hash_stable: true,
     gate_determinism_violation: gateDeterminismViolation,
     classification,
     observations: decisions,
   };
 });
 const measuredSceneVarianceSources = allRunCandidateStability.reduce((counts, candidate) => {
   if (candidate.classification === 'ai_marginal') counts.changed_ai_decisions++;
   else if (candidate.classification === 'gate_marginal') counts.changed_gate_outcomes++;
   else if (candidate.classification === 'final_assembly_marginal') counts.changed_coalescing_outcomes++;
   else if (candidate.classification === 'input_changed') counts.changed_inputs++;
   else if (candidate.gate_determinism_violation) counts.unexplained_same_input_variance++;
   return counts;
 }, { changed_ai_decisions: 0, changed_gate_outcomes: 0, changed_minimum_length_outcomes: 0, changed_coalescing_outcomes: 0, changed_inputs: 0, unexplained_same_input_variance: 0 });
 const terminalSkipReasons = {
   skipped_missing_candidate_history: 0,
   skipped_missing_gate_input_hash: 0,
   skipped_incompatible_legacy_gate_output: 0,
   skipped_gate_not_executed: 0,
   skipped_context_hash_mismatch: 0,
   skipped_prompt_hash_mismatch: 0,
   skipped_task_settings_mismatch: 0,
   skipped_ai_decision_mismatch: 0,
   skipped_gate_input_hash_mismatch: 0,
 };
 const secondaryIneligibilityObservations = {
   missing_candidate_history: 0,
   missing_gate_input_hash: 0,
   incompatible_legacy_gate_output: 0,
   gate_not_executed: 0,
   context_hash_mismatch: 0,
   prompt_hash_mismatch: 0,
   task_settings_mismatch: 0,
   ai_decision_mismatch: 0,
   gate_input_hash_mismatch: 0,
 };
 const gateComparisons = [];
 for (const candidate of allRunCandidateStability) {
   const missingHistory = candidate.run_count < runCount;
   const missingGateHash = candidate.gate_input_hash_values.length === 0;
   const contextMismatch = candidate.run_count > 1 && !candidate.context_hash_stable;
   const aiMismatch = candidate.run_count > 1 && !candidate.ai_decision_stable;
   const gateHashMismatch = candidate.gate_input_hash_values.length > 1;
   const observations = candidate.observations ?? [];
   const gateNotExecuted = observations.some((item) => item.gate_output_classification === 'gate_not_executed');
   const incompatibleOutput = observations.some((item) => !['comparable_canonical_output', 'migrated_legacy_output'].includes(item.gate_output_classification));
   if (missingHistory) secondaryIneligibilityObservations.missing_candidate_history++;
   if (missingGateHash) secondaryIneligibilityObservations.missing_gate_input_hash++;
   if (contextMismatch) secondaryIneligibilityObservations.context_hash_mismatch++;
   if (aiMismatch) secondaryIneligibilityObservations.ai_decision_mismatch++;
   if (gateHashMismatch) secondaryIneligibilityObservations.gate_input_hash_mismatch++;
   if (gateNotExecuted) secondaryIneligibilityObservations.gate_not_executed++;
   if (incompatibleOutput) secondaryIneligibilityObservations.incompatible_legacy_gate_output++;
   const terminal = missingHistory ? 'skipped_missing_candidate_history'
     : missingGateHash ? 'skipped_missing_gate_input_hash'
       : gateNotExecuted ? 'skipped_gate_not_executed'
         : incompatibleOutput ? 'skipped_incompatible_legacy_gate_output'
       : contextMismatch ? 'skipped_context_hash_mismatch'
         : aiMismatch ? 'skipped_ai_decision_mismatch'
           : gateHashMismatch ? 'skipped_gate_input_hash_mismatch'
             : null;
   if (terminal) terminalSkipReasons[terminal]++;
   else gateComparisons.push(candidate);
 }
 const gateDeterminismViolations = gateComparisons
   .filter((candidate) => {
     const values = new Set((candidate.observations ?? []).map((item) => item.gate_decision_hash).filter(Boolean));
     return values.size > 1;
   })
   .map((candidate) => ({
     candidate_id: candidate.candidate_id,
     message_index: candidate.message_index,
     run_ids: candidate.runs_observed,
     context_hash: candidate.observations[0]?.context_hash ?? null,
     gate_input_hash: candidate.gate_input_hash_values[0] ?? null,
     canonical_output_hashes: candidate.gate_output_hash_values,
     canonical_output_summaries: candidate.observations.map((item) => item.canonical_gate_output).filter(Boolean),
     violation_reason: 'matching_deterministic_inputs_different_canonical_output',
   }));
 const eligibleCandidateCount = gateComparisons.length;
 const comparisonsCompleted = gateComparisons.length;
 const comparisonsSkipped = Math.max(0, allRunCandidateStability.length - comparisonsCompleted);
 const accountingValid = allRunCandidateStability.length === comparisonsCompleted + comparisonsSkipped
   && gateDeterminismViolations.length <= comparisonsCompleted;
 const eligibleCoverageRatio = allRunCandidateStability.length
   ? eligibleCandidateCount / allRunCandidateStability.length : 0;
 const representativeThreshold = 0.8;
 const gateDeterminismCoverage = {
   candidate_count: allRunCandidateStability.length,
   eligible_candidate_count: eligibleCandidateCount,
   comparisons_attempted: allRunCandidateStability.length,
   comparisons_completed: comparisonsCompleted,
   comparisons_skipped: comparisonsSkipped,
   terminal_skip_reasons: terminalSkipReasons,
   secondary_ineligibility_observations: secondaryIneligibilityObservations,
   skip_reason_counts_are_exclusive: true,
   violations_found: gateDeterminismViolations.length,
   eligible_coverage_ratio: eligibleCoverageRatio,
   total_candidate_coverage_ratio: allRunCandidateStability.length ? comparisonsCompleted / allRunCandidateStability.length : 0,
   representative_coverage_threshold: representativeThreshold,
   result_conclusive_for_eligible_comparisons: candidateHistoryComplete && comparisonsCompleted > 0 && accountingValid,
   result_broadly_representative: accountingValid && eligibleCoverageRatio >= representativeThreshold,
   result_invalid_reason: accountingValid ? null : 'invalid_gate_determinism_accounting',
   // Compatibility field: it means only the eligible-comparison conclusion,
   // never broad representativeness across incomplete historical coverage.
   result_conclusive: candidateHistoryComplete && comparisonsCompleted > 0 && accountingValid,
 };
 const candidateHistoryCoverage = {
   distinct_comparable_runs: runCount,
   runs_with_candidate_detail: runsWithCandidateDetail.map((run) => run.run_id),
   runs_without_candidate_detail: runsWithoutCandidateDetail.map((run) => run.run_id),
   candidate_count_by_run: candidateCountByRun,
   candidate_count_per_run: [...new Set(Object.values(candidateCountByRun))].length === 1 ? Object.values(candidateCountByRun)[0] ?? 0 : null,
   candidate_records_available: [...candidateRecordsByRun.values()].reduce((total, records) => total + records.length, 0),
   candidate_records_expected: Object.values(candidateCountByRun).reduce((total, count) => total + count, 0),
   candidates_compared: candidateByRun.size,
   candidates_with_complete_history: allRunCandidateStability.filter((candidate) => candidate.run_count === runCount).length,
   candidates_with_partial_history: allRunCandidateStability.filter((candidate) => candidate.run_count > 0 && candidate.run_count < runCount).length,
   candidates_without_prior_history: allRunCandidateStability.filter((candidate) => candidate.run_count <= 1).length,
   variance_analysis_complete: candidateHistoryComplete,
   incomplete_reason: candidateHistoryComplete ? null : 'missing_candidate_history',
 };
 candidateHistoryCoverage.candidate_records_missing = Math.max(0, candidateHistoryCoverage.candidate_records_expected - candidateHistoryCoverage.candidate_records_available);
 candidateHistoryCoverage.coverage_ratio = candidateHistoryCoverage.candidate_records_expected > 0
   ? candidateHistoryCoverage.candidate_records_available / candidateHistoryCoverage.candidate_records_expected
   : null;
  const duplicateRunRecordsRemoved = duplicateRunRecordDetails.length;
 const identifiedPriorRuns = identifiedRuns.filter((run) => !run.current_run);
 const distinctPriorRunCount = identifiedPriorRuns.length;
 return {
   scene_run_input_accounting: {
     raw_prior_record_count: compatiblePriorRuns.length,
     raw_current_record_count: currentRunIncluded ? 1 : 0,
     raw_total_record_count: compatible.length,
     distinct_prior_run_count: distinctPriorRunCount,
     current_run_included: currentRunIncluded,
     distinct_total_run_count: runCount,
     duplicate_run_records_removed: duplicateRunRecordsRemoved,
     duplicate_runtime_run_ids: [...new Set(duplicateRuntimeRunIds)],
     duplicate_migration_run_ids: [...new Set(duplicateMigrationRunIds)],
   duplicate_fingerprint_records: [...new Set(duplicateFingerprintRecords)],
   },
   duplicate_run_record_details: duplicateRunRecordDetails,
   run_boundary_normalization: boundaryNormalizations,
   // Duplicate input is maintenance information, not an analytical gap once
   // the canonical comparable array has removed it successfully.
   scene_history_input_clean: true,
   input_maintenance_performed: duplicateRunRecordsRemoved > 0,
   duplicate_runs_removed: duplicateRunRecordsRemoved,
   prior_summary_invalidated_by_duplicate_runs: false,
   scene_stability_summary_complete: candidateHistoryComplete,
   scene_stability_incomplete_reasons: [
     ...(!candidateHistoryComplete ? ['missing_candidate_history'] : []),
   ],
   boundary_history_analysis_complete: true,
   candidate_variance_analysis_complete: candidateHistoryComplete,
   gate_determinism_analysis_complete: gateDeterminismCoverage.result_conclusive,
   // These fields must describe the deduplicated data that was actually
   // analyzed, not the raw compatible input. Otherwise a removed duplicate
   // can still appear as a retained prior run in exported diagnostics.
   comparable_prior_run_count: identifiedPriorRuns.length,
   prior_comparable_run_count: identifiedPriorRuns.length,
   comparable_total_run_count: runCount,
   total_comparable_run_count: runCount,
   comparable_run_count: runCount,
   scene_stability_schema_version: 2,
   comparable_runs: identifiedRuns.map((run) => ({
     run_id: run.run_id,
     run_id_source: run.run_id_source,
     current_run: run.current_run,
     created_at: run.created_at,
     scene_count: run.scene_count,
     boundary_count: run.boundary_count,
     final_break_indices: run.final_break_indices,
     candidate_detail_available: run.candidate_detail_available !== false,
     scene_detection_run_signature: runSignature(run),
     prompt_shape_hash: run.prompt_shape_hash ?? null,
     model_identifier: run.model_identifier ?? null,
     connection_profile_identifier: run.connection_profile_identifier ?? null,
     task_settings_hash: stableJson(run.task_sampling_settings),
     candidate_context_hash_summary: run.candidate_context_hash_summary ?? null,
   })),
   current_run_included: currentRunIncluded,
   retained_prior_run_ids: identifiedPriorRuns.map((run) => run.run_id),
   current_run_id: currentRunIncluded ? (currentAudit.run_id ?? deterministicLegacyId(currentAudit, compatiblePriorRuns.length)) : null,
   retained_run_ids: identifiedRuns.map((run) => run.run_id), retained_created_at: identifiedRuns.map((run) => run.created_at ?? run.completed_at ?? null),
   scene_counts: counts, boundary_counts: identifiedRuns.map((run) => (run.final_break_indices ?? []).length),
   scene_count_frequency_by_value: Object.fromEntries([...countFrequency.entries()].sort((a, b) => a[0] - b[0])),
   scene_count_modes: sceneCountModes, scene_count_mode: sceneCountModes.length === 1 ? sceneCountModes[0] : null,
   scene_count_mode_frequency: maxCountFrequency,
   scene_count_mode_is_unique: sceneCountModes.length === 1,
   scene_count_unique: sceneCountModes.length === 1 && maxCountFrequency === 1,
   scene_count_min: counts.length ? Math.min(...counts) : null, scene_count_max: counts.length ? Math.max(...counts) : null,
   scene_count_range: counts.length ? Math.max(...counts) - Math.min(...counts) : null,
   exact_boundary_frequency_by_index: Object.fromEntries(entries), boundary_frequency_by_index: Object.fromEntries(entries),
   exact_stable_consensus_boundaries: exactBoundaries((count) => count === runCount && runCount > 0),
   exact_consensus_boundaries: exactBoundaries((count) => count === runCount && runCount > 0),
   exact_majority_boundaries: exactBoundaries((count) => count > runCount / 2),
   exact_marginal_boundaries: exactBoundaries((count) => count > 0 && count <= runCount / 2),
   exact_one_off_boundaries: exactBoundaries((count) => count === 1),
   exact_consensus_boundary_details: boundaryDetails(exactBoundaries((count) => count === runCount && runCount > 0)),
   exact_majority_boundary_details: boundaryDetails(exactBoundaries((count) => count > runCount / 2)),
   exact_marginal_boundary_details: boundaryDetails(exactBoundaries((count) => count > 0 && count <= runCount / 2)),
   exact_one_off_boundary_details: boundaryDetails(exactBoundaries((count) => count === 1)),
   stable_consensus_boundaries: exactBoundaries((count) => count === runCount && runCount > 0),
   majority_boundaries: exactBoundaries((count) => count > runCount / 2), marginal_boundaries: exactBoundaries((count) => count > 0 && count <= runCount / 2),
   one_off_boundaries: exactBoundaries((count) => count === 1),
   shifted_boundary_clusters: detailedClusters.filter((cluster) => cluster.member_indices.length > 1),
   clustered_stable_consensus_boundaries: stableClusterBoundaries,
   clustered_consensus_transitions: stableClusterBoundaries,
   clustered_majority_transitions: majorityClusterBoundaries,
   clustered_marginal_transitions: marginalClusterBoundaries,
   clustered_one_off_transitions: oneOffClusterBoundaries,
   all_run_candidate_stability: allRunCandidateStability,
   candidate_history_coverage: candidateHistoryCoverage,
   scene_variance_sources: candidateHistoryComplete ? measuredSceneVarianceSources : null,
   gate_determinism_violation_count: gateDeterminismViolations.length,
   gate_determinism_violations: gateDeterminismViolations,
   gate_determinism_coverage: gateDeterminismCoverage,
   pipeline_stable: pipelinesStable, scene_count_exactly_stable: new Set(counts).size <= 1,
   scene_count_materially_stable: counts.length ? Math.max(...counts) - Math.min(...counts) <= 1 : false,
   boundary_positions_exactly_stable: entries.every(([, count]) => count === runCount),
   boundary_positions_materially_stable: entries.every(([index, count]) => count === runCount
     || (clusterForIndex(index)?.distinct_run_count === runCount)),
   decision_pipeline_stable: pipelinesStable,
 };
}
