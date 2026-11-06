/** Pure read models for UI and diagnostics. These functions never persist or mutate input. */

const cloneProjectionValue = (value) => {
  if (Array.isArray(value)) return value.map(cloneProjectionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, nested]) => [key, cloneProjectionValue(nested)]));
};

export function selectRunOutcomePresentation(report, { running = false, formatIdentifier = String } = {}) {
  const status = report?.run_status ?? null;
  if (running || !status || status.lifecycle_status === 'not_run') return Object.freeze({ visible: false });
  const class_name = status.severity === 'success' ? 'sme_outcome_success'
    : status.severity === 'warning' ? 'sme_outcome_warning'
      : status.severity === 'error' ? 'sme_outcome_error' : 'sme_outcome_info';
  const source = status.completion_evidence?.source_message_count;
  const committed = status.completion_evidence?.committed_message_count;
  const noticeSuffix = status.notice_count > 0
    ? ` ${status.notice_count} safe quality notice${status.notice_count === 1 ? '' : 's'} also remain available in diagnostics.` : '';
  const recoverySuffix = status.recovered_error_count > 0
    ? ` ${status.recovered_error_count} other failed extraction obligation${status.recovered_error_count === 1 ? ' was' : 's were'} recovered.` : '';
  const detail = status.lifecycle_status === 'completed' && status.unresolved_error_count > 0
    ? `All ${Number(source ?? committed ?? 0).toLocaleString()} messages were processed and finalization completed, but ${status.unresolved_error_count} memory extraction${status.unresolved_error_count === 1 ? '' : 's'} remain unresolved.${recoverySuffix}${noticeSuffix}`
    : status.lifecycle_status === 'completed' && status.outcome_status === 'completed_recovered_errors'
      ? status.recovered_error_count > 0
        ? `${status.recovered_error_count} failed extraction obligation${status.recovered_error_count === 1 ? ' was' : 's were'} recovered; none remain unresolved.${noticeSuffix}`
        : `${status.historical_failure_observation_count} transient failure observation${status.historical_failure_observation_count === 1 ? ' was' : 's were'} recorded; none remain unresolved.${noticeSuffix}`
      : status.lifecycle_status === 'completed' && status.notice_count > 0
        ? `Processing and finalization completed with ${status.notice_count} safe quality notice${status.notice_count === 1 ? '' : 's'}.`
        : status.lifecycle_status === 'completed'
          ? `${Number(committed ?? source ?? 0).toLocaleString()} source messages were safely committed and finalization completed.`
          : formatIdentifier(status.recovery_reason_code ?? status.status_reason_codes.join(', '), 'status unavailable');
  return Object.freeze({
    visible: true,
    class_name,
    aria_label: `${status.label}. ${detail}`,
    label: status.label,
    icon: status.icon,
    detail,
    header_severity_class: status.severity === 'error' ? 'sme_status_error'
      : status.severity === 'warning' ? 'sme_status_warning' : null,
    unresolved_error_label: status.severity === 'error' && status.unresolved_error_count > 0
      ? `${status.unresolved_error_count} unresolved extraction error${status.unresolved_error_count === 1 ? '' : 's'}` : null,
  });
}

export function selectRecoveryPresentation(input = {}) {
  const {
    checkpoint, rawSummary, recovery, manifest = {}, resumeEligibility = {},
    running = false, transaction = null, formatIdentifier = String,
  } = input;
  const authority = recovery?.authoritative_recovery ?? null;
  if (!checkpoint) {
    const reason = rawSummary?.reason_code
      ? ` Reason: ${formatIdentifier(rawSummary.reason_code, 'unknown reason')}.` : '';
    return Object.freeze({
      visible: rawSummary?.available === true,
      disabled: true,
      label: 'Resume Incomplete Run',
      title: 'Resume the last incomplete Memorize Chat run from its last safely committed chunk.',
      status_text: rawSummary?.available
        ? `Incomplete Memorize Chat run cannot safely resume (${rawSummary.status ?? 'invalid checkpoint'}). Start a new run after inspecting diagnostics.${reason}` : '',
      auto_resume_eligible: false,
    });
  }
  if (authority?.state === 'completed') return Object.freeze({
    visible: false, disabled: true, label: 'Resume Incomplete Run',
    title: 'The prior Memorize Chat run completed.', status_text: '',
    auto_resume_eligible: false,
  });
  if (authority?.state === 'terminal_failure') return Object.freeze({
    visible: true, disabled: true, label: 'Terminal Failure',
    title: 'The prior run ended in a terminal failure and has no safe executable Resume action.',
    status_text: `Terminal failure — ${formatIdentifier(
      authority.resume_blockers?.[0]?.reason_code, 'no safe recovery action is available')}. Completed work remains preserved.`,
    auto_resume_eligible: false,
  });
  if (authority?.state === 'recoverable_after_automatic_repair') return Object.freeze({
    visible: true, disabled: true, label: 'Repairing Incomplete Run',
    title: 'A closed controller or stale transaction is being reconciled before Resume is enabled.',
    status_text: 'Recoverable — automatic state repair is settling stale ownership before a safe Resume is offered. No provider request is sent during this repair.',
    auto_resume_eligible: false,
  });
  if (authority?.state === 'resume_blocked') return Object.freeze({
    visible: true, disabled: true, label: 'Recovery Change Required',
    title: 'Resume is blocked until the exact recovery condition is resolved.',
    status_text: `Blocked — ${formatIdentifier(
      authority.resume_blockers?.[0]?.reason_code, 'no executable recovery action')}. Safely completed work remains preserved.`,
    auto_resume_eligible: false,
  });
  if (recovery?.blocked) {
    const blocked = recovery.blocked_obligations ?? [];
    const affected = blocked.map((item) => `${item.tier}${item.owner ? `/${item.owner}` : ''} ${item.source_range?.start ?? '?'}–${item.source_range?.end ?? '?'}`).join(', ');
    const unresolved = Number(recovery.unresolved_obligation_count ?? blocked.length);
    return Object.freeze({ visible: true, disabled: true, label: 'Recovery Change Required',
      title: 'The remaining obligations exhausted every available recovery strategy. Safe progress is preserved.',
      status_text: `Blocked — recovery change required. ${unresolved} unresolved extraction obligation${unresolved === 1 ? '' : 's'}${affected ? `: ${affected}` : ''}. Safe progress is preserved, but another identical Resume is not useful. Change the provider/model configuration or install an updated build.`,
      auto_resume_eligible: false });
  }
  const committed = Math.min(Number(checkpoint.next_source_offset) || 0, Number(checkpoint.source_message_count) || 0);
  const total = Number(checkpoint.source_message_count) || 0;
  const attemptText = manifest.attempt_count > 1 ? ` across ${manifest.attempt_count} attempts` : '';
  const rangeText = `${manifest.cumulative_range_count ?? 0} coalesced committed range${manifest.cumulative_range_count === 1 ? '' : 's'}`;
  const traversalCount = Number(manifest.cumulative_committed_count ?? committed) || 0;
  const furthest = Math.max(-1, ...(manifest.cumulative_committed_ranges ?? []).map((range) => Number(range.source_end_index ?? range.end_offset ?? -1)));
  const backlog = Number(recovery?.recovery_backlog_count ?? 0);
  const progressText = `contiguous checkpoint ${committed}/${total}; ${traversalCount} source messages traversed${furthest >= 0 ? ` through source index ${furthest}` : ''}; ${backlog} recovery backlog obligation${backlog === 1 ? '' : 's'}`;
  const finalization = recovery?.finalization;
  const finalizationText = finalization?.completed_phase_count
    ? ` ${finalization.completed_phase_count} finalization phase${finalization.completed_phase_count === 1 ? '' : 's'} are safely committed${finalization.active_phase ? `; retrying ${formatIdentifier(finalization.active_phase, 'pending phase')}` : ''}.` : '';
  const operatorActionRequired = resumeEligibility.eligible !== true;
  const reconstructing = resumeEligibility.decision === 'reconstruct_successor_from_committed_boundary';
  const providerText = recovery?.next_eligible_recovery_action === 'single_source_unit_regeneration'
    ? ' Remaining malformed output will be retried one source message at a time; each validated result is saved before the next message.'
    : recovery?.exact_pending_obligation
      ? ` Pending ${recovery.exact_pending_obligation.tier === 'session' ? 'Session' : 'Long-Term'} obligation ${recovery.exact_pending_obligation.source_range?.start ?? '?'}–${recovery.exact_pending_obligation.source_range?.end ?? '?'}: ${formatIdentifier(recovery.exact_pending_obligation.exact_reason_code, 'pending recovery')}. Next action: ${formatIdentifier(recovery.exact_pending_obligation.next_eligible_action, 'resume exact obligation')}.` : '';
  const transactionLocked = Boolean(transaction);
  const disabled = running || operatorActionRequired;
  const label = running ? 'Resumed Automatically'
    : reconstructing ? 'Resume From Safe Boundary' : 'Resume Incomplete Run';
  const title = running
    ? transactionLocked ? `Resume is unavailable until stale transaction ${transaction.transaction_id} is safely rolled back.`
      : 'This incomplete Memorize Chat run has already resumed automatically. Use Cancel only if you want to stop it.'
    : operatorActionRequired ? `Resume is blocked: ${formatIdentifier(resumeEligibility.reason, 'recovery change required')}.`
      : reconstructing ? 'Rebuild the missing successor plan from the safely committed Short-Term boundary without repeating the prior segment.'
        : 'Resume the last incomplete Memorize Chat run from its last safely committed chunk.';
  const authorityText = authority?.state === 'awaiting_safe_resume'
    ? ` Safe Resume is authorized for ${formatIdentifier(authority.next_executable_action, 'the exact pending obligation')}; no completed sibling obligation will be repeated.` : '';
  const status_text = running
    ? transactionLocked ? `Resume temporarily unavailable: an in-memory transaction lock remains for ${transaction.owner?.phase ?? 'unknown phase'}. Starting Resume will first audit and roll back that stale lock; no committed work will be discarded.`
      : `Resumed automatically — processing continues; ${progressText}${attemptText} (${rangeText}). Later safe work remains preserved while mandatory backlog recovery blocks finalization.${finalizationText}${providerText}`
    : operatorActionRequired ? `Short-Term finalization cannot ordinarily resume (${formatIdentifier(resumeEligibility.decision, 'blocked')}: ${formatIdentifier(resumeEligibility.reason, 'recovery change required')}). Completed extraction and phase checkpoints remain preserved.`
      : reconstructing ? `Short-Term progress is safely committed. Resume will reconstruct the missing successor plan at the committed boundary without regenerating the prior segment.${finalizationText}`
        : `Incomplete Memorize Chat run available: ${progressText}${attemptText} (${rangeText}). Later safe work remains preserved; Resume continues the exact active obligation without restarting at the contiguous checkpoint.${authorityText}${finalizationText}${providerText}`;
  return Object.freeze({ visible: true, disabled, label, title, status_text,
    auto_resume_eligible: !operatorActionRequired
      && ['in_progress', 'awaiting_manual_resume'].includes(checkpoint.status) && !running });
}

export function selectDiagnosticsProjection(input = {}) {
  const { completedRun = null, current = {}, createdAt = Date.now() } = input;
  if (completedRun) return cloneProjectionValue({ ...completedRun, ...current });
  if (!current.fresh_start_postcondition_audit && !current.manual_idempotence
    && !current.live_memory_health && !current.catch_up_recovery?.available) return null;
  return cloneProjectionValue({
    version: 1,
    created_at: createdAt,
    diagnostic_type: current.catch_up_recovery?.available ? 'incomplete_catchup_recovery' : 'pre_run_state_audit',
    status: current.catch_up_recovery?.available ? 'incomplete' : 'not_run',
    operational_status: current.catch_up_recovery?.available ? 'incomplete' : 'not_run',
    automatic_stabilization: null,
    provider_calls_during_audit: 0,
    ...current,
  });
}

