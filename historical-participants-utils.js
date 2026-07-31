/**
 * Determines the target cards for a historical group rebuild. This is
 * deliberately separate from the live enabled roster: older chats may have
 * begun as one multi-character card, may later have been split into cards, or
 * may contain incorrect model speaker attribution. Every current group card
 * therefore receives the full historical evidence during Memorize Chat.
 */
const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function resolveHistoricalGroupParticipants({ group, characters = [], messages = [], fallbackCharacterName = null } = {}) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const disabled = new Set(group?.disabled_members ?? []);
  const cards = members
    .map((avatar) => ({ avatar, card: characters.find((entry) => entry?.avatar === avatar) }))
    .filter((entry) => entry.card?.name);
  const aliases = new Map();
  for (const { card } of cards) {
    for (const label of [card.name, ...(Array.isArray(card.aliases) ? card.aliases : [])]) {
      const key = normalize(label);
      if (!key) continue;
      const existing = aliases.get(key);
      aliases.set(key, existing && existing !== card.name ? null : card.name);
    }
  }
  const authored = new Set();
  for (const message of messages) {
    if (!message?.mes || message?.is_user || message?.is_system) continue;
    const name = aliases.get(normalize(message.name));
    if (name) authored.add(name);
  }
  const participantNames = cards.map(({ card }) => card.name);
  const fallbackUsed = participantNames.length === 0 && Boolean(fallbackCharacterName);
  const names = fallbackUsed ? [fallbackCharacterName] : participantNames;
  const disabledIncluded = cards
    .filter(({ avatar, card }) => disabled.has(avatar) && names.includes(card.name))
    .map(({ card }) => card.name);
  return {
    mode: group ? 'historical_group_roster' : 'single_character',
    participant_names: names,
    currently_disabled_included: disabledIncluded,
    members_with_authored_messages: cards
      .filter(({ card }) => authored.has(card.name))
      .map(({ card }) => card.name),
    fallback_used: fallbackUsed,
  };
}
