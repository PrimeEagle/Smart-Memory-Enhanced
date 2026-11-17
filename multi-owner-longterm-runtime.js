import { extension_settings, getContext } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { estimateTokens } from './constants.js';
import { generateMemoryExtract, getMemoryProviderCapabilities, getMemoryRequestBudget }
  from './generate.js';
import { applyDirectProvenance } from './grounding.js';
import { parseExtractionOutput } from './parsers.js';
import { buildMultiOwnerLongtermPrompt, dispatchMultiOwnerLongtermBatch,
  persistMultiOwnerLongtermPartitions }
  from './multi-owner-longterm.js';
import { buildStructuredMemoryProviderRequest, parseStructuredMemoryResponse }
  from './malformed-output-recovery.js';
import { sourceRange, sourceWindowFingerprint, makeExtractionPreflight }
  from './extraction-window-utils.js';
import { providerConfigurationSignature, finishProviderAttempt }
  from './provider-attempt-audit.js';
import { recordProviderCompletion } from './provider-completion-journal.js';
import { extendMemorizeExecutionContext, resolveMemorizeExecutionContext }
  from './memorize-execution-context.js';
import { createMemorizeTierPipeline } from './memorize-tier-pipeline.js';
import { createMemorizeRecoveryScheduler } from './memorize-recovery-scheduler.js';
import { attachMemorizeOperationContext, createMemorizeOperationContext }
  from './memorize-operation-context.js';
import { persistLongtermOwnerPartition } from './longterm.js';
import { projectMultiOwnerCoverage } from './multi-owner-coverage.js';
import { createMemorizeTierOutcome } from './memorize-tier-outcome.js';

const OWNER_SCOPE = '@multi-owner';

function boundedOwnerList(owners = []) {
  return [...new Set(owners.map((owner) => String(owner ?? '').trim()).filter(Boolean))];
}

function sourcePrompt(messages) {
  return messages.map((message, index) => `[${index}] ${message.name}: ${message.mes}`).join('\n\n');
}

function policyPauseEvidence(ingress, leafId, rootId) {
  return { ...(ingress.policy_outcome ?? {}), root_obligation_id: rootId,
    leaf_obligation_id: leafId, provider_call_required: false,
    next_eligible_action: ingress.next_action ?? 'resume_exact_obligation' };
}

/** One provider action and one lifecycle leaf for every Long-Term owner in a chunk. */
export async function extractAndStoreMultiOwnerMemories(
  ownersValue, recentMessages, statusFn = null, options = {},
) {
  const owners = boundedOwnerList(ownersValue);
  const requiredOwners = boundedOwnerList(options.requiredOwners ?? owners);
  const sourceMessages = recentMessages.filter((message) => message?.mes && !message.is_system);
  if (!owners.length || !sourceMessages.length) return createMemorizeTierOutcome({
    kind: 'complete_no_update', reason_code: 'not_applicable',
    value: { status: 'not_applicable', added: 0, owners: {}, physical_provider_requests: 0 },
  });
  const settings = extension_settings[MODULE_NAME];
  const execution = resolveMemorizeExecutionContext(options);
  const healthUpdate = (patch) => options.liveHealth?.update?.(patch);
  const healthFinish = (patch) => options.liveHealth?.finish?.(patch);
  const metadata = getContext()?.chatMetadata?.[META_KEY];
  const range = sourceRange(sourceMessages);
  const sourceFingerprint = sourceWindowFingerprint(sourceMessages);
  const perOwnerResponseLength = settings.longterm_response_length || 600;
  const configuredGenerationBudget = Number(settings.generation_budget);
  const responseLength = Math.max(perOwnerResponseLength, Math.min(
    configuredGenerationBudget > 0 ? configuredGenerationBudget : Number.MAX_SAFE_INTEGER,
    perOwnerResponseLength * owners.length,
  ));
  const capabilities = { ...getMemoryProviderCapabilities(), simple_json_records: true };
  const recoveryAttempt = Math.max(0, Number(options.recoveryAttempt ?? 0));
  const basePrompt = `${buildMultiOwnerLongtermPrompt(sourcePrompt(sourceMessages), owners)}${
    recoveryAttempt > 0 ? `\n\nRECOVERY PASS ${recoveryAttempt}: Return coverage only for the listed owners. Explicitly place every owner with no supported record in no_update_owners.` : ''}`;
  const request = buildStructuredMemoryProviderRequest(basePrompt, {
    tier: 'longterm', owner: null, allowedOwners: owners, capabilities,
  });
  const requestBudget = getMemoryRequestBudget(responseLength);
  const preflight = makeExtractionPreflight({
    prompt: request.prompt, estimateTokens,
    configuredContextLimit: requestBudget.configuredContextLimit,
    effectiveContextLimit: requestBudget.effectiveContextLimit,
    reservedOutputTokens: requestBudget.reservedOutputTokens,
    safetyMargin: requestBudget.safetyMargin,
    protocolOverhead: requestBudget.protocolOverhead,
  });
  const providerConfigSignature = providerConfigurationSignature({
    connection_profile_id: settings.connection_profile_id ?? null,
    model: settings.openai_compat_model ?? settings.ollama_model ?? null,
    source: settings.source ?? null, response_length: responseLength,
    context_length: settings.context_length ?? null,
    owner_scope: owners,
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'longterm', tierLabel: 'Long-Term', owner: OWNER_SCOPE,
    execution, metadata, range,
    rangeId: `longterm:multi:${range.start}-${range.end}:${sourceFingerprint}`,
    coverageLedger: options.extractionCoverage?.longterm,
    sourceFingerprint, preflight, requestBudget, providerConfigSignature,
    chatId: getContext()?.chatId ?? getContext()?.groupId ?? null,
    expectedOutputFormat: request.protocol, schemaVersion: request.protocol,
  });
  const operationContextInput = {
    logical_run_id: metadata?.active_catchup_run_id,
    controller_invocation_id: execution.controller.instance_id,
    transaction_id: execution.controller.transaction_id,
    transaction_generation: execution.controller.transaction_generation,
    chunk_id: execution.controller.transaction_id,
    root_obligation_id: pipeline.rootObligationId,
    leaf_obligation_id: pipeline.leafObligationId,
    tier: 'longterm', owner: OWNER_SCOPE, owners,
    source_range: range, source_fingerprint: sourceFingerprint,
    selected_action: execution.provider.selected_recovery_action
      ?? 'dispatch_provider_request',
    action_handler_revision: 2, provider_policy_revision: 2,
  };
  let operationContext = createMemorizeOperationContext(operationContextInput);
  const fail = (error) => attachMemorizeOperationContext(error, operationContext);
  healthUpdate({ preflight: { ...preflight, usable_input_budget: preflight.usable_input_tokens },
    owner_scope: { mode: 'multi_owner', owner_count: owners.length } });
  if (!preflight.fits) throw fail(pipeline.contextOverflowError());
  if (statusFn) statusFn(`Extracting Long-Term memories for ${owners.length} characters...`);
  if (execution.controller.lifecycle_required) await pipeline.emitLifecycleEvent('obligation_registered', {
    exact_reason_code: 'provider_request_not_started',
    next_eligible_action: 'dispatch_provider_request',
    recovery_intent: 'complete_multi_owner_source_extraction',
    recovery_stage: 'initial_dispatch', owner_scope: owners,
  });
  const dispatchAction = execution.provider.selected_recovery_action
    === 'recover_missing_owner_coverage'
    ? 'recover_missing_owner_coverage' : 'dispatch_provider_request';
  pipeline.requireSelectedAction(dispatchAction);
  await pipeline.recordActionReceipt('action_selected', { action: dispatchAction });
  await pipeline.recordActionReceipt('action_started', { action: dispatchAction });
  const registration = await pipeline.ingestProviderEvidence('register_new_attempt');
  if (registration.status === 'operationally_paused') {
    const evidence = policyPauseEvidence(registration, pipeline.leafObligationId,
      pipeline.rootObligationId);
    healthFinish({ terminal_health: 'policy_paused', provider_outcome: 'not_dispatched',
      attention_reason_codes: [registration.reason_code] });
    return createMemorizeTierOutcome({ kind: 'policy_paused',
      reason_code: registration.reason_code,
      next_action: evidence.next_eligible_action, provider_call_required: false,
      evidence, value: { root_obligation_id: pipeline.rootObligationId } });
  }
  if (registration.status !== 'applied') {
    const error = new Error('Multi-owner Long-Term provider attempt could not be registered.');
    error.code = 'SME_PROVIDER_ATTEMPT_REGISTRATION_FAILED';
    error.sme_origin = 'internal_invariant';
    error.sme_obligation_id = pipeline.leafObligationId;
    error.sme_request_diagnostics = registration;
    throw fail(error);
  }
  const attempt = registration.attempt;
  operationContext = createMemorizeOperationContext({
    ...operationContextInput, attempt_id: attempt?.attempt_id,
  });
  await pipeline.recordActionReceipt('provider_attempt_registered', {
    action: dispatchAction, attempt_id: attempt?.attempt_id,
  });
  let response;
  let partition;
  try {
    await execution.hooks.provider_await_point({
      await_point: 'provider_request', progress: true,
      active_provider_attempt_id: attempt?.attempt_id,
      root_obligation_id: pipeline.rootObligationId,
      child_obligation_id: pipeline.leafObligationId,
      source_range: range,
    });
    await pipeline.recordActionReceipt('provider_request_started', {
      action: dispatchAction, attempt_id: attempt?.attempt_id,
    });
    const batch = await pipeline.executeSelectedAction(dispatchAction,
      () => dispatchMultiOwnerLongtermBatch({
        request, owners, source_indices: sourceMessages.map((_, index) => index),
        dispatch: () => (options.provider ?? generateMemoryExtract)(request.prompt, {
          responseLength, systemPrompt: request.systemPrompt,
          providerConstraints: request.providerConstraints,
        }),
      }), { attempt_id: attempt?.attempt_id });
    response = batch.response;
    partition = batch.partition;
    await pipeline.recordActionReceipt('provider_response_received', {
      action: dispatchAction, attempt_id: attempt?.attempt_id,
    });
  } catch (error) {
    error.sme_origin ??= 'provider_transport';
    error.sme_request_diagnostics ??= {};
    error.sme_request_diagnostics.transport_started = true;
    error.sme_request_diagnostics.transport_completed = false;
    finishProviderAttempt(metadata, attempt, { terminal_outcome: 'provider_failure',
      recoverable: true, failure_classification: 'provider_transport_failure' });
    await pipeline.applyProviderCompletion({
      attempt_id: attempt?.attempt_id, transport_status: 'failed', terminal: false,
      reason_code: 'provider_transport_failure', next_action: 'dispatch_bounded_recovery_attempt',
    });
    healthFinish({ terminal_health: 'provider_failure', provider_outcome: 'provider_failure',
      attention_reason_codes: ['provider_transport_failure'] });
    throw fail(error);
  }
  let journalEntry = recordProviderCompletion(metadata, attempt, {
    child_key: pipeline.leafObligationId, response_text: response,
    owner_scope: owners,
  });
  await execution.hooks.provider_completion_journal_updated(journalEntry, {
    await_point: 'response_parse', progress: true,
  });
  const responseIngress = await pipeline.ingestProviderEvidence('record_new_response', { attempt });
  if (!['applied', 'idempotent_duplicate_verified'].includes(responseIngress.status)) {
    const error = new Error('Multi-owner response could not enter the lifecycle.');
    error.code = 'SME_PROVIDER_RESPONSE_INGRESS_REJECTED';
    error.sme_origin = 'internal_invariant';
    error.sme_request_diagnostics = responseIngress;
    throw fail(error);
  }
  if (partition.status === 'malformed') {
    finishProviderAttempt(metadata, attempt, { terminal_outcome: 'malformed_output', recoverable: true });
    journalEntry = recordProviderCompletion(metadata, attempt, {
      child_key: pipeline.leafObligationId,
      parser_result: { status: 'rejected', accepted_count: 0 },
      validation: { status: 'not_applicable', accepted_count: 0 },
      persistence: { status: 'not_required', durable_record_ids: [] },
    });
    await execution.hooks.provider_completion_journal_updated(journalEntry, {
      await_point: 'bounded_recovery', progress: true,
    });
    await pipeline.applyProviderCompletion({
      attempt_id: attempt?.attempt_id, terminal: false,
      raw_response_reference: { retained: true, journal_attempt_id: attempt?.attempt_id },
      parser_outcome: { status: 'rejected', accepted_candidate_ids: [],
        rejected_fragment_ids: ['multi-owner-contract'] },
      validation_outcome: { status: 'not_applicable', accepted_candidate_ids: [] },
      persistence_outcome: { status: 'not_required', durable_record_ids: [],
        durable_record_candidate_map: {}, source_provenance: {} },
      recovery_capsule: { private_fragment_payload_available: false,
        source_backed_regeneration_available: true,
        recovery_stage: 'multi_owner_source_backed_regeneration', protocol: request.protocol },
      reason_code: 'malformed_multi_owner_contract',
      next_action: 'dispatch_bounded_recovery_attempt',
    });
    const depth = Number(execution.recovery.malformed_depth ?? 0);
    if (sourceMessages.length > 1 && depth < 8) {
      const midpoint = Math.ceil(sourceMessages.length / 2);
      const children = [sourceMessages.slice(0, midpoint), sourceMessages.slice(midpoint)]
        .filter((child) => child.length > 0);
      const childDescriptors = children.map((child) => {
        const childRange = sourceRange(child);
        const childFingerprint = sourceWindowFingerprint(child);
        return {
          obligation_id: `${pipeline.rootObligationId}:leaf:${childRange.start}-${childRange.end}:${childFingerprint}`,
          tier: 'longterm', owner: OWNER_SCOPE,
          source_range: childRange, source_fingerprint: childFingerprint,
        };
      });
      await pipeline.emitLifecycleEvent('recovery_children_declared', {
        children: childDescriptors,
        exact_reason_code: 'malformed_multi_owner_contract_repartitioned',
      });
      let schedule;
      try {
        schedule = await createMemorizeRecoveryScheduler().run({
        tasks: children,
        keyOf: (child) => {
          const childRange = sourceRange(child);
          return `longterm:multi:${childRange.start}-${childRange.end}:${sourceWindowFingerprint(child)}`;
        },
        completedKeys: execution.recovery.completed_child_keys,
        shouldSkip: async (child) => {
          const childRange = sourceRange(child);
          const childId = `${pipeline.rootObligationId}:leaf:${childRange.start}-${childRange.end}:${sourceWindowFingerprint(child)}`;
          const canonical = await execution.hooks.get_canonical_obligation(
            childId, metadata?.active_catchup_run_id ?? null);
          return canonical?.checkpoint_eligible === true
            ? { skip: true, terminal: true } : { skip: false };
        },
        execute: async (child) => {
          const childRange = sourceRange(child);
          const childFingerprint = sourceWindowFingerprint(child);
          let childOwnerCoverage = null;
          let childAdded = 0;
          const childSchedule = await createMemorizeRecoveryScheduler().runOutcomes({
            maximum_attempts: Math.max(1, Number(settings.provider_max_retries ?? 5) + 1),
            execute: async ({ action, attempt_index: recoveryAttempt }) => {
              const childOwners = childOwnerCoverage?.owners_requiring_recovery?.length
                ? childOwnerCoverage.owners_requiring_recovery : owners;
              const outcome = await extractAndStoreMultiOwnerMemories(childOwners, child, statusFn, {
                ...options, liveHealth: null, priorOwnerCoverage: childOwnerCoverage,
                recoveryAttempt,
                executionContext: extendMemorizeExecutionContext(execution, {
                  provider: {
                    root_obligation_id: pipeline.rootObligationId,
                    root_source_range: execution.provider.root_source_range ?? range,
                    root_source_fingerprint: execution.provider.root_source_fingerprint
                      ?? sourceFingerprint,
                    parent_obligation_id: pipeline.leafObligationId,
                    parent_attempt_id: attempt?.attempt_id,
                    request_kind: action === 'recover_missing_owner_coverage'
                      ? 'multi_owner_recovery' : 'malformed_repartition_child',
                    selected_recovery_action: action === 'recover_missing_owner_coverage'
                      ? action : 'dispatch_provider_request',
                    changed_recovery_dimensions: action === 'recover_missing_owner_coverage'
                      ? ['missing_owner_subset', `recovery_pass_${recoveryAttempt}`]
                      : ['source_range', 'multi_owner_contract_size'],
                    resumed_pending_obligation: action === 'recover_missing_owner_coverage',
                    root_obligation_state: null,
                  },
                  recovery: { malformed_depth: depth + 1 },
                }),
                source_range: childRange,
                source_fingerprint: childFingerprint,
              });
              childOwnerCoverage = outcome.owner_coverage ?? childOwnerCoverage;
              childAdded += Number(outcome.value?.added ?? 0);
              return outcome;
            },
          });
          return { committed: childSchedule.decision === 'commit_obligation',
            added: childAdded, outcome: childSchedule.outcome,
            reason_code: childSchedule.reason_code };
        },
        onCommitted: async (child, { key }) => {
          const childRange = sourceRange(child);
          await execution.hooks.context_overflow_child_committed({
            key, tier: 'longterm', owner: OWNER_SCOPE,
            source_start_index: childRange.start,
            source_end_index: childRange.end,
            message_count: childRange.message_count,
            source_fingerprint: sourceWindowFingerprint(child),
            root_obligation_id: pipeline.rootObligationId,
            parent_obligation_id: pipeline.leafObligationId,
            depth: depth + 1,
            split_reason: 'malformed_multi_owner_contract',
            provider_parent_attempt_id: attempt?.attempt_id,
          });
        },
        });
      } catch (error) {
        healthFinish({ terminal_health: 'recovery_failure',
        provider_outcome: 'multi_owner_repartition_incomplete',
        parser_outcome: 'repartition_child_pending', persistence: 'partial_valid_records_saved',
        attention_reason_codes: [error?.sme_reason_code ?? error?.code
          ?? 'multi_owner_repartition_failure'] });
        throw fail(error);
      }
      if (schedule.completed) {
        await pipeline.emitLifecycleEvent('parent_children_completed', {
          persistence_result: 'committed_children', coverage_result: 'safely_committed',
        });
        pipeline.recordCompletedCoverage('malformed_multi_owner_repartition_recovered');
        healthFinish({ terminal_health: 'completed_repartitioned',
          provider_outcome: 'malformed_multi_owner_repartition_recovered',
          parser_outcome: 'repartitioned', persistence: 'saved' });
        return createMemorizeTierOutcome({ kind: 'complete',
          reason_code: 'malformed_multi_owner_repartition_recovered',
          value: { status: 'completed_repartitioned', added: schedule.added,
            owners: {}, physical_provider_requests: 1 + schedule.executed,
            root_obligation_id: pipeline.rootObligationId } });
      }
      return createMemorizeTierOutcome({ kind: 'policy_paused',
        reason_code: schedule.pause_reason ?? 'malformed_multi_owner_recovery_incomplete',
        next_action: 'dispatch_bounded_recovery_attempt', provider_call_required: true,
        value: { root_obligation_id: pipeline.rootObligationId },
        evidence: { next_task_key: schedule.next_task_key,
          unattempted_task_keys: schedule.unattempted_task_keys } });
    }
    healthFinish({ terminal_health: 'paused_resumable',
      provider_outcome: 'malformed_multi_owner_contract',
      parser_outcome: 'bounded_recovery_required', persistence: 'not_required',
      attention_reason_codes: ['unparseable_provider_response'] });
    return createMemorizeTierOutcome({ kind: 'policy_paused',
      reason_code: 'malformed_multi_owner_contract',
      next_action: 'dispatch_bounded_recovery_attempt', provider_call_required: true,
      value: { root_obligation_id: pipeline.rootObligationId },
      evidence: { root_obligation_id: pipeline.rootObligationId,
        leaf_obligation_id: pipeline.leafObligationId,
        recovery_stage: 'malformed_multi_owner_contract',
        next_eligible_recovery_action: 'dispatch_bounded_recovery_attempt' } });
  }
  const originalIndices = sourceMessages.map((message, index) =>
    Number.isInteger(message.__sme_original_index) ? message.__sme_original_index : index);
  let ownerResults = {};
  const allDurableIds = [];
  const allCandidateMap = {};
  const allCandidateIds = [];
  let added = 0;
  ownerResults = await persistMultiOwnerLongtermPartitions({ owners, partition,
    prepare_records: async (owner, records) => {
      const structured = parseStructuredMemoryResponse(JSON.stringify({ records }), {
        tier: 'longterm', parse: parseExtractionOutput,
      });
      const parsed = structured.accepted ? structured.records : [];
      applyDirectProvenance(parsed, sourceMessages, 0, originalIndices);
      parsed.forEach((memory, index) => {
        memory._memorize_candidate_id ??=
          `multi-owner:${pipeline.leafObligationId}:${owner}:${index}`;
      });
      const candidateIdsForOwner = parsed.map((memory) => memory._memorize_candidate_id);
      allCandidateIds.push(...candidateIdsForOwner);
      return { records: parsed, candidate_ids: candidateIdsForOwner };
    },
    persist_partition: (owner, parsed) =>
      (options.persistPartition ?? persistLongtermOwnerPartition)(
        owner, parsed, sourceMessages, { targeted_replay: execution.recovery.targeted_replay }),
  });
  for (const result of Object.values(ownerResults)) {
    added += Number(result.added ?? 0);
    allDurableIds.push(...(result.durable_record_ids ?? []));
    Object.assign(allCandidateMap, result.durable_record_candidate_map ?? {});
  }
  const ownerCoverage = projectMultiOwnerCoverage({
    required_owners: requiredOwners,
    partitions: partition.partitions,
    no_update_owners: partition.no_update_owners,
    rejected: partition.rejected,
    owner_results: ownerResults,
    prior: options.priorOwnerCoverage,
  });
  const needsRecovery = !ownerCoverage.complete;
  const candidateIds = [...new Set(allCandidateIds)];
  const explicitNoUpdate = partition.accepted_record_count === 0
    && partition.no_update_owners.length === owners.length && !needsRecovery;
  finishProviderAttempt(metadata, attempt, {
    terminal_outcome: needsRecovery ? 'partial_valid_output' : 'completed',
    recoverable: needsRecovery, accepted_record_count: partition.accepted_record_count,
  });
  journalEntry = recordProviderCompletion(metadata, attempt, {
    child_key: pipeline.leafObligationId,
    parser_result: { status: explicitNoUpdate ? 'explicit_none'
      : needsRecovery ? 'partial' : 'accepted',
      accepted_count: partition.accepted_record_count,
      rejected_count: partition.rejected.length },
    validation: { status: explicitNoUpdate ? 'validated_no_update'
      : needsRecovery ? 'partial' : 'accepted',
      accepted_count: candidateIds.length },
    persistence: { status: explicitNoUpdate ? 'not_needed' : 'committed',
      durable_record_ids: allDurableIds },
  });
  await execution.hooks.provider_completion_journal_updated(journalEntry, {
    await_point: 'canonical_persistence', progress: true,
  });
  await pipeline.applyProviderCompletion({
    attempt_id: attempt?.attempt_id, terminal: !needsRecovery,
    raw_response_reference: { retained: true, journal_attempt_id: attempt?.attempt_id },
    parser_outcome: { status: explicitNoUpdate ? 'explicit_none'
      : needsRecovery ? 'partial' : 'accepted',
      accepted_candidate_ids: candidateIds,
      rejected_fragment_ids: partition.rejected.map((item) =>
        `owner-record:${item.record_index ?? 'unknown'}:${item.reason_code}`) },
    validation_outcome: { status: explicitNoUpdate ? 'validated_no_update'
      : needsRecovery ? 'partial' : 'accepted',
      accepted_candidate_ids: candidateIds },
    persistence_outcome: { status: explicitNoUpdate ? 'not_required' : 'committed',
      durable_record_ids: allDurableIds,
      durable_record_candidate_map: allCandidateMap,
      source_provenance: { source_indices: originalIndices } },
    ...(needsRecovery ? { recovery_capsule: {
      private_fragment_payload_available: false,
      source_backed_regeneration_available: true,
      recovery_stage: 'missing_owner_coverage_recovery', protocol: request.protocol,
      owner_coverage: ownerCoverage,
      rejected_fragment_ids: partition.rejected.map((item) =>
        `owner-record:${item.record_index ?? 'unknown'}:${item.reason_code}`),
      durable_record_ids: allDurableIds,
      durable_record_candidate_map: allCandidateMap,
    }, reason_code: 'missing_owner_coverage_recovery',
    next_action: 'recover_missing_owner_coverage' } : {}),
  });
  if (needsRecovery) {
    healthFinish({ terminal_health: 'automatic_recovery_pending',
      provider_outcome: 'partial_multi_owner_contract',
      parser_outcome: 'partial', persistence: 'partial_valid_records_saved',
      attention_reason_codes: ['missing_owner_coverage_recovery'] });
    return createMemorizeTierOutcome({ kind: 'partial_recoverable',
      reason_code: 'missing_owner_coverage_recovery',
      next_action: 'recover_missing_owner_coverage', provider_call_required: true,
      recovery_dimension: `missing-owner-pass:${recoveryAttempt}:${
        ownerCoverage.owners_requiring_recovery.join('|')}`,
      accepted_owners: ownerCoverage.owners_with_accepted_records,
      explicit_no_update_owners: ownerCoverage.owners_with_explicit_no_update,
      missing_owners: ownerCoverage.owners_requiring_recovery,
      rejected_owners: ownerCoverage.owners_with_rejected_output,
      durable_receipts: allDurableIds, owner_coverage: ownerCoverage,
      value: { status: 'partial_recoverable', added, owners: ownerResults,
        physical_provider_requests: 1, root_obligation_id: pipeline.rootObligationId },
      evidence: { rejected_reason_codes:
        [...new Set(partition.rejected.map((item) => item.reason_code))] },
    });
  }
  pipeline.recordCompletedCoverage('completed_multi_owner');
  healthFinish({ terminal_health: 'completed', provider_outcome: 'completed',
    parser_outcome: explicitNoUpdate ? 'explicit_none' : 'accepted',
    persistence: explicitNoUpdate ? 'not_needed' : 'saved',
    candidates: { accepted: partition.accepted_record_count,
      rejected: partition.rejected.length } });
  return createMemorizeTierOutcome({ kind: explicitNoUpdate ? 'complete_no_update' : 'complete',
    reason_code: 'completed_multi_owner', accepted_owners:
      ownerCoverage.owners_with_accepted_records,
    explicit_no_update_owners: ownerCoverage.owners_with_explicit_no_update,
    durable_receipts: allDurableIds, owner_coverage: ownerCoverage,
    value: { status: 'completed', added, owners: ownerResults,
      physical_provider_requests: 1, explicit_no_update_owners: partition.no_update_owners,
      owner_coverage: ownerCoverage, root_obligation_id: pipeline.rootObligationId },
  });
}
