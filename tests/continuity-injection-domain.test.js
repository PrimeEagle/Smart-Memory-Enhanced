import test from 'node:test';
import assert from 'node:assert/strict';

import { createContinuityOutcome } from '../continuity-outcome.js';
import { createInjectionTierBreakdown, createUnifiedInjectionPlan,
  projectUnifiedInjectionDiagnostics } from '../injection-read-model.js';
import { createDiagnosticError } from '../memorize-domain-dtos.js';
import { assertSerializableDomain } from '../serializable-domain.js';

test('Continuity Check publishes a canonical plain-data provider failure', () => {
  const root = Object.assign(new Error('provider unavailable'), {
    code: 'SME_PROVIDER_UNAVAILABLE', sme_failure_stage: 'continuity_provider',
  });
  const outcome = createContinuityOutcome({
    outcome: 'provider_failure', contradictions: [], attention: true,
    event_id: 'continuity-1', diagnostic_error: createDiagnosticError(root),
  });
  assert.equal(outcome.diagnostic_error.code, 'SME_PROVIDER_UNAVAILABLE');
  assert.equal(outcome.diagnostic_error.failure_stage, 'continuity_provider');
  assert.equal(Object.isFrozen(outcome), true);
  assert.doesNotThrow(() => assertSerializableDomain(outcome));
});

test('Continuity Check rejects unknown outcomes and runtime diagnostic values', () => {
  assert.throws(() => createContinuityOutcome({ outcome: 'maybe' }), {
    code: 'SME_INVALID_CONTINUITY_OUTCOME',
  });
  assert.throws(() => createContinuityOutcome({
    outcome: 'clean', diagnostic_error: new Error('runtime value'),
  }), { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
});

test('unified injection exposes an immutable validated token breakdown', () => {
  const breakdown = createInjectionTierBreakdown([
    { key: 'longterm', label: 'Long-term', color: '#fff', tokens: 12.9 },
  ]);
  assert.deepEqual(breakdown, [{ key: 'longterm', label: 'Long-term',
    color: '#fff', tokens: 12 }]);
  assert.equal(Object.isFrozen(breakdown), true);
  assert.equal(Object.isFrozen(breakdown[0]), true);
  assert.throws(() => createInjectionTierBreakdown([
    { key: 'session', label: 'Session', tokens: Infinity },
  ]), { code: 'SME_INVALID_INJECTION_READ_MODEL' });
});

test('unified injection plans selection, deduplication, placement, and provenance before effects', () => {
  const plan = createUnifiedInjectionPlan({
    candidates: [
      { key: 'session', label: 'Session', color: '#222', rank: 2,
        content: 'same private content', tokens: 4, provenance: 'cached_prompt_slot' },
      { key: 'canon', label: 'Canon', color: '#111', rank: 0,
        content: 'same private content', tokens: 4, provenance: 'fresh_prompt_slot' },
      { key: 'arcs', label: 'Arcs', color: '#333', rank: 3,
        content: '', tokens: 0, provenance: 'empty' },
      { key: 'short', label: 'Short-term', color: '#444', rank: 1,
        content: 'different private content', tokens: 7, provenance: 'fresh_prompt_slot' },
    ],
    placement: { position: 2, depth: 4, role: 0 },
    macro_active: false,
  });
  assert.deepEqual(plan.selected.map((item) => item.key), ['canon', 'short']);
  assert.equal(plan.target, 'extension_prompt');
  assert.equal(plan.diagnostics.budget.selected_tokens, 11);
  assert.equal(plan.diagnostics.candidates.find((item) => item.key === 'session').rejection_reason,
    'duplicate_content');
  assert.equal(plan.diagnostics.candidates.find((item) => item.key === 'arcs').rejection_reason,
    'empty_content');
  assert.equal(JSON.stringify(plan.diagnostics).includes('private content'), false);
  assert.equal(Object.isFrozen(plan.selected), true);
  assert.doesNotThrow(() => assertSerializableDomain(plan));
});

test('unified injection diagnostics are content-free and malformed candidates fail precisely', () => {
  const diagnostics = projectUnifiedInjectionDiagnostics(null);
  assert.equal(diagnostics.target, 'cleared');
  assert.equal(diagnostics.budget.selected_tokens, 0);
  assert.throws(() => createUnifiedInjectionPlan({
    candidates: [{ key: 'x', label: 'X', rank: 0, content: 'value', tokens: Infinity,
      provenance: 'fresh_prompt_slot' }],
    placement: { position: 2, depth: 0, role: 0 },
  }), {
    code: 'SME_INVALID_INJECTION_READ_MODEL',
    sme_serialization_path: '$.unified_injection.candidates[0]',
  });
});
