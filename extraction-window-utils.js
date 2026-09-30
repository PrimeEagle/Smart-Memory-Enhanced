/** Privacy-safe helpers for final-prompt extraction budgeting and coverage. */
export const EXTRACTION_CONTEXT_SAFETY_MARGIN = 1000;
export const EXTRACTION_PROTOCOL_OVERHEAD = 256;

/** Chooses the smallest trustworthy context ceiling without changing user configuration. */
export function resolveEffectiveContextLimit(...limits) {
  const valid = limits.flat().map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? Math.min(...valid) : null;
}

export function makeExtractionPreflight({
  prompt = '',
  estimateTokens,
  configuredContextLimit,
  effectiveContextLimit = configuredContextLimit,
  reservedOutputTokens,
  safetyMargin = EXTRACTION_CONTEXT_SAFETY_MARGIN,
  protocolOverhead = EXTRACTION_PROTOCOL_OVERHEAD,
} = {}) {
  const inputTokens = estimateTokens(prompt);
  const usableInputTokens = Math.max(1, effectiveContextLimit - reservedOutputTokens - safetyMargin - protocolOverhead);
  return {
    estimated_input_tokens: inputTokens,
    reserved_output_tokens: reservedOutputTokens,
    safety_margin_tokens: safetyMargin,
    protocol_overhead_tokens: protocolOverhead,
    configured_context_limit: configuredContextLimit,
    effective_context_limit: effectiveContextLimit,
    usable_input_tokens: usableInputTokens,
    fits: inputTokens <= usableInputTokens,
  };
}

const CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'exceed_context_size_error',
  'max_context_length_exceeded',
  'prompt_too_long',
]);

function finitePositive(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function parseEmbeddedJson(value) {
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
}

function collectProviderEnvelopes(error) {
  const queue = [error];
  const seen = new Set();
  const envelopes = [];
  while (queue.length && envelopes.length < 24) {
    const value = queue.shift();
    if (!value || (typeof value !== 'object' && typeof value !== 'string')) continue;
    if (typeof value === 'string') {
      const parsed = parseEmbeddedJson(value);
      if (parsed) queue.push(parsed);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    envelopes.push(value);
    for (const key of ['cause', 'error', 'data', 'body', 'response', 'details', 'detail', 'result', 'sme_request_diagnostics', 'context_overflow']) {
      if (value[key] != null) queue.push(value[key]);
    }
    if (typeof value.message === 'string') queue.push(value.message);
  }
  return envelopes;
}

/**
 * Classifies context overflow errors without retaining prompts or provider text.
 * Structured provider fields are authoritative; message matching is used only
 * when no structured code/type or token-limit pair survived an adapter.
 */
export function classifyContextOverflow(error, context = {}) {
  const envelopes = collectProviderEnvelopes(error);
  const diagnostics = error?.sme_request_diagnostics ?? {};
  const status = finitePositive(
    diagnostics.http_status,
    ...envelopes.flatMap((item) => [item.status, item.statusCode, item.http_status, item.response?.status]),
  );
  let normalizedCode = null;
  let reportedPromptTokens = null;
  let reportedContextTokens = null;
  let reportedModel = context.model ?? null;
  let engineSessionFingerprint = null;
  let structuredMatch = diagnostics.context_overflow?.classification === 'context_overflow';
  let structuredEvidencePresent = false;
  for (const item of envelopes) {
    const candidates = [item.type, item.error_type, item.code, item.error_code]
      .filter((value) => value != null && String(value).trim())
      .map((value) => String(value).trim().toLowerCase());
    const code = candidates.find((value) => CONTEXT_OVERFLOW_CODES.has(value)
      || /(?:context|prompt).*(?:length|size).*(?:exceed|too[_ -]?long|overflow)/.test(value))
      ?? candidates[0] ?? '';
    if (code) structuredEvidencePresent = true;
    if (!normalizedCode && code) normalizedCode = code;
    reportedPromptTokens ??= finitePositive(item.n_prompt_tokens, item.prompt_tokens, item.input_tokens, item.num_prompt_tokens);
    reportedContextTokens ??= finitePositive(item.n_ctx, item.context_length, item.context_window, item.max_context_length, item.max_position_embeddings);
    reportedModel ??= typeof item.model === 'string' ? item.model : null;
    engineSessionFingerprint ??= typeof (item.system_fingerprint ?? item.engine_session_fingerprint ?? item.engine_id) === 'string'
      ? (item.system_fingerprint ?? item.engine_session_fingerprint ?? item.engine_id) : null;
    if (CONTEXT_OVERFLOW_CODES.has(code) || /(?:context|prompt).*(?:length|size).*(?:exceed|too[_ -]?long|overflow)/.test(code)) {
      structuredMatch = true;
      normalizedCode = code;
    }
  }
  if (reportedPromptTokens && reportedContextTokens && reportedPromptTokens > reportedContextTokens) structuredMatch = true;
  if (diagnostics.likely_cause === 'estimated_context_overflow' && Number(status) === 400) structuredMatch = true;

  let messageFallback = false;
  if (!structuredMatch && !structuredEvidencePresent) {
    const text = envelopes.map((item) => String(item?.message ?? '')).join(' ').toLowerCase();
    messageFallback = /(?:context (?:length|window|size)|maximum context|prompt (?:is )?too long).*(?:exceed|overflow|too (?:large|long)|maximum)/.test(text)
      || /(?:exceed|overflow|too (?:large|long)).*(?:context (?:length|window|size)|maximum context)/.test(text);
  }
  if (!structuredMatch && !messageFallback) return null;

  const configured = finitePositive(context.configuredContextLimit, diagnostics.configured_context_tokens, diagnostics.configured_context_limit);
  const effectiveBefore = finitePositive(context.effectiveContextLimitBefore, diagnostics.effective_context_tokens, configured);
  return {
    classification: 'context_overflow',
    provider: context.provider ?? diagnostics.provider ?? null,
    model: reportedModel ?? diagnostics.model_name ?? null,
    engine_session_fingerprint: engineSessionFingerprint,
    transport: context.transport ?? diagnostics.endpoint_category ?? null,
    http_status: status,
    normalized_provider_error_code: normalizedCode,
    reported_prompt_tokens: reportedPromptTokens,
    reported_context_tokens: reportedContextTokens,
    configured_context_limit: configured,
    effective_context_limit_before: effectiveBefore,
    effective_context_limit_after: reportedContextTokens ? Math.min(effectiveBefore ?? reportedContextTokens, reportedContextTokens) : effectiveBefore,
    retryable_after_repartition: true,
    classification_source: structuredMatch ? 'structured_provider_error' : 'message_fallback',
    privacy_safe_envelope_shape: envelopes.slice(0, 8).map((item) => Object.keys(item)
      .filter((key) => !['message', 'body', 'content', 'prompt', 'messages'].includes(key))
      .sort()),
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
  return classifyContextOverflow(error) !== null;
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

/** Non-reversible fingerprint proving an exact ordered recovery source range. */
export function sourceWindowFingerprint(messages = []) {
  let hash = 2166136261;
  for (const [position, message] of messages.entries()) {
    const value = `${message?.__sme_original_index ?? position}\u001f${message?.name ?? ''}\u001f${message?.mes ?? ''}\u001e`;
    for (const character of value) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function extractionRecoveryChildKey(tier, owner, messages = []) {
  const range = sourceRange(messages);
  return `${tier}:${String(owner ?? 'chat').toLowerCase()}:${range.start ?? 'none'}-${range.end ?? 'none'}:${sourceWindowFingerprint(messages)}`;
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
