import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContinuityFactBlocks, validateContinuityRepair } from '../continuity-utils.js';
import { createContinuityEvidenceSet, projectContinuityEvidenceSelection }
  from '../continuity-evidence.js';

const estimate = (text) => String(text).length;
const preflight = (prompt) => ({ fits: prompt.length <= 30, estimated_input_tokens: prompt.length, usable_input_tokens: 30 });
const evidence = (source, text, index) => ({ source, text, count: 1,
  evidence_id: `${source}:${index}`, source_identity: `${source}:owner`, record_type: source });

test('continuity fact selection is deterministic and retains priority diversity under budget pressure', () => {
  const result = selectContinuityFactBlocks([
    evidence('character_card', 'card facts', 1),
    evidence('persona', 'persona facts', 2),
    evidence('summary', 'summary facts', 3),
    evidence('longterm', 'long durable fact that will not fit', 4),
  ], { buildPrompt: (facts) => facts, estimateTokens: estimate, preflight });
  assert.deepEqual(result.selected.map((entry) => entry.source), ['character_card', 'persona']);
  assert.deepEqual(result.excluded.map((entry) => entry.source), ['summary', 'longterm']);
  assert.equal(result.preflight.fits, true);
});

test('continuity preflight prevents requests when even the minimum useful source cannot fit', () => {
  const result = selectContinuityFactBlocks([evidence('character_card', 'too large for this tiny budget', 1)], {
    buildPrompt: (facts) => facts, estimateTokens: estimate,
    preflight: (prompt) => ({ fits: prompt.length <= 3, estimated_input_tokens: prompt.length, usable_input_tokens: 3 }),
  });
  assert.equal(result.facts, '');
  assert.equal(result.preflight.fits, true);
  assert.equal(result.selected.length, 0);
});

test('continuity evidence uses unique canonical identities and content-free projections', () => {
  const records = createContinuityEvidenceSet([
    evidence('longterm', 'private established fact', 1),
    evidence('session', 'another private fact', 2),
  ]);
  const projection = projectContinuityEvidenceSelection(records, estimate);
  assert.deepEqual(projection.map((item) => item.evidence_id), ['longterm:1', 'session:2']);
  assert.equal(JSON.stringify(projection).includes('private established fact'), false);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.throws(() => createContinuityEvidenceSet([records[0], records[0]]), {
    code: 'SME_DUPLICATE_CONTINUITY_EVIDENCE',
  });
  assert.throws(() => createContinuityEvidenceSet([{
    ...evidence('longterm', 'fact', 1), evidence_id: undefined,
  }]), { code: 'SME_INVALID_CONTINUITY_EVIDENCE' });
});

test('continuity repair validation rejects empty and overlong notes without retaining prose', () => {
  assert.deepEqual(validateContinuityRepair('', estimate), { valid: false, reason: 'empty_repair' });
  assert.equal(validateContinuityRepair('x'.repeat(1201), estimate).reason, 'repair_character_cap_exceeded');
  assert.equal(validateContinuityRepair('Correction: retain the established fact.', estimate).valid, true);
});
