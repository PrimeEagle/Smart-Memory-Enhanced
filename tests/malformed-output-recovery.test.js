import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseExtractionOutput, parseSessionOutput } from '../parsers.js';
import {
  MALFORMED_RECOVERY_LIMITS,
  analyzeMalformedResponse,
  buildChangedDimensionRegenerationPrompt,
  buildCompactFormatRepairPrompt,
  buildMinimalRecordRegenerationPrompt,
  buildSingleSourceUnitRegenerationPrompt,
  buildStructuredJsonRegenerationPrompt,
  classifyTaggedResponseFailure,
  consumeMalformedRecoveryRequest,
  createMalformedRecoveryBudget,
  detectRecoveryResponseFormat,
  malformedChildCoverageComplete,
  normalizeTaggedMemoryOutput,
  partitionMalformedSourceWindow,
  parseSingleSourceUnitResponse,
  recoverMalformedTaggedOutput,
  routeMalformedTaggedRecovery,
} from '../malformed-output-recovery.js';
import { deriveRecoveryStageEligibility } from '../recovery-stage-eligibility.js';

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

test('modifier diagnostics expose subtype counts and normalize only unambiguous syntax', () => {
  const safeResponse = '[fact:2:permanent:source=01;2] A supported durable claim.';
  const safeShape = analyzeMalformedResponse(safeResponse, { tier: 'longterm' });
  assert.equal(safeShape.modifier_locally_normalizable_count, 1);
  assert.equal(safeShape.modifier_normalization_subtype_counts.normalize_source_list_delimiter, 1);
  const normalized = normalizeTaggedMemoryOutput(safeResponse, { tier: 'longterm', parse: parseExtractionOutput });
  assert.match(normalized.normalized_text, /:sources=1,2\]/);
  assert.equal(parseExtractionOutput(normalized.normalized_text).length, 1);

  const ambiguousResponse = '[fact:2:permanent:sources=1:sources=2] An ambiguous durable claim.';
  const ambiguousShape = analyzeMalformedResponse(ambiguousResponse, { tier: 'longterm' });
  assert.equal(ambiguousShape.modifier_failure_subtype_counts.duplicate_source_modifier, 1);
  assert.equal(normalizeTaggedMemoryOutput(ambiguousResponse, { tier: 'longterm', parse: parseExtractionOutput }).succeeded, false);
  assert.equal(JSON.stringify(ambiguousShape).includes('ambiguous durable claim'), false);
});

test('missing source citations remain explicit and are never invented by local normalization', () => {
  const response = '[fact:2:permanent] A durable claim without a citation.';
  const shape = analyzeMalformedResponse(response, { tier: 'longterm' });
  assert.equal(shape.modifier_missing_source_citation_count, 1);
  const normalized = normalizeTaggedMemoryOutput(response, { tier: 'longterm', parse: parseExtractionOutput });
  assert.equal(normalized.succeeded, false);
  assert.doesNotMatch(response, /sources=/);
  assert.equal(parseExtractionOutput(response)[0].grounding_status, 'ungrounded');
});

test('valid plus rejected tagged fragments is a reconciled partial, not total parse failure', () => {
  const response = `${validLongterm}\n[unsupported:2] A rejected but structurally distinct fragment.`;
  const shape = analyzeMalformedResponse(response, { tier: 'longterm' });
  assert.equal(shape.parser_accepted_record_count, 1);
  assert.equal(shape.structurally_rejected_record_count, 1);
  assert.equal(shape.unclassified_fragment_count, 0);
  assert.equal(shape.parser_shape_counts_reconciled, true);
  assert.equal(classifyTaggedResponseFailure(response, { tier: 'longterm' }), 'partial_valid_output');
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
  assert.equal(original.finished.malformed_reason, null);
  assert.match(original.finished.notice_reason, /^local_normalization:/);
  assert.equal(original.finished.response_shape.normalization_accepted_record_count, 1);
});

test('response without a recoverable tagged claim skips compact repair and regenerates', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  const prompts = [];
  const result = await recoverMalformedTaggedOutput({
    response: 'I could not format this.', tier: 'longterm', parse: parseExtractionOutput,
    generate: async (prompt) => { prompts.push(prompt); return validLongterm; },
    originalPrompt: 'ORIGINAL SOURCE PROMPT', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'changed_dimension_regeneration');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /ORIGINAL SOURCE PROMPT/);
  assert.deepEqual(audit.events[0].changed, ['minimal_output_prompt', 'deterministic_fresh_generation']);
});

test('recovery output contracts follow the original prompt so local models cannot override them', () => {
  const original = 'ORIGINAL PROMPT\nReturn a legacy shape.';
  const tagged = buildChangedDimensionRegenerationPrompt(original, { tier: 'longterm' });
  const json = buildStructuredJsonRegenerationPrompt(original, { tier: 'session' });
  assert.ok(tagged.indexOf('ORIGINAL PROMPT') < tagged.indexOf('RECOVERY MODE — FINAL OUTPUT CONTRACT'));
  assert.ok(json.indexOf('ORIGINAL PROMPT') < json.indexOf('FINAL MINIMUM-WINDOW RECOVERY — JSON ONLY'));
  assert.match(json, /sources is mandatory/);
  const minimal = buildMinimalRecordRegenerationPrompt(original, { tier: 'session' });
  assert.match(minimal, /exactly one complete supported record/i);
  assert.match(minimal, /sources=0/);
});

test('minimum-window recovery changes representation to cited JSON before pausing the run', async () => {
  const audit = auditHarness();
  const replies = [
    '[fact:2:permanent:unsupported=value:sources=1] Still malformed output.',
    '[{"type":"fact","content":"A cited recovered claim.","importance":2,"expiration":"permanent","entities":[],"sources":[1]}]',
  ];
  const result = await recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => replies.shift(), originalPrompt: 'numbered source', responseLength: 100,
    originalAttempt: { attempt_id: 'original' }, beginAttempt: audit.beginAttempt,
    finishAttempt: audit.finishAttempt, splitWindow: async () => ({ completed: false,
      reason: 'minimum_malformed_recovery_window_reached' }),
  });
  assert.equal(result.stage, 'structured_json_regeneration');
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].source_message_indices, [1]);
  assert.equal(audit.events.at(-1).requestKind, 'structured_json_regeneration');
  assert.deepEqual(audit.events.at(-1).changed, ['structured_json_schema', 'minimum_window_terminal_rescue']);
});

test('JSON rescue accepts fully valid tagged fallback without weakening strict parsing', async () => {
  const audit = auditHarness();
  const replies = ['bad', validLongterm];
  const result = await recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => replies.shift(), originalPrompt: 'numbered source', responseLength: 100,
    originalAttempt: { attempt_id: 'original' }, beginAttempt: audit.beginAttempt,
    finishAttempt: audit.finishAttempt, splitWindow: async () => ({ completed: false }),
  });
  assert.equal(result.stage, 'structured_json_regeneration');
  assert.equal(result.records.length, 1);
  assert.equal(result.response_contract_violated, true);
  const event = audit.events.at(-1).finished;
  assert.equal(event.requested_output_format, 'longterm_json_records_v1');
  assert.equal(event.actual_output_format, 'tagged_lines');
  assert.equal(event.parser_selected, 'strict_tagged_fallback_after_json_contract_violation');
  assert.equal(event.output_contract_followed, false);
  assert.equal(detectRecoveryResponseFormat(validLongterm, { tier: 'longterm' }), 'tagged_lines');
});

test('partial tagged output from JSON rescue preserves valid records and retries only unresolved output', async () => {
  const audit = auditHarness();
  const partial = `${validSession}\n[detail:2:session:unknown=value:sources=0] Broken fragment.`;
  const replies = ['still bad', partial, 'NONE'];
  const result = await recoverMalformedTaggedOutput({
    response: 'bad', tier: 'session', parse: parseSessionOutput,
    generate: async () => replies.shift(), originalPrompt: 'numbered source', responseLength: 100,
    originalAttempt: { attempt_id: 'original' }, beginAttempt: audit.beginAttempt,
    finishAttempt: audit.finishAttempt, splitWindow: async () => ({ completed: false }),
  });
  assert.equal(result.stage, 'minimal_record_regeneration');
  assert.equal(result.records.length, 1);
  const jsonAttempt = audit.events.find((event) => event.requestKind === 'structured_json_regeneration').finished;
  assert.equal(jsonAttempt.terminal_outcome, 'partial_output_pending');
  assert.equal(jsonAttempt.accepted_candidate_count, 1);
  assert.equal(jsonAttempt.rejected_candidate_count, 1);
  assert.equal(jsonAttempt.missing_required_results, true);
  const minimalAttempt = audit.events.at(-1).finished;
  assert.equal(minimalAttempt.obligation_closure_reason, 'explicit_no_additional_supported_record');
  assert.equal(minimalAttempt.accepted_partial_output_persisted, true);
});

test('resume skips exhausted intermediate recovery stages and selects the new minimal contract', async () => {
  const audit = auditHarness();
  const prompts = [];
  const original = {
    attempt_id: 'original', resumed_pending_obligation: true,
    prior_recovery_stages_attempted: ['strict_generation', 'changed_dimension_regeneration', 'structured_json_regeneration'],
  };
  const result = await recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async (prompt) => { prompts.push(prompt); return validLongterm; },
    originalPrompt: 'numbered source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    splitWindow: async () => ({ completed: false }),
  });
  assert.equal(result.stage, 'minimal_record_regeneration');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /ONE SIMPLE RECORD/);
  assert.equal(audit.events[0].requestKind, 'minimal_record_regeneration');
});

test('resume never repeats an already exhausted minimum-record recovery stage', async () => {
  const audit = auditHarness();
  let providerCalls = 0;
  await assert.rejects(() => recoverMalformedTaggedOutput({
    response: 'same malformed replay response', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => { providerCalls += 1; return validLongterm; },
    originalPrompt: 'numbered source', responseLength: 100,
    originalAttempt: {
      attempt_id: 'original', resumed_pending_obligation: true,
      prior_recovery_stages_attempted: [
        'strict_generation', 'changed_dimension_regeneration',
        'structured_json_regeneration', 'minimal_record_regeneration',
      ],
    },
    beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    splitWindow: async () => ({ completed: false }),
  }), (error) => error?.code === 'SME_RECOVERY_PATH_EXHAUSTED' && error?.sme_recovery_blocked === true);
  assert.equal(providerCalls, 0);
  assert.equal(audit.events.length, 0);
});

test('sanitized v0.9.61 replay shape selects only the unresolved minimum-window recovery dimension', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/v0961-minimum-window-resume-loop.json', import.meta.url), 'utf8'));
  assert.equal(fixture.safely_committed_count, 20);
  assert.equal(fixture.safe_longterm_siblings.length, 5);
  assert.deepEqual(fixture.unresolved_obligations.map((item) => item.tier), ['longterm', 'session']);
  for (const obligation of fixture.unresolved_obligations) {
    const audit = auditHarness();
    const parse = obligation.tier === 'session' ? parseSessionOutput : parseExtractionOutput;
    const valid = obligation.tier === 'session' ? validSession : validLongterm;
    const prompts = [];
    const result = await recoverMalformedTaggedOutput({
      response: 'malformed replay response', tier: obligation.tier, parse,
      generate: async (prompt) => { prompts.push(prompt); return valid; },
      originalPrompt: 'sanitized numbered messages 38-39', responseLength: 100,
      originalAttempt: {
        attempt_id: `${obligation.tier}-resume`, resumed_pending_obligation: true,
        prior_recovery_stages_attempted: obligation.stages,
      },
      beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
      splitWindow: async () => ({ completed: false }),
    });
    assert.equal(result.stage, 'minimal_record_regeneration');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /ONE SIMPLE RECORD/);
  }
});

test('compact repair is reserved for malformed tagged records with usable claim content', () => {
  const eligible = routeMalformedTaggedRecovery(' [fact:2] A sufficiently complete claim.', { tier: 'longterm' });
  assert.equal(eligible.route, 'compact_response_repair');
  assert.equal(eligible.recoverable_claim_fragment_count, 1);
  const ineligible = routeMalformedTaggedRecovery('I could not format this.', { tier: 'longterm' });
  assert.equal(ineligible.route, 'changed_dimension_regeneration');
  assert.equal(ineligible.avoided_repair_reason, 'no_recoverable_claim_content');
});

test('repair failure changes dimension before regeneration and supports session parity', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  const replies = [validSession];
  const result = await recoverMalformedTaggedOutput({
    response: '{bad json', tier: 'session', parse: parseSessionOutput,
    generate: async () => replies.shift(), originalPrompt: 'numbered session source', responseLength: 100,
    originalAttempt: original, beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
  });
  assert.equal(result.stage, 'changed_dimension_regeneration');
  assert.equal(audit.events.length, 1);
  assert.deepEqual(audit.events[0].changed, ['minimal_output_prompt', 'deterministic_fresh_generation']);
  assert.equal(audit.events.every((event) => event.finished), true);
});

test('provider exception remains distinct from malformed output and does not double-finish attempts', async () => {
  const audit = auditHarness();
  const original = { attempt_id: 'original' };
  let call = 0;
  const result = await recoverMalformedTaggedOutput({
    response: ' [fact:2] A sufficiently complete claim.', tier: 'longterm', parse: parseExtractionOutput,
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
      splits++; assert.equal(nextDepth, 1); assert.equal(parentAttemptId, 'attempt-1');
      return { completed: true, added: 3 };
    },
  });
  assert.equal(result.repartitioned, true);
  assert.equal(result.added, 3);
  assert.equal(splits, 1);
  assert.equal(budget.additional_provider_requests, 1);
  assert.equal(MALFORMED_RECOVERY_LIMITS.maximum_split_depth, 2);
});

test('bounded terminal failure is explicit when every recovery stage is exhausted', async () => {
  const audit = auditHarness();
  await assert.rejects(recoverMalformedTaggedOutput({
    response: 'bad', tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => 'bad', originalPrompt: 'source', responseLength: 100,
    originalAttempt: { attempt_id: 'original' }, beginAttempt: audit.beginAttempt,
    finishAttempt: audit.finishAttempt, splitDepth: MALFORMED_RECOVERY_LIMITS.maximum_split_depth,
  }), (error) => error.code === 'SME_RECOVERY_PATH_EXHAUSTED'
    && error.sme_recovery_blocked === true
    && error.sme_request_diagnostics.recovery_stage_exhausted === 'bounded_recovery_exhausted');
});

test('post-minimal eligibility advances only to the one-source-unit contract', () => {
  const eligibility = deriveRecoveryStageEligibility({
    recovery_stages_attempted: ['minimal_record_regeneration'],
    exhausted_stages: ['minimal_record_regeneration'],
    unresolved_semantic_units: ['65', '66'],
  });
  assert.equal(eligibility.blocked, false);
  assert.equal(eligibility.eligible_action, 'single_source_unit_regeneration');
  assert.equal(eligibility.replay_permission, 'changed_recovery_dimension');
});

test('sanitized v0.9.62 Nyx window ignores sibling partials and advances beyond exhausted minimal', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL(
    './fixtures/v0962-nyx-terminal-recovery-window.json', import.meta.url), 'utf8'));
  const eligibility = deriveRecoveryStageEligibility({
    recovery_stages_attempted: fixture.recovery_stages_attempted,
    exhausted_stages: fixture.exhausted_stages,
    accepted_partial_record_count: fixture.accepted_partial_record_count_for_child,
    unresolved_semantic_units: ['65', '66', '67', '68', '69'],
  });
  assert.equal(fixture.root_obligation_id, 'longterm:nyx watson:60-79:fnv1a-11a50c71');
  assert.equal(fixture.child_source_fingerprint, 'fnv1a-5fba3507');
  assert.equal(eligibility.eligible_action, 'single_source_unit_regeneration');
  assert.equal(eligibility.accepted_partial_record_count, 0);
  assert.notEqual(eligibility.accepted_partial_record_count,
    fixture.successful_sibling_range.accepted_partial_record_count);
});

test('single-source fallback stages one valid record and one explicit NONE without replaying minimal', async () => {
  const audit = auditHarness();
  const staged = [];
  const prompts = [];
  const responses = [validLongterm, 'NONE'];
  const result = await recoverMalformedTaggedOutput({
    response: null, tier: 'longterm', parse: parseExtractionOutput,
    generate: async (prompt) => { prompts.push(prompt); return responses.shift(); },
    originalPrompt: 'source', responseLength: 100,
    originalAttempt: { attempt_id: 'prior', logical_obligation_id: 'longterm:nyx:60-79:root' },
    beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    resumeState: {
      recovery_stages_attempted: ['minimal_record_regeneration'],
      exhausted_stages: ['minimal_record_regeneration'],
    },
    owner: 'Nyx Watson',
    sourceUnits: [
      { unit_key: '65', citation_index: 5, text: 'Nyx: The garden gate is locked.' },
      { unit_key: '66', citation_index: 6, text: 'Alex: Okay.' },
    ],
    stagePartialRecords: async (records, details) => staged.push({ records, details }),
  });
  assert.equal(prompts.length, 2, JSON.stringify({ result, events: audit.events, staged }));
  assert.match(prompts[0], /only the source message below is in scope/i);
  assert.equal(result.stage, 'single_source_unit_regeneration');
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].source_message_indices, [5]);
  assert.deepEqual(staged.map((item) => item.details.source_unit_key), ['65', '66']);
  assert.equal(staged[1].details.explicit_none, true);
  assert.equal(audit.events.every((event) => event.requestKind === 'single_source_unit_regeneration'), true);
});

test('single-source fallback skips already staged units and records actionable rejection reasons', async () => {
  const audit = auditHarness();
  let calls = 0;
  const result = await recoverMalformedTaggedOutput({
    response: null, tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => { calls++; return '[fact:2:permanent] Missing citation.'; },
    originalPrompt: 'source', responseLength: 100,
    originalAttempt: { attempt_id: 'prior', logical_obligation_id: 'longterm:nyx:60-79:root' },
    beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    resumeState: {
      recovery_stages_attempted: ['minimal_record_regeneration'],
      exhausted_stages: ['minimal_record_regeneration'],
      staged_partial_records: [parseExtractionOutput(validLongterm)[0]],
      completed_source_units: ['65'], accepted_partial_record_count: 1,
    },
    sourceUnits: [
      { unit_key: '65', citation_index: 0, text: 'Nyx: Prior staged unit.' },
      { unit_key: '66', citation_index: 1, text: 'Nyx: Remaining unit.' },
    ],
  });
  assert.equal(result.partial_unresolved, true, JSON.stringify({ result, events: audit.events }));
  assert.equal(result.terminal_error.code, 'SME_RECOVERY_PATH_EXHAUSTED');
  assert.equal(calls, 1);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].recovery.source_unit_key, '66');
  assert.ok(audit.events[0].finished.rejection_reasons.length > 0);
  assert.ok(audit.events[0].finished.candidate_rejections[0].candidate_fingerprint.startsWith('fnv1a-'));
});

test('single-source prompt is owner-scoped and contains no neighboring messages', () => {
  const prompt = buildSingleSourceUnitRegenerationPrompt(
    { unit_key: '65', text: 'Nyx: One bounded message.' }, { tier: 'longterm', owner: 'Nyx Watson' });
  assert.match(prompt, /Nyx Watson/);
  assert.match(prompt, /RECORD\|type\|0\|supported claim/);
  assert.doesNotMatch(prompt, /message 64|message 66/i);
});

test('single-source pipe contract reconstructs canonical records locally', () => {
  const result = parseSingleSourceUnitResponse('RECORD|fact|0|The garden gate is locked.', {
    tier: 'longterm', parse: parseExtractionOutput,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.parser_path, 'single_source_pipe_v2');
  assert.deepEqual(result.records[0].source_message_indices, [0]);
  assert.equal(result.contract.citation_requirement_followed, true);
});

test('safe optional modifier removal cannot invent or repair required citation evidence', () => {
  const safe = parseSingleSourceUnitResponse(
    '[fact:2:permanent:sources=0:optional-note] The garden gate is locked.',
    { tier: 'longterm', parse: parseExtractionOutput });
  assert.equal(safe.accepted, true);
  assert.equal(safe.normalization_result, 'accepted_after_safe_optional_modifier_removal');
  assert.deepEqual(safe.records[0].source_message_indices, [0]);

  const unsafe = parseSingleSourceUnitResponse(
    '[fact:2:permanent:optional-note] The garden gate is locked.',
    { tier: 'longterm', parse: parseExtractionOutput });
  assert.equal(unsafe.accepted, false);
  assert.equal(unsafe.contract.cardinality_followed, true);
  assert.equal(unsafe.contract.citation_requirement_followed, false);
  assert.deepEqual(unsafe.reason_codes.sort(), [
    'single_source_unit_requires_exact_local_citation', 'unknown_modifier_syntax',
  ]);
});

test('one blocked source unit does not prevent later siblings from completing', async () => {
  const audit = auditHarness();
  const responses = [
    '[fact:2:permanent] Missing citation.',
    'NONE',
    'RECORD|fact|0|The final sibling is independently supported.',
    'NONE',
    'RECORD|event|0|The fifth unit contains a supported durable event.',
  ];
  const staged = [];
  const result = await recoverMalformedTaggedOutput({
    response: null, tier: 'longterm', parse: parseExtractionOutput,
    generate: async () => responses.shift(), originalPrompt: 'source', responseLength: 100,
    originalAttempt: { attempt_id: 'prior', logical_obligation_id: 'longterm:lillian:80-84:root' },
    beginAttempt: audit.beginAttempt, finishAttempt: audit.finishAttempt,
    resumeState: { recovery_stages_attempted: ['minimal_record_regeneration'],
      exhausted_stages: ['minimal_record_regeneration'] },
    sourceUnits: [
      { unit_key: '80', citation_index: 0, text: 'Lillian: First.', source_fingerprint: 'unit-80',
        context_source_range: { start: 80, end: 80, message_count: 1 }, context_message_count: 1 },
      { unit_key: '81', citation_index: 1, text: 'Lillian: Second.', source_fingerprint: 'unit-81',
        context_source_range: { start: 81, end: 81, message_count: 1 }, context_message_count: 1 },
      { unit_key: '82', citation_index: 2, text: 'Lillian: Third.', source_fingerprint: 'unit-82',
        context_source_range: { start: 82, end: 82, message_count: 1 }, context_message_count: 1 },
      { unit_key: '83', citation_index: 3, text: 'Lillian: Fourth.', source_fingerprint: 'unit-83',
        context_source_range: { start: 83, end: 83, message_count: 1 }, context_message_count: 1 },
      { unit_key: '84', citation_index: 4, text: 'Lillian: Fifth.', source_fingerprint: 'unit-84',
        context_source_range: { start: 84, end: 84, message_count: 1 }, context_message_count: 1 },
    ],
    stagePartialRecords: async (records, details) => staged.push({ records, details }),
  });
  assert.equal(audit.events.length, 5);
  assert.deepEqual(audit.events.map((event) => event.recovery.source_unit_key), ['80', '81', '82', '83', '84']);
  assert.deepEqual(audit.events[0].recovery.context_source_range,
    { start: 80, end: 80, message_count: 1 });
  assert.equal(audit.events[0].recovery.context_message_count, 1);
  assert.equal(audit.events[0].recovery.context_only_messages_eligible, false);
  assert.equal(result.partial_unresolved, true);
  assert.deepEqual(result.blocked_source_units, ['80']);
  assert.deepEqual(result.validated_no_update_source_units, ['81', '83']);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0].source_message_indices, [2]);
  assert.deepEqual(result.records[1].source_message_indices, [4]);
  assert.deepEqual(staged.map((item) => item.details.source_unit_key), ['81', '82', '83', '84']);
  assert.equal(audit.events[0].finished.rejection_reasons
    .includes('single_source_unit_requires_exactly_one_record'), false);
});

test('sanitized v0.9.63 Lillian fixture preserves exact candidate and citation evidence', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL(
    './fixtures/v0963-lillian-per-unit-recovery.json', import.meta.url), 'utf8'));
  assert.equal(fixture.root_obligation_id, 'longterm:lillian kraft:80-99:fnv1a-b86f4be8');
  assert.equal(fixture.child_source_range.source_fingerprint, 'fnv1a-6a1ff517');
  assert.equal(fixture.observed_first_unit.structural_candidate_count, 1);
  assert.equal(fixture.observed_first_unit.citation_requirement_followed, true);
  assert.deepEqual(fixture.observed_first_unit.actual_citation_indexes, [0]);
  assert.equal(fixture.observed_first_unit.accepted_candidate_count
    + fixture.observed_first_unit.rejected_candidate_count,
  fixture.observed_first_unit.structural_candidate_count);
  assert.deepEqual(fixture.unattempted_units, ['81', '82', '83', '84']);
  assert.equal(fixture.raw_provider_output_included, false);
});

test('request and wall-time caps stop additional recovery work deterministically', () => {
  const requestBudget = createMalformedRecoveryBudget(null, 100);
  requestBudget.additional_provider_requests = MALFORMED_RECOVERY_LIMITS.maximum_additional_provider_requests;
  assert.equal(consumeMalformedRecoveryRequest(requestBudget, 'format_repair', 101).reason, 'recovery_request_limit_exhausted');
  const timeBudget = createMalformedRecoveryBudget(null, 100);
  assert.equal(consumeMalformedRecoveryRequest(timeBudget, 'format_repair',
    100 + MALFORMED_RECOVERY_LIMITS.maximum_wall_time_ms + 1).reason, 'recovery_wall_time_exhausted');
});
