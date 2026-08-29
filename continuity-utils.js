/** Pure, privacy-safe helpers for Continuity Check selection and repairs. */

export const CONTINUITY_MAX_REPAIR_CHARS = 1200;
export const CONTINUITY_MAX_REPAIR_TOKENS = 250;

/**
 * Selects fact blocks in caller-provided priority order without serializing
 * their text into diagnostics. Each block is all-or-nothing so a selected
 * source remains interpretable and deterministic.
 */
export function selectContinuityFactBlocks(blocks, { buildPrompt, estimateTokens, preflight }) {
  const selected = [];
  const excluded = [];
  for (const block of blocks) {
    const candidate = [...selected, block];
    if (preflight(buildPrompt(candidate.map((item) => item.text).join('\n\n'))).fits) selected.push(block);
    else excluded.push(block);
  }
  const facts = selected.map((block) => block.text).join('\n\n');
  const result = preflight(buildPrompt(facts));
  return {
    facts,
    preflight: result,
    selected: selected.map((block) => ({ source: block.source, count: block.count, estimated_tokens: estimateTokens(block.text) })),
    excluded: excluded.map((block) => ({ source: block.source, count: block.count, estimated_tokens: estimateTokens(block.text) })),
  };
}

export function validateContinuityRepair(note, estimateTokens) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) return { valid: false, reason: 'empty_repair' };
  if (text.length > CONTINUITY_MAX_REPAIR_CHARS) return { valid: false, reason: 'repair_character_cap_exceeded' };
  if (estimateTokens(text) > CONTINUITY_MAX_REPAIR_TOKENS) return { valid: false, reason: 'repair_token_cap_exceeded' };
  if (/^(?:none|null|n\/a|no repair)\.?$/i.test(text)) return { valid: false, reason: 'unusable_repair' };
  return { valid: true, note: text, estimated_tokens: estimateTokens(text) };
}
