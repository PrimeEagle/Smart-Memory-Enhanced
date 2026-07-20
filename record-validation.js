/** Shared normalization and integrity checks for generated-memory records. */

const validId = (value) => typeof value === 'string' && value.trim().length > 0;
const uniqueSorted = (values) => [...new Set(values.filter(Number.isInteger).filter((value) => value >= 0))].sort((a, b) => a - b);

function expandRanges(ranges) {
  const indices = [];
  for (const range of ranges ?? []) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const start = Number(range[0]); const end = Number(range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue;
    for (let index = start; index <= end; index++) indices.push(index);
  }
  return indices;
}

function toRanges(indices) {
  if (!indices.length) return [];
  const ranges = []; let start = indices[0]; let previous = indices[0];
  for (const index of indices.slice(1)) {
    if (index === previous + 1) { previous = index; continue; }
    ranges.push([start, previous]); start = index; previous = index;
  }
  ranges.push([start, previous]);
  return ranges;
}

/**
 * Makes source_message_indices authoritative while continuing to read/write the
 * legacy source_messages range field for backwards compatibility.
 */
export function normalizeMemoryProvenance(memory, options = {}) {
  const {
    sourceOffset = 0,
    relativeSourceLength = null,
    chatLength = null,
    inputIndicesAreRelative = false,
  } = options;
  let indices = Array.isArray(memory.source_message_indices) ? memory.source_message_indices.map(Number) : [];
  if (!indices.some(Number.isInteger)) indices = expandRanges(memory.source_messages);
  indices = uniqueSorted(indices);
  if (inputIndicesAreRelative && relativeSourceLength != null && indices.every((index) => index < relativeSourceLength)) {
    indices = indices.map((index) => index + sourceOffset);
  }
  if (chatLength != null) indices = indices.filter((index) => index < chatLength);
  memory.source_message_indices = indices;
  memory.source_messages = toRanges(indices);
  memory.parent_memory_ids = [...new Set((memory.parent_memory_ids ?? []).filter(validId))];
  return { indices, ranges: memory.source_messages, hasSources: indices.length > 0 };
}

/**
 * Translates a model's chunk-relative provenance claim into the original chat
 * coordinate system, normalizes it on the record that will be stored, and only
 * then applies the common grounding validation.  Callers that already have
 * full-chat indices may omit sourceContext (or set indicesAreRelative: false).
 */
export function prepareRecordForValidation(record, sourceContext = {}, validationOptions = {}) {
  const {
    originalMessageIndices = null,
    sourceOffset = 0,
    sourceLength = null,
    chatLength = null,
    indicesAreRelative = false,
  } = sourceContext;
  const rawIndices = Array.isArray(record.source_message_indices) && record.source_message_indices.length
    ? record.source_message_indices.map(Number)
    : expandRanges(record.source_messages);
  const invalidClaim = rawIndices.some((index) => !Number.isInteger(index) || index < 0 ||
    (indicesAreRelative && sourceLength != null && index >= sourceLength));
  let mapped = rawIndices.filter(Number.isInteger).filter((index) => index >= 0);
  if (indicesAreRelative) {
    mapped = mapped
      .filter((index) => sourceLength == null || index < sourceLength)
      .map((index) => originalMessageIndices?.[index] ?? (sourceOffset + index));
  }
  record.source_message_indices = mapped;
  record.source_messages = [];
  normalizeMemoryProvenance(record, { chatLength });
  if (invalidClaim) {
    record.source_message_indices = [];
    record.source_messages = [];
  }
  const result = validateGeneratedRecord(record, validationOptions);
  if (invalidClaim && !result.valid) {
    record.validation_issues = ['One or more claimed source messages are outside this extraction chunk.'];
  }
  // A valid source set and the old missing-source error are mutually exclusive.
  // Keeping this assertion close to the normalization boundary makes regressions
  // visible in development without changing production persistence behavior.
  console.assert(
    !(record.source_message_indices.length > 0 && record.validation_issues?.some((issue) => /no (valid )?source messages? (were )?supplied/i.test(issue))),
    '[Smart Memory Enhanced] Provenance invariant violated: sourced record retained a missing-source error.',
    record,
  );
  return result;
}

export function validateMemoryAncestry(memoryId, parentIds, memoryStore = []) {
  const parents = [...new Set((parentIds ?? []).filter(validId))];
  const issues = [];
  if (parents.includes(memoryId)) issues.push('A memory cannot list itself as a parent.');
  const byId = new Map(memoryStore.filter((entry) => validId(entry?.id)).map((entry) => [entry.id, entry]));
  const reaches = (currentId, visiting = new Set()) => {
    if (currentId === memoryId) return true;
    if (visiting.has(currentId)) return false;
    visiting.add(currentId);
    return (byId.get(currentId)?.parent_memory_ids ?? []).some((parent) => reaches(parent, visiting));
  };
  for (const parentId of parents) {
    if (!byId.has(parentId)) issues.push(`Parent memory "${parentId}" does not exist.`);
    else if (reaches(parentId)) issues.push('Parent-memory ancestry contains a cycle.');
  }
  return { valid: issues.length === 0, parentIds: parents.filter((id) => id !== memoryId), issues: [...new Set(issues)] };
}

/**
 * Replaces references to disposable extraction candidates with their evidence.
 * A consolidation result may only retain parent IDs that still exist in the
 * transaction's final store; all other ancestry is flattened into direct
 * source-message provenance.
 */
export function flattenConsolidationProvenance(record, sourceCandidates = [], finalStore = []) {
  const finalIds = new Set(finalStore.map((entry) => entry?.id).filter(validId));
  const sourceIndices = [record, ...sourceCandidates]
    .flatMap((entry) => normalizeMemoryProvenance(entry).indices);
  const inheritedParents = [record, ...sourceCandidates]
    .flatMap((entry) => entry?.parent_memory_ids ?? [])
    .filter((id) => validId(id) && id !== record.id && finalIds.has(id));
  record.source_message_indices = uniqueSorted(sourceIndices);
  record.source_messages = toRanges(record.source_message_indices);
  record.parent_memory_ids = [...new Set(inheritedParents)];
  return record;
}

/**
 * Applies the common, tier-agnostic grounding contract to a generated record.
 * Records without direct source messages may still be valid when they are
 * explicitly derived from approved parent records (profiles and resolutions).
 */
export function validateGeneratedRecord(record, options = {}) {
  const { requireSources = true, allowDerived = false, parentStore = [] } = options;
  const provenance = normalizeMemoryProvenance(record);
  const ancestry = validateMemoryAncestry(record.id, record.parent_memory_ids, parentStore);
  record.parent_memory_ids = ancestry.parentIds;
  const hasDerivedEvidence = allowDerived && record.parent_memory_ids.length > 0;
  // Validation is final state, not an accumulation of parser-time guesses.
  // In particular, a parser may initially mark a record source-less before the
  // caller has translated its chunk-relative sources to original chat indices.
  const issues = [...ancestry.issues];
  if ((!provenance.hasSources && !hasDerivedEvidence && requireSources) || !ancestry.valid) {
    if (!provenance.hasSources && !hasDerivedEvidence) issues.push('No valid source evidence was supplied.');
    record.grounding_status = 'ungrounded';
    record.validation_status = 'needs_review';
    record.validation_issues = [...new Set(issues)];
    return { valid: false, issues: record.validation_issues };
  }
  record.grounding_status = hasDerivedEvidence && !provenance.hasSources ? 'derived' : 'direct';
  record.validation_status = 'validated';
  record.validation_issues = [];
  return { valid: true, issues: [] };
}

export function isGeneratedRecordApproved(record) {
  return record?.grounding_status !== 'ungrounded' || record?.validation_status === 'approved';
}

/**
 * Stronger propagation gate for records that can influence future generation.
 * Derived records with semantic verification metadata are usable only after a
 * supported verification result (or an explicit user approval).
 */
export function isRecordApprovedForPropagation(record) {
  if (record?.validation_status === 'approved') return true;
  if (record?.grounding_status === 'derived' || Object.hasOwn(record ?? {}, 'semantic_support')) {
    return record?.validation_status === 'validated' && record?.semantic_support === 'supported';
  }
  return isGeneratedRecordApproved(record);
}

export function sanitizeStructuredModelOutput(raw, taskType = 'generic') {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  text = text.replace(/^```[^\n]*\n?|\n?```$/g, '');
  text = text.split('\n').map((line) => line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*["']|["']\s*$/g, '')
    .replace(/[→➜⇒]/g, '->')
    .trim()).filter(Boolean).join('\n');
  if (taskType === 'epistemic') {
    text = text.replace(/\s*\((?:retires?|retire)\s*\[?(\d+)\]?\)\s*/gi, '\n[retire] $1\n');
    text = text.replace(/\[retire\s*:\s*(\d+)\]/gi, '[retire] $1');
  }
  return text;
}
