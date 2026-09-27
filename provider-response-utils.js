/** Privacy-safe interpretation of an OpenAI-compatible response envelope. */
export function classifyOpenAiResponseEnvelope({
  bodyPresent = true, data = null, streaming = false,
  streamEventCount = 0, contentDeltaCount = 0, streamOutput = '',
} = {}) {
  if (streaming) {
    const output = typeof streamOutput === 'string' ? streamOutput : '';
    return {
      classification: contentDeltaCount > 0
        ? (output.trim() ? 'stream_content' : 'stream_whitespace_only')
        : 'stream_no_content_deltas',
      response_envelope_present: bodyPresent,
      response_top_level_type: 'event_stream',
      provider_error_envelope_present: false,
      normalized_provider_error_code: null,
      choices_array_present: null, choices_length: null,
      message_object_present: null, content_field_present: null, content_field_type: null,
      content_length: output.length,
      streaming_chunk_count: Number(streamEventCount) || 0,
      content_delta_observed: Number(contentDeltaCount) > 0,
    };
  }

  const topLevelType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
  const error = data && typeof data === 'object' ? data.error : null;
  const choicesPresent = Array.isArray(data?.choices);
  const message = choicesPresent ? data.choices[0]?.message : null;
  const messagePresent = Boolean(message && typeof message === 'object');
  const contentPresent = messagePresent && Object.hasOwn(message, 'content');
  const content = contentPresent ? message.content : undefined;
  const contentType = contentPresent ? (content === null ? 'null' : typeof content) : null;
  const output = typeof content === 'string' ? content : '';
  let classification;
  if (!bodyPresent) classification = 'no_response_body';
  else if (error) classification = 'provider_error_envelope';
  else if (!choicesPresent) classification = 'missing_choices';
  else if (data.choices.length === 0) classification = 'empty_choices';
  else if (!messagePresent) classification = 'missing_message';
  else if (!contentPresent) classification = 'missing_content_field';
  else if (content === null) classification = 'null_content';
  else if (typeof content !== 'string') classification = 'non_string_content';
  else if (content.length === 0) classification = 'empty_string_content';
  else if (content.trim().length === 0) classification = 'whitespace_only_content';
  else classification = 'content_string';

  return {
    classification,
    response_envelope_present: bodyPresent,
    response_top_level_type: topLevelType,
    provider_error_envelope_present: Boolean(error),
    normalized_provider_error_code: error?.code ?? error?.type ?? (error ? 'provider_error' : null),
    choices_array_present: choicesPresent,
    choices_length: choicesPresent ? data.choices.length : null,
    message_object_present: messagePresent,
    content_field_present: contentPresent,
    content_field_type: contentType,
    content_length: output.length,
    streaming_chunk_count: null,
    content_delta_observed: null,
  };
}
