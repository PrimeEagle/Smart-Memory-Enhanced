import { extension_settings, getContext } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';
import { estimateTokens } from './constants.js';
import { generateMemoryExtract, getMemoryProviderCapabilities, getMemoryRequestBudget }
  from './generate.js';
import { applyDirectProvenance } from './grounding.js';
import { parseExtractionOutput } from './parsers.js';
import { buildMultiOwnerLongtermPrompt, dispatchMultiOwnerLongtermBatch,
  partitionMultiOwnerLongtermResponse, persistMultiOwnerLongtermPartitions }
  from './multi-owner-longterm.js';
import { buildStructuredMemoryProviderRequest, parseStructuredMemoryResponse }
  from './malformed-output-recovery.js';
import { sourceRange, sourceWindowFingerprint, makeExtractionPreflight }
  from './extraction-window-utils.js';
import { providerConfigurationSignature, finishProviderAttempt }
  from './provider-attempt-audit.js';
import { findCurrentRunProviderCompletion, recordProviderCompletion }
  from './provider-completion-journal.js';
import { extendMemorizeExecutionContext, resolveMemorizeExecutionContext }
  from './memorize-execution-context.js';
import { createMemorizeTierPipeline } from './memorize-tier-pipeline.js';
import { createMemorizeRecoveryScheduler } from './memorize-recovery-scheduler.js';
import { attachMemorizeOperationContext, createMemorizeOperationContext }
  from './memorize-operation-context.js';
import { createLongtermOwnerPersistenceExecutor,
  prepareLongtermOwnerPersistencePlan } from './longterm.js';
import { projectMultiOwnerCoverage } from './multi-owner-coverage.js';
import { createMemorizeTierOutcome } from './memorize-tier-outcome.js';
import { assignCandidateIdentity, candidateIdentityOf } from './candidate-identity.js';
import { executeEffectPlanAggregate, validateEffectPlanAggregate }
  from './runtime-effect-executor.js';
import { assertSerializableDomain } from './serializable-domain.js';

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
    next_eligible_action: ingress.next_action ?? 'dispatch_provider_request' };
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
  const canonicalBeforeDispatch = execution.controller.lifecycle_required
    ? await pipeline.getCanonicalObligation() : null;
  const replayAttemptId = canonicalBeforeDispatch?.provider_attempt_lineage?.at(-1) ?? null;
  const journaledCurrentCompletion = replayAttemptId
    ? findCurrentRunProviderCompletion(metadata, {
      logical_run_id: pipeline.lifecycleIdentity.logical_run_id,
      attempt_id: replayAttemptId,
      obligation_leaf_id: pipeline.leafObligationId,
      source_fingerprint: sourceFingerprint,
    }) : null;
  const journalReplayMode = Boolean(journaledCurrentCompletion?.response_text != null
    && execution.provider.selected_recovery_action === 'apply_journaled_provider_completion');
  const physicalProviderRequests = journalReplayMode ? 0 : 1;
  const dispatchAction = journalReplayMode ? 'apply_journaled_provider_completion'
    : execution.provider.selected_recovery_action === 'recover_missing_owner_coverage'
      ? 'recover_missing_owner_coverage' : 'dispatch_provider_request';
  pipeline.requireSelectedAction(dispatchAction);
  await pipeline.recordActionReceipt('action_selected', { action: dispatchAction });
  await pipeline.recordActionReceipt('action_started', { action: dispatchAction });
  const registration = journalReplayMode ? null
    : await pipeline.ingestProviderEvidence('register_new_attempt');
  if (registration?.status === 'operationally_paused') {
    const evidence = policyPauseEvidence(registration, pipeline.leafObligationId,
      pipeline.rootObligationId);
    healthFinish({ terminal_health: 'policy_paused', provider_outcome: 'not_dispatched',
      attention_reason_codes: [registration.reason_code] });
    return createMemorizeTierOutcome({ kind: 'policy_paused',
      reason_code: registration.reason_code,
      next_action: evidence.next_eligible_action, provider_call_required: false,
      evidence, value: { root_obligation_id: pipeline.rootObligationId } });
  }
  if (registration && registration.status !== 'applied') {
    const error = new Error('Multi-owner Long-Term provider attempt could not be registered.');
    error.code = 'SME_PROVIDER_ATTEMPT_REGISTRATION_FAILED';
    error.sme_origin = 'internal_invariant';
    error.sme_obligation_id = pipeline.leafObligationId;
    error.sme_request_diagnostics = registration;
    throw fail(error);
  }
  const attempt = journalReplayMode
    ? [...(metadata?.live_memory_health?.provider_attempt_audit?.recent_attempts ?? [])]
      .reverse().find((item) => item.attempt_id === replayAttemptId)
      ?? { ...journaledCurrentCompletion, attempt_id: replayAttemptId,
        logical_obligation_id: pipeline.rootObligationId,
        child_obligation_id: pipeline.leafObligationId }
    : registration.attempt;
  operationContext = createMemorizeOperationContext({
    ...operationContextInput, attempt_id: attempt?.attempt_id,
  });
  if (!journalReplayMode) await pipeline.recordActionReceipt('provider_attempt_registered', {
    action: dispatchAction, attempt_id: attempt?.attempt_id,
  });
  let response;
  let partition;
  try {
    if (journalReplayMode) {
      response = await pipeline.executeSelectedAction(dispatchAction,
        async () => journaledCurrentCompletion.response_text,
        { attempt_id: attempt?.attempt_id });
      partition = partitionMultiOwnerLongtermResponse(response, {
        allowed_owners: owners,
        source_indices: sourceMessages.map((_, index) => index),
      });
    } else {
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
    }
    await pipeline.recordActionReceipt('provider_response_received', {
      action: dispatchAction, attempt_id: attempt?.attempt_id,
    });
  } catch (error) {
    error.sme_origin ??= journalReplayMode ? 'internal_invariant' : 'provider_transport';
    error.sme_request_diagnostics ??= {};
    error.sme_request_diagnostics.transport_started = !journalReplayMode;
    error.sme_request_diagnostics.transport_completed = journalReplayMode;
    error.sme_request_diagnostics.provider_call_required = !journalReplayMode;
    if (journalReplayMode) {
      error.sme_reason_code ??= 'local_completion_replay_failure';
      error.sme_request_diagnostics.retry_eligible = false;
      error.sme_request_diagnostics.next_eligible_recovery_action = null;
      healthFinish({ terminal_health: 'local_replay_failure',
        provider_outcome: 'previous_response_retained',
        attention_reason_codes: ['local_completion_replay_failure'] });
      throw fail(error);
    }
    finishProviderAttempt(metadata, attempt, { terminal_outcome: 'provider_failure',
      recoverable: true, failure_classification: 'provider_transport_failure' });
    await pipeline.applyProviderCompletion({
      attempt_id: attempt?.attempt_id, transport_status: 'failed', terminal: false,
      reason_code: 'provider_transport_failure', next_action: 'dispatch_provider_request',
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
      next_action: 'dispatch_provider_request',
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
          await execution.hooks.recovery_child_completed({
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
            owners: {}, physical_provider_requests: physicalProviderRequests + schedule.executed,
            root_obligation_id: pipeline.rootObligationId } });
      }
      return createMemorizeTierOutcome({ kind: 'policy_paused',
        reason_code: schedule.pause_reason ?? 'malformed_multi_owner_recovery_incomplete',
        next_action: 'dispatch_provider_request', provider_call_required: true,
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
      next_action: 'dispatch_provider_request', provider_call_required: true,
      value: { root_obligation_id: pipeline.rootObligationId },
      evidence: { root_obligation_id: pipeline.rootObligationId,
        leaf_obligation_id: pipeline.leafObligationId,
        recovery_stage: 'malformed_multi_owner_contract',
        next_eligible_recovery_action: 'dispatch_provider_request' } });
  }
  const originalIndices = sourceMessages.map((message, index) =>
    Number.isInteger(message.__sme_original_index) ? message.__sme_original_index : index);
  let ownerPlans = {};
  const allDurableIds = [];
  const allCandidateMap = {};
  const allCandidateIds = [];
  let added = 0;
  ownerPlans = await persistMultiOwnerLongtermPartitions({ owners, partition,
    prepare_records: async (owner, records) => {
      const structured = parseStructuredMemoryResponse(JSON.stringify({ records }), {
        tier: 'longterm', parse: parseExtractionOutput,
      });
      const parsed = structured.accepted ? structured.records : [];
      applyDirectProvenance(parsed, sourceMessages, 0, originalIndices);
      parsed.forEach((memory, index) => {
        memory._memorize_candidate_id ??=
          `multi-owner:${pipeline.leafObligationId}:${owner}:${index}`;
        assignCandidateIdentity(memory, memory._memorize_candidate_id);
      });
      const candidateIdsForOwner = parsed.map((memory) => candidateIdentityOf(memory));
      allCandidateIds.push(...candidateIdsForOwner);
      return { records: parsed, candidate_ids: candidateIdsForOwner };
    },
    persist_partition: (owner, parsed) =>
      (options.preparePersistencePlan ?? prepareLongtermOwnerPersistencePlan)(
        owner, parsed, sourceMessages, {
          targeted_replay: execution.recovery.targeted_replay,
        }),
  });
  const persistenceExecutor = options.persistenceExecutor
    ?? createLongtermOwnerPersistenceExecutor(options.persistenceAdapters);
  assertSerializableDomain(ownerPlans, {
    path: '$.owner_persistence_plans', stage: 'owner_plan_aggregate_validation',
    operation_type: 'longterm_multi_owner_persistence_v1',
    obligation_id: pipeline.leafObligationId,
  });
  const effectPlans = Object.values(ownerPlans).filter((plan) => plan?.operation_type);
  validateEffectPlanAggregate(persistenceExecutor, effectPlans, {
    obligation_id: pipeline.leafObligationId,
  });
  for (const plan of Object.values(ownerPlans)) {
    added += Number(plan.added ?? 0);
    allDurableIds.push(...(plan.durable_record_ids ?? []));
    Object.assign(allCandidateMap, plan.durable_record_candidate_map ?? {});
  }
  const ownerCoverage = projectMultiOwnerCoverage({
    required_owners: requiredOwners,
    partitions: partition.partitions,
    no_update_owners: partition.no_update_owners,
    rejected: partition.rejected,
    owner_results: ownerPlans,
    prior: options.priorOwnerCoverage,
  });
  const needsRecovery = !ownerCoverage.complete;
  const candidateIds = [...new Set(allCandidateIds)];
  const explicitNoUpdate = partition.accepted_record_count === 0
    && partition.no_update_owners.length === owners.length && !needsRecovery;
  const sourceProvenance = { source_indices: originalIndices };
  const persistenceCompletionDetails = {
    attempt_id: attempt?.attempt_id, terminal: !needsRecovery,
    raw_response_reference: { retained: true, journal_attempt_id: attempt?.attempt_id },
    parser_outcome: { status: explicitNoUpdate ? 'explicit_none'
      : needsRecovery ? 'partial' : 'accepted',
    accepted_candidate_ids: candidateIds,
    rejected_fragment_ids: partition.rejected.map((item) =>
      `owner-record:${item.record_index ?? 'unknown'}:${item.reason_code}`) },
    validation_outcome: { status: explicitNoUpdate ? 'validated_no_update'
      : needsRecovery ? 'partial' : 'accepted', accepted_candidate_ids: candidateIds },
    persistence_outcome: { status: explicitNoUpdate ? 'not_required' : 'committed',
      durable_record_ids: allDurableIds, durable_record_candidate_map: allCandidateMap,
      source_provenance: allDurableIds.length ? sourceProvenance : {} },
    ...(needsRecovery ? { recovery_capsule: {
      private_fragment_payload_available: false, source_backed_regeneration_available: true,
      recovery_stage: 'missing_owner_coverage_recovery', protocol: request.protocol,
      owner_coverage: ownerCoverage,
      rejected_fragment_ids: partition.rejected.map((item) =>
        `owner-record:${item.record_index ?? 'unknown'}:${item.reason_code}`),
      durable_record_ids: allDurableIds, durable_record_candidate_map: allCandidateMap,
    }, reason_code: 'missing_owner_coverage_recovery',
    next_action: 'recover_missing_owner_coverage' } : {}),
  };
  if (pipeline.atomicCompletionEnabled) {
    pipeline.prepareProviderCompletion(persistenceCompletionDetails);
  }
  journalEntry = recordProviderCompletion(metadata, attempt, {
    child_key: pipeline.leafObligationId,
    parser_result: { status: explicitNoUpdate ? 'explicit_none'
      : needsRecovery ? 'partial' : 'accepted',
    accepted_count: partition.accepted_record_count,
    rejected_count: partition.rejected.length },
    parser_accepted_candidate_ids: candidateIds,
    validation: { status: explicitNoUpdate ? 'validated_no_update'
      : needsRecovery ? 'partial' : 'accepted', accepted_count: candidateIds.length },
    validation_accepted_candidate_ids: candidateIds,
    persistence: { status: 'prepared', durable_record_ids: [],
      durable_record_candidate_map: {}, source_provenance: {} },
    prepared_effect_plans: effectPlans,
  });
  await execution.hooks.provider_completion_journal_updated(journalEntry, {
    await_point: 'persistence_plan_prepared', progress: true,
  });
  // Plans contain data only. Validate the complete aggregate before allowing
  // the runtime-only executor to invoke the first storage adapter.
  const receiptEntries = Object.entries(ownerPlans)
    .filter(([, plan]) => !plan?.operation_type);
  try {
    const aggregateReceipt = await executeEffectPlanAggregate({
      executor: persistenceExecutor, plans: effectPlans,
      context: { obligation_id: pipeline.leafObligationId },
      hooks: { on_boundary: async (event) => {
        await options.persistenceHooks?.on_boundary?.(event);
        if (event.stage === 'before_effect') {
          await execution.hooks.provider_await_point({
            await_point: 'local_owner_persistence', progress: true,
            active_provider_attempt_id: attempt?.attempt_id,
            root_obligation_id: pipeline.rootObligationId,
            child_obligation_id: pipeline.leafObligationId,
            source_range: range,
          });
        }
      } },
    });
    for (const receipt of aggregateReceipt.receipts) {
      receiptEntries.push([receipt.owner, receipt]);
    }
  } catch (error) {
      error.sme_origin ??= error?.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
        ? 'programming_error' : 'persistence';
      error.sme_reason_code ??= error?.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
        ? 'non_serializable_domain_data' : 'persistence_failure';
      error.sme_request_diagnostics = {
        ...(error.sme_request_diagnostics ?? {}),
        provider_call_required: false,
        retry_eligible: false,
        failure_stage: error.sme_failure_stage ?? 'owner_effect_execution',
      };
      finishProviderAttempt(metadata, attempt, {
        terminal_outcome: 'downstream_failure', recoverable: false,
        failure_classification: error.sme_origin === 'programming_error'
          ? 'local_programming_defect' : 'local_persistence_failure',
      });
      journalEntry = recordProviderCompletion(metadata, attempt, {
        child_key: pipeline.leafObligationId,
        persistence: { status: 'rejected', durable_record_ids: [],
          durable_record_candidate_map: {}, source_provenance: {} },
        logical_disposition: 'local_failure_no_provider_retry',
      });
      await execution.hooks.provider_completion_journal_updated(journalEntry, {
        await_point: 'canonical_persistence_failure', progress: false,
      });
      const completedReceipts = error.sme_request_diagnostics?.completed_owner_receipts ?? [];
      const locallyDurableIds = completedReceipts.flatMap((receipt) =>
        receipt.durable_record_ids ?? []);
      const locallyDurableMap = Object.assign({}, ...completedReceipts.map((receipt) =>
        receipt.durable_record_candidate_map ?? {}));
      try {
        await pipeline.applyProviderCompletion({
          ...persistenceCompletionDetails,
          terminal: false,
          persistence_outcome: {
            status: locallyDurableIds.length ? 'committed' : 'rejected',
            durable_record_ids: locallyDurableIds,
            durable_record_candidate_map: locallyDurableMap,
            source_provenance: locallyDurableIds.length ? sourceProvenance : {},
          },
          reason_code: 'local_persistence_replay_required',
          next_action: 'apply_journaled_provider_completion',
        });
      } catch (lifecycleError) {
        error.sme_request_diagnostics.lifecycle_recording_failure = {
          code: lifecycleError?.code ?? null,
          reason_code: lifecycleError?.sme_reason_code ?? null,
        };
      }
      throw fail(error);
  }
  const ownerResults = Object.freeze(Object.fromEntries(receiptEntries));
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
    parser_accepted_candidate_ids: candidateIds,
    validation: { status: explicitNoUpdate ? 'validated_no_update'
      : needsRecovery ? 'partial' : 'accepted',
      accepted_count: candidateIds.length },
    validation_accepted_candidate_ids: candidateIds,
    persistence: { status: explicitNoUpdate ? 'not_needed' : 'committed',
      durable_record_ids: allDurableIds,
      durable_record_candidate_map: allCandidateMap,
      source_provenance: allDurableIds.length ? sourceProvenance : {} },
    durable_record_candidate_mappings: allCandidateMap,
    source_provenance: allDurableIds.length ? sourceProvenance : {},
    checkpoint_effect: { obligation_leaf_id: pipeline.leafObligationId,
      checkpoint_eligible_on_commit: !needsRecovery },
    prepared_effect_plans: [],
  });
  await execution.hooks.provider_completion_journal_updated(journalEntry, {
    await_point: 'canonical_persistence', progress: true,
  });
  await pipeline.applyProviderCompletion(persistenceCompletionDetails);
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
        physical_provider_requests: physicalProviderRequests,
        root_obligation_id: pipeline.rootObligationId },
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
      physical_provider_requests: physicalProviderRequests,
      explicit_no_update_owners: partition.no_update_owners,
      owner_coverage: ownerCoverage, root_obligation_id: pipeline.rootObligationId },
  });
}
