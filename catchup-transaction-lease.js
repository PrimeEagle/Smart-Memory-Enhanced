export function createTransactionLease(transaction, detail = {}) {
  if (!transaction) return null;
  return Object.freeze({
    schema_version: 1,
    logical_run_id: transaction.owner?.logical_run_id ?? null,
    controller_instance_id: transaction.owner?.controller_instance_id ?? null,
    transaction_id: transaction.transaction_id,
    transaction_revision: transaction.revision,
    transaction_generation: transaction.generation,
    obligation_id: detail.obligation_id ?? null,
    provider_attempt_id: detail.provider_attempt_id ?? null,
    callback_type: detail.callback_type ?? 'unspecified_callback',
  });
}

export function inspectTransactionLease(transaction, currentTransaction, lease,
  snapshot = (value) => value ?? null) {
  const current = snapshot(currentTransaction);
  const captured = lease ? { ...lease } : null;
  let reason_code = null;
  if (!transaction || !lease) reason_code = 'transaction_lease_missing';
  else if (transaction !== currentTransaction) reason_code = 'transaction_lease_not_current';
  else if (transaction.state !== 'active') reason_code = 'transaction_lease_transaction_settled';
  else if (transaction.transaction_id !== lease.transaction_id) reason_code = 'transaction_lease_id_mismatch';
  else if (transaction.revision !== lease.transaction_revision
    || transaction.generation !== lease.transaction_generation) reason_code = 'transaction_lease_revision_mismatch';
  else if ((transaction.owner?.logical_run_id ?? null) !== (lease.logical_run_id ?? null)) {
    reason_code = 'transaction_lease_logical_run_mismatch';
  } else if ((transaction.owner?.controller_instance_id ?? null)
    !== (lease.controller_instance_id ?? null)) reason_code = 'transaction_lease_controller_mismatch';
  return {
    allowed: reason_code === null,
    disposition: reason_code === null ? 'lease_current' : 'stale_lease_mutation_rejected',
    reason_code,
    captured_lease: captured,
    current_transaction: current,
    durable_mutation_performed: false,
  };
}
