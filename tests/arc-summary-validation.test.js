import test from 'node:test';
import assert from 'node:assert/strict';
import { preverifyArcSummary } from '../arc-summary-validation.js';

const evidence = {
  canonicalParticipants: ['Kyle Holland', 'Alissa Kawaguchi', 'Paul Schmidt'],
  structuredParticipants: ['Kyle Holland', 'Alissa Kawaguchi'],
  text: 'Kyle Holland and Alissa Kawaguchi discuss relationship boundaries and agree on next steps.',
};

test('arc summary pre-verification rejects invented people', () => {
  const result = preverifyArcSummary('John, Emma, and Mike resolve the conflict.', evidence);
  assert.equal(result.semantic_support, 'unsupported');
  assert.match(result.reason, /John/);
});

test('arc summary pre-verification accepts supported paraphrase for semantic review', () => {
  const result = preverifyArcSummary('Kyle Holland and Alissa Kawaguchi agree on how to proceed.', evidence);
  assert.equal(result.semantic_support, 'not_checked');
});

test('arc summary pre-verification flags unsupported high-risk detail', () => {
  const result = preverifyArcSummary('Kyle Holland and Paul Schmidt reconcile as roommates.', evidence);
  assert.equal(result.semantic_support, 'unsupported');
  assert.equal(result.reason_code, 'high_risk_claim');
});

test('arc summary pre-verification rejects unresolved restatements and unsupported negation', () => {
  assert.equal(preverifyArcSummary('Alissa Kawaguchi remains unresolved about the plan.', evidence).reason_code, 'unresolved_restatement');
  assert.equal(preverifyArcSummary('Kyle Holland failed to keep the promise.', evidence).reason_code, 'unsupported_negation');
});
