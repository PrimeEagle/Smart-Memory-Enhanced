import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContinuityFactBlocks, validateContinuityRepair } from '../continuity-utils.js';

const estimate = (text) => String(text).length;
const preflight = (prompt) => ({ fits: prompt.length <= 30, estimated_input_tokens: prompt.length, usable_input_tokens: 30 });

test('continuity fact selection is deterministic and retains priority diversity under budget pressure', () => {
  const result = selectContinuityFactBlocks([
    { source: 'character_card', text: 'card facts', count: 1 },
    { source: 'persona', text: 'persona facts', count: 1 },
    { source: 'summary', text: 'summary facts', count: 1 },
    { source: 'longterm', text: 'long durable fact that will not fit', count: 1 },
  ], { buildPrompt: (facts) => facts, estimateTokens: estimate, preflight });
  assert.deepEqual(result.selected.map((entry) => entry.source), ['character_card', 'persona']);
  assert.deepEqual(result.excluded.map((entry) => entry.source), ['summary', 'longterm']);
  assert.equal(result.preflight.fits, true);
});

test('continuity preflight prevents requests when even the minimum useful source cannot fit', () => {
  const result = selectContinuityFactBlocks([{ source: 'character_card', text: 'too large for this tiny budget', count: 1 }], {
    buildPrompt: (facts) => facts, estimateTokens: estimate,
    preflight: (prompt) => ({ fits: prompt.length <= 3, estimated_input_tokens: prompt.length, usable_input_tokens: 3 }),
  });
  assert.equal(result.facts, '');
  assert.equal(result.preflight.fits, true);
  assert.equal(result.selected.length, 0);
});

test('continuity repair validation rejects empty and overlong notes without retaining prose', () => {
  assert.deepEqual(validateContinuityRepair('', estimate), { valid: false, reason: 'empty_repair' });
  assert.equal(validateContinuityRepair('x'.repeat(1201), estimate).reason, 'repair_character_cap_exceeded');
  assert.equal(validateContinuityRepair('Correction: retain the established fact.', estimate).valid, true);
});
