/**
 * Deterministic helpers for the structured relationship-role portion of a
 * profile. They intentionally have no SillyTavern dependencies so migrations
 * can be tested independently of storage and prompt injection.
 */
export const CANONICAL_RELATIONSHIP_ROLE_TOKENS = new Set([
  'husband', 'wife', 'spouse', 'ex-husband', 'ex-wife', 'partner',
  'sister', 'brother', 'sibling', 'mother', 'father', 'parent',
  'daughter', 'son', 'sister-in-law', 'brother-in-law', 'sibling-in-law',
]);

export function normalizeRelationshipDescriptors(descriptors = [], canonicalRelationshipType = null) {
  const tokens = descriptors
    .map((value) => String(typeof value === 'string' ? value : value?.word ?? '').trim().toLowerCase())
    .filter(Boolean);
  const removed = canonicalRelationshipType
    ? tokens.filter((token) => CANONICAL_RELATIONSHIP_ROLE_TOKENS.has(token))
    : [];
  return { descriptors: [...new Set(tokens.filter((token) => !removed.includes(token)))], removed };
}

export function renderRelationshipMatrixLine(target, pair, descriptors = pair?.descriptors ?? []) {
  const normalized = normalizeRelationshipDescriptors(descriptors, pair?.relationship_type);
  const role = pair?.relationship_type ? ` [${pair.relationship_type}]` : '';
  return `${target}${role}: ${normalized.descriptors.join(', ')}`;
}

/**
 * Returns the target-relative role for a profile. Only spouse roles need
 * inversion; a fact whose subject is already the target is direct.
 */
export function relationshipTypeForProfileTarget(pair, self, target) {
  if (!pair?.relationship_type) return null;
  if (pair.subject === target) return pair.relationship_type;
  if (pair.subject === self && pair.target === target) {
    return ({ wife: 'husband', husband: 'wife', 'ex-wife': 'ex-husband', 'ex-husband': 'ex-wife' })[pair.relationship_type]
      ?? pair.relationship_type;
  }
  return pair.relationship_type;
}

/** Combines one matched pair's evidence without letting descriptors hide a role. */
export function mergeRelationshipPairEvidence(...candidates) {
  const pairs = candidates.filter(Boolean);
  if (!pairs.length) return null;
  const typed = pairs.find((pair) => pair.relationship_type);
  return {
    ...pairs[0],
    relationship_type: typed?.relationship_type ?? null,
    relationship_type_source: typed?.relationship_type_source ?? pairs[0].relationship_type_source ?? null,
    relationship_type_confidence_class: typed?.relationship_type_confidence_class ?? pairs[0].relationship_type_confidence_class ?? null,
    relationship_type_source_ids: typed?.relationship_type_source_ids ?? pairs[0].relationship_type_source_ids ?? [],
    descriptors: [...new Set(pairs.flatMap((pair) => pair.descriptors ?? []))]
      .filter((descriptor) => !CANONICAL_RELATIONSHIP_ROLE_TOKENS.has(descriptor)),
  };
}

/**
 * Parses only fully named, directional family statements from raw chat. It
 * returns candidates rather than canonical entities; the caller remains
 * responsible for roster resolution and for rejecting unsafe identities.
 */
export function extractExplicitNamedFamilyCandidates(messages = []) {
  const familyPattern = 'sister|brother|sibling|mother|father|parent|daughter|son';
  const namePattern = "[A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*";
  const candidates = [];
  const add = (subject, target, relationshipType, sourceIndex) => {
    const normalizedSubject = String(subject).trim();
    const normalizedTarget = String(target).trim();
    // A coordinated phrase is not an identity. It is handled only by the
    // dedicated two-participant grammar below, never stored as a faux person.
    if (/\s+and\s+/i.test(normalizedSubject) || /\s+and\s+/i.test(normalizedTarget)) return;
    candidates.push({
      subject: normalizedSubject, target: normalizedTarget,
      relationship_type: String(relationshipType).trim().toLowerCase(), source_index: sourceIndex,
    });
  };
  for (const [arrayIndex, message] of (messages ?? []).entries()) {
    if (message?.is_system) continue;
    const text = String(message?.mes ?? '');
    if (!text.trim()) continue;
    const sourceIndex = Number.isInteger(message?.__sme_original_index) ? message.__sme_original_index : arrayIndex;
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern})\\s+(?:is|was)\\s+(?:the\\s+)?(${familyPattern})\\s+of\\s+(${namePattern})`, 'gi'))) {
      // A greedy proper-name capture can include an explicit coordinated list;
      // split only that literal list, never a surname or pronoun heuristic.
      for (const target of match[3].split(/\s+(?:and|,)\s+/i).filter(Boolean)) add(match[1], target, match[2], sourceIndex);
    }
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern})\\s+(?:is|was)\\s+(${namePattern})'s\\s+(${familyPattern})\\b`, 'gi'))) {
      add(match[1], match[2], match[3], sourceIndex);
    }
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern})'s\\s+(${familyPattern})\\s+(?:is|was)\\s+(${namePattern})`, 'gi'))) {
      add(match[3], match[1], match[2], sourceIndex);
    }
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern})\\s+and\\s+(${namePattern})'s\\s+(${familyPattern})\\s+(?:is|was)\\s+(${namePattern})`, 'gi'))) {
      add(match[4], match[1], match[3], sourceIndex);
      add(match[4], match[2], match[3], sourceIndex);
    }
    // Explicit coordinated sibling wording: every participant is independently
    // named, so it cannot create an identity merge or pronoun-based role.
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern}?)\\s+and\\s+(${namePattern}?)\\s+(?:are|were)\\s+(?:the\\s+)?(sisters|brothers|siblings)\\b`, 'gi'))) {
      const role = ({ sisters: 'sister', brothers: 'brother', siblings: 'sibling' })[match[3].toLowerCase()];
      add(match[1], match[2], role, sourceIndex);
      add(match[2], match[1], role, sourceIndex);
    }
    // Coordinated parents remain generic unless the source itself identifies
    // mother/father. Names and shared surnames are never treated as gender
    // evidence; the generic parent role is still a safe durable fact.
    for (const match of text.matchAll(new RegExp(`\\b(${namePattern}?)\\s+and\\s+(${namePattern}?)\\s+(?:are|were)\\s+(${namePattern}?)(?:\\s+and\\s+(${namePattern}?))?'s\\s+parents\\b`, 'gi'))) {
      for (const child of [match[3], match[4]].filter(Boolean)) {
        add(match[1], child, 'parent', sourceIndex);
        add(match[2], child, 'parent', sourceIndex);
      }
    }
  }
  return candidates;
}

/** Idempotently separates known roles from legacy structured profile entries. */
export function migrateProfileRoleDescriptorSeparation(profile = {}) {
  const entries = Array.isArray(profile.relationship_matrix_structured)
    ? profile.relationship_matrix_structured
    : [];
  let removed = 0;
  let migrated = 0;
  const relationship_matrix_structured = entries.map((entry) => {
    const role = String(entry?.canonical_relationship_type ?? '').trim().toLowerCase() || null;
    const cleaned = normalizeRelationshipDescriptors(entry?.relationship_descriptors ?? entry?.descriptors ?? [], role);
    removed += cleaned.removed.length;
    if (cleaned.removed.length) migrated++;
    return { ...entry, canonical_relationship_type: role, relationship_descriptors: cleaned.descriptors };
  });
  const relationship_matrix = relationship_matrix_structured.length
    ? relationship_matrix_structured.map((entry) => renderRelationshipMatrixLine(entry.target, { relationship_type: entry.canonical_relationship_type }, entry.relationship_descriptors)).join('\n')
    : profile.relationship_matrix;
  return { profile: { ...profile, relationship_matrix, relationship_matrix_structured }, profile_role_tokens_removed: removed, profile_fields_migrated_for_role_separation: migrated };
}
