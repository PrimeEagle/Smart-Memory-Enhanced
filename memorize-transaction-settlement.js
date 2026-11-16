const TERMINAL_TRANSACTION_STATES = new Set([
  'committed', 'rolled_back', 'commit_failed_with_exact_state',
  'rollback_failed_with_exact_state',
]);

/** Pure checkpoint projection applied only after the transaction has settled. */
export function settleMemorizeTransactionCheckpoint(checkpointValue, transaction = {}, {
  reason_code: reasonCode = 'controller_exit', at = Date.now(),
} = {}) {
  if (!checkpointValue || typeof checkpointValue !== 'object') return null;
  if (!TERMINAL_TRANSACTION_STATES.has(transaction.state)) {
    const error = new Error('Checkpoint cannot be settled from a nonterminal transaction.');
    error.code = 'SME_TRANSACTION_SETTLEMENT_NOT_TERMINAL';
    error.sme_origin = 'internal_invariant';
    throw error;
  }
  const checkpoint = structuredClone(checkpointValue);
  checkpoint.transaction_lifecycle = {
    schema_version: 2,
    transaction_id: transaction.transaction_id ?? null,
    state: transaction.state,
    terminal_disposition: transaction.terminal_disposition ?? transaction.state,
    owner: structuredClone(transaction.owner ?? {}),
    revision: transaction.revision ?? null,
    generation: transaction.generation ?? null,
    started_at: transaction.started_at ?? null,
    settled_at: transaction.settled_at ?? at,
    updated_at: at,
    exact_reason_code: transaction.exact_reason_code ?? reasonCode,
    durable_checkpoint_count: Number(transaction.durable_checkpoint_count ?? 0),
    saga_disposition: transaction.saga_disposition
      ?? transaction.terminal_disposition ?? transaction.state,
    durable_subwrites_preserved: transaction.durable_subwrites_preserved === true,
  };
  checkpoint.status = transaction.state === 'rolled_back'
    ? 'awaiting_manual_resume'
    : transaction.state === 'committed' ? checkpoint.status
      : 'blocked_transaction_settlement_failure';
  checkpoint.updated_at = at;
  if (checkpoint.transaction_lifecycle.state === 'rolled_back'
    && checkpoint.status === 'in_progress') {
    throw new Error('Rolled-back transaction cannot retain an in-progress checkpoint.');
  }
  return checkpoint;
}
