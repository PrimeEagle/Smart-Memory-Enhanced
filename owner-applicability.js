/** Deterministic, conservative owner applicability for one-source recovery. */

const words = (value) => String(value ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasesFor(owner, aliases = []) {
  const parts = String(owner ?? '').trim().split(/\s+/).filter(Boolean);
  return [...new Set([owner, ...aliases, parts.length > 1 ? parts[0] : null]
    .map((item) => String(item ?? '').trim()).filter((item) => item.length >= 2))];
}

function mentions(text, aliases) {
  return aliases.some((alias) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(alias)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text));
}

export function assessSourceFragment(text) {
  const normalized = String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const lexicalWords = words(normalized);
  const hesitation = /^(?:[“"'*(\s]*(?:but|and|so|well|uh+|um+|hmm+|oh|okay|ok|yeah|yes|no|right|wait)(?:\s*\.{2,}|[.!?,…]+)?[”"'*)\s]*)?(?:i\s+)?(?:pause|hesitate|nod|shrug|sigh|blink|swallow)(?:\s*,?\s*(?:nervously|silently|slowly|briefly))?[.!…]*$/iu.test(normalized)
    || /^(?:[“"'*(\s]*(?:but|and|so|well|uh+|um+|hmm+|oh|okay|ok|yeah|yes|no|right|wait)[”"'*)\s]*[.!?,…]*)$/iu.test(normalized);
  const propositionVerb = /\b(?:is|are|was|were|have|has|had|will|would|can|could|did|does|do|want|need|love|hate|care|know|think|believe|remember|promise|decide|leave|arrive|live|work|hurt|help|become|grew|started|ended)\b/iu.test(normalized);
  const incompleteConnective = /^(?:[“"'*(\s]*(?:but|and|so|because|although|if|when|then)[”"'*)\s]*[.!?,…]*)$/iu.test(normalized);
  const nonSubstantive = hesitation || incompleteConnective
    || (lexicalWords.length <= 3 && !propositionVerb && !/\b(?:dead|pregnant|married|divorced|injured|missing)\b/iu.test(normalized));
  return {
    classification: nonSubstantive ? 'non_substantive_fragment' : 'substantive_or_context_dependent',
    reason_codes: nonSubstantive
      ? [hesitation ? 'hesitation_or_stage_direction_without_durable_change'
        : incompleteConnective ? 'incomplete_connective_without_proposition' : 'short_filler_without_proposition']
      : [propositionVerb ? 'standalone_proposition_detected' : 'context_required_to_assess_proposition'],
    word_count: lexicalWords.length,
    standalone_proposition_detected: propositionVerb,
  };
}

/**
 * Returns a local no-update only when irrelevance or non-substance is proven.
 * Every unresolved pronoun/addressee case remains ambiguous and reaches the provider.
 */
export function classifyOwnerApplicability(sourceUnit, { owner, ownerAliases = [], contextUnits = [] } = {}) {
  const text = String(sourceUnit?.raw_text ?? sourceUnit?.text ?? '').trim();
  const aliases = aliasesFor(owner, ownerAliases);
  const ownerMentioned = mentions(text, aliases);
  const speaker = String(sourceUnit?.speaker ?? '').trim();
  const speakerIsOwner = mentions(speaker, aliases);
  const fragment = assessSourceFragment(text);
  const context = (contextUnits.length ? contextUnits : sourceUnit?.context_units ?? [])
    .filter((item) => String(item?.unit_key) !== String(sourceUnit?.unit_key));
  const targetIndex = Number(sourceUnit?.unit_key);
  const before = context.filter((item) => Number(item.unit_key) < targetIndex).sort((a, b) => Number(b.unit_key) - Number(a.unit_key))[0];
  const after = context.filter((item) => Number(item.unit_key) > targetIndex).sort((a, b) => Number(a.unit_key) - Number(b.unit_key))[0];
  const contextOwnerMentions = context.filter((item) => mentions(String(item.raw_text ?? item.text ?? ''), aliases));
  const secondPerson = /\b(?:you|your|you're|you’ve|you've|yourself)\b/iu.test(text);
  const namedNeighbors = [before, after].filter((item) => item && !item.is_user && item.speaker)
    .map((item) => String(item.speaker));
  const uniqueNeighbor = [...new Set(namedNeighbors.map((item) => item.toLocaleLowerCase()))].length === 1
    ? namedNeighbors[0] : null;
  const neighborIsOwner = uniqueNeighbor ? mentions(uniqueNeighbor, aliases) : false;
  const neighborAliases = uniqueNeighbor ? aliasesFor(uniqueNeighbor) : [];
  const followingNarrationConfirmsNeighbor = Boolean(after && uniqueNeighbor
    && String(after.speaker).toLocaleLowerCase() === String(uniqueNeighbor).toLocaleLowerCase()
    && mentions(String(after.raw_text ?? after.text ?? ''), neighborAliases));
  const safelyResolvedOwnerPronoun = !ownerMentioned && /\b(?:she|her|hers|he|him|his|they|them|their)\b/iu.test(text)
    && Boolean(before && mentions(String(before.raw_text ?? before.text ?? ''), aliases))
    && !before?.multiple_people_mentioned;

  let classification = 'owner_relevance_ambiguous';
  const reasonCodes = [];
  if (ownerMentioned || speakerIsOwner || safelyResolvedOwnerPronoun || (secondPerson && neighborIsOwner)) {
    classification = 'owner_relevant';
    if (ownerMentioned) reasonCodes.push('explicit_owner_alias_mention');
    if (speakerIsOwner) reasonCodes.push('owner_is_message_speaker');
    if (safelyResolvedOwnerPronoun) reasonCodes.push('pronoun_resolves_to_unique_owner_antecedent');
    if (secondPerson && neighborIsOwner) reasonCodes.push('direct_address_resolves_to_owner');
  } else if (fragment.classification === 'non_substantive_fragment') {
    classification = 'non_substantive_fragment';
    reasonCodes.push(...fragment.reason_codes);
  } else if (secondPerson && uniqueNeighbor && !neighborIsOwner
    && ((before && after && String(before.speaker).toLocaleLowerCase() === String(after.speaker).toLocaleLowerCase())
      || followingNarrationConfirmsNeighbor)) {
    classification = 'owner_irrelevant';
    reasonCodes.push('direct_address_resolves_to_different_participant');
  } else {
    reasonCodes.push(contextOwnerMentions.length
      ? 'owner_participates_in_context_but_target_reference_is_ambiguous'
      : 'no_deterministic_owner_or_other_addressee_resolution');
  }

  return {
    schema_version: 1,
    classification,
    reason_codes: [...new Set(reasonCodes)],
    evidence: {
      owner_explicitly_mentioned: ownerMentioned,
      owner_is_speaker: speakerIsOwner,
      safely_resolved_owner_pronoun: safelyResolvedOwnerPronoun,
      second_person_address: secondPerson,
      resolved_neighbor_speaker: uniqueNeighbor,
      resolved_neighbor_is_owner: neighborIsOwner,
      following_narration_confirms_neighbor: followingNarrationConfirmsNeighbor,
      context_owner_mention_count: contextOwnerMentions.length,
      context_source_units_inspected: context.map((item) => String(item.unit_key)),
      standalone_proposition_detected: fragment.standalone_proposition_detected,
      fragment_word_count: fragment.word_count,
    },
    local_no_update_validated: ['owner_irrelevant', 'non_substantive_fragment'].includes(classification),
  };
}

/** Builds bounded discourse context while keeping only the target unit citable. */
export function buildRecoverySourceUnits(sourceMessages, rangeStart = 0, fingerprint = null) {
  const base = (sourceMessages ?? []).map((message, index) => {
    const sourceIndex = message.__sme_original_index ?? rangeStart + index;
    const rawText = String(message.mes ?? '');
    const namedReferences = [...new Set((rawText.match(/\b\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*/gu) ?? [])
      .map((item) => item.toLocaleLowerCase()))];
    return {
      unit_key: String(sourceIndex), citation_index: index,
      speaker: String(message.name ?? 'Unknown'), is_user: message.is_user === true,
      raw_text: rawText,
      text: `${message.name ?? 'Unknown'}: ${message.mes ?? ''}`,
      source_fingerprint: typeof fingerprint === 'function' ? fingerprint([message]) : null,
      context_source_range: { start: sourceIndex, end: sourceIndex, message_count: 1 },
      context_message_count: 1,
      multiple_people_mentioned: namedReferences.length > 1,
    };
  });
  return base.map((unit, index) => {
    const context = base.slice(Math.max(0, index - 2), Math.min(base.length, index + 3));
    const indexes = context.map((item) => Number(item.unit_key)).filter(Number.isInteger);
    return {
      ...unit,
      context_units: context.map((item) => ({
        unit_key: item.unit_key, speaker: item.speaker, is_user: item.is_user,
        raw_text: item.raw_text,
        multiple_people_mentioned: item.multiple_people_mentioned,
      })),
      context_source_range: indexes.length
        ? { start: Math.min(...indexes), end: Math.max(...indexes), message_count: indexes.length }
        : unit.context_source_range,
      context_message_count: context.length,
    };
  });
}
