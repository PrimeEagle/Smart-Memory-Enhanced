import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpenAiResponseEnvelope } from '../provider-response-utils.js';

test('OpenAI-compatible response envelopes distinguish every empty response shape', () => {
  assert.equal(classifyOpenAiResponseEnvelope({ bodyPresent: false }).classification, 'no_response_body');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [] } }).classification, 'empty_choices');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [{}] } }).classification, 'missing_message');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [{ message: {} }] } }).classification, 'missing_content_field');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [{ message: { content: null } }] } }).classification, 'null_content');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [{ message: { content: '' } }] } }).classification, 'empty_string_content');
  assert.equal(classifyOpenAiResponseEnvelope({ data: { choices: [{ message: { content: '  ' } }] } }).classification, 'whitespace_only_content');
});

test('provider errors and streams without content deltas remain distinct', () => {
  const error = classifyOpenAiResponseEnvelope({ data: { error: { code: 'model_error' } } });
  assert.equal(error.classification, 'provider_error_envelope');
  assert.equal(error.normalized_provider_error_code, 'model_error');
  const stream = classifyOpenAiResponseEnvelope({ streaming: true, bodyPresent: true, streamEventCount: 3, contentDeltaCount: 0 });
  assert.equal(stream.classification, 'stream_no_content_deltas');
  assert.equal(stream.streaming_chunk_count, 3);
  assert.equal(stream.content_delta_observed, false);
});
