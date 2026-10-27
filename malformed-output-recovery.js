/** Privacy-safe structural recovery for tagged Long-Term and Session output. */
import { analyzeBracketModifiers, analyzeTaggedMemoryOutput, getTaggedMemoryGrammar } from './parsers.js';
import { deriveRecoveryStageEligibility, RECOVERY_STAGE_ORDER } from './recovery-stage-eligibility.js';

export const MALFORMED_RECOVERY_SCHEMA_VERSION = 6;

export const MALFORMED_RECOVERY_LIMITS = Object.freeze({
  local_normalization_paths: 5,
  provider_repair_attempts: 1,
  changed_dimension_regenerations: 1,
  structured_json_regenerations: 1,
  minimal_record_regenerations: 1,
  single_source_unit_regenerations_per_unit: 1,
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

const safeFingerprint = (value) => {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
};

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

/** Content-free, per-candidate evidence for every structurally rejected line. */
export function buildCandidateRejectionEvidence(response, { tier = 'longterm', minimalContract = false } = {}) {
  const lexical = analyzeTaggedMemoryOutput(String(response ?? ''), { tier });
  const candidateCount = lexical.structural_candidate_count;
  const byLine = new Map(lexical.rejected.map((item) => [item.line_index, item]));
  const candidates = responseLines(response)
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => /^\s*(?:[-*+]\s*)?\[/.test(line));
  if (!candidates.length) {
    try {
      const parsed = JSON.parse(String(response ?? '').trim());
      const collection = Array.isArray(parsed) ? parsed
        : ['memories', 'records', 'items', 'results'].map((key) => parsed?.[key]).find(Array.isArray)
          ?? (parsed && typeof parsed === 'object' ? [parsed] : []);
      return collection.map((candidate, candidateIndex) => ({
        candidate_index: candidateIndex,
        candidate_fingerprint: safeFingerprint(JSON.stringify(candidate)),
        parser_path: 'strict_json', structural_validation: 'rejected',
        semantic_validation: 'not_reached', citation_validation: 'not_reached',
        deduplication_result: 'not_reached', disposition: 'rejected',
        reason_codes: ['invalid_or_unsupported_json_schema'],
      }));
    } catch { /* not JSON */ }
  }
  return candidates.map(({ line, lineIndex }, candidateIndex) => {
    const rejected = byLine.get(lineIndex);
    const reasons = new Set(rejected?.modifier_failure_subtypes ?? []);
    if (rejected?.reason_code) reasons.add(rejected.reason_code);
    if (rejected?.modifier_missing_source_citation) reasons.add('missing_source_citation');
    if (minimalContract && candidateCount !== 1) reasons.add('minimal_record_contract_requires_exactly_one_candidate');
    if (!rejected && minimalContract && candidateCount === 1) reasons.add('failed_minimal_record_contract_validation');
    if (!reasons.size) reasons.add(classifyTaggedResponseFailure(line, { tier }));
    return {
      candidate_index: candidateIndex,
      candidate_fingerprint: safeFingerprint(line.trim()),
      parser_path: minimalContract ? 'strict_minimal_tagged_record' : 'strict_tagged',
      structural_validation: rejected ? 'rejected' : 'accepted_structure',
      semantic_validation: 'not_reached',
      citation_validation: rejected?.modifier_missing_source_citation ? 'missing' : 'not_reached',
      deduplication_result: 'not_reached',
      disposition: 'rejected',
      reason_codes: [...reasons],
    };
  });
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
  try { parsed = JSON.parse(String(response ?? '').trim()); } catch {
    return { lines: [], supported: false, valid_json: false, candidate_count: 0, rejected_count: 0 };
  }
  const collectionKey = ['memories', 'records', 'items', 'results'].find((key) => Array.isArray(parsed?.[key]));
  const recognizedContainer = Array.isArray(parsed) || Boolean(collectionKey)
    || Boolean(parsed && typeof parsed === 'object');
  const candidates = Array.isArray(parsed) ? parsed
    : collectionKey ? parsed[collectionKey]
      : parsed && typeof parsed === 'object' ? [parsed] : [];
  const lines = candidates.map((record) => canonicalJsonRecord(record, tier)).filter(Boolean);
  return {
    lines,
    supported: recognizedContainer && lines.length === candidates.length,
    valid_json: true,
    candidate_count: candidates.length,
    rejected_count: Math.max(0, candidates.length - lines.length),
  };
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

export function buildMinimalRecordRegenerationPrompt(originalPrompt, { tier = 'longterm' } = {}) {
  const types = taggedTypes(tier);
  const expiration = tier === 'session' ? 'session' : 'permanent';
  return `${originalPrompt}\n\nFINAL MINIMUM-WINDOW RECOVERY — ONE SIMPLE RECORD\nReturn exactly one complete supported record, or exactly NONE when the supplied messages support no record. Do not return JSON, markdown, analysis, optional entity modifiers, or more than one record. Use exactly: [type:importance:${expiration}:sources=0] supported claim. Allowed type values: ${types.join(', ')}. importance must be 1, 2, or 3. sources is mandatory and must contain only indices from the supplied numbered messages. This is a new minimal contract; do not repeat a malformed multi-record answer.`;
}

export function buildSingleSourceUnitRegenerationPrompt(sourceUnit, { tier = 'longterm', owner = null } = {}) {
  const types = taggedTypes(tier);
  const ownerRule = owner ? ` The record must describe durable memory for ${owner}; do not describe another owner's private memory.` : '';
  // Keep untrusted chat text inside an explicit bounded section and put the
  // recovery contract last. Local models weight the prompt tail heavily; when
  // the source message followed the contract they could answer the chat prose
  // conversationally instead of emitting RECORD or NONE.
  return `SINGLE-SOURCE RECOVERY\nOnly the source message below is in scope.${ownerRule}\n\nSOURCE MESSAGE START\n[0] ${String(sourceUnit?.text ?? '').trim()}\nSOURCE MESSAGE END\n\nFINAL OUTPUT CONTRACT\nReturn exactly one line in one of these forms:\nRECORD|type|0|supported claim\nNONE\nAllowed type values: ${types.join(', ')}. The third field must be 0. Do not output brackets, modifiers, JSON, markdown, analysis, prose, or multiple records.`;
}

/** Deterministic v2 single-unit parser plus a narrowly bounded legacy-tag normalizer. */
export function parseSingleSourceUnitResponse(response, { tier = 'longterm', parse } = {}) {
  const text = String(response ?? '').trim();
  const grammar = getTaggedMemoryGrammar(tier);
  const expiration = tier === 'session' ? 'session' : 'permanent';
  if (text.toUpperCase() === 'NONE') return {
    accepted: true, explicit_none: true, records: [], parser_path: 'exact_none',
    actual_format: 'none', actual_citation_indexes: [], normalization_eligible: false,
    normalization_result: 'not_needed', reason_codes: [],
  };
  const pipe = text.match(/^RECORD\|([^|\r\n]+)\|([^|\r\n]+)\|([^\r\n|][^\r\n]*)$/i);
  if (pipe) {
    const type = pipe[1].trim().toLowerCase();
    const citation = Number(pipe[2].trim());
    const claim = pipe[3].trim();
    const reasons = [];
    if (!grammar.types.includes(type)) reasons.push('unsupported_memory_type');
    if (citation !== 0) reasons.push('single_source_unit_requires_exact_local_citation');
    if (claim.length < grammar.minimumContentLength) reasons.push('content_too_short');
    const canonical = reasons.length ? null : `[${type}:2:${expiration}:sources=0] ${claim}`;
    const records = canonical && typeof parse === 'function' ? parse(canonical) : [];
    if (canonical && records.length !== 1) reasons.push('canonical_reconstruction_failed');
    return {
      accepted: reasons.length === 0 && records.length === 1,
      explicit_none: false, records, parser_path: 'single_source_pipe_v2',
      actual_format: 'single_source_pipe', actual_citation_indexes: Number.isInteger(citation) ? [citation] : [],
      normalized_text: canonical, normalization_eligible: false, normalization_result: 'not_needed',
      reason_codes: [...new Set(reasons)],
      contract: { outer_shape_followed: true, cardinality_followed: true, prohibited_prose_avoided: true,
        modifier_restrictions_followed: true, citation_requirement_followed: citation === 0 },
    };
  }

  const lexical = analyzeTaggedMemoryOutput(text, { tier });
  const strictRecords = typeof parse === 'function' ? parse(text) : [];
  const candidateLines = responseLines(text).filter((line) => /^\s*(?:[-*+]\s*)?\[/.test(line));
  const cardinalityFollowed = lexical.structural_candidate_count === 1 && candidateLines.length === 1;
  const match = cardinalityFollowed
    ? candidateLines[0].match(/^\s*(?:[-*+]\s*)?\[([a-z_]+)([^\]]*)\]\s*(\S[\s\S]*)$/i) : null;
  const analysis = match ? analyzeBracketModifiers(match[2]) : null;
  const citationIndexes = analysis?.canonical_values?.sources
    ? String(analysis.canonical_values.sources).split(',').map(Number).filter(Number.isInteger) : [];
  const citationValid = citationIndexes.length === 1 && citationIndexes[0] === 0;
  const strictTaggedAccepted = strictRecords.length === 1
    && lexical.structural_candidate_count === 1
    && strictRecords[0].source_message_indices?.length === 1
    && strictRecords[0].source_message_indices[0] === 0;
  if (strictTaggedAccepted) return {
    accepted: true, explicit_none: false, records: strictRecords,
    parser_path: 'strict_single_source_tagged_compatibility',
    actual_format: 'tagged_lines', actual_citation_indexes: [0],
    normalization_eligible: false, normalization_result: 'not_needed',
    reason_codes: [], candidate_count: 1,
    contract: {
      outer_shape_followed: false,
      cardinality_followed: true,
      prohibited_prose_avoided: lexical.unclassified_fragment_count === 0,
      modifier_restrictions_followed: true,
      citation_requirement_followed: true,
    },
  };
  const safeFailureCodes = new Set(['unknown_modifier_syntax']);
  const failuresSafeToRemove = Boolean(analysis?.failures?.length)
    && analysis.failures.every((item) => safeFailureCodes.has(item.reason_code));
  const requiredCoreValid = Boolean(match && grammar.types.includes(match[1].toLowerCase())
    && match[3].trim().length >= grammar.minimumContentLength
    && /^[123]$/.test(String(analysis?.canonical_values?.score ?? ''))
    && String(analysis?.canonical_values?.expiration ?? '').toLowerCase() === expiration
    && citationValid);
  const normalizationEligible = cardinalityFollowed && failuresSafeToRemove && requiredCoreValid;
  let records = [];
  let normalizedText = null;
  if (normalizationEligible) {
    normalizedText = `[${match[1].toLowerCase()}:${analysis.canonical_values.score}:${expiration}:sources=0] ${match[3].trim()}`;
    records = typeof parse === 'function' ? parse(normalizedText) : [];
  }
  const normalized = normalizationEligible && records.length === 1
    && records[0].source_message_indices?.length === 1
    && records[0].source_message_indices[0] === 0;
  const reasons = new Set(analysis?.failures?.map((item) => item.reason_code) ?? []);
  if (!cardinalityFollowed) reasons.add('single_source_unit_requires_exactly_one_record');
  if (!citationValid) reasons.add('single_source_unit_requires_exact_local_citation');
  if (normalizationEligible && !normalized) reasons.add('canonical_reconstruction_failed');
  return {
    accepted: normalized, explicit_none: false, records: normalized ? records : [],
    parser_path: normalized ? 'single_source_optional_modifier_normalization' : 'strict_single_source_tagged',
    actual_format: lexical.tagged_candidate_count ? 'tagged_lines' : 'unknown_text',
    actual_citation_indexes: citationIndexes, normalized_text: normalizedText,
    normalization_eligible: normalizationEligible,
    normalization_result: normalized ? 'accepted_after_safe_optional_modifier_removal'
      : normalizationEligible ? 'canonical_reparse_failed' : 'not_eligible',
    original_rejection_reason_codes: [...reasons],
    reason_codes: normalized ? [] : [...reasons],
    candidate_count: lexical.structural_candidate_count,
    contract: {
      outer_shape_followed: lexical.tagged_candidate_count === 1,
      cardinality_followed: cardinalityFollowed,
      prohibited_prose_avoided: lexical.unclassified_fragment_count === 0,
      modifier_restrictions_followed: analysis?.failures?.length === 0,
      citation_requirement_followed: citationValid,
    },
  };
}

export function detectRecoveryResponseFormat(response, { tier = 'longterm' } = {}) {
  const text = String(response ?? '').trim();
  if (/^RECORD\|[^|\r\n]+\|[^|\r\n]+\|[^\r\n]+$/i.test(text)) return 'single_source_pipe';
  const json = jsonRecords(text, tier);
  if (json.valid_json) return 'json';
  const shape = analyzeMalformedResponse(text, { tier });
  if (shape.tagged_line_candidate_count > 0) return 'tagged_lines';
  if (text.toUpperCase() === 'NONE') return 'none';
  return text ? 'unknown_text' : 'empty';
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
  budget = createMalformedRecoveryBudget(), splitDepth = 0, resumeState = null,
  sourceUnits = [], owner = null, stagePartialRecords = null,
} = {}) {
  const effectiveResumeState = resumeState ?? originalAttempt?.prior_window_recovery_state
    ?? (originalAttempt?.resumed_pending_obligation === true
    && (originalAttempt?.prior_recovery_stages_attempted ?? []).length
    ? {
      resume_unresolved_obligation: true,
      recovery_stages_attempted: originalAttempt.prior_recovery_stages_attempted,
      last_malformed_reason: originalAttempt.repair_reason ?? null,
    } : null);
  const reportedPriorStages = [...new Set(effectiveResumeState?.recovery_stages_attempted ?? [])];
  const furthestPriorStage = reportedPriorStages.reduce((maximum, stage) =>
    Math.max(maximum, RECOVERY_STAGE_ORDER.indexOf(stage)), -1);
  const priorStages = new Set([
    ...reportedPriorStages,
    ...RECOVERY_STAGE_ORDER.slice(0, Math.max(0, furthestPriorStage + 1)),
  ]);
  const resumedLadder = Boolean(effectiveResumeState
    && (effectiveResumeState.resume_unresolved_obligation === true || priorStages.size > 0)
    && (response === null || response === undefined));
  const parserPaths = ['strict_expected_format'];
  const originalReason = resumedLadder
    ? effectiveResumeState?.last_malformed_reason ?? 'resumed_unresolved_obligation'
    : classifyTaggedResponseFailure(response, { tier });
  const recoveryRoute = routeMalformedTaggedRecovery(response, { tier, reason: originalReason });
  const local = resumedLadder
    ? { succeeded: false, records: [], paths_attempted: [], structural: analyzeMalformedResponse('', { tier }) }
    : normalizeTaggedMemoryOutput(response, { tier, parse });
  if (!resumedLadder && local.succeeded) {
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
  if (!resumedLadder && originalAttempt) {
    finishAttempt(originalAttempt, {
      terminal_outcome: 'provider_response_malformed', malformed_reason: originalReason, recoverable: true,
      recovery_stage: 'strict_generation', response_text: response,
      parser_paths_attempted: parserPaths,
      local_normalization_paths_attempted: local.paths_attempted.map((item) => item.path),
      recovery_route: recoveryRoute.route,
      avoided_repair_reason: recoveryRoute.avoided_repair_reason,
      requested_output_format: `${tier}_tagged_lines_v1`,
      actual_output_format: detectRecoveryResponseFormat(response, { tier }),
      parser_selected: 'strict_tagged_then_local_normalization',
      output_contract_followed: detectRecoveryResponseFormat(response, { tier }) === 'tagged_lines',
    });
  }

  let lastReason = originalReason;
  let lastFailedAttempt = originalAttempt ?? null;
  let lastProviderError = null;
  let acceptedPartialRecords = [...(effectiveResumeState?.staged_partial_records ?? [])];
  const stagedCompletedUnitKeys = new Set(effectiveResumeState?.completed_source_units ?? []);
  const repairBudget = recoveryRoute.compact_repair_eligible && !priorStages.has('compact_response_repair')
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

  const regenerationBudget = priorStages.has('changed_dimension_regeneration')
    ? { allowed: false, reason: 'stage_already_exhausted_before_resume' }
    : consumeMalformedRecoveryRequest(budget, 'changed_dimension_regeneration');
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
  if (!priorStages.has('structured_json_regeneration')
    && splitWindow && splitDepth < MALFORMED_RECOVERY_LIMITS.maximum_split_depth) {
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
  if (!splitResult?.completed && !priorStages.has('structured_json_regeneration')) {
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
        const actualFormat = detectRecoveryResponseFormat(jsonResponse, { tier });
        if (isExplicitEmptyStructuredResponse(jsonResponse)) {
          finishAttempt(attempt, { terminal_outcome: 'completed_no_candidates', recoverable: true,
            recovery_stage: 'structured_json_regeneration', final_recovery_stage: 'structured_json_regeneration',
            requested_output_format: `${tier}_json_records_v1`, actual_output_format: actualFormat,
            parser_selected: 'strict_json', output_contract_followed: actualFormat === 'json',
            strict_parse_result: 'explicit_empty_array', total_candidate_count: 0,
            accepted_candidate_count: 0, rejected_candidate_count: 0 });
          markMalformedRecoverySuccess(budget, 'structured_json_regeneration');
          return { records: [], explicit_none: true, stage: 'structured_json_regeneration', budget, original_reason: originalReason };
        }
        const json = jsonRecords(jsonResponse, tier);
        let records = [];
        let parserSelected = 'strict_json';
        let normalized = null;
        if (json.valid_json && json.supported) records = parse(json.lines.join('\n'));
        if (!records.length && actualFormat === 'tagged_lines') {
          parserSelected = 'strict_tagged_fallback_after_json_contract_violation';
          records = parse(jsonResponse);
        }
        if (!records.length) {
          normalized = normalizeTaggedMemoryOutput(jsonResponse, { tier, parse });
          records = normalized.records;
          if (records.length) parserSelected = 'local_normalization_fallback';
        }
        const responseShape = analyzeMalformedResponse(jsonResponse, { tier });
        const candidateRejections = buildCandidateRejectionEvidence(jsonResponse, { tier });
        const rejectedCount = actualFormat === 'json'
          ? json.rejected_count : responseShape.structurally_rejected_record_count;
        if (records.length && rejectedCount === 0) {
          finishAttempt(attempt, { terminal_outcome: 'completed', recoverable: true,
            recovery_stage: 'structured_json_regeneration', final_recovery_stage: 'structured_json_regeneration',
            response_text: jsonResponse,
            notice_reason: actualFormat === 'json' ? null : 'provider_output_contract_violated_but_strict_fallback_succeeded',
            parser_paths_attempted: actualFormat === 'json'
              ? ['strict_json', 'supported_json_conversion'] : ['strict_json', 'strict_tagged_fallback'],
            local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [],
            requested_output_format: `${tier}_json_records_v1`, actual_output_format: actualFormat,
            parser_selected: parserSelected, output_contract_followed: actualFormat === 'json',
            strict_parse_result: 'accepted', fallback_parse_result: actualFormat === 'json' ? null : 'accepted',
            total_candidate_count: actualFormat === 'json' ? json.candidate_count : responseShape.structural_candidate_count,
            accepted_candidate_count: records.length, rejected_candidate_count: 0,
            accepted_partial_output_persisted: false, missing_required_results: false });
          markMalformedRecoverySuccess(budget, 'structured_json_regeneration');
          return { records, stage: 'structured_json_regeneration', budget, original_reason: originalReason,
            response_contract_violated: actualFormat !== 'json' };
        }
        if (records.length) {
          acceptedPartialRecords = records;
          if (stagePartialRecords) {
            const recordsByUnit = new Map();
            for (const record of records) {
              for (const citationIndex of record.source_message_indices ?? []) {
                const sourceUnit = sourceUnits.find((item) => Number(item.citation_index) === Number(citationIndex));
                if (!sourceUnit) continue;
                const unitKey = String(sourceUnit.unit_key);
                recordsByUnit.set(unitKey, [...(recordsByUnit.get(unitKey) ?? []), record]);
              }
            }
            for (const [sourceUnitKey, unitRecords] of recordsByUnit) {
              await stagePartialRecords(unitRecords, { source_unit_key: sourceUnitKey, explicit_none: false,
                producing_attempt_id: attempt?.attempt_id, recovery_stage: 'structured_json_regeneration' });
              stagedCompletedUnitKeys.add(sourceUnitKey);
            }
          }
          lastReason = 'partial_valid_output';
          finishAttempt(attempt, { terminal_outcome: 'partial_output_pending', malformed_reason: lastReason,
            notice_reason: 'partial_valid_output', recoverable: true,
            recovery_stage: 'structured_json_regeneration', response_text: jsonResponse,
            parser_paths_attempted: actualFormat === 'json'
              ? ['strict_json', 'supported_json_conversion'] : ['strict_json', 'strict_tagged_fallback'],
            local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [],
            requested_output_format: `${tier}_json_records_v1`, actual_output_format: actualFormat,
            parser_selected: parserSelected, output_contract_followed: actualFormat === 'json',
            strict_parse_result: 'partial', fallback_parse_result: actualFormat === 'json' ? null : 'partial',
            total_candidate_count: actualFormat === 'json' ? json.candidate_count : responseShape.structural_candidate_count,
            accepted_candidate_count: records.length, rejected_candidate_count: rejectedCount,
            rejection_reasons: [...new Set(candidateRejections.flatMap((item) => item.reason_codes))],
            candidate_rejections: candidateRejections,
            accepted_partial_output_persisted: false, missing_required_results: true,
            obligation_closure_reason: 'minimal_record_fallback_required' });
          lastFailedAttempt = attempt;
        } else {
          lastReason = actualFormat === 'json' ? 'invalid_or_unsupported_json_schema'
            : classifyTaggedResponseFailure(jsonResponse, { tier });
          finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: lastReason,
            recoverable: true, recovery_stage: 'structured_json_regeneration', response_text: jsonResponse,
            parser_paths_attempted: actualFormat === 'json'
              ? ['strict_json', 'supported_json_conversion'] : ['strict_json', 'strict_tagged_fallback'],
            local_normalization_paths_attempted: normalized?.paths_attempted?.map((item) => item.path) ?? [],
            smaller_window_retry_followed: false,
            requested_output_format: `${tier}_json_records_v1`, actual_output_format: actualFormat,
            parser_selected: parserSelected, output_contract_followed: actualFormat === 'json',
            strict_parse_result: 'rejected', fallback_parse_result: actualFormat === 'json' ? null : 'rejected',
            total_candidate_count: actualFormat === 'json' ? json.candidate_count : responseShape.structural_candidate_count,
            accepted_candidate_count: 0, rejected_candidate_count: rejectedCount,
            rejection_reasons: [...new Set(candidateRejections.flatMap((item) => item.reason_codes))],
            candidate_rejections: candidateRejections,
            missing_required_results: true, obligation_closure_reason: 'minimal_record_fallback_required' });
          lastFailedAttempt = attempt;
        }
      }
    }
  }

  const minimalBudget = priorStages.has('minimal_record_regeneration')
    ? { allowed: false, reason: 'stage_already_exhausted_for_source_window' }
    : consumeMalformedRecoveryRequest(budget, 'minimal_record_regeneration');
  if (minimalBudget.allowed) {
    const attempt = beginAttempt('minimal_record_regeneration',
      ['single_record_contract', 'optional_modifiers_removed', 'minimum_window_changed_recovery_dimension'], {
        recovery_of_attempt_id: lastFailedAttempt?.attempt_id ?? originalAttempt?.attempt_id ?? null,
        repair_reason: lastReason, recovery_stage: 'minimal_record_regeneration',
        expected_output_format: `${tier}_minimal_tagged_record_v1`,
      });
    let minimalResponse;
    try {
      minimalResponse = await generate(buildMinimalRecordRegenerationPrompt(originalPrompt, { tier }), {
        responseLength: Math.min(Number(responseLength) || 300, 300),
        task: `${tier}-malformed-minimal-record-regeneration`,
      });
    } catch (error) {
      finishAttempt(attempt, { terminal_outcome: 'provider_failure', recoverable: false,
        recovery_stage: 'minimal_record_regeneration', final_disposition: 'minimal_record_provider_failure',
        recovery_ladder_terminal: true, accepted_candidate_count: acceptedPartialRecords.length });
      lastProviderError = error;
      minimalResponse = null;
    }
    if (minimalResponse !== null) {
      const actualFormat = detectRecoveryResponseFormat(minimalResponse, { tier });
      if (String(minimalResponse).trim().toUpperCase() === 'NONE') {
        finishAttempt(attempt, { terminal_outcome: acceptedPartialRecords.length ? 'completed' : 'completed_no_candidates',
          notice_reason: acceptedPartialRecords.length ? 'partial_valid_output_completed_by_explicit_no_additional_record' : null,
          recoverable: true, recovery_stage: 'minimal_record_regeneration',
          final_recovery_stage: 'minimal_record_regeneration', requested_output_format: `${tier}_minimal_tagged_record_v1`,
          actual_output_format: actualFormat, parser_selected: 'exact_none', output_contract_followed: true,
          strict_parse_result: 'explicit_none', accepted_candidate_count: acceptedPartialRecords.length,
          rejected_candidate_count: 0, missing_required_results: false,
          accepted_partial_output_persisted: acceptedPartialRecords.length > 0,
          obligation_closure_reason: 'explicit_no_additional_supported_record' });
        markMalformedRecoverySuccess(budget, 'minimal_record_regeneration');
        return acceptedPartialRecords.length
          ? { records: acceptedPartialRecords, stage: 'minimal_record_regeneration', budget, original_reason: originalReason }
          : { records: [], explicit_none: true, stage: 'minimal_record_regeneration', budget, original_reason: originalReason };
      }
      const shape = analyzeMalformedResponse(minimalResponse, { tier });
      const minimalRecords = parse(minimalResponse);
      if (minimalRecords.length) {
        const unique = [...acceptedPartialRecords, ...minimalRecords].filter((record, index, all) =>
          all.findIndex((item) => item.type === record.type && item.content === record.content
            && JSON.stringify(item.source_message_indices ?? []) === JSON.stringify(record.source_message_indices ?? [])) === index);
        finishAttempt(attempt, { terminal_outcome: 'completed', recoverable: true,
          notice_reason: shape.structurally_rejected_record_count > 0 ? 'partial_valid_output' : null,
          recovery_stage: 'minimal_record_regeneration', final_recovery_stage: 'minimal_record_regeneration',
          response_text: minimalResponse, parser_paths_attempted: ['strict_minimal_tagged_record'],
          requested_output_format: `${tier}_minimal_tagged_record_v1`, actual_output_format: actualFormat,
          parser_selected: 'strict_tagged', output_contract_followed: actualFormat === 'tagged_lines',
          strict_parse_result: shape.structurally_rejected_record_count > 0 ? 'partial_accepted' : 'accepted',
          total_candidate_count: shape.structural_candidate_count,
          accepted_candidate_count: unique.length, rejected_candidate_count: shape.structurally_rejected_record_count,
          accepted_partial_output_persisted: acceptedPartialRecords.length > 0,
          missing_required_results: false, obligation_closure_reason: 'minimal_record_contract_satisfied' });
        markMalformedRecoverySuccess(budget, 'minimal_record_regeneration');
        return { records: unique, stage: 'minimal_record_regeneration', budget, original_reason: originalReason };
      }
      lastReason = classifyTaggedResponseFailure(minimalResponse, { tier });
      const candidateRejections = buildCandidateRejectionEvidence(minimalResponse, { tier, minimalContract: true });
      finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed', malformed_reason: lastReason,
        recoverable: false, recovery_stage: 'minimal_record_regeneration', response_text: minimalResponse,
        parser_paths_attempted: ['strict_minimal_tagged_record'], recovery_ladder_terminal: true,
        requested_output_format: `${tier}_minimal_tagged_record_v1`, actual_output_format: actualFormat,
        parser_selected: 'strict_tagged', output_contract_followed: actualFormat === 'tagged_lines',
        strict_parse_result: 'rejected', total_candidate_count: shape.structural_candidate_count,
        accepted_candidate_count: acceptedPartialRecords.length,
        rejected_candidate_count: shape.structurally_rejected_record_count,
        rejection_reasons: [...new Set(candidateRejections.flatMap((item) => item.reason_codes))],
        candidate_rejections: candidateRejections,
        accepted_partial_output_persisted: false, missing_required_results: true,
        obligation_closure_reason: 'bounded_minimal_record_fallback_exhausted' });
    }
  }

  const completedUnitKeys = stagedCompletedUnitKeys;
  const unresolvedUnits = (sourceUnits ?? []).filter((unit) => !completedUnitKeys.has(String(unit.unit_key)));
  if ((sourceUnits ?? []).length > 0 && unresolvedUnits.length === 0) {
    return { records: acceptedPartialRecords, explicit_none: acceptedPartialRecords.length === 0,
      stage: 'single_source_unit_regeneration', budget, original_reason: originalReason,
      logical_obligation_id: originalAttempt?.logical_obligation_id ?? null,
      staged_partial_record_count: acceptedPartialRecords.length };
  }
  const eligibility = deriveRecoveryStageEligibility({
    attempted_stages: [...priorStages, ...(minimalBudget.allowed ? ['minimal_record_regeneration'] : [])],
    exhausted_stages: [...priorStages, ...(minimalBudget.allowed ? ['minimal_record_regeneration'] : [])],
    accepted_partial_record_count: acceptedPartialRecords.length,
    unresolved_semantic_units: unresolvedUnits.map((unit) => String(unit.unit_key)),
    implementation_version_changed: effectiveResumeState?.implementation_version_changed === true,
    unit_outcomes: effectiveResumeState?.unit_outcomes ?? [],
  });
  const priorUnitOutcomes = [...(effectiveResumeState?.unit_outcomes ?? [])];
  const blockedUnitKeys = new Set(priorUnitOutcomes
    .filter((item) => String(item.disposition ?? '').startsWith('blocked_'))
    .map((item) => String(item.source_unit_key)));
  const noUpdateUnitKeys = new Set(effectiveResumeState?.explicit_none_source_units ?? []);
  const unitOutcomes = priorUnitOutcomes;
  if (eligibility.eligible_action === 'single_source_unit_regeneration' && unresolvedUnits.length) {
    const permittedUnitKeys = eligibility.reason_code === 'unattempted_source_units_remain'
      ? new Set(eligibility.unattempted_semantic_units ?? []) : null;
    const unitsToAttempt = permittedUnitKeys
      ? unresolvedUnits.filter((unit) => permittedUnitKeys.has(String(unit.unit_key))) : unresolvedUnits;
    for (const unit of unitsToAttempt) {
      const allowance = consumeMalformedRecoveryRequest(budget, 'single_source_unit_regeneration');
      if (!allowance.allowed) break;
      const attempt = beginAttempt('single_source_unit_regeneration', eligibility.changed_dimensions, {
        recovery_of_attempt_id: lastFailedAttempt?.attempt_id ?? originalAttempt?.attempt_id ?? null,
        repair_reason: lastReason, recovery_stage: 'single_source_unit_regeneration',
        expected_output_format: `${tier}_single_source_pipe_v2`,
        source_unit_key: String(unit.unit_key),
        target_source_unit: String(unit.unit_key),
        target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
        context_source_range: unit.context_source_range ?? null,
        context_message_count: Number(unit.context_message_count ?? 1),
        permitted_citation_indexes: [0],
        context_only_messages_eligible: false,
      });
      let unitResponse;
      try {
        unitResponse = await generate(buildSingleSourceUnitRegenerationPrompt(unit, { tier, owner }), {
          responseLength: Math.min(Number(responseLength) || 120, 120),
          task: `${tier}-malformed-single-source-unit-regeneration`,
        });
      } catch (error) {
        finishAttempt(attempt, { terminal_outcome: 'provider_failure', recoverable: false,
          recovery_stage: 'single_source_unit_regeneration', recovery_ladder_terminal: true,
          target_source_unit: String(unit.unit_key),
          target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
          actual_citation_indexes: [], accepted_record_cites_target: false,
          missing_required_results: true, obligation_closure_reason: 'single_source_unit_provider_failure',
          unresolved_semantic_units: unresolvedUnits
            .filter((item) => !completedUnitKeys.has(String(item.unit_key))).map((item) => String(item.unit_key)) });
        lastProviderError = error;
        blockedUnitKeys.add(String(unit.unit_key));
        unitOutcomes.push({ source_unit_key: String(unit.unit_key), disposition: 'blocked_provider_failure' });
        continue;
      }
      const actualFormat = detectRecoveryResponseFormat(unitResponse, { tier });
      if (String(unitResponse ?? '').trim().toUpperCase() === 'NONE') {
        const unresolvedAfterUnit = unresolvedUnits
          .filter((item) => String(item.unit_key) !== String(unit.unit_key)
            && !completedUnitKeys.has(String(item.unit_key)))
          .map((item) => String(item.unit_key));
        finishAttempt(attempt, { terminal_outcome: 'partial_output_pending', recoverable: true,
          source_unit_completed: true,
          recovery_stage: 'single_source_unit_regeneration', final_recovery_stage: 'single_source_unit_regeneration',
          requested_output_format: `${tier}_single_source_pipe_v2`, actual_output_format: actualFormat,
          parser_selected: 'exact_none', output_contract_followed: true, strict_parse_result: 'explicit_none',
          outer_response_shape_followed: true, cardinality_followed: true,
          prohibited_prose_avoided: true, modifier_restrictions_followed: true,
          citation_requirement_followed: true,
          total_candidate_count: 0, accepted_candidate_count: 0, rejected_candidate_count: 0,
          missing_required_results: false, obligation_closure_reason: 'source_unit_explicit_none',
          target_source_unit: String(unit.unit_key),
          target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
          actual_citation_indexes: [], accepted_record_cites_target: null,
          unresolved_semantic_units: unresolvedAfterUnit,
          source_unit_key: String(unit.unit_key) });
        await stagePartialRecords?.([], { source_unit_key: String(unit.unit_key), explicit_none: true,
          producing_attempt_id: attempt?.attempt_id, recovery_stage: 'single_source_unit_regeneration',
          target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
          normalization_result: 'not_needed',
          unresolved_semantic_units: unresolvedAfterUnit });
        completedUnitKeys.add(String(unit.unit_key));
        noUpdateUnitKeys.add(String(unit.unit_key));
        unitOutcomes.push({ source_unit_key: String(unit.unit_key), disposition: 'validated_no_update' });
        continue;
      }
      const shape = analyzeMalformedResponse(unitResponse, { tier });
      const unitResult = parseSingleSourceUnitResponse(unitResponse, { tier, parse });
      if (unitResult.accepted && unitResult.records.length === 1) {
        const records = unitResult.records;
        const unresolvedAfterUnit = unresolvedUnits
          .filter((item) => String(item.unit_key) !== String(unit.unit_key)
            && !completedUnitKeys.has(String(item.unit_key)))
          .map((item) => String(item.unit_key));
        records[0].source_message_indices = [Number(unit.citation_index)];
        const combined = [...acceptedPartialRecords, ...records];
        acceptedPartialRecords = combined.filter((record, index, all) => all.findIndex((item) =>
          item.type === record.type && item.content === record.content
          && JSON.stringify(item.source_message_indices ?? []) === JSON.stringify(record.source_message_indices ?? [])) === index);
        finishAttempt(attempt, { terminal_outcome: 'partial_output_pending', recoverable: true,
          source_unit_completed: true,
          recovery_stage: 'single_source_unit_regeneration', final_recovery_stage: 'single_source_unit_regeneration',
          requested_output_format: `${tier}_single_source_pipe_v2`, actual_output_format: unitResult.actual_format ?? actualFormat,
          parser_selected: unitResult.parser_path,
          output_contract_followed: Object.values(unitResult.contract ?? {}).every((value) => value === true),
          outer_response_shape_followed: unitResult.contract?.outer_shape_followed ?? null,
          cardinality_followed: unitResult.contract?.cardinality_followed ?? null,
          prohibited_prose_avoided: unitResult.contract?.prohibited_prose_avoided ?? null,
          modifier_restrictions_followed: unitResult.contract?.modifier_restrictions_followed ?? null,
          citation_requirement_followed: unitResult.contract?.citation_requirement_followed ?? null,
          strict_parse_result: unitResult.normalization_result === 'accepted_after_safe_optional_modifier_removal'
            ? 'accepted_after_safe_optional_modifier_normalization' : 'accepted',
          local_normalization_paths_attempted: unitResult.normalization_eligible
            ? ['remove_unknown_optional_modifier_and_reconstruct_canonical_record'] : [],
          normalization_eligibility: unitResult.normalization_eligible,
          normalization_result: unitResult.normalization_result,
          original_rejection_reasons: unitResult.original_rejection_reason_codes ?? [],
          total_candidate_count: 1, accepted_candidate_count: 1,
          rejected_candidate_count: 0, missing_required_results: false,
          accepted_partial_output_persisted: true, obligation_closure_reason: 'source_unit_record_staged',
          target_source_unit: String(unit.unit_key),
          target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
          actual_citation_indexes: unitResult.actual_citation_indexes,
          accepted_record_cites_target: true,
          unresolved_semantic_units: unresolvedAfterUnit,
          source_unit_key: String(unit.unit_key) });
        await stagePartialRecords?.(records, { source_unit_key: String(unit.unit_key), explicit_none: false,
          producing_attempt_id: attempt?.attempt_id, recovery_stage: 'single_source_unit_regeneration',
          normalization_result: unitResult.normalization_result,
          target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
          unresolved_semantic_units: unresolvedAfterUnit });
        completedUnitKeys.add(String(unit.unit_key));
        unitOutcomes.push({ source_unit_key: String(unit.unit_key), disposition: 'record_staged',
          normalization_result: unitResult.normalization_result });
        continue;
      }
      const candidateRejections = buildCandidateRejectionEvidence(unitResponse, { tier, minimalContract: true });
      const rejectionReasons = [...new Set(unitResult.reason_codes ?? [])];
      if (!candidateRejections.length) candidateRejections.push({
        candidate_index: 0, candidate_fingerprint: safeFingerprint(String(unitResponse ?? '').trim()),
        parser_path: 'strict_single_source_tagged', structural_validation: 'rejected',
        semantic_validation: 'not_reached', citation_validation: 'not_reached',
        deduplication_result: 'not_reached', disposition: 'rejected',
        reason_codes: rejectionReasons.length ? rejectionReasons : ['unparseable_single_source_unit_response'],
      });
      for (const candidate of candidateRejections) {
        candidate.core_field_parsing = unitResult.parser_path === 'strict_single_source_tagged'
          ? 'parsed_tag_and_claim' : 'rejected';
        candidate.modifier_parsing = unitResult.contract?.modifier_restrictions_followed === true
          ? 'accepted' : 'rejected';
        candidate.citation_parsing = unitResult.actual_citation_indexes?.length ? 'parsed' : 'missing';
        candidate.citation_range_validation = unitResult.contract?.citation_requirement_followed === true
          ? 'accepted_target_unit' : 'rejected';
        candidate.normalization_eligibility = unitResult.normalization_eligible === true;
        candidate.normalization_result = unitResult.normalization_result ?? 'not_eligible';
        candidate.reason_codes = [...rejectionReasons];
      }
      finishAttempt(attempt, { terminal_outcome: 'provider_response_malformed',
        malformed_reason: classifyTaggedResponseFailure(unitResponse, { tier }), recoverable: false,
        recovery_stage: 'single_source_unit_regeneration', response_text: unitResponse,
        recovery_ladder_terminal: true, requested_output_format: `${tier}_single_source_pipe_v2`,
        actual_output_format: unitResult.actual_format ?? actualFormat, parser_selected: unitResult.parser_path,
        output_contract_followed: false, strict_parse_result: 'rejected',
        outer_response_shape_followed: unitResult.contract?.outer_shape_followed ?? false,
        cardinality_followed: unitResult.contract?.cardinality_followed ?? false,
        prohibited_prose_avoided: unitResult.contract?.prohibited_prose_avoided ?? false,
        modifier_restrictions_followed: unitResult.contract?.modifier_restrictions_followed ?? false,
        citation_requirement_followed: unitResult.contract?.citation_requirement_followed ?? false,
        normalization_eligibility: unitResult.normalization_eligible,
        normalization_result: unitResult.normalization_result,
        total_candidate_count: unitResult.candidate_count ?? Math.max(1, shape.structural_candidate_count),
        accepted_candidate_count: 0, rejected_candidate_count: candidateRejections.length,
        rejection_reasons: rejectionReasons, candidate_rejections: candidateRejections,
        missing_required_results: true, accepted_partial_output_persisted: acceptedPartialRecords.length > 0,
        obligation_closure_reason: 'single_source_unit_fallback_exhausted',
        target_source_unit: String(unit.unit_key),
        target_source_fingerprint: unit.source_fingerprint ?? safeFingerprint(unit.text),
        actual_citation_indexes: unitResult.actual_citation_indexes ?? [],
        accepted_record_cites_target: false,
        unresolved_semantic_units: unresolvedUnits
          .filter((item) => !completedUnitKeys.has(String(item.unit_key))).map((item) => String(item.unit_key)),
        source_unit_key: String(unit.unit_key) });
      lastReason = classifyTaggedResponseFailure(unitResponse, { tier });
      lastFailedAttempt = attempt;
      blockedUnitKeys.add(String(unit.unit_key));
      unitOutcomes.push({ source_unit_key: String(unit.unit_key), disposition: 'blocked_validation',
        reason_codes: rejectionReasons });
      continue;
    }
    if (completedUnitKeys.size === (sourceUnits ?? []).length) {
      markMalformedRecoverySuccess(budget, 'single_source_unit_regeneration');
      return { records: acceptedPartialRecords, explicit_none: acceptedPartialRecords.length === 0,
        stage: 'single_source_unit_regeneration', budget, original_reason: originalReason,
        logical_obligation_id: originalAttempt?.logical_obligation_id ?? null,
        staged_partial_record_count: acceptedPartialRecords.length,
        completed_source_units: [...completedUnitKeys],
        validated_no_update_source_units: [...noUpdateUnitKeys],
        blocked_source_units: [], unit_outcomes: unitOutcomes };
    }
  }
  const terminal = terminalMalformedError(tier, lastReason, 'bounded_recovery_exhausted', budget, lastProviderError);
  terminal.sme_recovery_blocked = deriveRecoveryStageEligibility({
    attempted_stages: [...priorStages, 'minimal_record_regeneration', 'single_source_unit_regeneration'],
    exhausted_stages: [...priorStages, 'minimal_record_regeneration', 'single_source_unit_regeneration'],
    unresolved_semantic_units: (sourceUnits ?? []).filter((unit) => !completedUnitKeys.has(String(unit.unit_key)))
      .map((unit) => String(unit.unit_key)),
    accepted_partial_record_count: acceptedPartialRecords.length,
    unit_outcomes: unitOutcomes,
  }).blocked;
  if (terminal.sme_recovery_blocked) terminal.code = 'SME_RECOVERY_PATH_EXHAUSTED';
  terminal.sme_completed_source_units = [...completedUnitKeys];
  terminal.sme_validated_no_update_source_units = [...noUpdateUnitKeys];
  terminal.sme_blocked_source_units = [...blockedUnitKeys];
  terminal.sme_unit_outcomes = unitOutcomes;
  if (acceptedPartialRecords.length || completedUnitKeys.size > 0) {
    terminal.sme_accepted_partial_records = acceptedPartialRecords;
    return { records: acceptedPartialRecords, stage: 'partial_records_preserved_pending', budget,
      original_reason: originalReason, partial_unresolved: true, terminal_error: terminal,
      logical_obligation_id: lastFailedAttempt?.logical_obligation_id ?? originalAttempt?.logical_obligation_id ?? null,
      completed_source_units: [...completedUnitKeys],
      validated_no_update_source_units: [...noUpdateUnitKeys],
      blocked_source_units: [...blockedUnitKeys], unit_outcomes: unitOutcomes };
  }
  throw terminal;
}
