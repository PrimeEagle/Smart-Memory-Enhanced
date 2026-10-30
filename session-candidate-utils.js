/** Deterministic representation-only repair for Session candidates. */
export function repairSessionCandidateShapes(candidates = [], maximumLength = 240) {
  const records = [];
  const rejected = [];
  let repairedCount = 0;
  for (const candidate of candidates ?? []) {
    const content = String(candidate?.content ?? '').replace(/\s+/g, ' ').trim();
    if (content.length >= 5 && content.length <= maximumLength) {
      records.push(content === candidate.content ? candidate : { ...candidate, content });
      if (content !== candidate.content) repairedCount++;
      continue;
    }
    if (content.length <= maximumLength) {
      rejected.push({ candidate, reason_code: 'invalid_candidate_shape' });
      continue;
    }
    const sentences = content.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
    if (sentences.length < 2 || sentences.some((part) => part.length > maximumLength || part.length < 5)) {
      rejected.push({ candidate, reason_code: 'invalid_candidate_shape' });
      continue;
    }
    const parts = [];
    let current = '';
    for (const sentence of sentences) {
      const combined = current ? `${current} ${sentence}` : sentence;
      if (combined.length <= maximumLength) current = combined;
      else {
        if (current) parts.push(current);
        current = sentence;
      }
    }
    if (current) parts.push(current);
    if (!parts.length || parts.some((part) => part.length < 5 || part.length > maximumLength)) {
      rejected.push({ candidate, reason_code: 'invalid_candidate_shape' });
      continue;
    }
    records.push(...parts.map((part, index) => ({
      ...candidate, content: part,
      _shape_repair_parent_index: index,
      _shape_repair_part_count: parts.length,
    })));
    repairedCount++;
  }
  return { records, rejected, repaired_count: repairedCount };
}

