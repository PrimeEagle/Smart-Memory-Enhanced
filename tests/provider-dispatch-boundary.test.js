import test from 'node:test';
import assert from 'node:assert/strict';

import { annotatePreTransmissionFailure }
  from '../provider-dispatch-boundary.js';

test('pre-transmission annotation preserves the root exception and forbids provider retry', () => {
  const root = Object.assign(new Error('checkpoint validation failed'), {
    code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA',
    sme_failure_stage: 'registration_publication',
    sme_serialization_path: '$.metadata.invalid',
  });

  const result = annotatePreTransmissionFailure(root);

  assert.equal(result, root);
  assert.equal(result.code, 'SME_NON_SERIALIZABLE_DOMAIN_DATA');
  assert.equal(result.sme_failure_stage, 'registration_publication');
  assert.equal(result.sme_serialization_path, '$.metadata.invalid');
  assert.equal(result.sme_provider_request_sent, false);
  assert.equal(result.sme_request_diagnostics.transport_started, false);
  assert.equal(result.sme_request_diagnostics.provider_call_required, false);
  assert.equal(result.sme_request_diagnostics.retry_eligible, false);
});

test('pre-transmission annotation creates a canonical local error for non-Error throws', () => {
  const result = annotatePreTransmissionFailure('storage rejected');
  assert.equal(result.code, 'SME_LOCAL_DISPATCH_PREPARATION_FAILED');
  assert.equal(result.sme_origin, 'local_execution');
  assert.equal(result.sme_failure_stage, 'provider_dispatch_publication');
  assert.equal(result.sme_provider_request_sent, false);
});
