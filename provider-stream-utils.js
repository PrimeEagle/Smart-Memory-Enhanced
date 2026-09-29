/** Privacy-safe inspection of OpenAI-compatible SSE events. */
export const OPENAI_STREAM_EVENT_SAMPLE_LIMIT = 24;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function shapeOf(value) {
  if (Array.isArray(value)) return `array:${value.length}`;
  if (isObject(value)) return Object.keys(value).sort().slice(0, 16);
  if (value === null) return 'null';
  return typeof value;
}

export function inspectOpenAiSsePayload(payload, sequence, eventName = 'message') {
  const text = String(payload ?? '').trim();
  const base = {
    sequence,
    event_name: eventName || 'message',
    payload_shape: text ? 'unparsed' : 'empty',
    done: false,
    choices_present: false,
    choices_count: 0,
    delta_present: false,
    delta_shape: null,
    usage_present: false,
    error_present: false,
    normalized_error_code: null,
    json_parse_state: 'not_attempted',
    classification: 'empty_data_event',
    content_bearing: false,
    alternate_content_field: null,
  };
  if (!text) return { summary: eventName === 'keepalive_comment'
    ? { ...base, classification: 'server_keepalive' } : base };
  if (text === '[DONE]') return { summary: { ...base, done: true, payload_shape: 'done_sentinel', classification: 'done_sentinel' } };
  let data;
  try { data = JSON.parse(text); }
  catch {
    return { summary: { ...base, payload_shape: 'invalid_json_text', json_parse_state: 'invalid_json', classification: 'invalid_json_event' } };
  }
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const first = choices[0];
  const delta = isObject(first?.delta) ? first.delta : null;
  const content = typeof delta?.content === 'string' ? delta.content : '';
  const alternateField = typeof delta?.text === 'string' ? 'choices[0].delta.text'
    : typeof first?.text === 'string' ? 'choices[0].text'
      : typeof first?.message?.content === 'string' ? 'choices[0].message.content'
        : typeof data?.output_text === 'string' ? 'output_text'
          : typeof data?.content === 'string' ? 'content' : null;
  const alternate = alternateField === 'choices[0].delta.text' ? delta.text
    : alternateField === 'choices[0].text' ? first.text
      : alternateField === 'choices[0].message.content' ? first.message.content
        : alternateField === 'output_text' ? data.output_text
          : alternateField === 'content' ? data.content : '';
  const reasoningPresent = typeof delta?.reasoning === 'string'
    || typeof delta?.reasoning_content === 'string'
    || typeof delta?.analysis === 'string';
  const error = isObject(data?.error) ? data.error : null;
  let classification = 'unknown_json_event';
  if (error) classification = 'provider_error_event';
  else if (content) classification = 'choices_delta_content';
  else if (alternate) classification = 'adapter_alternate_content_field';
  else if (reasoningPresent) classification = 'choices_reasoning_only';
  else if (choices.length && delta && ('content' in delta) && delta.content == null) classification = 'choices_delta_null_content';
  else if (choices.length && !delta) classification = 'choices_missing_delta';
  else if (data?.usage) classification = 'usage_only';
  else if (isObject(data) && Object.keys(data).length === 0) classification = 'empty_object';
  return {
    summary: {
      ...base,
      payload_shape: shapeOf(data),
      choices_present: Array.isArray(data?.choices),
      choices_count: choices.length,
      delta_present: Boolean(delta),
      delta_shape: shapeOf(delta),
      usage_present: Boolean(data?.usage),
      error_present: Boolean(error),
      normalized_error_code: error?.code == null ? null : String(error.code).slice(0, 80),
      json_parse_state: 'parsed',
      classification,
      content_bearing: Boolean(content || alternate),
      alternate_content_field: alternateField,
    },
    content,
    alternate,
    finishReason: first?.finish_reason ?? null,
    usage: data?.usage ?? null,
    providerError: error ? { code: error.code ?? null, message: error.message ?? 'Provider stream error' } : null,
  };
}

export function summarizeOpenAiStreamEvents(events, totalEventCount, typeCounts) {
  return {
    schema_version: 1,
    retained_event_limit: OPENAI_STREAM_EVENT_SAMPLE_LIMIT,
    total_event_count: totalEventCount,
    retained_event_count: events.length,
    history_truncated: totalEventCount > events.length,
    event_type_counts: { ...typeCounts },
    events,
  };
}

export function shouldFallbackFromEmptyDirectStream({ directStream, httpStatus, output, contentDeltaCount, permitted }) {
  return Boolean(directStream && Number(httpStatus) === 200 && !String(output ?? '').length
    && Number(contentDeltaCount ?? 0) === 0 && permitted === true);
}

export async function runAuthorizedEmptyStreamFallback(input, fallbackRequest) {
  if (!shouldFallbackFromEmptyDirectStream(input)) return { used: false, response: null };
  return { used: true, response: await fallbackRequest() };
}
