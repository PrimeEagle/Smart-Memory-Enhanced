/** Privacy-safe structural recovery for tagged Long-Term and Session output. */
import { analyzeBracketModifiers, analyzeTaggedMemoryOutput, getTaggedMemoryGrammar } from './parsers.js';

export const MALFORMED_RECOVERY_SCHEMA_VERSION = 3;

export const MALFORMED_RECOVERY_LIMITS = Object.freeze({
  local_normalization_paths: 5,
  provider_repair_attempts: 1,
  changed_dimension_regenerations: 1,
  structured_json_regenerations: 1,
  maximum_split_depth: 2,
  minimum_child_messages: 5,
  maximum_additional_provider_requests: 20,
  // Local providers can legitimately take many minutes per generation. This
  // is a safety ceiling across one root's ladder, not a request timeout.
  maximum_wall_time_ms: 6 * 60 * 60 * 1000,
  automatic_sweep_rounds: 2,
});

const taggedTypes = (tier) => getTaggedMemoryGrammar(tier).types;

const classifyCharacter = (character) => {
  if (!character) return 'none';
  if (character === '[') return 'tag_open';
  if (character === '{') return 'json_object_open';
  if (character === ']') return 'tag_or_json_array_close';
  if (character === '}') return 'json_object_close';
  if (/[-*+>]/.test(character)) return 'prose_or_bullet_marker';
  if (/\p{L}/u.test(character)) return 'letter';
  if (/\d/.test(character)) return 'digit';
  return 'punctuation_or_symbol';
};

const responseLines = (response) => String(response ?? '').replace(/\r\n?/g, '\n').split('\n');

/** Returns content-free shape data suitable for exported diagnostics. */
export function analyzeMalformedResponse(response, { tier = 'longterm', finishReason = null,
  requestedOutputTokens = null, reportedOutputTokens = null } = {}) {
  const text = String(response ?? '');
  const trimmed = text.trim();
  const lines = responseLines(text);
  const lexical = analyzeTaggedMemoryOutput(text, { tier });
  const firstStructure = lines.findIndex((line) => /^\s*(?:[-*+]\s*)?\[/.test(line));
  const lastStructure = lines.findLastIndex((line) => /^\s*(?:[-*+]\s*)?\[/.test(line));
  const proseBefore = firstStructure > 0 && lines.slice(0, firstStructure).some((line) => line.trim() && !/^```/.test(line.trim()));
  const proseAfter = lastStructure >= 0 && lines.slice(lastStructure + 1).some((line) => line.trim() && !/^```/.test(line.trim()));
  const jsonLike = /^\{/.test(trimmed) || /^\[\s*\{/.test(trimmed) || /^\[\s*\]/.test(trimmed);
  let validJson = false;
  if (jsonLike) {
    try { JSON.parse(trimmed); validJson = true; } catch { /* shape only */ }
  }
  const truncatedJson = jsonLike && !validJson && ((/^\{/.test(trimmed) || /^\[\s*\{/.test(trimmed))
    && !/[\]}]\s*$/.test(trimmed));
  const truncatedTag = lines.some((line) => /^\s*(?:[-*+]\s*)?\[[^\]]*$/.test(line));
  const outputLengthTruncation = finishReason === 'length'
    || (requestedOutputTokens !== null && requestedOutputTokens !== undefined
      && reportedOutputTokens !== null && reportedOutputTokens !== undefined
      && Number.isFinite(Number(requestedOutputTokens)) && Number.isFinite(Number(reportedOutputTokens))
      && Number(reportedOutputTokens) >= Number(requestedOutputTokens));
  const modifierFailures = lexical.rejected.flatMap((entry) => (entry.modifier_failure_subtypes ?? [])
    .map((reason_code, index) => ({ reason_code, line_index: entry.line_index,
      token_index: entry.modifier_field_positions?.[index]?.token_index ?? null })));
  const modifierNormalizations = [
    ...lexical.accepted.flatMap((entry) => entry.modifier_diagnostics?.normalizations?.map((item) => item.reason_code) ?? []),
    ...lexical.rejected.flatMap((entry) => entry.modifier_normalization_subtypes ?? []),
  ];
  const modifierMissingSourceCitationCount = lexical.accepted.filter((entry) =>
    entry.modifier_diagnostics?.missing_source_citation === true).length
    + lexical.rejected.filter((entry) => entry.modifier_missing_source_citation === true).length;
  return {
    schema_version: MALFORMED_RECOVERY_SCHEMA_VERSION,
    expected_output_format: `${tier}_tagged_lines_v1`,
    response_received: text.length > 0,
    response_character_length: text.length,
    response_line_count: lines.length,
    first_non_whitespace_character_class: classifyCharacter(trimmed[0]),
    last_non_whitespace_character_class: classifyCharacter(trimmed.at(-1)),
    code_fence_present: /```/.test(text),
    json_like_object: /^\s*\{/.test(text),
    json_like_array: /^\s*\[\s*\{/.test(text),
    valid_json: validJson,
    tagged_line_candidate_count: lexical.tagged_candidate_count,
    valid_tagged_record_count: lexical.parser_accepted_record_count,
    parser_accepted_record_count: lexical.parser_accepted_record_count,
    normalization_accepted_record_count: 0,
    semantic_validation_rejected_record_count: null,
    rejected_tagged_record_count: lexical.structurally_rejected_record_count,
    structurally_rejected_record_count: lexical.structurally_rejected_record_count,
    unclassified_fragment_count: lexical.unclassified_fragment_count,
    structural_candidate_count: lexical.structural_candidate_count,
    recoverable_claim_fragment_count: lexical.recoverable_claim_fragment_count,
    parser_shape_counts_reconciled: lexical.accounting_reconciled,
    modifier_failure_subtype_counts: modifierFailures.reduce((counts, item) => {
      counts[item.reason_code] = (counts[item.reason_code] ?? 0) + 1;
      return counts;
    }, {}),
    modifier_failure_field_positions: modifierFailures.slice(0, 24),
    modifier_failure_field_positions_bounded: modifierFailures.length > 24,
    modifier_locally_normalizable_count: lexical.accepted.filter((entry) =>
      entry.modifier_diagnostics?.safely_normalizable === true).length
      + lexical.rejected.filter((entry) => entry.modifier_safely_normalizable).length,
    modifier_missing_source_citation_count: modifierMissingSourceCitationCount,
    modifier_normalization_subtype_counts: modifierNormalizations.reduce((counts, reason) => {
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {}),
    prose_before_structure: proseBefore,
    prose_after_structure: proseAfter,
    escaped_newlines_present: /\\[rn]/.test(text),
    truncated_json: truncatedJson,
    truncated_tagged_record: truncatedTag,
    output_length_truncation: outputLengthTruncation,
    provider_finish_reason: finishReason,
    requested_output_tokens: requestedOutputTokens,
    reported_output_tokens: reportedOutputTokens,
  };
}

export function classifyTaggedResponseFailure(response, options = {}) {
  const shape = analyzeMalformedResponse(response, options);
  const text = String(response ?? '').trim();
  if (!text) return 'empty_or_whitespace_response';
  if (text.toUpperCase() === 'NONE') return 'explicit_none';
  if (/^(?:<analysis>|<think>)[\s\S]*?(?:<\/analysis>|<\/think>)?$/i.test(text)) return 'reasoning_only_response';
  if (/^\s*\{[\s\S]*"error"\s*:\s*\{/i.test(text)) return 'structured_provider_error_mistaken_for_generated_content';
  if (/^\s*\{[\s\S]*"(?:choices|usage)"\s*:/i.test(text)) return 'transport_envelope_mistaken_for_model_content';
  if (shape.output_length_truncation) return 'output_length_truncation';
  if (shape.truncated_json) return 'truncated_json';
  if (shape.valid_json) {
    const converted = jsonRecords(response, options.tier ?? 'longterm');
    return converted.supported ? 'json_returned_instead_of_tagged_records' : 'valid_json_with_unsupported_schema';
  }
  if (shape.truncated_tagged_record) return 'truncated_tagged_record';
  if (shape.valid_tagged_record_count > 0 && shape.rejected_tagged_record_count > 0) return 'partial_valid_output';
  if (shape.valid_tagged_record_count > 0 && (shape.prose_before_structure || shape.prose_after_structure)) return 'prose_around_tagged_records';
  if (shape.tagged_line_candidate_count > 0) {
    const tagText = responseLines(text).filter((line) => /^\s*(?:[-*+]\s*)?\[/.test(line)).join('\n');
    const allowed = taggedTypes(options.tier ?? 'longterm');
    if (!new RegExp(`\\[(?:${allowed.join('|')})(?:[:\\]])`, 'i').test(tagText)) return 'unsupported_memory_type';
    if (/\[[^\]]*(?:source|sources|source_indices)\s*=\s*[^\d\]]/i.test(tagText)) return 'invalid_source_citations';
    if (/\[[^\]]*(?:source|sources|source_indices)\s*=\s*\]/i.test(tagText)) return 'missing_source_citations';
    if (Object.keys(shape.modifier_failure_subtype_counts ?? {}).length
      || shape.modifier_locally_normalizable_count > 0) return 'invalid_modifier_syntax';
    return 'malformed_tag';
  }
  return 'missing_tagged_records';
}

/** Selects the cheapest safe recovery stage from content-free response shape. */
export function routeMalformedTaggedRecovery(response, { tier = 'longterm', reason = null } = {}) {
  const malformedReason = reason ?? classifyTaggedResponseFailure(response, { tier });
  const shape = analyzeMalformedResponse(response, { tier });
  const repairableReasons = new Set(['invalid_modifier_syntax', 'malformed_tag', 'partial_valid_output']);
  const compactRepairEligible = repairableReasons.has(malformedReason)
    && shape.recoverable_claim_fragment_count > 0;
  return {
    route: compactRepairEligible ? 'compact_response_repair' : 'changed_dimension_regeneration',
    malformed_reason: malformedReason,
    compact_repair_eligible: compactRepairEligible,
    recoverable_claim_fragment_count: shape.recoverable_claim_fragment_count,
    avoided_repair_reason: compactRepairEligible ? null
      : malformedReason === 'repair_failure_sentinel' ? 'repair_failure_sentinel'
        : shape.recoverable_claim_fragment_count === 0 ? 'no_recoverable_claim_content'
          : `reason_not_repair_eligible:${malformedReason}`,
  };
}

function canonicalJsonRecord(record, tier) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const allowed = taggedTypes(tier);
  const type = String(record.type ?? record.memory_type ?? record.category ?? '').trim().toLowerCase();
  const content = String(record.content ?? record.memory ?? record.text ?? record.description ?? '').trim();
  if (!allowed.includes(type) || content.length < (tier === 'session' ? 4 : 6)) return null;
  const importance = [1, 2, 3].includes(Number(record.importance ?? record.score))
    ? Number(record.importance ?? record.score) : 2;
  const expiration = /^(scene|session|permanent)$/i.test(String(record.expiration ?? record.expires ?? ''))
    ? String(record.expiration ?? record.expires).toLowerCase()
    : tier === 'session' ? 'session' : 'permanent';
  const entities = Array.isArray(record.entities) ? record.entities : record.entity ? [record.entity] : [];
  const sources = Array.isArray(record.source_indices) ? record.source_indices
    : Array.isArray(record.source_messages) ? record.source_messages
      : Array.isArray(record.sources) ? record.sources : [];
  const modifiers = [importance, expiration];
  if (entities.length) modifiers.push(`entity=${entities.map(String).join(',')}`);
  const validSources = sources.map(Number).filter((value) => Number.isInteger(value) && value >= 0);
  if (validSources.length) modifiers.push(`sources=${validSources.join(',')}`);
  return `[${type}:${modifiers.join(':')}] ${content.replace(/\s+/g, ' ')}`;
}

function jsonRecords(response, tier) {
  let parsed;
  try { parsed = JSON.parse(String(response ?? '').trim()); } catch { return { lines: [], supported: false }; }
  const collectionKey = ['memories', 'records', 'items', 'results'].find((key) => Array.isArray(parsed?.[key]));
  const recognizedContainer = Array.isArray(parsed) || Boolean(collectionKey)
    || Boolean(parsed && typeof parsed === 'object');
  const candidates = Array.isArray(parsed) ? parsed
    : collectionKey ? parsed[collectionKey]
      : parsed && typeof parsed === 'object' ? [parsed] : [];
  const lines = candidates.map((record) => canonicalJsonRecord(record, tier)).filter(Boolean);
  return { lines, supported: recognizedContainer && lines.length === candidates.length };
}

/** Conservative normalization. Success requires the ordinary parser to accept the result. */
export function normalizeTaggedMemoryOutput(response, { tier = 'longterm', parse } = {}) {
  const raw = String(response ?? '');
  const attempts = [];
  const tryPath = (path, text) => {
    if (attempts.length >= MALFORMED_RECOVERY_LIMITS.local_normalization_paths || !text) return null;
    const records = typeof parse === 'function' ? parse(text) : [];
    attempts.push({ path, accepted_record_count: records.length });
    return records.length ? { text, records, succeeded_path: path } : null;
  };
  const unfenced = raw.replace(/^\s*```(?:json|text|markdown)?\s*/i, '').replace(/\s*```\s*$/i, '');
  let result = unfenced !== raw ? tryPath('strip_markdown_code_fence', unfenced) : null;
  const unescaped = unfenced.replace(/\\r\\n|\\n|\\r/g, '\n');
  result ??= unescaped !== unfenced ? tryPath('decode_escaped_newlines', unescaped) : null;
  const unbulleted = unescaped.replace(/^\s*[-*+]\s+(?=\[)/gm, '');
  result ??= unbulleted !== unescaped ? tryPath('remove_tagged_line_bullets', unbulleted) : null;
  const modifierLines = responseLines(unbulleted);
  let modifierChanged = false;
  let modifierAmbiguous = false;
  const normalizedModifierLines = modifierLines.map((line) => {
    const match = line.match(/^\s*\[([a-z_]+)([^\]]*)\]\s*(\S[\s\S]*)$/i);
    if (!match || !taggedTypes(tier).includes(match[1].toLowerCase())) return line;
    const analysis = analyzeBracketModifiers(match[2]);
    if (analysis.failures.length) { modifierAmbiguous = true; return line; }
    if (!analysis.safely_normalizable) return line;
    modifierChanged = true;
    const suffix = analysis.canonical_modifiers ? `:${analysis.canonical_modifiers}` : '';
    return `[${match[1].toLowerCase()}${suffix}] ${match[3].trim()}`;
  });
  result ??= modifierChanged && !modifierAmbiguous
    ? tryPath('normalize_unambiguous_modifiers', normalizedModifierLines.join('\n')) : null;
  const allowed = taggedTypes(tier);
  const extracted = responseLines(unbulleted).filter((line) => new RegExp(`^\\s*\\[(?:${allowed.join('|')})(?:[^\\]]*)\\]\\s*\\S`, 'i').test(line)).join('\n');
  result ??= extracted && extracted !== unbulleted.trim() ? tryPath('extract_complete_tagged_lines', extracted) : null;
  const json = jsonRecords(unfenced, tier);
  result ??= json.supported ? tryPath('convert_supported_json_records', json.lines.join('\n')) : null;
  return {
    succeeded: Boolean(result),
    records: result?.records ?? [],
    normalized_text: result?.text ?? null,
    succeeded_path: result?.succeeded_path ?? null,
    paths_attempted: attempts,
    structural: analyzeMalformedResponse(response, { tier }),
    ambiguous_conversion_rejected: Boolean(json.lines.length && !json.supported),
  };
}

export function buildCompactFormatRepairPrompt(response, { tier = 'longterm' } = {}) {
  const types = taggedTypes(tier);
  const defaultExpiration = tier === 'session' ? 'session' : 'permanent';
  const boundedResponse = String(response ?? '').slice(0, 16000);
  return `Transform the supplied malformed model output into the exact tagged-line schema below.\n\nRules:\n- Preserve only claims already present in MALFORMED OUTPUT.\n- Do not add, infer, summarize, or embellish facts.\n- Keep source indices only when present and valid.\n- Drop ambiguous fragments.\n- Output repaired tagged records only.\n- If no record can be repaired without inventing content, output exactly REPAIR_FAILED.\n\nSchema:\n[type:importance:expiration:entity=Name/type:sources=0,1] content\nAllowed types: ${types.join(', ')}\nImportance: 1, 2, or 3\nDefault expiration: ${defaultExpiration}\n\nMALFORMED OUTPUT BEGIN\n${boundedResponse}\nMALFORMED OUTPUT END`;
}

export function buildChangedDimensionRegenerationPrompt(originalPrompt, { tier = 'longterm' } = {}) {
  const types = taggedTypes(tier);
  // Keep the recovery contract last. Local models commonly weight the final
  // instruction most strongly; prepending this override allowed the original
  // prompt body to supersede the very schema change recovery was meant to make.
  return `${originalPrompt}\n\nRECOVERY MODE — FINAL OUTPUT CONTRACT\nReturn only complete tagged lines. No JSON, markdown, analysis, preface, or trailing commentary. Use only these types: ${types.join(', ')}. Use exactly this modifier order and spelling: [type:importance:expiration:entity=Name/type:sources=0,1]. Omit entity when none is grounded, but sources is mandatory. Use commas only inside entity and sources lists. Every record must cite source indices from the supplied numbered messages. If there are no supported records, output exactly NONE.`;
}

export function buildStructuredJsonRegenerationPrompt(originalPrompt, { tier = 'longterm' } = {}) {
  const types = taggedTypes(tier);
  const expiration = tier === 'session' ? 'session' : 'permanent';
  return `${originalPrompt}\n\nFINAL MINIMUM-WINDOW RECOVERY — JSON ONLY\nThe tagged-line attempts could not be parsed. Return only a JSON array, with no markdown, analysis, preface, or trailing text. Each item must use exactly these keys: {"type":"${types[0]}","content":"supported claim","importance":2,"expiration":"${expiration}","entities":["Name"],"sources":[0]}. Allowed type values: ${types.join(', ')}. importance must be 1, 2, or 3. sources is mandatory and must contain only indices from the supplied numbered messages. entities may be an empty array. Do not add claims. If no supported record exists, return exactly [].`;
}

function isExplicitEmptyStructuredResponse(response) {
  const text = String(response ?? '').trim();
  if (text === '[]') return true;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && !Array.isArray(parsed)
      && ['memories', 'records', 'items', 'results'].some((key) => Array.isArray(parsed[key]) && parsed[key].length === 0));
  } catch { return false; }
}

export function partitionMalformedSourceWindow(messages, { minimumChildMessages = MALFORMED_RECOVERY_LIMITS.minimum_child_messages } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  if (source.length <= minimumChildMessages) return [];
  const midpoint = Math.ceil(source.length / 2);
  const children = [source.slice(0, midpoint), source.slice(midpoint)].filter(Boolean);
  if (children.some((child) => child.length < minimumChildMessages)) return [];
  return children;
}

export function malformedChildCoverageComplete(expectedChildKeys, committedChildKeys) {
  const committed = new Set((committedChildKeys ?? []).filter(Boolean));
  const expected = [...new Set((expectedChildKeys ?? []).filter(Boolean))];
  return expected.length > 0 && expected.every((key) => committed.has(key));
}

export function createMalformedRecoveryBudget(prior = null, now = Date.now()) {
  return prior ?? { schema_version: 1, started_at: now, additional_provider_requests: 0,
    requests_by_stage: {}, recovered_by_stage: {}, split_children_committed: [] };
}

export function consumeMalformedRecoveryRequest(budget, stage, now = Date.now()) {
  if (!budget) return { allowed: false, reason: 'recovery_budget_missing' };
  if (now - Number(budget.started_at ?? now) > MALFORMED_RECOVERY_LIMITS.maximum_wall_time_ms) return { allowed: false, reason: 'recovery_wall_time_exhausted' };
  if (Number(budget.additional_provider_requests ?? 0) >= MALFORMED_RECOVERY_LIMITS.maximum_additional_provider_requests) return { allowed: false, reason: 'recovery_request_limit_exhausted' };
  budget.additional_provider_requests = Number(budget.additional_provider_requests ?? 0) + 1;
  budget.requests_by_stage[stage] = Number(budget.requests_by_stage[stage] ?? 0) + 1;
  return { allowed: true, request_number: budget.additional_provider_requests };
}

export function markMalformedRecoverySuccess(budget, stage) {
  if (!budget) return;
  budget.recovered_by_stage[stage] = Number(budget.recovered_by_stage[stage] ?? 0) + 1;
}

function terminalMalformedError(tier, reason, stage, budget, cause = null) {
  const error = new Error(`${tier === 'session' ? 'Session' : 'Long-term'} extraction exhausted bounded malformed-output recovery.`);
  if (cause) error.cause = cause;
  error.code = 'SME_MALFORMED_PROVIDER_OUTPUT';
  error.sme_request_diagnostics = {
    tier, malformed_reason: reason, recovery_stage_exhausted: stage,
    additional_provider_requests: Number(budget?.additional_provider_requests ?? 0),
    recovery_limits: MALFORMED_RECOVERY_LIMITS,
    last_failure_kind: cause ? 'provider_failure' : 'parser_failure',
  };
  return error;
}

/**
 * Shared bounded recovery through local normalization, compact repair,
 * changed-dimension regeneration, and caller-provided exact repartition.
 */
export async function recoverMalformedTaggedOutput({
  response, tier, parse, generate, originalPrompt, responseLength,
  originalAttempt, beginAttempt, finishAttempt, splitWindow = null,
  budget = createMalformedRecoveryBudget(), splitDepth = 0,
} = {}) {
  const parserPaths = ['strict_expected_format'];
  const originalReason = classifyTaggedResponseFailure(response, { tier });
  const recoveryRoute = routeMalformedTaggedRecovery(response, { tier, reason: originalReason });
  const local = normalizeTaggedMemoryOutput(response, { tier, parse });
  if (local.succeeded) {
    finishAttempt(originalAttempt, {
      terminal_outcome: 'completed', malformed_reason: null,
      notice_reason: `local_normalization:${originalReason}`, recoverable: true,
      recovery_stage: 'local_normalization', final_recovery_stage: 'local_normalization',
      response_shape: { ...local.structural, normalization_accepted_record_count: local.records.length },
      parser_paths_attempted: parserPaths,
      local_normalization_paths_attempted: local.paths_attempted.map((item) => item.path),
    });
    markMalformedRecoverySuccess(budget, 'local_normalization');
    return { records: local.records, stage: 'local_normalization', budget, original_reason: originalReason };
  }
  finishAttempt(originalAttempt, {
    terminal_outcome: 'provider_response_malformed', malformed_reason: originalReason, recoverable: true,
    recovery_stage: 'strict_generation', response_text: response,
    parser_paths_attempted: parserPaths,
    local_normalization_paths_attempted: local.paths_attempted.map((item) => item.path),
    recovery_route: recoveryRoute.route,
    avoided_repair_reason: recoveryRoute.avoided_repair_reason,
  });

  let lastReason = originalReason;
  let lastFailedAttempt = originalAttempt;
  let lastProviderError = null;
  const repairBudget = recoveryRoute.compact_repair_eligible
    ? consumeMalformedRecoveryRequest(budget, 'compact_response_repair')
    : { allowed: false, reason: recoveryRoute.avoided_repair_reason };
  if (repairBudget.allowed) {
    const attempt = beginAttempt('format_repair', ['malformed_response_input', 'compact_repair_prompt'], {
      recovery_of_attempt_id: originalAttempt?.attempt_id ?? null, repair_reason: originalReason,
      recovery_stage: 'compact_response_repair', expected_output_format: `${tier}_tagged_lines_v1`,
    });
    let repairedResponse;
    try {
      repairedResponse = await generate(buildCompactFormatRepairPrompt(response, { tier }), {
        responseLength, task: `${tier}-malformed-response-repair`,
      });
    } catch (error) {
      finishAttempt(attempt, { terminal_outcome: 'provider_failure', recoverable: true,
        recovery_stage: 'compact_response_repair', final_disposition: 'repair_provider_failure' });
      repairedResponse = null;
      lastFailedAttempt = attempt;
      lastProviderError = error;
    }
    if (repairedResponse !== null) {
      lastProviderError = null;
      let records = String(repairedResponse).trim() === 'REPAIR_FAILED' ? [] : parse(repairedResponse);
      let normalized = null;
      if (!records.length && String(repairedResponse).trim() !== 'REPAIR_FAILED') {
        normalized = normalizeTaggedMemoryOutput(repairedResponse, { tier, parse });
        records = normalized.records;
      }
      if (records.length) {
        finishAttempt(attempt, { terminal_outcome: 'completed', recoverable: true,
          recovery_stage: 'compact_response_repair', final_recovery_stage: 'compact_response_repair',
          response_text: repairedResponse, parser_paths_attempted: ['strict_expected_format'],
          local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [] });
        markMalformedRecoverySuccess(budget, 'compact_response_repair');
        return { records, stage: 'compact_response_repair', budget, original_reason: originalReason };
      }
      lastReason = String(repairedResponse).trim() === 'REPAIR_FAILED'
        ? 'repair_failure_sentinel' : classifyTaggedResponseFailure(repairedResponse, { tier });
      finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: lastReason,
        recoverable: true, recovery_stage: 'compact_response_repair', response_text: repairedResponse,
        parser_paths_attempted: ['strict_expected_format'],
        local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [] });
      lastFailedAttempt = attempt;
    }
  }

  const regenerationBudget = consumeMalformedRecoveryRequest(budget, 'changed_dimension_regeneration');
  if (regenerationBudget.allowed) {
    const attempt = beginAttempt('changed_dimension_regeneration', ['minimal_output_prompt', 'deterministic_fresh_generation'], {
      recovery_of_attempt_id: lastFailedAttempt?.attempt_id ?? originalAttempt?.attempt_id ?? null, repair_reason: lastReason,
      recovery_stage: 'changed_dimension_regeneration', expected_output_format: `${tier}_tagged_lines_v1`,
    });
    let regeneratedResponse;
    try {
      regeneratedResponse = await generate(buildChangedDimensionRegenerationPrompt(originalPrompt, { tier }), {
        responseLength, task: `${tier}-malformed-changed-dimension-regeneration`,
      });
    } catch (error) {
      finishAttempt(attempt, { terminal_outcome: 'provider_failure', recoverable: true,
        recovery_stage: 'changed_dimension_regeneration', final_disposition: 'regeneration_provider_failure' });
      regeneratedResponse = null;
      lastFailedAttempt = attempt;
      lastProviderError = error;
    }
    if (regeneratedResponse !== null) {
      lastProviderError = null;
      if (String(regeneratedResponse).trim().toUpperCase() === 'NONE') {
        finishAttempt(attempt, { terminal_outcome: 'completed_no_candidates', recoverable: true,
          recovery_stage: 'changed_dimension_regeneration', final_recovery_stage: 'changed_dimension_regeneration' });
        markMalformedRecoverySuccess(budget, 'changed_dimension_regeneration');
        return { records: [], explicit_none: true, stage: 'changed_dimension_regeneration', budget, original_reason: originalReason };
      }
      let records = parse(regeneratedResponse);
      let normalized = null;
      if (!records.length) {
        normalized = normalizeTaggedMemoryOutput(regeneratedResponse, { tier, parse });
        records = normalized.records;
      }
      if (records.length) {
        finishAttempt(attempt, { terminal_outcome: 'completed', recoverable: true,
          recovery_stage: 'changed_dimension_regeneration', final_recovery_stage: 'changed_dimension_regeneration',
          response_text: regeneratedResponse, parser_paths_attempted: ['strict_expected_format'],
          local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [] });
        markMalformedRecoverySuccess(budget, 'changed_dimension_regeneration');
        return { records, stage: 'changed_dimension_regeneration', budget, original_reason: originalReason };
      }
      lastReason = classifyTaggedResponseFailure(regeneratedResponse, { tier });
      finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: lastReason,
        recoverable: splitDepth < MALFORMED_RECOVERY_LIMITS.maximum_split_depth,
        recovery_stage: 'changed_dimension_regeneration', response_text: regeneratedResponse,
        parser_paths_attempted: ['strict_expected_format'],
        local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [],
        smaller_window_retry_followed: Boolean(splitWindow) });
      lastFailedAttempt = attempt;
    }
  }

  let splitResult = null;
  if (splitWindow && splitDepth < MALFORMED_RECOVERY_LIMITS.maximum_split_depth) {
    splitResult = await splitWindow({
      budget, nextDepth: splitDepth + 1, reason: lastReason,
      parentAttemptId: lastFailedAttempt?.attempt_id ?? originalAttempt?.attempt_id ?? null,
    });
    if (splitResult?.completed) {
      markMalformedRecoverySuccess(budget, 'malformed_source_repartition');
      return { repartitioned: true, added: Number(splitResult.added ?? 0), stage: 'malformed_source_repartition', budget, original_reason: originalReason };
    }
  }
  // Once deterministic repartition reaches its minimum useful source window,
  // change the output representation rather than replaying the same failed
  // tagged request forever on every Resume. JSON is converted through the
  // ordinary parser and still requires source citations; it cannot invent or
  // bypass provenance.
  if (!splitResult?.completed) {
    const jsonBudget = consumeMalformedRecoveryRequest(budget, 'structured_json_regeneration');
    if (jsonBudget.allowed) {
      const attempt = beginAttempt('structured_json_regeneration', ['structured_json_schema', 'minimum_window_terminal_rescue'], {
        recovery_of_attempt_id: lastFailedAttempt?.attempt_id ?? originalAttempt?.attempt_id ?? null,
        repair_reason: lastReason, recovery_stage: 'structured_json_regeneration',
        expected_output_format: `${tier}_json_records_v1`,
      });
      let jsonResponse;
      try {
        jsonResponse = await generate(buildStructuredJsonRegenerationPrompt(originalPrompt, { tier }), {
          responseLength, task: `${tier}-malformed-structured-json-regeneration`,
        });
      } catch (error) {
        finishAttempt(attempt, { terminal_outcome: 'provider_failure', recoverable: true,
          recovery_stage: 'structured_json_regeneration', final_disposition: 'structured_json_provider_failure' });
        jsonResponse = null;
        lastProviderError = error;
      }
      if (jsonResponse !== null) {
        lastProviderError = null;
        if (isExplicitEmptyStructuredResponse(jsonResponse)) {
          finishAttempt(attempt, { terminal_outcome: 'completed_no_candidates', recoverable: true,
            recovery_stage: 'structured_json_regeneration', final_recovery_stage: 'structured_json_regeneration' });
          markMalformedRecoverySuccess(budget, 'structured_json_regeneration');
          return { records: [], explicit_none: true, stage: 'structured_json_regeneration', budget, original_reason: originalReason };
        }
        const normalized = normalizeTaggedMemoryOutput(jsonResponse, { tier, parse });
        if (normalized.records.length) {
          finishAttempt(attempt, { terminal_outcome: 'completed', recoverable: true,
            recovery_stage: 'structured_json_regeneration', final_recovery_stage: 'structured_json_regeneration',
            response_text: jsonResponse, parser_paths_attempted: ['supported_json_conversion'],
            local_normalization_paths_attempted: normalized.paths_attempted.map((item) => item.path) });
          markMalformedRecoverySuccess(budget, 'structured_json_regeneration');
          return { records: normalized.records, stage: 'structured_json_regeneration', budget, original_reason: originalReason };
        }
        lastReason = classifyTaggedResponseFailure(jsonResponse, { tier });
        finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: lastReason,
          recoverable: false, recovery_stage: 'structured_json_regeneration', response_text: jsonResponse,
          parser_paths_attempted: ['supported_json_conversion'],
          local_normalization_paths_attempted: normalized.paths_attempted.map((item) => item.path),
          smaller_window_retry_followed: false });
      }
    }
  }
  throw terminalMalformedError(tier, lastReason, 'bounded_recovery_exhausted', budget, lastProviderError);
}
