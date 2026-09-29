import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectOpenAiSsePayload, summarizeOpenAiStreamEvents, shouldFallbackFromEmptyDirectStream, runAuthorizedEmptyStreamFallback } from '../provider-stream-utils.js';

test('SSE diagnostics distinguish DONE-only, empty, null-content, reasoning, usage, and embedded errors', () => {
  assert.equal(inspectOpenAiSsePayload('[DONE]', 1).summary.classification, 'done_sentinel');
  assert.equal(inspectOpenAiSsePayload('', 2).summary.classification, 'empty_data_event');
  assert.equal(inspectOpenAiSsePayload('{"choices":[{"delta":{"content":null}}]}', 3).summary.classification, 'choices_delta_null_content');
  assert.equal(inspectOpenAiSsePayload('{"choices":[{"delta":{"reasoning_content":"private"}}]}', 4).summary.classification, 'choices_reasoning_only');
  assert.equal(inspectOpenAiSsePayload('{"usage":{"prompt_tokens":10}}', 5).summary.classification, 'usage_only');
  const error = inspectOpenAiSsePayload('{"error":{"code":"model_error","message":"nope"}}', 6);
  assert.equal(error.summary.classification, 'provider_error_event');
  assert.equal(error.summary.normalized_error_code, 'model_error');
  assert.doesNotMatch(JSON.stringify(error.summary), /private|nope/);
});

test('empty direct-stream fallback is bounded by explicit permission and HTTP 200', () => {
  const input = { directStream: true, httpStatus: 200, output: '', contentDeltaCount: 0 };
  assert.equal(shouldFallbackFromEmptyDirectStream({ ...input, permitted: true }), true);
  assert.equal(shouldFallbackFromEmptyDirectStream({ ...input, permitted: false }), false);
  assert.equal(shouldFallbackFromEmptyDirectStream({ ...input, httpStatus: 500, permitted: true }), false);
  assert.equal(shouldFallbackFromEmptyDirectStream({ ...input, output: 'content', permitted: true }), false);
});

test('authorized fallback invokes the alternate transport exactly once and prohibited fallback never invokes it', async () => {
  let calls = 0;
  const input = { directStream: true, httpStatus: 200, output: '', contentDeltaCount: 0 };
  const recovered = await runAuthorizedEmptyStreamFallback({ ...input, permitted: true }, async () => { calls++; return 'proxy-response'; });
  assert.deepEqual(recovered, { used: true, response: 'proxy-response' });
  assert.equal(calls, 1);
  const prohibited = await runAuthorizedEmptyStreamFallback({ ...input, permitted: false }, async () => { calls++; });
  assert.deepEqual(prohibited, { used: false, response: null });
  assert.equal(calls, 1);
});

test('alternate text is content-bearing while malformed JSON remains diagnosable', () => {
  const alternate = inspectOpenAiSsePayload('{"choices":[{"text":"answer"}]}', 1);
  assert.equal(alternate.summary.classification, 'adapter_alternate_content_field');
  assert.equal(alternate.summary.alternate_content_field, 'choices[0].text');
  assert.equal(alternate.summary.content_bearing, true);
  assert.equal(inspectOpenAiSsePayload('{bad', 2).summary.json_parse_state, 'invalid_json');
  const audit = summarizeOpenAiStreamEvents([alternate.summary], 30, { adapter_alternate_content_field: 1 });
  assert.equal(audit.history_truncated, true);
  assert.equal(audit.retained_event_limit, 24);
});
