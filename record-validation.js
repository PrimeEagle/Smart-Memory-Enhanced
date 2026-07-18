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
  const issues = [...(record.validation_issues ?? []), ...ancestry.issues];
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
