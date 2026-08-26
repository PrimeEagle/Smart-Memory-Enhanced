/** Privacy-safe helpers for final-prompt extraction budgeting and coverage. */
export const EXTRACTION_CONTEXT_SAFETY_MARGIN = 1000;

export function makeExtractionPreflight({
  prompt = '',
  estimateTokens,
  configuredContextLimit,
  reservedOutputTokens,
  safetyMargin = EXTRACTION_CONTEXT_SAFETY_MARGIN,
} = {}) {
  const inputTokens = estimateTokens(prompt);
  const usableInputTokens = Math.max(1, configuredContextLimit - reservedOutputTokens - safetyMargin);
  return {
    estimated_input_tokens: inputTokens,
    reserved_output_tokens: reservedOutputTokens,
    safety_margin_tokens: safetyMargin,
    configured_context_limit: configuredContextLimit,
    usable_input_tokens: usableInputTokens,
    fits: inputTokens <= usableInputTokens,
  };
}

/** Partitions a source window greedily, without overlap or dropped messages. */
export function partitionSourceWindow(messages, renderPrompt, preflight) {
  const partitions = [];
  const oversized = [];
  let current = [];
  for (const message of messages) {
    const candidate = [...current, message];
    if (preflight(renderPrompt(candidate)).fits) {
      current = candidate;
      continue;
    }
    if (current.length) partitions.push(current);
    const single = [message];
    if (preflight(renderPrompt(single)).fits) current = single;
    else {
      oversized.push(single);
      current = [];
    }
  }
  if (current.length) partitions.push(current);
  return { partitions, oversized };
}

export function isEstimatedContextOverflow(error) {
  const diagnostics = error?.sme_request_diagnostics ?? {};
  return Number(diagnostics.http_status) === 400
    && diagnostics.likely_cause === 'estimated_context_overflow';
}

export function sourceRange(messages = []) {
  const indices = messages.map((message, index) => Number.isInteger(message?.__sme_original_index)
    ? message.__sme_original_index
    : index);
  return {
    start: indices.length ? Math.min(...indices) : null,
    end: indices.length ? Math.max(...indices) : null,
    message_count: indices.length,
    source_indices: indices,
  };
}

export function summarizeExtractionCoverage(records = []) {
  const roots = records.filter((record) => !record.parent_range_id);
  const complete = roots.filter((record) => ['completed', 'repartitioned_completed'].includes(record.coverage_terminal_state));
  // A root that never reached a completed terminal state is unresolved even
  // when a child failed for a reason other than context overflow. This keeps
  // the summary honest if a repartitioned child aborts mid-lineage.
  const unresolved = roots.filter((record) => !complete.includes(record));
  return {
    original_ranges: roots.length,
    completed_ranges: complete.length,
    unresolved_ranges: unresolved.length,
    coverage_complete: roots.length === complete.length,
    unresolved_range_ids: unresolved.map((record) => record.range_id),
  };
}
