/** Canonical character-card roster and deterministic name resolution. */

const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const words = (value) => normalize(value).split(' ').filter(Boolean);

/** Removes model-created parenthetical disambiguators without touching known titles. */
export function normalizeSyntheticIdentityQualifier(candidate, existingEntities = []) {
  const original = String(candidate ?? '').trim();
  const match = original.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (!match) return { normalized_name: original, qualifier_removed: false };
  const base = match[1].trim();
  const qualifier = match[2].trim();
  // Numeric/unit titles are often genuine identities, while speaker/subject
  // labels and a second known person's name are model disambiguators.
  if (/\b(?:prototype|incarnation|mark|model)\b/i.test(qualifier) || /\d/.test(base)) {
    return { normalized_name: original, qualifier_removed: false };
  }
  const knownQualifier = existingEntities.some((entry) => normalize(entry?.name) === normalize(qualifier));
  if (/^(?:speaker|subject|mentioned by .+|context)$/i.test(qualifier) || knownQualifier || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(qualifier)) {
    return { normalized_name: base, qualifier_removed: true, qualifier_type: knownQualifier ? 'known_entity_context' : 'synthetic_disambiguator' };
  }
  return { normalized_name: original, qualifier_removed: false };
}

export function buildCanonicalCharacterRoster(context, options = {}) {
  const group = context?.groupId ? context.groups?.find((entry) => String(entry.id) === String(context.groupId)) : null;
  const activeAvatars = new Set(group?.members ?? []);
  const activeNames = new Set(options.activeNames?.map(normalize) ?? []);
  const characters = (context?.characters ?? [])
    .filter((card) => {
      if (activeNames.size) return activeNames.has(normalize(card.name));
      // In a group, only cards referenced by that group's member avatar IDs
      // are relevant. In one-to-one chat, retain the loaded-card roster.
      return !group || activeAvatars.has(card.avatar);
    })
    .map((card) => {
      const canonicalName = String(card.name ?? '').trim();
      const aliases = [...new Set([...(card.aliases ?? []), words(canonicalName)[0]].filter(Boolean))];
      return {
        id: card.id ?? card.avatar ?? null,
        canonicalName,
        aliases,
        descriptionExcerpt: String(card.description ?? '').trim().slice(0, 240),
        source: 'character-card',
      };
    })
    .filter((entry) => entry.canonicalName);
  // The active user persona participates in the chat but is not represented
  // by a character card. Include it as a canonical participant so persona
  // entities are not incorrectly reported as unmatched during reconciliation.
  const personaName = String(options.personaName ?? context?.name1 ?? context?.userName ?? '').trim();
  const personaRecord = options.persona ?? context?.persona ?? (context?.personas ?? []).find((entry) => normalize(entry?.name) === normalize(personaName));
  const personaId = personaRecord?.id ?? personaRecord?.avatar ?? context?.personaId ?? context?.persona_id ?? normalize(personaName);
  const personaAliases = [
    ...(Array.isArray(options.personaAliases) ? options.personaAliases : []),
    ...(Array.isArray(personaRecord?.aliases) ? personaRecord.aliases : []),
    ...(Array.isArray(personaRecord?.previous_names) ? personaRecord.previous_names : []),
    personaRecord?.alias,
    words(personaName)[0],
  ].map((alias) => String(alias ?? '').trim()).filter(Boolean);
  if (personaName && !characters.some((entry) => normalize(entry.canonicalName) === normalize(personaName))) {
    characters.push({
      id: `persona:${personaId}`,
      canonicalName: personaName,
      aliases: [...new Set(personaAliases)],
      descriptionExcerpt: '',
      source: 'user-persona',
    });
  }
  return { characters };
}

export function formatCanonicalRosterForPrompt(roster) {
  if (!roster?.characters?.length) return '';
  const lines = roster.characters.map((entry) =>
    `- ${entry.canonicalName}${entry.aliases.length ? ` (known references: ${entry.aliases.join(', ')})` : ''}`,
  );
  return `CANONICAL PARTICIPANTS (authoritative):\n${lines.join('\n')}\n\nUse canonical names. Do not infer surnames, married names, or aliases.\n\n`;
}

export function resolveCanonicalCharacterName(candidateName, roster, existingEntities = []) {
  const qualifier = normalizeSyntheticIdentityQualifier(candidateName, [...(roster?.characters ?? []), ...existingEntities]);
  const candidate = qualifier.normalized_name;
  const candidateNorm = normalize(candidate);
  if (!candidateNorm) return { status: 'unresolved', candidateName: candidate, reason: 'Empty name.', shouldCreateEntity: false, shouldAddAlias: false };
  const characters = roster?.characters ?? [];
  const exact = characters.find((entry) => normalize(entry.canonicalName) === candidateNorm);
  if (exact) return resolved(candidate, exact, 'Exact canonical character-card name.');
  const aliasMatches = characters.filter((entry) => entry.aliases.some((alias) => normalize(alias) === candidateNorm));
  if (aliasMatches.length === 1) return resolved(candidate, aliasMatches[0], 'Approved character-card alias.');
  if (aliasMatches.length > 1) return ambiguous(candidate, aliasMatches, 'Alias matches multiple canonical characters.');
  const first = words(candidate)[0];
  const firstMatches = characters.filter((entry) => words(entry.canonicalName)[0] === first);
  if (firstMatches.length > 1) return ambiguous(candidate, firstMatches, 'First name is ambiguous.');
  if (firstMatches.length === 1) {
    const match = firstMatches[0];
    if (words(candidate).length > 1 && normalize(match.canonicalName) !== candidateNorm) {
      return { ...resolved(candidate, match, 'Unique first-name match; unsupported surname rejected.'), status: 'rejected', shouldAddAlias: false };
    }
    return resolved(candidate, match, match.source === 'user-persona'
      ? 'Unique active persona first-name match.'
      : 'Unique first-name match.');
  }
  const existing = existingEntities.find((entry) => normalize(entry.name) === candidateNorm || (entry.aliases ?? []).some((alias) => normalize(alias) === candidateNorm));
  if (existing) return { status: 'resolved', candidateName: candidate, canonicalName: existing.name, canonicalId: existing.canonical_card_id ?? null, reason: 'Existing approved entity alias.', shouldCreateEntity: false, shouldAddAlias: false };
  return { status: 'unresolved', candidateName: candidate, reason: 'Not represented by a relevant character card.', shouldCreateEntity: true, shouldAddAlias: false };
}

/**
 * The single identity decision used by extraction and reconciliation. It keeps
 * roster matching scoped to the active chat and returns promotion evidence for
 * genuinely new grounded NPCs.
 */
export function resolveEntityCandidate(candidate, canonicalRoster, registries = [], evidence = {}) {
  const name = typeof candidate === 'string' ? candidate : candidate?.name;
  const entries = Array.isArray(registries)
    ? registries.flatMap((registry) => Array.isArray(registry) ? registry : [registry])
    : [];
  const resolution = resolveCanonicalCharacterName(name, canonicalRoster, entries);
  const sourceRecordIds = [...new Set((evidence.source_record_ids ?? evidence.sourceRecordIds ?? []).filter(Boolean))];
  const sourceMessageIndices = [...new Set((evidence.source_message_indices ?? evidence.sourceMessageIndices ?? []).filter(Number.isInteger))];
  const explicitlyGrounded = evidence.grounding_status === 'direct' || sourceMessageIndices.length > 0;
  const repeated = Number(evidence.repeated_mentions ?? evidence.repeatedMentions ?? 0) >= 2 || sourceRecordIds.length >= 2;
  return {
    ...resolution,
    candidateName: String(name ?? '').trim(),
    promotion: resolution.shouldCreateEntity && (explicitlyGrounded || repeated || evidence.manual === true)
      ? {
        allowed: true,
        creation_reason: evidence.manual ? 'manual' : explicitlyGrounded ? 'grounded-record' : 'repeated-mention',
        source_record_ids: sourceRecordIds,
        source_message_indices: sourceMessageIndices,
      }
      : { allowed: false },
  };
}

export function canonicalizeRelationshipPair(subject, target, roster) {
  const left = resolveCanonicalCharacterName(subject, roster);
  const right = resolveCanonicalCharacterName(target, roster);
  if (left.status !== 'resolved' || right.status !== 'resolved') return null;
  return [left.canonicalName ?? subject, right.canonicalName ?? target];
}

/**
 * Canonicalizes structured scene/arc participants without inventing people.
 * Known card and persona references receive their canonical display name;
 * grounded unknown NPC names are retained verbatim. Ambiguous or contradictory
 * card-like names are omitted so they cannot become durable graph references.
 */
export function canonicalizeStructuredParticipants(participants, roster) {
  const result = { names: [], rejected: [] };
  for (const rawName of Array.isArray(participants) ? participants : []) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    const resolution = resolveCanonicalCharacterName(name, roster);
    if (resolution.status === 'resolved') {
      result.names.push(resolution.canonicalName);
      continue;
    }
    if (resolution.status === 'ambiguous' || resolution.status === 'rejected') {
      result.rejected.push({
        name,
        reason: resolution.reason,
        candidates: resolution.candidates ?? [],
        canonicalName: resolution.canonicalName ?? null,
        canonicalId: resolution.canonicalId ?? null,
      });
      continue;
    }
    result.names.push(name);
  }
  result.names = [...new Set(result.names)];
  return result;
}

/** Rewrites only deterministic roster aliases/variants in generated prose. */
export function canonicalizeNarrativeNames(text, roster) {
  const replacements = [];
  const value = String(text ?? '');
  const output = value.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g, (candidate) => {
    const resolution = resolveCanonicalCharacterName(candidate, roster);
    if (!resolution.canonicalName || !['resolved', 'rejected'].includes(resolution.status)) return candidate;
    if (normalize(candidate) === normalize(resolution.canonicalName)) return candidate;
    replacements.push({ from: candidate, to: resolution.canonicalName, reason: resolution.reason });
    return resolution.canonicalName;
  });
  return { text: output, replacements };
}

/** Coalesces repeated identity decisions while retaining their evidence. */
export function deduplicateIdentityDecisions(decisions = [], recordScope = '') {
  const merged = new Map();
  for (const decision of decisions.filter(Boolean)) {
    const source = String(decision.from ?? decision.candidateName ?? decision.name ?? '').trim();
    const target = String(decision.to ?? decision.canonicalName ?? '').trim();
    const type = String(decision.reason ?? decision.reason_code ?? decision.status ?? '').trim();
    const key = `${normalize(source)}|${normalize(target)}|${normalize(type)}|${normalize(recordScope)}`;
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, {
        ...decision,
        source_record_ids: [...new Set((decision.source_record_ids ?? decision.memoryIds ?? []).filter(Boolean))],
        source_message_indices: [...new Set((decision.source_message_indices ?? []).filter(Number.isInteger))].sort((a, b) => a - b),
        occurrences: decision.occurrences ?? 1,
      });
      continue;
    }
    prior.source_record_ids = [...new Set([...(prior.source_record_ids ?? []), ...(decision.source_record_ids ?? decision.memoryIds ?? [])].filter(Boolean))];
    prior.source_message_indices = [...new Set([...(prior.source_message_indices ?? []), ...(decision.source_message_indices ?? [])].filter(Number.isInteger))].sort((a, b) => a - b);
    prior.occurrences = (prior.occurrences ?? 1) + (decision.occurrences ?? 1);
  }
  return [...merged.values()];
}

/** Builds a stable storage reference plus the readable canonical label. */
export function buildStableEntityReference(name, roster) {
  const result = resolveCanonicalCharacterName(name, roster);
  const accepted = result.status === 'resolved';
  const displayName = accepted ? result.canonicalName : String(name).trim();
  return {
    displayName,
    canonicalId: accepted ? (result.canonicalId ?? null) : null,
    storageId: accepted && result.canonicalId ? `card:${result.canonicalId}` : `name:${normalize(displayName)}`,
  };
}

/** Builds the ID-backed Relationship History key and display labels. */
export function buildStableRelationshipPair(subject, target, roster) {
  const left = buildStableEntityReference(subject, roster);
  const right = buildStableEntityReference(target, roster);
  return { key: `${left.storageId}→${right.storageId}`, subject: left, target: right };
}

/** Builds a State Ledger key that uses a card ID when one exists. */
export function buildStableLedgerKey(name, type, roster) {
  return `${buildStableEntityReference(name, roster).storageId}|${type}`;
}

/** Rewrites every graph-memory reference from a duplicate ID to its survivor. */
export function remapEntityIdInMemories(memories, sourceId, targetId) {
  let changed = false;
  for (const memory of memories) {
    if (!Array.isArray(memory.entities) || !memory.entities.includes(sourceId)) continue;
    memory.entities = [...new Set(memory.entities.map((id) => id === sourceId ? targetId : id))];
    changed = true;
  }
  return changed;
}

/** Creates the durable review record for an ambiguous or rejected identity. */
export function buildIdentityReviewCandidate(result, details = {}, id = null) {
  return {
    ...result,
    id,
    candidateKey: normalize(result.candidateName),
    memoryIds: details.memoryId ? [details.memoryId] : [],
    entityType: details.entityType ?? 'unknown',
    occurrences: 1,
    createdAt: details.createdAt ?? Date.now(),
  };
}

export function reconcileCanonicalLedger(ledger, roster) {
  const result = { ...ledger };
  for (const [key, fields] of Object.entries(ledger)) {
    const separator = key.lastIndexOf('|');
    if (separator < 1) continue;
    const name = key.slice(0, separator);
    const type = key.slice(separator + 1);
    const resolved = resolveCanonicalCharacterName(name, roster);
    if (!resolved.canonicalName || resolved.status !== 'resolved') continue;
    const canonicalKey = `${normalize(resolved.canonicalName)}|${type}`;
    if (canonicalKey === key) continue;
    result[canonicalKey] = { ...fields, ...(result[canonicalKey] ?? {}) };
    delete result[key];
  }
  return result;
}

function resolved(candidateName, entry, reason) {
  return { status: 'resolved', candidateName, canonicalName: entry.canonicalName, canonicalId: entry.id, reason, shouldCreateEntity: false, shouldAddAlias: normalize(candidateName) === normalize(entry.canonicalName) || entry.aliases.some((alias) => normalize(alias) === normalize(candidateName)) };
}

function ambiguous(candidateName, entries, reason) {
  return { status: 'ambiguous', candidateName, candidates: entries.map((entry) => entry.canonicalName), reason, shouldCreateEntity: false, shouldAddAlias: false };
}
