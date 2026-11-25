import { createMemorizeExecutionContext } from './memorize-execution-context.js';
import { applyMemorizeLifecycleEvent, createMemorizeObligationLedger,
  projectMemorizeObligationLedger } from './memorize-obligation-ledger.js';
import { buildFullChatReplay, runMemorizeReplay } from './memorize-replay-harness.js';
import { createMemorizeTierPipeline } from './memorize-tier-pipeline.js';
import { assertSerializableDomain, cloneSerializableDomain }
  from './serializable-domain.js';
import { resetMemorizeRunMetadata } from './fresh-start-state.js';

function fingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

/** Whole-state release boundary for every durable or projected value. */
export function assertMemorizeArchitectureAggregate(input = {}) {
  const aggregate = {
    persisted_metadata: input.persisted_metadata ?? null,
    commands: input.commands ?? [],
    outcomes: input.outcomes ?? [],
    receipts: input.receipts ?? [],
    diagnostics: input.diagnostics ?? null,
  };
  assertSerializableDomain(aggregate, {
    path: '$.memorize_architecture_aggregate',
    stage: 'whole_state_architecture_gate',
    operation_type: 'release_gate',
  });
  return cloneSerializableDomain(aggregate, {
    path: '$.memorize_architecture_aggregate',
    stage: 'whole_state_architecture_gate',
    operation_type: 'release_gate',
  });
}

/** Dispatch is legal only after the same attempt has a durable registration. */
export function assertProviderLifecycleOrdering(events = []) {
  const registered = new Set();
  for (const event of events) {
    const attemptId = event?.attempt_id ?? event?.provider_attempt_id;
    if (event?.type === 'provider_attempt_registered') registered.add(attemptId);
    if (event?.type === 'provider_attempt_started' && !registered.has(attemptId)) {
      const error = new Error(`Provider dispatch preceded durable registration for ${attemptId ?? 'unknown attempt'}.`);
      error.code = 'SME_PROVIDER_DISPATCH_BEFORE_REGISTRATION';
      throw error;
    }
  }
  return true;
}

/**
 * Fast production-module startup gate. The provider is a counter: no external
 * request is made, but registration and dispatch use the real tier pipeline,
 * audit, journal, and obligation reducer.
 */
export async function runMemorizeStartupReleaseGate({
  fault_at: faultAt = null,
  persist_lifecycle: persistLifecycle = async ({ apply }) => apply(),
  observe_dispatch: observeDispatch = () => {},
} = {}) {
  const logicalRunId = 'startup-release-gate';
  const metadata = {
    active_catchup_run_id: 'discarded-run',
    catch_up_checkpoint: { run_id: 'discarded-run', status: 'in_progress' },
    catch_up_diagnostics: { status: 'failed' },
    provider_completion_journal: { schema_version: -1 },
    live_memory_health: { extraction_session: { status: 'failed' } },
    page_run_lifecycle: { active_run_id: 'discarded-run' },
    preserved_chat_setting: 'preserved',
  };
  const freshStartReset = resetMemorizeRunMetadata(metadata);
  metadata.active_catchup_run_id = logicalRunId;
  const ledger = createMemorizeObligationLedger(logicalRunId, 1);
  const lifecycleEvents = [];
  let providerTransmissions = 0;
  const execution = createMemorizeExecutionContext({
    controller: { lifecycle_required: true, instance_id: 'controller:startup-gate',
      page_instance_id: 'page:startup-gate', transaction_id: 'tx:startup-gate',
      transaction_generation: 1 },
    provider: { selected_recovery_action: 'dispatch_provider_request' },
    hooks: {
      obligation_event: async (event) => {
        if (faultAt === event.type) throw Object.assign(
          new Error(`Injected startup fault at ${event.type}.`), {
            code: 'SME_INJECTED_RELEASE_GATE_FAILURE',
            sme_failure_stage: event.type,
          });
        const applied = await persistLifecycle({ metadata, event, ledger, apply: () => {
          const proposal = event.provider_state_proposal;
          if (proposal) {
            metadata.live_memory_health ??= {};
            metadata.live_memory_health.provider_attempt_audit = proposal.provider_attempt_audit;
            metadata.provider_completion_journal = proposal.provider_completion_journal;
          }
          return applyMemorizeLifecycleEvent(ledger, {
          obligation_id: event.obligation_id,
          root_obligation_id: event.root_obligation_id,
          leaf_obligation_id: event.leaf_obligation_id,
          logical_run_id: logicalRunId,
          tier: event.tier,
          owner: event.owner,
          source_range: event.source_range,
          source_fingerprint: event.source_fingerprint,
        }, { ...event, event_id: event.event_id
          ?? `startup:${event.type}:${lifecycleEvents.length}` });
        } });
        lifecycleEvents.push({ type: event.type,
          attempt_id: event.provider_attempt_id ?? null });
        return applied;
      },
      get_canonical_obligation: (id) => ledger.obligations[id] ?? null,
      action_receipt: async () => ({ status: 'applied' }),
      provider_completion_command: async () => ({ status: 'applied' }),
    },
  });
  const pipeline = createMemorizeTierPipeline({
    tier: 'session', tierLabel: 'Session', execution, metadata,
    range: { start: 0, end: 1, message_count: 2, source_indices: [0, 1] },
    rangeId: 'startup:0-1', coverageLedger: { records: [] },
    sourceFingerprint: 'startup-fingerprint', preflight: {
      configured_context_limit: 8192, effective_context_limit: 8192,
      reserved_output_tokens: 512, safety_margin_tokens: 128,
      protocol_overhead_tokens: 128, estimated_input_tokens: 100,
    }, requestBudget: {}, providerConfigSignature: 'release-gate-provider',
    chatId: 'release-gate-chat', expectedOutputFormat: 'session-v1',
  });
  await pipeline.emitLifecycleEvent('obligation_registered', {
    next_eligible_action: 'dispatch_provider_request',
  });
  let attempt = null;
  try {
    attempt = await pipeline.beginRegisteredAttempt();
    await pipeline.markProviderDispatchStarted(attempt);
    observeDispatch(attempt);
    providerTransmissions++;
  } catch (error) {
    const authoritativeAttempt = metadata.live_memory_health?.provider_attempt_audit
      ?.recent_attempts?.find((item) => item.attempt_id === attempt?.attempt_id) ?? null;
    return assertMemorizeArchitectureAggregate({ persisted_metadata: metadata,
      outcomes: [{ status: 'failed', code: error.code ?? null,
        failure_stage: error.sme_failure_stage ?? null }] }) && {
      status: 'failed', error, metadata, ledger, lifecycleEvents,
      provider_transmissions: providerTransmissions,
      fresh_start_reset: freshStartReset,
      authoritative_attempt: authoritativeAttempt,
      projection: projectMemorizeObligationLedger(ledger),
    };
  }
  assertProviderLifecycleOrdering(lifecycleEvents);
  assertMemorizeArchitectureAggregate({ persisted_metadata: metadata,
    outcomes: [{ status: 'provider_dispatched', attempt_id: attempt.attempt_id }] });
  return { status: 'provider_dispatched', attempt, metadata, ledger,
    lifecycleEvents, provider_transmissions: providerTransmissions,
    fresh_start_reset: freshStartReset,
    projection: projectMemorizeObligationLedger(ledger) };
}

/** Deterministic 9,434-message lifecycle, coverage, and idempotence gate. */
export function runMemorizeLongRunReleaseGate({ message_count: messageCount = 9434,
  chunk_size: chunkSize = 20, owners = ['owner'] } = {}) {
  const built = buildFullChatReplay(messageCount, chunkSize, owners);
  const fixture = { ...built, events: built.events.map((event, index) => ({
    ...event, at: index + 2,
  })) };
  const first = runMemorizeReplay(fixture);
  const second = runMemorizeReplay(fixture);
  const firstState = assertMemorizeArchitectureAggregate({
    persisted_metadata: { obligation_ledger: first.ledger },
    outcomes: [{ checkpoint: first.checkpoint,
      finalization_reachable: first.finalization_reachable }],
  });
  const secondState = assertMemorizeArchitectureAggregate({
    persisted_metadata: { obligation_ledger: second.ledger },
    outcomes: [{ checkpoint: second.checkpoint,
      finalization_reachable: second.finalization_reachable }],
  });
  const firstHash = fingerprint(JSON.stringify(firstState));
  const secondHash = fingerprint(JSON.stringify(secondState));
  return {
    message_count: messageCount,
    checkpoint: first.checkpoint,
    obligation_count: Object.keys(first.ledger.obligations).length,
    duplicate_record_count: first.duplicate_record_count,
    finalization_reachable: first.finalization_reachable,
    first_hash: firstHash,
    second_hash: secondHash,
    idempotent: firstHash === secondHash,
  };
}
