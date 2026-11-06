import { deriveMemorizeRecoveryAuthority } from './memorize-recovery-authority.js';

const bounded = (error) => String(error?.message ?? error ?? 'Unknown error')
  .replace(/\s+/g, ' ').slice(0, 300);

/**
 * Non-throwing controller exit boundary. Every callback is dependency-injected
 * so this function cannot rely on variables from a caller's catch/finally scope.
 */
export async function finalizeMemorizeController(input = {}) {
  const secondary = [];
  let settlement = null;
  let repair = null;
  const safe = async (stage, operation) => {
    try { return await operation(); }
    catch (error) {
      secondary.push({ stage, code: error?.code ?? null,
        normalized_exception_class: error?.constructor?.name ?? typeof error,
        bounded_message: bounded(error) });
      return null;
    }
  };
  if (input.settle_transaction) settlement = await safe('transaction_settlement',
    input.settle_transaction);
  if (input.repair_state) repair = await safe('state_reconciliation', input.repair_state);
  const checkpoint = input.get_checkpoint?.() ?? input.checkpoint ?? null;
  if (input.close_controller) await safe('controller_heartbeat_close', input.close_controller);
  const authority = deriveMemorizeRecoveryAuthority({
    checkpoint,
    ledger: checkpoint?.run_manifest?.obligation_ledger,
    provider_audit: input.provider_audit,
    provider_completion_journal: input.provider_completion_journal,
    controller_heartbeat: checkpoint?.controller_heartbeat,
    transaction_lifecycle: checkpoint?.transaction_lifecycle,
    checkpoint_status: checkpoint?.status,
  });
  const primary = input.primary_error ? {
    code: input.primary_error.code ?? 'internal_exception',
    normalized_exception_class: input.primary_error.constructor?.name
      ?? typeof input.primary_error,
    bounded_message: bounded(input.primary_error),
  } : null;
  const exit = {
    reason_code: input.reason_code ?? primary?.code
      ?? authority.resume_blockers[0]?.reason_code ?? 'controller_exit',
    classification: input.classification ?? (authority.resume_eligible
      ? 'awaiting_actionable_recovery' : 'internal_exception'),
    resumable: authority.resume_eligible,
    obligation_id: authority.pending_obligation?.obligation_id ?? null,
    next_eligible_action: authority.next_executable_action,
    primary_failure: primary,
    secondary_finalization_failures: secondary,
    transaction_settlement: settlement,
    repair,
  };
  if (checkpoint) {
    checkpoint.authoritative_recovery = authority;
    checkpoint.resume_eligibility = {
      schema_version: 2,
      eligible: authority.resume_eligible,
      mode: authority.resume_eligible ? 'provider_resume' : 'blocked',
      reason_code: authority.resume_eligible ? 'exact_recovery_action_available'
        : authority.resume_blockers[0]?.reason_code ?? 'no_executable_recovery_action',
      next_eligible_action: authority.next_executable_action,
      obligation_id: authority.pending_obligation?.obligation_id ?? null,
      provider_call_required: authority.provider_call_permitted,
      evaluated_at: Date.now(),
    };
    checkpoint.status = authority.resume_eligible
      ? 'awaiting_manual_resume' : authority.state === 'completed'
        ? 'completed' : authority.state === 'terminal_failure'
          ? 'terminal_failure' : 'blocked_reconciliation_required';
    checkpoint.controller_failure ??= primary ? { schema_version: 1, ...primary,
      recorded_at: Date.now() } : null;
    checkpoint.secondary_finalization_failures = secondary.slice(-16);
    checkpoint.updated_at = Date.now();
  }
  if (input.record_exit) await safe('controller_exit_record', () => input.record_exit(exit));
  if (checkpoint) checkpoint.secondary_finalization_failures = secondary.slice(-16);
  if (input.persist_diagnostics) await safe('diagnostic_persistence', input.persist_diagnostics);
  if (checkpoint) checkpoint.secondary_finalization_failures = secondary.slice(-16);
  exit.secondary_finalization_failures = secondary;
  return { exit, authority, checkpoint, secondary_failures: secondary };
}
