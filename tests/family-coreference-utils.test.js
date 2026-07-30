import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBoundedFamilyCoreferenceCandidates } from '../family-coreference-utils.js';

test('direct named kinship address establishes a parent role', () => {
  const facts = extractBoundedFamilyCoreferenceCandidates([
    { mes: 'Taylor Covington looked at Richard Covington. "Dad."', __sme_original_index: 12 },
  ]);
  assert.deepEqual(facts.map(({ subject, target, relationship_type, evidence_pattern, evidence_strength }) => ({ subject, target, relationship_type, evidence_pattern, evidence_strength })), [
    { subject: 'Richard Covington', target: 'Taylor Covington', relationship_type: 'father', evidence_pattern: 'direct_address_kinship', evidence_strength: 'direct' },
  ]);
});

test('narrative mother-daughter apposition preserves direction without name-based gender inference', () => {
  const facts = extractBoundedFamilyCoreferenceCandidates([
    { mes: 'Margaret Covington looked at Kyler Covington. Something passed between mother and daughter.', __sme_original_index: 21 },
  ]);
  assert.deepEqual(facts.map(({ subject, target, relationship_type }) => ({ subject, target, relationship_type })), [
    { subject: 'Margaret Covington', target: 'Kyler Covington', relationship_type: 'mother' },
    { subject: 'Kyler Covington', target: 'Margaret Covington', relationship_type: 'daughter' },
  ]);
});

test('joint Mom/Dad address maps roles from the address grammar, not the names', () => {
  const facts = extractBoundedFamilyCoreferenceCandidates([
    { mes: 'Margaret and Richard Covington entered. Taylor Covington said, "Mom, Dad, you remember Aaron."', __sme_original_index: 35 },
  ]);
  assert.deepEqual(facts.map(({ subject, target, relationship_type }) => ({ subject, target, relationship_type })), [
    { subject: 'Margaret Covington', target: 'Taylor Covington', relationship_type: 'mother' },
    { subject: 'Richard Covington', target: 'Taylor Covington', relationship_type: 'father' },
  ]);
});

test('does not resolve a remote, ambiguous, or surname-only family reference', () => {
  const facts = extractBoundedFamilyCoreferenceCandidates([
    { mes: 'Taylor Covington and Kyler Covington waited in silence.' },
    { mes: 'Much later, their parents might visit.' },
    { mes: 'Margaret Covington and Richard Covington own a house.' },
  ]);
  assert.deepEqual(facts, []);
});
