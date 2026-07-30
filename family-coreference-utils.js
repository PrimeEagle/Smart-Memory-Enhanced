/**
 * Deterministic, bounded family-coreference extraction.  This module never
 * guesses from surnames, names, summaries, or long-range pronouns: every
 * promoted candidate carries the small local source span that established it.
 */

const FAMILY_ROLES = new Set(['parent', 'mother', 'father', 'daughter', 'son', 'sibling', 'sister', 'brother']);

function sourceIndex(message, fallback) {
  return Number.isInteger(message?.__sme_original_index) ? message.__sme_original_index : fallback;
}

function textOf(message) {
  return String(message?.mes ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sharedSurnamePair(text) {
  const match = String(text).match(/\b([A-Z][\w'-]+)\s+and\s+([A-Z][\w'-]+)\s+([A-Z][\w'-]+)\b/);
  return match ? [`${match[1]} ${match[3]}`, `${match[2]} ${match[3]}`] : [];
}

function nearestCapitalizedName(text) {
  const ignored = new Set(['Her', 'His', 'She', 'He', 'They', 'The', 'A', 'An', 'Mom', 'Dad']);
  const matches = [...String(text ?? '').matchAll(/\b([A-Z][\w'-]*)\b/g)]
    .map((match) => match[1])
    .filter((name) => !ignored.has(name));
  return matches.at(-1)?.replace(/'s$/i, '') ?? null;
}

function addCandidate(output, candidate) {
  if (!FAMILY_ROLES.has(candidate.relationship_type)) return;
  const key = [candidate.subject.toLowerCase(), candidate.target.toLowerCase(), candidate.relationship_type,
    candidate.evidence_pattern, candidate.source_message_indices.join(',')].join('|');
  if (!output.some((entry) => entry.observation_id === key)) output.push({ ...candidate, observation_id: key });
}

/**
 * Extracts only strong, immediate family references with named participants.
 * The optional caller is responsible for canonical identity resolution and
 * durable persistence; this function intentionally does neither.
 */
export function extractBoundedFamilyCoreferenceCandidates(messages = []) {
  const candidates = [];
  for (let index = 0; index < messages.length; index++) {
    const current = textOf(messages[index]);
    if (!current) continue;
    const currentIndex = sourceIndex(messages[index], index);

    // Direct address with explicit speaker and addressee in the same local
    // statement: "Taylor looked at Richard. Dad." No pronoun resolution.
    for (const match of current.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:looked at|said to|turned to|addressed)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)[\s\S]{0,180}?["“']\s*(Mom|Dad)\b/g)) {
      addCandidate(candidates, {
        subject: match[2], target: match[1], relationship_type: match[3].toLowerCase() === 'mom' ? 'mother' : 'father',
        source_message_indices: [currentIndex], evidence_window_size: 1, evidence_pattern: 'direct_address_kinship',
        evidence_strength: 'direct', speaker_resolved: true, addressee_resolved: true, possessor_resolved: false,
      });
    }

    // Explicit narrative apposition with both participants named locally.
    for (const match of current.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:looked at|looked toward|turned to|watched)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)[\s\S]{0,220}?\bmother and daughter\b/g)) {
      addCandidate(candidates, {
        subject: match[1], target: match[2], relationship_type: 'mother',
        source_message_indices: [currentIndex], evidence_window_size: 1, evidence_pattern: 'narrative_kinship_apposition',
        evidence_strength: 'direct', speaker_resolved: false, addressee_resolved: false, possessor_resolved: false,
      });
      addCandidate(candidates, {
        subject: match[2], target: match[1], relationship_type: 'daughter',
        source_message_indices: [currentIndex], evidence_window_size: 1, evidence_pattern: 'narrative_kinship_apposition',
        evidence_strength: 'direct', speaker_resolved: false, addressee_resolved: false, possessor_resolved: false,
      });
    }

    // A named pair followed in the same message by an unambiguous, ordered
    // Mom/Dad direct address. Roles derive from the address terms and their
    // grammar, never from either person's name or shared surname.
    const pair = sharedSurnamePair(current);
    if (pair.length === 2 && /\bMom\b[\s\S]{0,360}\bDad\b/i.test(current)) {
      const localSpeakers = [];
      for (const match of current.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:said|says|called)[^.]{0,120}["“']Mom\s*,\s*Dad[,.!"”']/g)) {
        localSpeakers.push(match[1]);
      }
      // "Mom, Dad," she said: the nearest named participant before the
      // quote supplies the speaker only within this same message.
      for (const match of current.matchAll(/["“']Mom\s*,\s*Dad[,.!"”'][\s\S]{0,90}?\b(?:she|he)\s+(?:said|asked|called)\b/g)) {
        const speaker = nearestCapitalizedName(current.slice(Math.max(0, match.index - 220), match.index));
        if (speaker) localSpeakers.push(speaker);
      }
      // "Mom," Kyler said ... "Dad": the name immediately attached to the
      // first direct address is an equally local, syntactic speaker binding.
      for (const match of current.matchAll(/["“']Mom,["”']?[^.]{0,100}?\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:said|asked|called)\b[\s\S]{0,260}?["“']Dad\b/g)) {
        localSpeakers.push(match[1]);
      }
      const uniqueSpeakers = [...new Set(localSpeakers.map((name) => name.trim()).filter((name) => !pair.includes(name)))];
      for (const child of uniqueSpeakers) {
        addCandidate(candidates, {
          subject: pair[0], target: child, relationship_type: 'mother',
          source_message_indices: [currentIndex], evidence_window_size: 1, evidence_pattern: 'direct_address_kinship',
          evidence_strength: 'direct', speaker_resolved: true, addressee_resolved: true, possessor_resolved: false,
        });
        addCandidate(candidates, {
          subject: pair[1], target: child, relationship_type: 'father',
          source_message_indices: [currentIndex], evidence_window_size: 1, evidence_pattern: 'direct_address_kinship',
          evidence_strength: 'direct', speaker_resolved: true, addressee_resolved: true, possessor_resolved: false,
        });
      }
    }

    // Adjacent generic introduction is only provisional. It requires the
    // parent phrase and exactly one syntactically linked named pair in the
    // immediately next message; without a named possessor it remains absent.
    if (/\b(?:her|his) parents\s+(?:walked in|entered|arrived|came in)\b/i.test(current)) {
      const next = messages[index + 1];
      const nextPair = sharedSurnamePair(textOf(next));
      const prior = textOf(messages[index - 1]);
      const possessor = [...prior.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b/g)].map((match) => match[1]).at(-1);
      if (nextPair.length === 2 && possessor && !nextPair.includes(possessor)) {
        for (const parent of nextPair) addCandidate(candidates, {
          subject: parent, target: possessor, relationship_type: 'parent',
          source_message_indices: [currentIndex, sourceIndex(next, index + 1)], evidence_window_size: 2,
          evidence_pattern: 'adjacent_family_introduction', evidence_strength: 'provisional',
          speaker_resolved: false, addressee_resolved: false, possessor_resolved: true,
        });
      }
    }
  }
  return candidates;
}
