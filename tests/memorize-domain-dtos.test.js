import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSerializableDomain } from '../serializable-domain.js';
import {
  createStaleControllerAudit,
  createCompactFailureDiagnostics,
  createFullDiagnosticsExport,
  createUnresolvedObligationSummary,
  createControllerExit,
  createDiagnosticError,
  createProviderRegistrationReceipt,
  createTransactionSnapshot,
} from '../memorize-domain-dtos.js';

test('stale controller audit represents unavailable age without a numeric sentinel', () => {
  const audit = createStaleControllerAudit({ stale: true, age_ms: null,
    threshold_ms: 300000, blockers: [], await_point: null });
  assert.equal(audit.age_ms, null);
  assert.equal(audit.age_available, false);
  assert.equal(audit.age_status, 'unavailable_no_heartbeat');
  assert.doesNotThrow(() => assertSerializableDomain(audit));
});

test('unresolved canonical obligation derives stable root identity and null optionals', () => {
  const summary = createUnresolvedObligationSummary({
    obligation_id: 'session:0-19', tier: 'session', current_state: 'pending_recovery',
  });
  assert.equal(summary.root_obligation_id, 'session:0-19');
  assert.equal(summary.owner, null);
  assert.equal(summary.next_eligible_recovery_action, null);
  assert.deepEqual(summary.stages_attempted, []);
  assert.doesNotThrow(() => assertSerializableDomain(summary));
});

test('unresolved provider audit obligation normalizes alternate identity and arrays', () => {
  const summary = createUnresolvedObligationSummary({
    logical_obligation_id: 'longterm:owner:0-19', root_source_fingerprint: 'fp',
    recovery_stages_attempted: ['strict_generation', undefined, 'strict_generation'],
    candidate_rejections: [],
  });
  assert.equal(summary.obligation_id, 'longterm:owner:0-19');
  assert.equal(summary.root_obligation_id, 'longterm:owner:0-19');
  assert.deepEqual(summary.stages_attempted, ['strict_generation']);
  assert.equal(summary.source_fingerprint, 'fp');
});

test('unresolved obligation rejects missing mandatory identity before publication', () => {
  assert.throws(() => createUnresolvedObligationSummary({ tier: 'session' }), (error) => {
    assert.equal(error.code, 'SME_INVALID_DOMAIN_DTO');
    assert.equal(error.sme_serialization_path, '$.obligation_id');
    return true;
  });
});

test('DTO optional-value matrix never emits undefined or non-finite numbers', () => {
  for (const value of [undefined, null, Number.NaN, Infinity, -Infinity, 0, 4]) {
    const summary = createUnresolvedObligationSummary({
      obligation_id: 'obligation', parser_accepted_candidate_count: value,
      durable_partial_record_count: value,
      staged_partial_record_count: value, replay_count: value,
    });
    assert.doesNotThrow(() => assertSerializableDomain(summary));
  }
});

test('compact failure diagnostics distinguish allocation from provider transmission', () => {
  const diagnostics = createCompactFailureDiagnostics({
    build_identity: { version: '0.9.94', fingerprint: 'test' },
    catch_up_recovery: { available: true, resumable: false,
      reason_code: 'non_serializable_domain_data', safely_committed_offset: 0,
      source_message_count: 9434 },
    provider_attempt_audit: { run_id: 'run', recent_attempts: [{
      attempt_id: 'provider-1', logical_obligation_id: 'session:0-19',
      transmission_started: false, state_history: [{ state: 'created' }],
    }] },
    controller_exit: { reason_code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA',
      bounded_message: 'number is not finite', failure_stage: 'transaction_state_snapshot',
      serialization_path: '$.checkpoint.age_ms', serialization_type: 'number' },
  }, 100);
  assert.equal(diagnostics.provider_transmission.attempt_allocated, true);
  assert.equal(diagnostics.provider_transmission.occurred, false);
  assert.equal(diagnostics.root_error.serialization_path, '$.checkpoint.age_ms');
  assert.equal(diagnostics.resume.eligible, false);
  assert.doesNotThrow(() => assertSerializableDomain(diagnostics));
});

test('full diagnostics publication validates the complete graph and adds stable identities', () => {
  const diagnostics = createFullDiagnosticsExport({
    status: 'completed', operational_status: 'completed',
    build_identity: { version: '0.9.94', fingerprint: 'test' },
    logical_run: { logical_run_id: 'run-1' },
    provider_attempt_audit: { recent_attempts: [{
      attempt_id: 'attempt-1', transmission_started: true,
      lifecycle_state: 'response_received',
    }] },
    feature_section: { count: 2 },
  }, 100);
  assert.equal(diagnostics.schema_version, 1);
  assert.equal(diagnostics.diagnostic_type, 'memorize_chat_run');
  assert.equal(diagnostics.export_identity.logical_run_id, 'run-1');
  assert.equal(diagnostics.provider_transmission.occurred, true);
  assert.deepEqual(diagnostics.feature_section, { count: 2 });
  assert.doesNotThrow(() => assertSerializableDomain(diagnostics));
  assert.throws(() => createFullDiagnosticsExport({
    status: 'completed', invalid: undefined,
  }), { code: 'SME_NON_SERIALIZABLE_DOMAIN_DATA' });
});

test('diagnostic projection failure can report a completed core workflow without offering Resume', () => {
  const diagnostics = createCompactFailureDiagnostics({
    core_workflow_completed: true,
    catch_up_recovery: { available: true, resumable: true,
      resume_can_make_progress: true, reason_code: 'SME_DIAGNOSTIC_PROJECTION_FAILED' },
  }, 100);
  assert.equal(diagnostics.diagnostic_type, 'diagnostics_projection_failure');
  assert.equal(diagnostics.status, 'completed');
  assert.equal(diagnostics.resume.eligible, false);
  assert.equal(diagnostics.resume.next_action, null);
});

test('compact diagnostics survive a malformed obligation projection source', () => {
  const diagnostics = createCompactFailureDiagnostics({
    catch_up_recovery: { available: true, resumable: false,
      unresolved_obligations: [{ tier: 'session',
        candidate_rejections: [{ callback: () => {} }] }] },
  }, 100);
  assert.equal(diagnostics.obligation_state.exact_reason_code,
    'diagnostic_source_invalid');
  assert.equal(diagnostics.obligation_state.obligation_id, null);
  assert.ok(diagnostics.invariant_violations.some((item) =>
    item.code === 'SME_INVALID_DOMAIN_DTO'));
  assert.doesNotThrow(() => assertSerializableDomain(diagnostics));
});

test('controller, transaction, registration, and diagnostic builders publish canonical immutable data', () => {
  const exit = createControllerExit({ controller_invocation_id: 'controller-1',
    reason_code: 'local_failure', classification: 'internal_exception',
    active_transaction_state: 'rolled_back', checkpoint_before: 0,
    checkpoint_after: 0, at: 10 });
  const transaction = createTransactionSnapshot({ transaction_id: 'tx-1',
    state: 'rolled_back', owner: { phase: 'registration' } }, 11);
  const registration = createProviderRegistrationReceipt({ attempt_id: 'attempt-1',
    obligation_id: 'session:0-19', registered_at: 9 });
  const diagnostic = createDiagnosticError(Object.assign(new TypeError('bad value'), {
    code: 'SME_BAD_VALUE', sme_failure_stage: 'registration',
    sme_serialization_path: '$.bad', sme_serialization_type: 'function',
  }));
  for (const value of [exit, transaction, registration, diagnostic]) {
    assert.equal(Object.isFrozen(value), true);
    assert.doesNotThrow(() => structuredClone(value));
  }
  assert.equal(registration.transmission_started, false);
  assert.equal(diagnostic.message, 'bad value');
  assert.equal(diagnostic.serialization_path, '$.bad');
});

test('canonical identity builders fail before publication when identifiers are missing', () => {
  for (const build of [
    () => createControllerExit({ reason_code: 'x', classification: 'internal_exception' }),
    () => createTransactionSnapshot({ state: 'rolled_back' }),
    () => createProviderRegistrationReceipt({ attempt_id: 'attempt-1' }),
  ]) assert.throws(build, { code: 'SME_INVALID_DOMAIN_DTO' });
});
