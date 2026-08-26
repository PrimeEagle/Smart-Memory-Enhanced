import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEstimatedContextOverflow,
  makeExtractionPreflight,
  partitionSourceWindow,
  sourceRange,
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
  assert.equal(preflight.usable_input_tokens, 8_400);
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
