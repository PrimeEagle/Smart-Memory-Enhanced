import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyContextOverflow,
  extractionRecoveryChildKey,
  isEstimatedContextOverflow,
  makeExtractionPreflight,
  partitionSourceWindow,
  resolveEffectiveContextLimit,
  sourceRange,
  sourceWindowFingerprint,
  summarizeExtractionCoverage,
} from '../extraction-window-utils.js';

const tokens = (text) => Math.ceil(String(text).length / 4);
const promptFor = (messages) => `instruction framing\n${messages.map((message) => message.mes).join('\n')}`;

test('preflight uses final rendered input plus reserved output and safety margin', () => {
  const preflight = makeExtractionPreflight({
    prompt: 'x'.repeat(34_001),
    estimateTokens: tokens,
    configuredContextLimit: 10_000,
    reservedOutputTokens: 600,
    safetyMargin: 1_000,
  });
  assert.equal(preflight.usable_input_tokens, 8_144);
  assert.equal(preflight.fits, false);
});

test('partitioning preserves ordered source indices without overlap or loss', () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({
    __sme_original_index: 100 + index,
    mes: 'x'.repeat(1_900),
  }));
  const check = (prompt) => makeExtractionPreflight({
    prompt,
    estimateTokens: tokens,
    configuredContextLimit: 2_400,
    reservedOutputTokens: 500,
    safetyMargin: 200,
  });
  const result = partitionSourceWindow(messages, promptFor, check);
  assert.equal(result.oversized.length, 0);
  const recovered = result.partitions.flat().map((message) => message.__sme_original_index);
  assert.deepEqual(recovered, messages.map((message) => message.__sme_original_index));
  assert.equal(new Set(recovered).size, messages.length);
  assert.ok(result.partitions.every((part) => check(promptFor(part)).fits));
});

test('an oversized individual message is explicit rather than silently dropped', () => {
  const messages = [
    { __sme_original_index: 1, mes: 'small' },
    { __sme_original_index: 2, mes: 'x'.repeat(20_000) },
    { __sme_original_index: 3, mes: 'small' },
  ];
  const check = (prompt) => makeExtractionPreflight({
    prompt,
    estimateTokens: tokens,
    configuredContextLimit: 1_800,
    reservedOutputTokens: 400,
    safetyMargin: 200,
  });
  const result = partitionSourceWindow(messages, promptFor, check);
  assert.deepEqual(result.oversized.flat().map((message) => message.__sme_original_index), [2]);
  assert.deepEqual(result.partitions.flat().map((message) => message.__sme_original_index), [1, 3]);
});

test('only provider 400 estimated context overflows qualify for bounded repartitioning', () => {
  assert.equal(isEstimatedContextOverflow({ sme_request_diagnostics: { http_status: 400, likely_cause: 'estimated_context_overflow' } }), true);
  assert.equal(isEstimatedContextOverflow({ sme_request_diagnostics: { http_status: 400, likely_cause: 'bad_request' } }), false);
  assert.equal(isEstimatedContextOverflow({ sme_request_diagnostics: { http_status: 429, likely_cause: 'estimated_context_overflow' } }), false);
});

test('structured wrapped provider overflow learns the runtime context ceiling', () => {
  const inner = new Error('Bad Request');
  inner.status = 400;
  inner.body = JSON.stringify({
    error: { code: 400, type: 'exceed_context_size_error' },
    n_prompt_tokens: 10_896,
    n_ctx: 10_240,
  });
  const outer = new Error('API request failed', { cause: inner });
  const result = classifyContextOverflow(outer, {
    provider: 'connection_profile',
    configuredContextLimit: 84_500,
    effectiveContextLimitBefore: 84_500,
  });
  assert.equal(result.classification, 'context_overflow');
  assert.equal(result.classification_source, 'structured_provider_error');
  assert.equal(result.normalized_provider_error_code, 'exceed_context_size_error');
  assert.equal(result.reported_prompt_tokens, 10_896);
  assert.equal(result.reported_context_tokens, 10_240);
  assert.equal(result.effective_context_limit_after, 10_240);
  assert.equal(result.retryable_after_repartition, true);
  assert.equal(JSON.stringify(result).includes('Bad Request'), false);
});

test('structured non-overflow bad requests are not reclassified from generic wrapper text', () => {
  const error = new Error('API request failed');
  error.status = 400;
  error.data = { error: { type: 'invalid_request_error', code: 'unsupported_parameter' } };
  assert.equal(classifyContextOverflow(error), null);
});

test('effective context limit is the smallest trustworthy ceiling', () => {
  assert.equal(resolveEffectiveContextLimit(84_500, 32_768, 10_240), 10_240);
  assert.equal(resolveEffectiveContextLimit(84_500, null, undefined), 84_500);
});

test('recovery source fingerprints are ordered, stable, and content-sensitive', () => {
  const source = [
    { __sme_original_index: 7, name: 'A', mes: 'one' },
    { __sme_original_index: 8, name: 'B', mes: 'two' },
  ];
  assert.equal(sourceWindowFingerprint(source), sourceWindowFingerprint(structuredClone(source)));
  assert.notEqual(sourceWindowFingerprint(source), sourceWindowFingerprint([...source].reverse()));
  assert.notEqual(sourceWindowFingerprint(source), sourceWindowFingerprint([{ ...source[0], mes: 'changed' }, source[1]]));
  assert.equal(extractionRecoveryChildKey('longterm', 'Alex Mercer', source), extractionRecoveryChildKey('longterm', 'Alex Mercer', structuredClone(source)));
  assert.notEqual(extractionRecoveryChildKey('longterm', 'Alex Mercer', source), extractionRecoveryChildKey('longterm', 'Aster Graves', source));
});

test('coverage distinguishes stable repartitioning from an unresolved source window', () => {
  const records = [
    { range_id: 'longterm:a', parent_range_id: null, coverage_terminal_state: 'repartitioned_completed' },
    { range_id: 'longterm:b', parent_range_id: null, coverage_terminal_state: 'unresolved_context_overflow' },
    { range_id: 'longterm:b-child', parent_range_id: 'longterm:b', coverage_terminal_state: 'completed' },
  ];
  assert.deepEqual(summarizeExtractionCoverage(records), {
    original_ranges: 2,
    completed_ranges: 1,
    unresolved_ranges: 1,
    coverage_complete: false,
    unresolved_range_ids: ['longterm:b'],
  });
  assert.deepEqual(sourceRange([{ __sme_original_index: 7 }, { __sme_original_index: 9 }]), {
    start: 7,
    end: 9,
    message_count: 2,
    source_indices: [7, 9],
  });
});
