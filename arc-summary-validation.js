/** Conservative deterministic checks for high-risk resolved arc summaries. */

const HIGH_RISK = /\b(?:mother|father|parent|married|marriage|romance|lover|abuse|abused|died|death|pregnan|roommates?|roommate|high school|college|for years|after months|owned|ownership|injur(?:y|ed)|criminal|crime|allegiance)\b/i;

function namesIn(text) {
  return [...String(text ?? '').matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)].map((match) => match[0]);
}

/**
 * Does not try to prove a paraphrase correct. It rejects a candidate only for
 * a named person absent from the explicit evidence allowlist, and marks
 * unsupported high-risk language ambiguous for the semantic verifier.
 */
export function preverifyArcSummary(candidate, evidence = {}) {
  const allowed = new Set([
    ...(evidence.canonicalParticipants ?? []),
    ...(evidence.structuredParticipants ?? []),
    ...namesIn(evidence.text ?? ''),
  ].map((name) => String(name).toLowerCase()));
  const introduced = namesIn(candidate).filter((name) => !allowed.has(name.toLowerCase()));
  if (introduced.length) return { semantic_support: 'unsupported', reason: `Introduced named participant(s): ${introduced.join(', ')}.`, introduced };
  if (HIGH_RISK.test(candidate) && !HIGH_RISK.test(evidence.text ?? '')) {
    return { semantic_support: 'ambiguous', reason: 'Contains a high-risk claim not found in the evidence text.', introduced: [] };
  }
  return { semantic_support: 'not_checked', reason: null, introduced: [] };
}
