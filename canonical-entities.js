/** Canonical character-card roster and deterministic name resolution. */

const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const words = (value) => normalize(value).split(' ').filter(Boolean);
const PERSONA_PLACEHOLDERS = new Set(['', 'unused', 'unknown', 'user', 'default', 'user-default', 'user-default.png', 'null', 'undefined']);
const isUsablePersonaName = (value) => {
  const name = String(value ?? '').trim();
  return Boolean(name) && !PERSONA_PLACEHOLDERS.has(normalize(name)) && !/^(?:user[-_ ]?default|default[-_ ]?user)\.(?:png|jpg|jpeg|webp)$/i.test(name);
};

// Catch-up work can run for hours.  SillyTavern's serialized chat header is
// not authoritative for a persona (and imported chats commonly contain
// placeholders), so retain the live persona selected when the run began.
// This is deliberately module-scoped rather than written to chat metadata:
// it is transient runtime context, not a generated memory fact.
let activeRuntimePersonaSnapshot = null;

export function snapshotCanonicalRuntimeContext(context = {}) {
  const chatPersonaName = [...(context?.chat ?? [])].reverse().find((message) => message?.is_user && isUsablePersonaName(message?.name))?.name;
  const explicitPersona = context?.activePersona ?? context?.persona ?? null;
  const personaCandidates = [
    { name: explicitPersona?.name, record: explicitPersona, source: context?.activePersona ? 'active_persona' : 'persona' },
    { name: context?.personaName, record: explicitPersona, source: 'persona_name' },
    { name: context?.userName, record: explicitPersona, source: 'resolved_user_name' },
    // SillyTavern uses name1 for the current user/persona and name2 for the
    // active character.  Keep name2 only as a legacy final fallback for older
    // context adapters that expose the user identity there.
    { name: context?.name1, record: explicitPersona, source: 'context_name1' },
    { name: chatPersonaName, record: explicitPersona, source: 'user_message' },
    { name: context?.name2, record: explicitPersona, source: 'legacy_name2' },
  ];
  const selected = personaCandidates.find((candidate) => isUsablePersonaName(candidate.name)) ?? null;
  const personaName = selected ? String(selected.name).trim() : '';
  const personaRecord = selected?.record
    ?? (Array.isArray(context?.personas) ? context.personas.find((entry) => normalize(entry?.name) === normalize(personaName)) : null)
    ?? {};
  const runtimePersonaKey = String(context?.activePersonaKey ?? context?.personaKey ?? '').trim();
  const providedPersonaId = String(personaRecord?.id ?? personaRecord?.avatar ?? runtimePersonaKey ?? context?.personaId ?? context?.persona_id ?? context?.user_avatar ?? '').trim();
  const stablePersonaId = personaName ? (providedPersonaId || `name:${normalize(personaName)}`) : null;
  const aliases = [
    ...(Array.isArray(personaRecord?.aliases) ? personaRecord.aliases : []),
    personaRecord?.alias,
    words(personaName)[0],
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  const historicalAliases = [
    ...(Array.isArray(personaRecord?.previous_names) ? personaRecord.previous_names : []),
    ...(Array.isArray(personaRecord?.historical_aliases) ? personaRecord.historical_aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean);
  return Object.freeze({
    active_persona: Object.freeze({
      canonical_name: personaName,
      stable_persona_id: stablePersonaId,
      avatar_or_persona_key: String(personaRecord?.avatar ?? context?.user_avatar ?? '').trim() || null,
      active_display_name: personaName,
      approved_aliases: Object.freeze([...new Set(aliases)]),
      historical_aliases: Object.freeze([...new Set(historicalAliases)]),
      source: 'live_runtime',
      runtime_source: selected?.source ?? 'unavailable',
      stable_id_source: providedPersonaId ? 'runtime_key' : personaName ? 'derived_name' : 'unavailable',
    }),
  });
}

export function setCanonicalRuntimeContextSnapshot(snapshot) {
  activeRuntimePersonaSnapshot = snapshot?.active_persona?.canonical_name ? snapshot : null;
}

export function clearCanonicalRuntimeContextSnapshot() {
  activeRuntimePersonaSnapshot = null;
}

export function getCanonicalRuntimeContextSnapshot() {
  return activeRuntimePersonaSnapshot;
}

/** Normalizes supported roster shapes before identity helpers inspect them. */
export function getCanonicalRosterPeople(roster) {
  if (Array.isArray(roster)) return roster;
  if (Array.isArray(roster?.characters)) return roster.characters;
  if (roster?.characters instanceof Map) return [...roster.characters.values()];
  if (roster?.people instanceof Map) return [...roster.people.values()];
  if (Array.isArray(roster?.people)) return roster.people;
  return [];
}

export function getCanonicalPersonaEntries(roster) {
  return getCanonicalRosterPeople(roster).filter((entry) => entry?.source === 'user-persona' || entry?.source_type === 'persona');
}

export function getCanonicalCardEntries(roster) {
  return getCanonicalRosterPeople(roster).filter((entry) => entry?.source === 'character-card' || entry?.source_type === 'character-card');
}

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
  const knownQualifier = existingEntities.some((entry) => normalize(entry?.name ?? entry?.canonicalName) === normalize(qualifier));
  if (/^(?:speaker|subject|mentioned by .+|context)$/i.test(qualifier) || knownQualifier || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(qualifier)) {
    return { normalized_name: base, qualifier_removed: true, qualifier_type: knownQualifier ? 'known_entity_context' : 'synthetic_disambiguator' };
  }
  return { normalized_name: original, qualifier_removed: false };
}

/**
 * Builds the authoritative identity roster for one active chat scope. Entries
 * retain the legacy camelCase fields for existing callers and expose the
 * canonical schema used by reconciliation and diagnostics.
 */
export function buildCanonicalRoster(context, scope = {}) {
  const group = context?.groupId ? context.groups?.find((entry) => String(entry.id) === String(context.groupId)) : null;
  const activeAvatars = new Set(group?.members ?? []);
  const activeNames = new Set(scope.activeNames?.map(normalize) ?? []);
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
        canonical_id: String(card.id ?? card.avatar ?? `card:${normalize(canonicalName)}`),
        canonical_name: canonicalName,
        entity_type: 'character',
        aliases,
        descriptionExcerpt: String(card.description ?? '').trim().slice(0, 240),
        source: 'character-card',
        source_type: 'character-card',
      };
    })
    .filter((entry) => entry.canonicalName);
  // The active user persona participates in the chat but is not represented
  // by a character card. Include it as a canonical participant so persona
  // entities are not incorrectly reported as unmatched during reconciliation.
  const chatPersonaName = [...(context?.chat ?? [])].reverse().find((message) => message?.is_user && String(message?.name ?? '').trim())?.name;
  // SillyTavern's name1 is normally the active character while name2 is the
  // user/persona. Prefer explicit persona state, userName/name2, and actual
  // user messages before using name1 as a legacy fallback.
  const runtimePersona = scope.runtimeSnapshot?.active_persona ?? activeRuntimePersonaSnapshot?.active_persona ?? null;
  const personaName = String(runtimePersona?.canonical_name ?? scope.personaName ?? scope.persona?.name ?? scope.activePersona?.name ?? context?.persona?.name ?? context?.userName ?? context?.name2 ?? chatPersonaName ?? context?.name1 ?? '').trim();
  const personaRecord = scope.persona ?? scope.activePersona ?? context?.persona ?? (context?.personas ?? []).find((entry) => normalize(entry?.name) === normalize(personaName));
  const personaId = runtimePersona?.stable_persona_id ?? personaRecord?.id ?? personaRecord?.avatar ?? context?.personaId ?? context?.persona_id ?? normalize(personaName);
  const personaAliases = [
    ...(Array.isArray(scope.personaAliases) ? scope.personaAliases : []),
    ...(Array.isArray(personaRecord?.aliases) ? personaRecord.aliases : []),
    ...(Array.isArray(personaRecord?.previous_names) ? personaRecord.previous_names : []),
    ...(runtimePersona?.approved_aliases ?? []),
    ...(runtimePersona?.historical_aliases ?? []),
    personaRecord?.alias,
    words(personaName)[0],
  ].map((alias) => String(alias ?? '').trim()).filter(Boolean);
  // Historical persona names are often shortened in imported prose (for
  // example Adam -> Adam Lawson -> Kyle Holland). Preserve that direct alias
  // only when no active card or approved alias could also mean Adam. This
  // flattens a safe historical chain without guessing in a competing roster.
  const rosterUsesFirstName = (firstName) => characters.some((entry) =>
    [entry?.canonicalName, ...(entry?.aliases ?? [])]
      .map((name) => words(name)[0])
      .some((name) => name === firstName),
  );
  for (const alias of [...personaAliases]) {
    const shortHistoricalAlias = words(alias)[0];
    if (!shortHistoricalAlias || words(alias).length < 2 || rosterUsesFirstName(shortHistoricalAlias)) continue;
    personaAliases.push(shortHistoricalAlias);
  }
  if (personaName && !characters.some((entry) => normalize(entry.canonicalName) === normalize(personaName))) {
    characters.push({
      id: `persona:${personaId}`,
      canonicalName: personaName,
      canonical_id: `persona:${personaId}`,
      canonical_name: personaName,
      entity_type: 'character',
      canonical_identity_type: 'persona',
      canonical_persona_id: String(personaId),
      canonical_card_id: null,
      aliases: [...new Set(personaAliases)],
      descriptionExcerpt: '',
      source: 'user-persona',
      source_type: 'persona',
    });
  }
  // Chat-local approved character entities are useful as roster context in a
  // group chat but must never override a card or persona identity.
  if (scope.includeChatLocalApproved) {
    const meta = context?.chatMetadata?.smartMemoryEnhanced ?? {};
    const entries = Object.values(meta.card_local_entities ?? {}).flat();
    for (const entity of entries) {
      if (entity?.type !== 'character' || !entity?.name || entity?.validation_status === 'needs_review') continue;
      if (characters.some((entry) => normalize(entry.canonicalName) === normalize(entity.name))) continue;
      characters.push({
        id: entity.id ?? `chat-local:${normalize(entity.name)}`,
        canonicalName: entity.name,
        canonical_id: entity.id ?? `chat-local:${normalize(entity.name)}`,
        canonical_name: entity.name,
        entity_type: 'character',
        aliases: [...new Set(entity.aliases ?? [])],
        descriptionExcerpt: '',
        source: 'chat-local-approved',
        source_type: 'chat-local-approved',
      });
    }
  }
  return { characters };
}

/**
 * Removes model-created identity disambiguators from generated prose without
 * treating ordinary parentheticals as disposable. Only qualifiers already
 * recognized as synthetic by normalizeSyntheticIdentityQualifier are removed.
 */
export function sanitizeSyntheticIdentityLabels(text, roster = { characters: [] }, existingEntities = []) {
  const known = [...(roster?.characters ?? []), ...(existingEntities ?? [])];
  const removals = [];
  const output = String(text ?? '').replace(/\b([A-Z][A-Za-z]*(?:[ -][A-Z][A-Za-z]*){0,3})\s*\(([^()\n]{1,80})\)/g, (full) => {
    const normalized = normalizeSyntheticIdentityQualifier(full, known);
    if (!normalized.qualifier_removed) return full;
    removals.push({ from: full, to: normalized.normalized_name, qualifier_type: normalized.qualifier_type ?? 'synthetic_disambiguator' });
    return normalized.normalized_name;
  });
  return { text: output, removals };
}

/** Backward-compatible name for callers that only need character entries. */
export function buildCanonicalCharacterRoster(context, options = {}) {
  return buildCanonicalRoster(context, options);
}

export function formatCanonicalRosterForPrompt(roster) {
  const people = getCanonicalRosterPeople(roster);
  if (!people.length) return '';
  const lines = people.map((entry) =>
    `- ${entry.canonicalName}${entry.aliases.length ? ` (known references: ${entry.aliases.join(', ')})` : ''}`,
  );
  return `CANONICAL PARTICIPANTS (authoritative):\n${lines.join('\n')}\n\nUse canonical names. Do not infer surnames, married names, or aliases.\n\n`;
}

export function resolveCanonicalCharacterName(candidateName, roster, existingEntities = []) {
  const people = getCanonicalRosterPeople(roster);
  const qualifier = normalizeSyntheticIdentityQualifier(candidateName, [...people, ...existingEntities]);
  const candidate = qualifier.normalized_name;
  const candidateNorm = normalize(candidate);
  if (!candidateNorm) return { status: 'unresolved', candidateName: candidate, reason: 'Empty name.', shouldCreateEntity: false, shouldAddAlias: false };
  const characters = people;
  const exact = characters.find((entry) => normalize(entry.canonicalName) === candidateNorm);
  if (exact) return resolved(candidate, exact, 'Exact canonical character-card name.');
  const aliasMatches = characters.filter((entry) => entry.aliases.some((alias) => normalize(alias) === candidateNorm));
  if (aliasMatches.length === 1) return resolved(candidate, aliasMatches[0], aliasMatches[0].source === 'user-persona'
    ? 'Historical active persona name.'
    : 'Approved character-card alias.');
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
  if (existing) return {
    status: 'resolved',
    candidateName: candidate,
    canonicalName: existing.name,
    canonicalId: existing.id ?? existing.canonical_card_id ?? null,
    canonicalIdentityType: existing.canonical_identity_type ?? (existing.canonical_persona_id ? 'persona' : existing.canonical_card_id ? 'character_card' : 'grounded_npc'),
    canonicalCardId: existing.canonical_card_id ?? null,
    canonicalPersonaId: existing.canonical_persona_id ?? null,
    reason: 'Existing approved entity alias.',
    shouldCreateEntity: false,
    shouldAddAlias: false,
  };
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
  const synthetic = normalizeSyntheticIdentityQualifier(name, [...getCanonicalRosterPeople(canonicalRoster), ...entries]);
  const sourceRecordIds = [...new Set((evidence.source_record_ids ?? evidence.sourceRecordIds ?? []).filter(Boolean))];
  const sourceMessageIndices = [...new Set((evidence.source_message_indices ?? evidence.sourceMessageIndices ?? []).filter(Number.isInteger))];
  const explicitlyGrounded = evidence.grounding_status === 'direct' || sourceMessageIndices.length > 0;
  const repeated = Number(evidence.repeated_mentions ?? evidence.repeatedMentions ?? 0) >= 2 || sourceRecordIds.length >= 2;
  return {
    ...resolution,
    candidateName: String(name ?? '').trim(),
    synthetic_parenthetical: synthetic.qualifier_removed ? { base_name: synthetic.normalized_name, qualifier_type: synthetic.qualifier_type } : null,
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
  // Relationship History represents two individual people. Collective labels
  // must be split before this point, and a person cannot form a pair with
  // themself merely because an alias resolved twice to the same card.
  if (/\s+(?:&|and)\s+/i.test(String(subject ?? '')) || /\s+(?:&|and)\s+/i.test(String(target ?? ''))) return null;
  const left = resolveCanonicalCharacterName(subject, roster);
  const right = resolveCanonicalCharacterName(target, roster);
  if (left.status !== 'resolved' || right.status !== 'resolved') return null;
  if (String(left.canonicalId ?? '').toLowerCase() === String(right.canonicalId ?? '').toLowerCase()) return null;
  return [left.canonicalName ?? subject, right.canonicalName ?? target];
}

/**
 * Canonicalizes structured scene/arc participants without inventing people.
 * Known card and persona references receive their canonical display name;
 * grounded unknown NPC names are retained verbatim. Ambiguous or contradictory
 * card-like names are omitted so they cannot become durable graph references.
 */
export function canonicalizeStructuredParticipants(participants, roster) {
  const result = { names: [], rejected: [], references: [] };
  for (const rawName of Array.isArray(participants) ? participants : []) {
    const name = String(rawName ?? '').trim();
    if (!name) continue;
    const resolution = resolveCanonicalCharacterName(name, roster);
    if (resolution.status === 'resolved') {
      result.names.push(resolution.canonicalName);
      result.references.push({
        entity_id: resolution.canonicalId,
        canonical_name: resolution.canonicalName,
        display_name_at_time: name,
        alias_type: resolution.reason ?? 'canonical-name',
      });
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
  result.references = result.references.filter((reference, index, entries) =>
    entries.findIndex((candidate) => candidate.entity_id === reference.entity_id && candidate.display_name_at_time === reference.display_name_at_time) === index,
  );
  return result;
}

/**
 * Finds only roster-backed people explicitly named in a stored narrative.
 * This is deliberately not free-form entity extraction: it repairs an omitted
 * structured participant list without creating NPCs from a scene summary.
 */
export function findCanonicalParticipantsInText(text, roster) {
  const result = { names: [], references: [] };
  const narrative = String(text ?? '');
  for (const entry of getCanonicalRosterPeople(roster)) {
    const references = [...new Set([entry.canonicalName, ...(entry.aliases ?? [])]
      .map((name) => String(name ?? '').trim())
      .filter(Boolean))];
    for (const displayName of references) {
      if (!new RegExp(`(^|[^\\p{L}])${escapeRegExp(displayName)}(?=$|[^\\p{L}])`, 'iu').test(narrative)) continue;
      result.names.push(entry.canonicalName);
      result.references.push({
        entity_id: entry.id,
        canonical_name: entry.canonicalName,
        display_name_at_time: displayName,
        alias_type: normalize(displayName) === normalize(entry.canonicalName) ? 'canonical-name' : 'historical-alias',
      });
      break;
    }
  }
  result.names = [...new Set(result.names)];
  return result;
}

/**
 * Retains structured arc participants only when the arc itself or its supplied
 * source evidence names that person. Roster membership establishes identity;
 * it does not establish involvement in a particular story thread.
 */
export function validateArcParticipants(participants, roster, { content = '', evidenceText = '' } = {}) {
  const canonical = canonicalizeStructuredParticipants(participants, roster);
  const supported = [];
  const added = [];
  const rejected = [...canonical.rejected];
  const evidence = `${content}\n${evidenceText}`;
  for (const name of canonical.names) {
    const entry = (roster?.characters ?? []).find((candidate) => normalize(candidate.canonicalName) === normalize(name));
    const references = [...new Set([name, ...(entry?.aliases ?? [])].map((reference) => String(reference ?? '').trim()).filter(Boolean))];
    const mentioned = references.some((reference) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(reference)}(?=$|[^\\p{L}])`, 'iu').test(evidence));
    if (mentioned) {
      supported.push(name);
    } else {
      rejected.push({
        name,
        reason: 'Participant is not named in the arc content or supplied source evidence.',
        canonicalName: entry?.canonicalName ?? name,
        canonicalId: entry?.canonical_id ?? null,
      });
    }
  }
  // Structured output can omit a clearly named card/persona participant. The
  // arc text itself is the authority for additions; broad source evidence is
  // intentionally not used here, because it can mention unrelated speakers.
  for (const entry of roster?.characters ?? []) {
    const references = [...new Set([entry.canonicalName, ...(entry.aliases ?? [])].map((reference) => String(reference ?? '').trim()).filter(Boolean))];
    if (!references.some((reference) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(reference)}(?=$|[^\\p{L}])`, 'iu').test(String(content)))) continue;
    if (supported.includes(entry.canonicalName)) continue;
    supported.push(entry.canonicalName);
    added.push({ name: entry.canonicalName, reason: 'Named directly in arc content.' });
  }
  return { names: [...new Set(supported)], rejected, added };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrites only deterministic roster aliases/variants in generated prose. */
export function canonicalizeNarrativeNames(text, roster, { preserveHistoricalPersonaNames = false } = {}) {
  const replacements = [];
  const value = String(text ?? '');
  const output = value.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g, (candidate) => {
    const resolution = resolveCanonicalCharacterName(candidate, roster);
    if (!resolution.canonicalName || !['resolved', 'rejected'].includes(resolution.status)) return candidate;
    if (normalize(candidate) === normalize(resolution.canonicalName)) return candidate;
    // Scene archives retain source-era persona wording for historical context,
    // while their participant references continue to carry the current stable
    // persona ID. Other generated prose remains normalized by default.
    if (preserveHistoricalPersonaNames && resolution.reason === 'Historical active persona name.') return candidate;
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
  const identityType = accepted ? (result.canonicalIdentityType ?? 'character_card') : null;
  const canonicalId = accepted ? (result.canonicalId ?? null) : null;
  return {
    displayName,
    canonicalId,
    canonicalIdentityType: identityType,
    canonicalCardId: accepted ? (result.canonicalCardId ?? null) : null,
    canonicalPersonaId: accepted ? (result.canonicalPersonaId ?? null) : null,
    storageId: accepted && canonicalId
      ? `${identityType === 'persona' ? 'persona' : 'card'}:${identityType === 'persona' ? (result.canonicalPersonaId ?? String(canonicalId).replace(/^persona:/, '')) : canonicalId}`
      : `name:${normalize(displayName)}`,
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
    const canonicalKey = buildStableLedgerKey(resolved.canonicalName, type, roster);
    // A stable ledger key alone is not sufficient: an old card identifier can
    // survive an earlier rename or merge and later be injected as a dangling
    // structured reference.  The resolver gives us the safe, authoritative
    // card link, so keep the label and ID synchronized even when the key was
    // already canonical.
    const canonicalFields = {
      ...fields,
      _name: resolved.canonicalName,
      _canonical_identity_type: resolved.canonicalIdentityType ?? 'character_card',
      _canonical_card_id: resolved.canonicalCardId ?? resolved.canonicalId,
      _canonical_persona_id: resolved.canonicalPersonaId ?? null,
    };
    if (canonicalKey === key) {
      // Earlier alias rows may already have contributed non-conflicting
      // fields to this canonical key during this pass.
      result[key] = {
        ...canonicalFields,
        ...(result[key] ?? {}),
        _name: resolved.canonicalName,
        _canonical_card_id: resolved.canonicalId,
      };
      continue;
    }
    result[canonicalKey] = {
      ...(result[canonicalKey] ?? {}),
      ...canonicalFields,
      _name: resolved.canonicalName,
      _canonical_card_id: resolved.canonicalId,
    };
    delete result[key];
  }
  return result;
}

function resolved(candidateName, entry, reason) {
  const isPersona = entry.source === 'user-persona' || entry.source_type === 'persona';
  return {
    status: 'resolved',
    candidateName,
    canonicalName: entry.canonicalName,
    canonicalId: entry.id,
    canonicalIdentityType: isPersona ? 'persona' : 'character_card',
    canonicalPersonaId: isPersona ? (entry.canonical_persona_id ?? String(entry.id).replace(/^persona:/, '')) : null,
    canonicalCardId: isPersona ? null : entry.id,
    reason,
    shouldCreateEntity: false,
    shouldAddAlias: normalize(candidateName) === normalize(entry.canonicalName) || entry.aliases.some((alias) => normalize(alias) === normalize(candidateName)),
  };
}

function ambiguous(candidateName, entries, reason) {
  return { status: 'ambiguous', candidateName, candidates: entries.map((entry) => entry.canonicalName), reason, shouldCreateEntity: false, shouldAddAlias: false };
}
