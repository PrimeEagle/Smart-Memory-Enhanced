/** Conservative deterministic checks for high-risk resolved arc summaries. */

const HIGH_RISK = /\b(?:mother|father|parent|married|marriage|romance|lover|abuse|abused|died|death|pregnan|roommates?|roommate|high school|college|for years|after months|owned|ownership|injur(?:y|ed)|criminal|crime|allegiance)\b/i;
const UNSUPPORTED_NEGATION = /\b(?:did not|never|failed to|could not)\b/i;
const UNRESOLVED_RESTATEMENT = /\b(?:remains? unresolved|still unresolved|continues? to be unresolved|still open|has not been resolved)\b/i;
const COLLECTIVE_PSEUDO_ENTITY = /\b(?:the group|everyone|everybody|the team|the party)\b/i;

function namesIn(text) {
  return [...String(text ?? '').matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)].map((match) => match[0]);
}

/**
 * Does not try to prove a paraphrase correct. It rejects a candidate only for
 * a named person absent from the canonical allowlist, and rejects predictable
 * template language before an expensive semantic verifier is requested.
 */
export function preverifyArcSummary(candidate, evidence = {}) {
  const allowed = new Set([
    ...(evidence.canonicalParticipants ?? []),
    ...(evidence.structuredParticipants ?? []),
  ].map((name) => String(name).toLowerCase()));
  const introduced = namesIn(candidate).filter((name) => !allowed.has(name.toLowerCase()));
  if (introduced.length) return { semantic_support: 'unsupported', reason: `Introduced named participant(s): ${introduced.join(', ')}.`, reason_code: 'unknown_name', introduced };
  if (UNRESOLVED_RESTATEMENT.test(candidate)) return { semantic_support: 'unsupported', reason: 'Restates an unresolved arc instead of a resolution.', reason_code: 'unresolved_restatement', introduced: [] };
  if (UNSUPPORTED_NEGATION.test(candidate) && !UNSUPPORTED_NEGATION.test(evidence.text ?? '')) return { semantic_support: 'unsupported', reason: 'States a negative outcome not explicitly present in the evidence.', reason_code: 'unsupported_negation', introduced: [] };
  if (/\b(?:for example|e\.g\.|example name)\b/i.test(candidate)) return { semantic_support: 'unsupported', reason: 'Contains example or template language.', reason_code: 'template_language', introduced: [] };
  if (COLLECTIVE_PSEUDO_ENTITY.test(candidate) && !COLLECTIVE_PSEUDO_ENTITY.test(evidence.text ?? '')) return { semantic_support: 'unsupported', reason: 'Introduces a collective pseudo-entity.', reason_code: 'collective_entity', introduced: [] };
  if (HIGH_RISK.test(candidate) && !HIGH_RISK.test(evidence.text ?? '')) {
    return { semantic_support: 'unsupported', reason: 'Contains a high-risk claim not found in the evidence text.', reason_code: 'high_risk_claim', introduced: [] };
  }
  return { semantic_support: 'not_checked', reason: null, reason_code: null, introduced: [] };
}
