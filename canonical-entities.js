/** Canonical character-card roster and deterministic name resolution. */

const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const words = (value) => normalize(value).split(' ').filter(Boolean);

export function buildCanonicalCharacterRoster(context, options = {}) {
  const activeNames = new Set(options.activeNames?.map(normalize) ?? []);
  const characters = (context?.characters ?? [])
    .filter((card) => !activeNames.size || activeNames.has(normalize(card.name)))
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
  return { characters };
}

export function formatCanonicalRosterForPrompt(roster) {
  if (!roster?.characters?.length) return '';
  const lines = roster.characters.map((entry) =>
    `- ${entry.canonicalName}${entry.aliases.length ? ` (known references: ${entry.aliases.join(', ')})` : ''}`,
  );
  return `CANONICAL CHARACTERS (authoritative):\n${lines.join('\n')}\n\nUse canonical names. Do not infer surnames, married names, or aliases.\n\n`;
}

export function resolveCanonicalCharacterName(candidateName, roster, existingEntities = []) {
  const candidate = String(candidateName ?? '').trim();
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
    return resolved(candidate, match, 'Unique first-name match.');
  }
  const existing = existingEntities.find((entry) => normalize(entry.name) === candidateNorm || (entry.aliases ?? []).some((alias) => normalize(alias) === candidateNorm));
  if (existing) return { status: 'resolved', candidateName: candidate, canonicalName: existing.name, canonicalId: existing.canonical_card_id ?? null, reason: 'Existing approved entity alias.', shouldCreateEntity: false, shouldAddAlias: false };
  return { status: 'unresolved', candidateName: candidate, reason: 'Not represented by a relevant character card.', shouldCreateEntity: true, shouldAddAlias: false };
}

function resolved(candidateName, entry, reason) {
  return { status: 'resolved', candidateName, canonicalName: entry.canonicalName, canonicalId: entry.id, reason, shouldCreateEntity: false, shouldAddAlias: normalize(candidateName) === normalize(entry.canonicalName) || entry.aliases.some((alias) => normalize(alias) === normalize(candidateName)) };
}

function ambiguous(candidateName, entries, reason) {
  return { status: 'ambiguous', candidateName, candidates: entries.map((entry) => entry.canonicalName), reason, shouldCreateEntity: false, shouldAddAlias: false };
}
