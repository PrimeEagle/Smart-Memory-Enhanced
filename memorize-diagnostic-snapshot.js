import { cloneSerializableDomain, freezeDomainTree }
  from './serializable-domain.js';

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

/** Captures metadata and its matching checkpoint in one synchronous read boundary. */
export function captureMemorizeDiagnosticSnapshot({ metadata = {}, checkpoint = null,
  at = Date.now() } = {}) {
  const metadataCopy = cloneSerializableDomain(metadata ?? {}, {
    path: '$.diagnostic_snapshot.metadata', stage: 'diagnostic_snapshot',
  });
  const checkpointCopy = cloneSerializableDomain(
    checkpoint ?? metadataCopy.catch_up_checkpoint ?? null, {
      path: '$.diagnostic_snapshot.checkpoint', stage: 'diagnostic_snapshot',
    });
  const ledger = checkpointCopy?.run_manifest?.obligation_ledger ?? null;
  const kernel = ledger?.execution_kernel ?? null;
  const identity = {
    schema_version: 1,
    captured_at: at,
    logical_run_id: checkpointCopy?.run_manifest?.logical_run_id
      ?? metadataCopy.active_catchup_run_id ?? null,
    aggregate_revision: Number(kernel?.revision ?? ledger?.revision ?? 0),
    transaction_revision: Number(checkpointCopy?.transaction_lifecycle?.revision ?? 0),
    transaction_state: checkpointCopy?.transaction_lifecycle?.state ?? null,
    checkpoint_revision: Number(checkpointCopy?.revision
      ?? checkpointCopy?.committed_chunks ?? 0),
    checkpoint_status: checkpointCopy?.status ?? null,
    checkpoint_updated_at: checkpointCopy?.updated_at ?? null,
  };
  return freezeDomainTree({ identity, metadata: metadataCopy, checkpoint: checkpointCopy });
}

export function validateMemorizeDiagnosticSnapshot(diagnostics = {}, identity = {}) {
  const violations = [];
  const runIds = new Set([
    diagnostics.logical_run?.logical_run_id,
    diagnostics.authoritative_obligation_ledger?.logical_run_id,
    diagnostics.memorize_execution_kernel?.logical_run_id,
    diagnostics.authoritative_recovery?.logical_run_id,
    identity.logical_run_id,
  ].filter(Boolean));
  if (runIds.size > 1) violations.push('logical_run_id_mismatch');
  const revisions = [
    diagnostics.memorize_execution_kernel?.revision,
    diagnostics.authoritative_recovery?.aggregate_revision,
    identity.aggregate_revision,
  ].filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
    .map(Number);
  if (new Set(revisions).size > 1) violations.push('aggregate_revision_mismatch');
  const attemptCounts = [
    diagnostics.logical_run?.attempt_count,
    diagnostics.malformed_recovery?.attempt_count,
  ].filter((value) => Number.isFinite(Number(value))).map(Number);
  if (new Set(attemptCounts).size > 1) violations.push('attempt_count_mismatch');
  if (identity.transaction_state === 'rolled_back'
    && identity.checkpoint_status === 'in_progress') {
    violations.push('rolled_back_transaction_with_in_progress_checkpoint');
  }
  return freeze({ consistent: violations.length === 0, violations,
    identity: cloneSerializableDomain(identity, {
      path: '$.diagnostic_snapshot.identity', stage: 'diagnostic_projection',
    }) });
}
