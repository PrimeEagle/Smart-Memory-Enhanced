import { deriveMemorizeResumeEligibility } from './memorize-authority-model.js';
import { getMemorizeActionContract, projectMemorizeObligationLedger }
  from './memorize-obligation-ledger.js';
import { deriveRecoveryStageEligibility } from './recovery-stage-eligibility.js';

const terminalTransactionStates = new Set([
  'committed', 'rolled_back', 'commit_failed_with_exact_state',
  'rollback_failed_with_exact_state',
]);

/** One pure recovery decision consumed by UI, controller, diagnostics and exit records. */
export function deriveMemorizeRecoveryAuthority(input = {}) {
  const checkpoint = input.checkpoint ?? null;
  const ledger = input.ledger ?? null;
  const projection = input.projection ?? projectMemorizeObligationLedger(ledger);
  const pending = projection.next_eligible_obligation ?? null;
  const providerAudit = input.provider_audit ?? null;
  const heartbeat = input.controller_heartbeat ?? null;
  const transaction = input.transaction_lifecycle ?? null;
  const physicalRunning = (providerAudit?.recent_attempts ?? [])
    .filter((attempt) => attempt?.terminal_outcome === 'running');
  const liveController = heartbeat?.terminal === false
    && Boolean(heartbeat?.controller_invocation_id);
  const ownedRunning = physicalRunning.filter((attempt) => liveController
    && attempt.controller_instance_id
    && attempt.controller_instance_id === heartbeat.controller_invocation_id);
  const orphanedRunning = physicalRunning.filter((attempt) => !ownedRunning.includes(attempt));
  const recoveryWindow = pending ? providerAudit?.obligations?.[
    pending.parent_obligation_id ?? pending.obligation_id
  ]?.recovery_windows?.[pending.source_fingerprint] ?? null : null;
  const stageEligibility = recoveryWindow ? deriveRecoveryStageEligibility(recoveryWindow) : null;
  const sourceMessageCount = Number(input.source_message_count
    ?? checkpoint?.source_message_count ?? 0);
  const nextSourceOffset = Number(input.next_source_offset
    ?? checkpoint?.next_source_offset ?? 0);
  const sourceTraversalPending = !pending && sourceMessageCount > 0
    && nextSourceOffset < sourceMessageCount;
  const finalizationPending = !pending && !sourceTraversalPending
    && checkpoint != null && !['completed', 'terminal_failure'].includes(
      input.checkpoint_status ?? checkpoint.status);
  const exactAction = stageEligibility?.blocked === false
    ? stageEligibility.eligible_action : pending?.next_eligible_action
      ?? (sourceTraversalPending ? 'continue_source_traversal'
        : finalizationPending ? 'continue_finalization' : null);
  const transactionContradiction = transaction?.state === 'active' && !liveController
    || terminalTransactionStates.has(transaction?.state) && input.checkpoint_status === 'in_progress';
  const activeTransaction = transaction?.state === 'active' ? transaction : null;
  const base = deriveMemorizeResumeEligibility({
    ledger, projection, provider_audit: providerAudit,
    provider_completion_journal: input.provider_completion_journal,
    active_transaction: activeTransaction,
  });
  const blockers = [];
  if (transactionContradiction) blockers.push({
    reason_code: 'transaction_checkpoint_lifecycle_requires_repair',
    evidence: { transaction_id: transaction?.transaction_id ?? null,
      transaction_state: transaction?.state ?? null,
      checkpoint_status: input.checkpoint_status ?? null },
  });
  if (orphanedRunning.length) blockers.push({
    reason_code: 'orphaned_provider_attempt_requires_repair',
    evidence: { attempt_ids: orphanedRunning.map((item) => item.attempt_id) },
  });
  if (stageEligibility?.blocked) blockers.push({
    reason_code: stageEligibility.reason_code,
    evidence: { attempted_stages: stageEligibility.attempted_stages,
      exhausted_stages: stageEligibility.exhausted_stages },
  });
  if (!blockers.length && pending && base.eligible !== true) blockers.push({
    reason_code: base.reason_code ?? 'no_executable_recovery_action', evidence: null,
  });
  const actionContract = getMemorizeActionContract(exactAction);
  const eligible = blockers.length === 0 && Boolean(exactAction)
    && (sourceTraversalPending || finalizationPending || base.eligible === true
      || actionContract != null);
  const providerCallPermitted = eligible && (sourceTraversalPending || finalizationPending
    || actionContract?.provider_call_required === true
    || base.provider_call_required === true);
  const terminalFailure = ['terminal_failure', 'failed'].includes(
    input.checkpoint_status ?? checkpoint?.status);
  const state = liveController ? 'actively_running'
    : blockers.some((item) => item.reason_code.includes('requires_repair'))
      ? 'recoverable_after_automatic_repair'
      : terminalFailure ? 'terminal_failure'
        : eligible ? 'awaiting_safe_resume'
        : projection.pending_obligation_count > 0 || sourceTraversalPending || finalizationPending
          ? 'resume_blocked' : 'completed';
  return Object.freeze({
    schema_version: 1,
    state,
    pending_obligation: pending,
    exact_recovery_stage: exactAction,
    next_executable_action: exactAction,
    resume_eligible: eligible,
    resume_blockers: blockers,
    provider_call_permitted: providerCallPermitted,
    source_traversal_pending: sourceTraversalPending,
    finalization_pending: finalizationPending,
    transaction_repair_required: transactionContradiction,
    orphaned_provider_attempt_ids: orphanedRunning.map((item) => item.attempt_id),
    provider_attempt_owned_by_live_controller: ownedRunning.length > 0,
    base_resume_eligibility: base,
    invariants: {
      closed_controller_owns_no_running_attempt: !orphanedRunning.length,
      rolled_back_transaction_has_no_in_progress_checkpoint: !(
        terminalTransactionStates.has(transaction?.state) && input.checkpoint_status === 'in_progress'),
      one_action_or_exact_blocker: Boolean(exactAction) || blockers.length > 0,
      ui_controller_resume_agreement: true,
    },
  });
}
