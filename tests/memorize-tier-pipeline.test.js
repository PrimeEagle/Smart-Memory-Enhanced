import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import {
  createMemorizeTierPipeline,
  createTierContextOverflowError,
  recordTierCoverage,
} from '../memorize-tier-pipeline.js';

const makePipeline = ({ range = { start: 10, end: 19, message_count: 10, source_indices: [10, 11] }, rootRange = null } = {}) => {
  const transitions = [];
  const execution = createMemorizeExecutionContext({
    provider: {
      root_obligation_id: 'session:chat:0-19:root',
      root_source_range: rootRange ?? range,
      root_source_fingerprint: 'root-fingerprint',
    },
    hooks: { obligation_event: async (transition) => transitions.push(transition) },
  });
  const coverageLedger = { records: [] };
  const pipeline = createMemorizeTierPipeline({
    tier: 'session', tierLabel: 'Session', execution, metadata: {}, range,
    rangeId: `session:${range.start}-${range.end}`, coverageLedger,
    sourceFingerprint: 'leaf-fingerprint', preflight: {
      configured_context_limit: 8192, effective_context_limit: 8192,
      reserved_output_tokens: 1000, safety_margin_tokens: 128,
      protocol_overhead_tokens: 256, estimated_input_tokens: 400,
    }, requestBudget: {}, providerConfigSignature: 'provider-signature',
    chatId: 'chat', expectedOutputFormat: 'session-v1',
  });
  return { pipeline, coverageLedger, transitions };
};

test('shared tier pipeline derives one root and exact recovery-leaf identity', () => {
  const { pipeline } = makePipeline({
    range: { start: 10, end: 14, message_count: 5, source_indices: [10, 11] },
    rootRange: { start: 0, end: 19, message_count: 20 },
  });
  assert.equal(pipeline.rootObligationId, 'session:chat:0-19:root');
  assert.equal(pipeline.leafObligationId, 'session:chat:0-19:root:leaf:10-14:leaf-fingerprint');
  assert.equal(pipeline.isRecoveryLeaf, true);
});

test('coverage projection merges repeated writes and becomes terminal only explicitly', () => {
  const { pipeline, coverageLedger } = makePipeline();
  pipeline.recordCoverage({ provider_outcome: 'provider_running' });
  pipeline.recordCompletedCoverage('completed_and_persisted');
  assert.equal(coverageLedger.records.length, 1);
  assert.equal(coverageLedger.records[0].provider_outcome, 'completed_and_persisted');
  assert.equal(coverageLedger.records[0].coverage_terminal_state, 'completed');
  assert.equal(coverageLedger.records[0].all_source_messages_covered, true);
  assert.equal(coverageLedger.records[0].citation_mapping_valid, true);
});

test('obligation events and context-overflow errors retain exact tier range', async () => {
  const { pipeline, transitions } = makePipeline();
  await pipeline.emitLifecycleEvent('provider_attempt_started', { provider_attempt_id: 'attempt-1' });
  assert.equal(transitions[0].obligation_id, pipeline.leafObligationId);
  assert.deepEqual(transitions[0].source_range, { start: 10, end: 19, message_count: 10 });
  const error = createTierContextOverflowError('Session', { estimated_input_tokens: 9000 }, pipeline.range);
  assert.equal(error.code, 'SME_ESTIMATED_CONTEXT_OVERFLOW');
  assert.equal(error.sme_request_diagnostics.source_start_index, 10);
  assert.equal(error.sme_request_diagnostics.source_end_index, 19);
});

test('coverage helper does not duplicate a stable range identity', () => {
  const ledger = { records: [] };
  recordTierCoverage(ledger, { range_id: 'one', provider_outcome: 'running' });
  recordTierCoverage(ledger, { range_id: 'one', provider_outcome: 'completed' });
  assert.deepEqual(ledger.records, [{ range_id: 'one', provider_outcome: 'completed' }]);
});
