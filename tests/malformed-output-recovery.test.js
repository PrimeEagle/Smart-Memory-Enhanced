import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractionOutput, parseSessionOutput } from '../parsers.js';
import {
  MALFORMED_RECOVERY_LIMITS,
  analyzeMalformedResponse,
  buildCompactFormatRepairPrompt,
  classifyTaggedResponseFailure,
  consumeMalformedRecoveryRequest,
  createMalformedRecoveryBudget,
  malformedChildCoverageComplete,
  normalizeTaggedMemoryOutput,
  partitionMalformedSourceWindow,
  recoverMalformedTaggedOutput,
} from '../malformed-output-recovery.js';

const validLongterm = '[fact:2:permanent:sources=0] The garden gate is locked.';
const validSession = '[detail:2:session:sources=0] The garden gate is currently locked.';

function auditHarness() {
  const events = [];
  let next = 0;
  return {
    events,
    beginAttempt(requestKind, changed, recovery) {
      const event = { attempt_id: `attempt-${++next}`, requestKind, changed, recovery };
      events.push(event);
      return event;
    },
    finishAttempt(attempt, patch) {
      assert.equal(attempt.finished, undefined, 'a physical attempt must finish exactly once');
      attempt.finished = patch;
    },
  };
}

test('privacy-safe structural classifier distinguishes malformed response families', () => {
  assert.equal(classifyTaggedResponseFailure('   '), 'empty_or_whitespace_response');
  assert.equal(classifyTaggedResponseFailure('<think>Only reasoning</think>'), 'reasoning_only_response');
  assert.equal(classifyTaggedResponseFailure('{"items":['), 'truncated_json');
  assert.equal(classifyTaggedResponseFailure('{"items":[] }'), 'json_returned_instead_of_tagged_records');
  assert.equal(classifyTaggedResponseFailure('{"unexpected":"shape"}'), 'valid_json_with_unsupported_schema');
  assert.equal(classifyTaggedResponseFailure('[fact:2:permanent The gate'), 'truncated_tagged_record');
  assert.equal(classifyTaggedResponseFailure('[unsupported:2:permanent] text'), 'unsupported_memory_type');
  assert.equal(classifyTaggedResponseFailure(validLongterm, { tier: 'longterm', finishReason: 'length' }), 'output_length_truncation');
  const shape = analyzeMalformedResponse(`Preface\n${validLongterm}`, { tier: 'longterm' });
  assert.equal(shape.valid_tagged_record_count, 1);
  assert.equal(shape.prose_before_structure, true);
  assert.equal(JSON.stringify(shape).includes('garden gate'), false);
});

test('local normalization handles fences, escaped newlines, bullets, prose, and supported JSON conservatively', () => {
  const cases = [
    `\`\`\`text\n${validLongterm}\n\`\`\``,
    `${validLongterm}\\n[preference:1:permanent:sources=0] Rowan likes tea.`,
    `- ${validLongterm}`,
    `Here are results:\n${validLongterm}\nThat is all.`,
    JSON.stringify([{ type: 'fact', importance: 2, expiration: 'permanent', content: 'The garden gate is locked.', source_indices: [0] }]),
  ];
  for (const response of cases) {
    const result = normalizeTaggedMemoryOutput(response, { tier: 'longterm', parse: parseExtractionOutput });
    assert.equal(result.succeeded, true, response);
    assert.ok(result.records.length >= 1);
  }
  const ambiguous = normalizeTaggedMemoryOutput(JSON.stringify([
    { type: 'fact', content: 'Supported complete record.' },
    { unknown: 'ambiguous record' },
  ]), { tier: 'longterm', parse: parseExtractionOutput });
  assert.equal(ambiguous.succeeded, false);
  assert.equal(ambiguous.ambiguous_conversion_rejected, true);
});

test('compact repair prompt repairs the malformed response rather than rerunning the source prompt', () => {
  const prompt = buildCompactFormatRepairPrompt('broken tagged output', { tier: 'session' });
  assert.match(prompt, /MALFORMED OUTPUT BEGIN/);
  assert.match(prompt, /broken tagged output/);
  assert.match(prompt, /REPAIR_FAILED/);
  assert.doesNotMatch(prompt, /numbered source messages/i);
});

test('recovery accepts local normalization without another provider request', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  let calls = 0;
  const result = await recoverMalformedTaggedOutput({
    response: `\`\`\`\n${validLongterm}\n\`\`\``, tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => { calls++; return 'NONE'; }, originalPrompt: 'source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'local_normalization');
  assert.equal(calls, 0);
  assert.equal(original.finished.terminal_outcome, 'completed');
});

test('recovery uses one compact response repair and records its changed dimension', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  const prompts = [];
  const result = await recoverMalformedTaggedOutput({
    response: 'I could not format this.', tier: 'longterm', parse: parseExtractionOutput,
    generate: async (prompt) => { prompts.push(prompt); return validLongterm; },
    originalPrompt: 'ORIGINAL SOURCE PROMPT', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'compact_response_repair');
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /ORIGINAL SOURCE PROMPT/);
  assert.deepEqual(audit.events[0].changed, ['malformed_response_input', 'compact_repair_prompt']);
});

test('repair failure changes dimension before regeneration and supports session parity', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  const replies = ['REPAIR_FAILED', validSession];
  const result = await recoverMalformedTaggedOutput({
    response: '{bad json', tier: 'session', parse: parseSessionOutput,
    generate: async () => replies.shift(), originalPrompt: 'numbered session source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'changed_dimension_regeneration');
  assert.equal(audit.events.length, 2);
  assert.deepEqual(audit.events[1].changed, ['minimal_output_prompt', 'deterministic_fresh_generation']);
  assert.equal(audit.events.every((event) => event.finished), true);
});

test('provider exception remains distinct from malformed output and does not double-finish attempts', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  let call = 0;
  const result = await recoverMalformedTaggedOutput({
    response: 'prose only', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => { call++; if (call === 1) throw new Error('transport'); return validLongterm; },
    originalPrompt: 'source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'changed_dimension_regeneration');
  assert.equal(audit.events[0].finished.terminal_outcome, 'provider_failure');
  assert.equal(audit.events[1].finished.terminal_outcome, 'completed');
});

test('deterministic malformed repartition is 20 to 10 to 5 and stops at the floor', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ mes: `m${index}` }));
  const first = partitionMalformedSourceWindow(messages);
  assert.deepEqual(first.map((child) => child.length), [10, 10]);
  assert.deepEqual(partitionMalformedSourceWindow(first[0]).map((child) => child.length), [5, 5]);
  assert.deepEqual(partitionMalformedSourceWindow(first[0].slice(0, 5)), []);
  assert.equal(malformedChildCoverageComplete(['left', 'right'], ['left', 'right']), true);
  assert.equal(malformedChildCoverageComplete(['left', 'right'], ['left']), false);
});

test('exhausted repair and regeneration delegates once to the bounded split callback', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  let splits = 0;
  const budget = createMalformedRecoveryBudget();
  const result = await recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => 'still bad', originalPrompt: 'source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    budget, splitWindow: async ({ nextDepth, parentAttemptId }) => {
      splits++; assert.equal(nextDepth, 1); assert.equal(parentAttemptId, 'attempt-2');
      return { completed: true, added: 3 };
    },
  });
  assert.equal(result.repartitioned, true);
  assert.equal(result.added, 3);
  assert.equal(splits, 1);
  assert.equal(budget.additional_provider_requests, 2);
  assert.equal(MALFORMED_RECOVERY_LIMITS.maximum_split_depth, 2);
});

test('bounded terminal failure is explicit when every recovery stage is exhausted', async () => {
  const audit = auditHarness();
  await assert.rejects(recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => 'bad', originalPrompt: 'source', responseLength: 100,
    originalAttempt: { attempt_id: 'original' }, beginAttempt: audit.beginAttempt,
    finishAttempt: audit.finishAttempt, splitDepth: MALFORMED_RECOVERY_LIMITS.maximum_split_depth,
  }), (error) => error.code === 'SME_MALFORMED_PROVIDER_OUTPUT'
    && error.sme_request_diagnostics.recovery_stage_exhausted === 'bounded_recovery_exhausted');
});

test('request and wall-time caps stop additional recovery work deterministically', () => {
  const requestBudget = createMalformedRecoveryBudget(null, 100);
  requestBudget.additional_provider_requests = MALFORMED_RECOVERY_LIMITS.maximum_additional_provider_requests;
  assert.equal(consumeMalformedRecoveryRequest(requestBudget, 'format_repair', 101).reason, 'recovery_request_limit_exhausted');
  const timeBudget = createMalformedRecoveryBudget(null, 100);
  assert.equal(consumeMalformedRecoveryRequest(timeBudget, 'format_repair',
    100 + MALFORMED_RECOVERY_LIMITS.maximum_wall_time_ms + 1).reason, 'recovery_wall_time_exhausted');
});
