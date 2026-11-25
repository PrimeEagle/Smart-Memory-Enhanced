import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { META_KEY, MODULE_NAME } from '../constants.js';
import { runMemorizeStartupReleaseGate } from '../memorize-architecture-gates.js';
import { finalizeMemorizeController } from '../memorize-controller-finalizer.js';
import { selectDiagnosticsProjection } from '../memorize-projections.js';
import { retainResponseBeforeReceipt } from '../memorize-tier-pipeline.js';
import { recordProviderCompletion, exportProviderCompletionJournal } from '../provider-completion-journal.js';
import { applyMemorizeLifecycleEvent, createMemorizeObligationLedger } from '../memorize-obligation-ledger.js';
import { selectMemorizeSourceTierWork, stageMemorizeSourceCheckpoint } from '../memorize-authority-model.js';
import { createMemorizeExecutionContext } from '../memorize-execution-context.js';
import { createRuntimeEffectExecutor } from '../runtime-effect-executor.js';
import { createMemorizeExecutionAggregate } from '../memorize-execution-kernel.js';
import { prepareMemorizeUnitOfWork, markMemorizeRecordsApplied, commitMemorizeUnitOfWork } from '../memorize-unit-of-work.js';

const transactionUrl = new URL('../catchup-transaction.js', import.meta.url).href;
const longtermRuntimeUrl = new URL('../multi-owner-longterm-runtime.js', import.meta.url).href;
const sessionRuntimeUrl = new URL('../session.js', import.meta.url).href;
const stub = (source) => ({ shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` });

test('the first diagnostic save contains the recorded exit and exports its original failure', async () => {
  let saved;
  const failure = Object.assign(new Error('scripted receipt write failure'), {
    code: 'SME_RECEIPT_WRITE_FAILED',
  });
  await finalizeMemorizeController({
    primary_error: failure,
    record_exit: ({ primary_failure: primary }) => ({
      controller_invocation_id: 'first-chunk',
      reason_code: primary.code,
      bounded_message: primary.bounded_message,
      failure_stage: 'action_receipt',
    }),
    persist_diagnostics: ({ exit }) => {
      saved = JSON.stringify({ status: 'incomplete', controller_exit: exit });
    },
  });
  const completedRun = JSON.parse(saved);
  for (const current of [{}, { invalid_section: Infinity }]) {
    const report = selectDiagnosticsProjection({ completedRun, current });
    assert.equal(report.root_error.code, failure.code);
    assert.equal(report.root_error.message, failure.message);
    assert.equal(report.root_error.failure_stage, 'action_receipt');
  }
});
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ([longtermRuntimeUrl, sessionRuntimeUrl].includes(context.parentURL)) {
      if (specifier === '../../../extensions.js') return stub(
        `export const extension_settings = {${JSON.stringify(MODULE_NAME)}: {session_enabled:true}};
         export const getContext = () => globalThis.smeTestExtractionContext;`);
      if (specifier === './generate.js') return stub(
        `export const generateMemoryExtract = (...args) => globalThis.smeTestSessionProvider(...args);
         export const getMemoryProviderCapabilities = () => ({});
         export const getMemoryRequestBudget = () => ({
           configuredContextLimit: 8192, effectiveContextLimit: 8192,
           reservedOutputTokens: 600, safetyMargin: 128, protocolOverhead: 128,
           runtimeContextLookup: {status:'miss'},
         });`);
      if (specifier === './longterm.js') return stub(
        `export const createLongtermOwnerPersistenceExecutor = () => { throw new Error('Unexpected record write'); };
         export const prepareLongtermOwnerPersistencePlan = createLongtermOwnerPersistenceExecutor;
         export const loadCharacterMemories = createLongtermOwnerPersistenceExecutor;
         export const formatMemoriesForPrompt = createLongtermOwnerPersistenceExecutor;`);
    }
    if (context.parentURL === sessionRuntimeUrl) {
      if (specifier === '../../../../script.js') return stub(
        `export const getCurrentChatId = () => globalThis.smeTestExtractionContext.chatId;
         export const setExtensionPrompt = () => {};
         export const extension_prompt_types = {}, extension_prompt_roles = {};`);
      if (specifier === './prompt-config.js') return stub(
        'export const applyPromptOverride = prompt => prompt, PROMPT_TASKS = {};');
      if (specifier === './macros.js') return stub('export const MACRO_NAMES = {}, setMacroContent = () => {}, isMacroActive = () => false;');
      if (specifier === './logging.js') return stub('export const smLog = () => {};');
      if (specifier === './unified-inject.js') return stub('export const invalidateUnifiedCache = () => {};');
      const unused = {
        './graph-migration.js': ['loadSessionEntityRegistry', 'saveSessionEntityRegistry',
          'resolveEntityNames', 'reconcileCanonicalEntityRegistry', 'reconcileEntityRegistry'],
        './embeddings.js': ['batchVerify', 'getEmbeddingBatch', 'cosineSimilarity', 'getHardwareProfile'],
      }[specifier];
      if (unused) return stub(unused.map((name) =>
        `export const ${name} = () => { throw new Error('Unexpected test call: ${name}'); };`).join('\n'));
    }
    if (context.parentURL === transactionUrl) {
      if (specifier === '../../../../script.js') {
        return { shortCircuit: true, url: 'data:text/javascript,export const getRequestHeaders = () => ({}), saveSettingsDebounced = () => {}, saveChat = () => globalThis.smeTestSaveChat()' };
      }
      if (specifier === '../../../extensions.js') {
        const settings = JSON.stringify({ [MODULE_NAME]: {} });
        return { shortCircuit: true, url: `data:text/javascript,export const extension_settings = ${encodeURIComponent(settings)}` };
      }
    }
    return nextResolve(specifier, context);
  },
});
const {
  beginCatchUpTransaction, commitCatchUpTransaction, createCatchUpTransactionLease,
  getActiveCatchUpTransactionSnapshot, mutateAndCheckpointCatchUpTransaction,
  rollbackCatchUpTransaction, saveChatMetadata,
} = await import(transactionUrl);
const { extractAndStoreMultiOwnerMemories } = await import(longtermRuntimeUrl);
const { extractSessionMemories } = await import(sessionRuntimeUrl);
hooks.deregister();

for (const mode of ['no-update', 'record', 'receipt-failure']) {
test(mode === 'record' ? 'real Long-Term and Session adapters complete the same chunk across reload'
  : `real Long-Term adapter: ${mode}`, async () => {
  const rejectReceipt = mode === 'receipt-failure';
  const producesRecord = mode === 'record';
  const logical_run_id = 'real-longterm-first-chunk';
  let metadata = { active_catchup_run_id: logical_run_id,
    ledger: createMemorizeExecutionAggregate(logical_run_id) };
  let context = { chatId: 'longterm-test', groupId: 'group-test',
    groups: [{ id: 'group-test', chat_id: 'longterm-test' }],
    chatMetadata: { [META_KEY]: metadata } };
  globalThis.smeTestExtractionContext = context;
  let saved;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, request) => {
    assert.equal(url, '/api/chats/group/save');
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body);
    assert.equal(body.id, context.chatId);
    saved = body.chat[0].chat_metadata[META_KEY];
    return { ok: true };
  };
  let transaction = beginCatchUpTransaction(context);
  const persist = (mutate) => mutateAndCheckpointCatchUpTransaction(transaction,
    createCatchUpTransactionLease(transaction), async () => {
      const result = mutate();
      await saveChatMetadata(context);
      return result;
    });
  const failure = new Error('scripted local receipt failure');
  let calls = 0;
  const didReply = JSON.stringify(producesRecord ? {
    records: [{ owner: 'A', type: 'fact', content: 'A keeps a blue bicycle.',
      source_indices: [1], importance: 2, expiration: 'permanent' }],
    no_update_owners: ['B'],
  } : { records: [], no_update_owners: ['A', 'B'] });
  try {
    const makeExecutionContext = (page = 'real-longterm') => createMemorizeExecutionContext({
      controller: { lifecycle_required: true, instance_id: 'controller:real-longterm',
        page_instance_id: `page:${page}`,
        transaction_id: transaction.transaction_id, transaction_generation: transaction.generation },
      provider: { selected_recovery_action: 'dispatch_provider_request' },
      hooks: {
        obligation_event: async (event) => (await persist(() => {
          const { provider_state_proposal: proposal, ...transition } = event;
          if (proposal) {
            metadata.live_memory_health ??= {};
            metadata.live_memory_health.provider_attempt_audit = proposal.provider_attempt_audit;
            metadata.provider_completion_journal = proposal.provider_completion_journal;
          }
          return applyMemorizeLifecycleEvent(metadata.ledger, { ...transition, logical_run_id }, transition);
        })).value,
        get_canonical_obligation: (id) => metadata.ledger.obligations[id],
        action_receipt: async ({ phase }) => {
          if (rejectReceipt && phase === 'provider_response_received') throw failure;
          return { status: 'applied' };
        },
        provider_await_point: async () => {},
        provider_completion_journal_updated: () => persist(() => null),
        provider_completion_command: async (command) => {
          assert.equal(rejectReceipt, false, 'receipt failure must stop downstream completion');
          return (await persist(() => {
            const prepared = prepareMemorizeUnitOfWork({
              aggregate: metadata.ledger,
              checkpoint: { starting_source_offset: 0, next_source_offset: 0 },
              unit_of_work_journal: [],
            }, command);
            const marked = markMemorizeRecordsApplied(prepared.state, command.command_id, {
              persistence_status: command.persistence_outcome.status,
              durable_record_ids: command.persistence_outcome.durable_record_ids,
            });
            const committed = commitMemorizeUnitOfWork(marked.state, command.command_id);
            metadata.ledger = committed.state.aggregate;
            return committed;
          })).value;
        },
      },
    });
    const messages = Array.from({ length: 20 }, (_, i) => ({
      name: i % 2 ? 'A' : 'B', mes: i === 1 ? 'I keep a blue bicycle.' : `Fixture message ${i}`, __sme_original_index: i,
    }));
    context.chat = messages;
    const recordId = 'saved-bicycle';
    const run = extractAndStoreMultiOwnerMemories(['A', 'B'], messages, null, {
      executionContext: makeExecutionContext(),
      preparePersistencePlan: (owner, records) => {
        assert.equal(producesRecord, true);
        assert.equal(owner, 'A');
        assert.equal(records.length, 1);
        const record = records[0];
        assert.match(record.content, /blue bicycle/);
        return { operation_type: 'test_owner_write', owner,
          record: { id: recordId, content: record.content },
          added: 1, durable_record_ids: [recordId],
          durable_record_candidate_map: { [recordId]: record._memorize_candidate_id } };
      },
      persistenceExecutor: createRuntimeEffectExecutor({
        test_owner_write: async (plan) => {
          metadata.saved_records ??= [];
          metadata.saved_records.push(plan.record);
          await saveChatMetadata(context);
          return { owner: plan.owner, status: 'committed', added: 1,
            durable_record_ids: plan.durable_record_ids,
            durable_record_candidate_map: plan.durable_record_candidate_map };
        },
      }),
      provider: async () => {
        calls++;
        assert.equal(Object.values(saved.ledger.obligations)[0].current_state, 'provider_running');
        assert.equal(saved.live_memory_health.provider_attempt_audit.recent_attempts[0].transmission_started, true);
        return didReply;
      },
    });
    if (rejectReceipt) {
      await assert.rejects(run, (error) => error === failure && error.sme_origin !== 'provider_transport');
    } else {
      const outcome = await run;
      assert.equal(outcome.kind, producesRecord ? 'complete' : 'complete_no_update');
      const checkpoint = { run_manifest: { logical_run_id,
        source_window: { message_count: 20 }, obligation_ledger: saved.ledger } };
      metadata.catch_up_checkpoint = checkpoint;
      const enabled_tiers = producesRecord ? ['longterm', 'session'] : ['longterm'];
      const coverageOptions = { source_message_count: 20, chunk_size: 20, enabled_tiers };
      stageMemorizeSourceCheckpoint(checkpoint, coverageOptions);
      await saveChatMetadata(context);
      await commitCatchUpTransaction(transaction);
      assert.equal(saved.catch_up_checkpoint.next_source_offset, producesRecord ? 0 : 20);
      assert.equal(selectMemorizeSourceTierWork(
        saved.catch_up_checkpoint.run_manifest.obligation_ledger,
        { start: 0, end: 19 }, ['longterm']).longterm.dispatch, false);
      if (producesRecord) {
        assert.deepEqual(saved.saved_records, [{ id: recordId, content: 'A keeps a blue bicycle.' }]);
        assert.ok(Object.values(saved.provider_completion_journal.entries)[0]
          .persistence.durable_record_ids.includes(recordId));
        metadata = structuredClone(saved);
        context = { ...context, chatMetadata: { [META_KEY]: metadata } };
        globalThis.smeTestExtractionContext = context;
        transaction = beginCatchUpTransaction(context, { page_instance_id: 'page:reloaded' });
        const range = { start: 0, end: 19 };
        const work = selectMemorizeSourceTierWork(metadata.ledger, range, enabled_tiers);
        assert.equal(work.longterm.dispatch, false);
        assert.equal(work.session.dispatch, true);
        let sessionCalls = 0;
        globalThis.smeTestSessionProvider = async () => {
          sessionCalls++;
          const leaf = Object.values(saved.ledger.obligations).find((item) => item.tier === 'session');
          assert.equal(leaf.current_state, 'provider_running');
          return 'NONE';
        };
        assert.equal(await extractSessionMemories(messages, null, {
          executionContext: makeExecutionContext('reloaded'),
        }), 0);
        metadata.catch_up_checkpoint.run_manifest.obligation_ledger = metadata.ledger;
        stageMemorizeSourceCheckpoint(metadata.catch_up_checkpoint, coverageOptions);
        await saveChatMetadata(context);
        await commitCatchUpTransaction(transaction);
        assert.equal(saved.catch_up_checkpoint.next_source_offset, 20);
        assert.deepEqual(saved.saved_records.map((record) => record.id), [recordId]);
        assert.equal(sessionCalls, 1);
        const repeat = selectMemorizeSourceTierWork(
          saved.catch_up_checkpoint.run_manifest.obligation_ledger, range, enabled_tiers);
        assert.equal(repeat.longterm.dispatch, false);
        assert.equal(repeat.session.dispatch, false);
      }
    }
    assert.equal(calls, 1);
    const entry = Object.values(saved.provider_completion_journal.entries)[0];
    assert.equal(entry.response_text, didReply);
  } finally {
    if (transaction.state === 'active') rollbackCatchUpTransaction(transaction);
    delete globalThis.smeTestExtractionContext;
    delete globalThis.smeTestSessionProvider;
    globalThis.fetch = fetchBefore;
  }
});
}

test('first two-tier chunk advances durable coverage only after both tiers settle', async () => {
  const logical_run_id = 'first-chunk';
  const range = { start: 0, end: 19, message_count: 20 };
  const tiers = ['longterm', 'session'];
  const metadata = { catch_up_checkpoint: { next_source_offset: 0, run_manifest: {
    logical_run_id, source_window: { message_count: 20 },
    obligation_ledger: createMemorizeObligationLedger(logical_run_id),
  } } };
  let context = { chatId: 'first-chunk', chatMetadata: { [META_KEY]: metadata } };
  let disk;
  let active;
  const requested = [];
  globalThis.smeTestSaveChat = async () => { disk = JSON.stringify(context.chatMetadata); };
  const settleTier = (tier) => {
    const manifest = context.chatMetadata[META_KEY].catch_up_checkpoint.run_manifest;
    requested.push(tier);
    applyMemorizeLifecycleEvent(manifest.obligation_ledger, {
      logical_run_id, tier, owner: tier === 'longterm' ? '@multi-owner' : null,
      obligation_id: `${tier}:first-chunk`,
      source_range: range, source_fingerprint: 'test-source',
    }, {
      type: 'leaf_coverage_completed', verified_coverage: true,
      persistence_result: 'verified_existing', durable_record_ids: [],
    });
  };
  const commit = async () => {
    const checkpoint = context.chatMetadata[META_KEY].catch_up_checkpoint;
    stageMemorizeSourceCheckpoint(checkpoint, {
      source_message_count: 20, chunk_size: 20, enabled_tiers: tiers,
    });
    await saveChatMetadata(context);
    await commitCatchUpTransaction(active);
    return JSON.parse(disk)[META_KEY].catch_up_checkpoint;
  };
  try {
    active = beginCatchUpTransaction(context);
    settleTier('longterm');
    const partial = await commit();
    assert.equal(partial.next_source_offset, 0);

    context = { chatId: context.chatId, chatMetadata: JSON.parse(disk) };
    active = beginCatchUpTransaction(context);
    const ledger = context.chatMetadata[META_KEY].catch_up_checkpoint.run_manifest.obligation_ledger;
    const work = selectMemorizeSourceTierWork(ledger, range, tiers);
    assert.equal(work.longterm.dispatch, false);
    assert.equal(work.session.dispatch, true);
    for (const tier of tiers) if (work[tier].dispatch) settleTier(tier);
    const complete = await commit();
    assert.equal(complete.next_source_offset, 20);
    const afterCommit = selectMemorizeSourceTierWork(complete.run_manifest.obligation_ledger, range, tiers);
    assert.equal(afterCommit.longterm.dispatch, false);
    assert.equal(afterCommit.session.dispatch, false);
    assert.deepEqual(requested, ['longterm', 'session']);
  } finally {
    if (active?.state === 'active') rollbackCatchUpTransaction(active);
    delete globalThis.smeTestSaveChat;
  }
});

test('a failed local receipt save preserves the previously checkpointed provider response', async () => {
  const context = { chatId: 'receipt-failure', chatMetadata: { [META_KEY]: {} } };
  const transaction = beginCatchUpTransaction(context);
  const saveError = new Error('host rejected the action receipt');
  let saved;
  let saveCount = 0;
  globalThis.smeTestSaveChat = async () => {
    if (++saveCount === 2) throw saveError;
    saved = JSON.stringify(context.chatMetadata[META_KEY]);
  };
  const mutate = (callback) => mutateAndCheckpointCatchUpTransaction(transaction,
    createCatchUpTransactionLease(transaction), async () => {
      const value = callback(context.chatMetadata[META_KEY]);
      await saveChatMetadata(context);
      return value;
    });
  const attempt = {
    attempt_id: 'attempt-1', logical_run_id: 'run-1', tier: 'longterm',
    logical_obligation_id: 'longterm:root', root_obligation_id: 'longterm:root',
    transmission_started: true, source_range: { start: 0, end: 19, message_count: 20 },
  };
  try {
    await assert.rejects(retainResponseBeforeReceipt(
      () => mutate((metadata) => recordProviderCompletion(metadata, attempt,
        { child_key: 'longterm:root', response_text: 'scripted private response' })),
      () => mutate((metadata) => { metadata.action_receipt = 'provider_response_received'; }),
    ), (error) => error === saveError);
    assert.equal(saveCount, 2);
    const restored = context.chatMetadata[META_KEY];
    assert.deepEqual(restored, JSON.parse(saved));
    assert.equal(restored.action_receipt, undefined);
    assert.equal(restored.provider_completion_journal.entries['attempt-1'].response_text,
      'scripted private response');
    assert.doesNotMatch(JSON.stringify(exportProviderCompletionJournal(restored)), /scripted private response/);
  } finally {
    if (transaction.state === 'active') rollbackCatchUpTransaction(transaction);
    delete globalThis.smeTestSaveChat;
  }
});

for (const rejectSave of [false, true]) {
  test(`startup transaction ${rejectSave ? 'blocks dispatch when host save rejects' : 'persists registration before dispatch'}`, async () => {
    let transaction;
    let context;
    let eventType;
    const saved = new Map();
    const dispatched = [];
    const saveError = new Error('scripted host save failure');
    globalThis.smeTestSaveChat = async () => {
      if (rejectSave && eventType === 'provider_attempt_registered') throw saveError;
      saved.set(eventType, structuredClone(context.chatMetadata[META_KEY]));
    };
    try {
      const result = await runMemorizeStartupReleaseGate({
        persist_lifecycle: async ({ metadata, ledger, event, apply }) => {
          if (!transaction) {
            context = { chatId: 'startup', chatMetadata: { [META_KEY]: metadata } };
            transaction = beginCatchUpTransaction(context);
          }
          eventType = event.type;
          const lease = createCatchUpTransactionLease(transaction);
          const receipt = await mutateAndCheckpointCatchUpTransaction(transaction, lease, async () => {
            const outcome = apply();
            metadata.obligation_ledger = ledger;
            await saveChatMetadata(context);
            return outcome;
          });
          assert.equal(receipt.durable_mutation_performed, true);
          return receipt.value;
        },
        observe_dispatch: (attempt) => {
          dispatched.push({ id: attempt.attempt_id, registered: saved.get('provider_attempt_registered'),
            started: saved.get('provider_attempt_started') });
        },
      });
      if (rejectSave) {
        assert.equal(result.error, saveError);
        assert.equal(result.provider_transmissions, 0);
        assert.equal(dispatched.length, 0);
        assert.equal(context.chatMetadata[META_KEY].provider_completion_journal, undefined);
        assert.equal(context.chatMetadata[META_KEY].live_memory_health?.provider_attempt_audit, undefined);
        return;
      }
      assert.equal(result.provider_transmissions, 1);
      assert.equal(dispatched.length, 1);
      const { id, registered, started } = dispatched[0];
      assert.equal(registered.live_memory_health.provider_attempt_audit.recent_attempts.at(-1).attempt_id, id);
      assert.ok(registered.provider_completion_journal.entries[id]);
      assert.equal(Object.values(registered.obligation_ledger.obligations)[0].current_state, 'provider_registered');
      assert.equal(Object.values(started.obligation_ledger.obligations)[0].current_state, 'provider_running');
    } finally {
      if (transaction?.state === 'active') rollbackCatchUpTransaction(transaction);
      delete globalThis.smeTestSaveChat;
    }
  });
}

test('reopening saved metadata preserves committed work and rejects the old transaction lease', async () => {
  let context = { chatId: 'reload', chatMetadata: { [META_KEY]: { records: [], next_source_offset: 0 } } };
  let savedJson;
  let saves = 0;
  globalThis.smeTestSaveChat = async () => {
    saves++;
    savedJson = JSON.stringify(context.chatMetadata);
  };
  const first = beginCatchUpTransaction(context, { page_instance_id: 'original-page' });
  const firstLease = createCatchUpTransactionLease(first);
  let reopened;
  try {
    const write = async (id, offset) => {
      const metadata = context.chatMetadata[META_KEY];
      metadata.records.push(id);
      metadata.next_source_offset = offset;
      await saveChatMetadata(context);
    };
    assert.equal((await mutateAndCheckpointCatchUpTransaction(first, firstLease,
      () => write('first-record', 20))).allowed, true);
    await write('uncommitted-record', 40);
    rollbackCatchUpTransaction(first);

    context = { chatId: 'reload', chatMetadata: JSON.parse(savedJson) };
    assert.deepEqual(context.chatMetadata[META_KEY], { records: ['first-record'], next_source_offset: 20 });
    reopened = beginCatchUpTransaction(context, { page_instance_id: 'reloaded-page' });
    const stale = await mutateAndCheckpointCatchUpTransaction(first, firstLease,
      () => assert.fail('old page must not mutate the reopened chat'));
    assert.equal(stale.allowed, false);
    assert.equal(saves, 1);
    assert.equal((await mutateAndCheckpointCatchUpTransaction(reopened,
      createCatchUpTransactionLease(reopened), () => write('resumed-record', 40))).allowed, true);
    assert.deepEqual(JSON.parse(savedJson)[META_KEY], {
      records: ['first-record', 'resumed-record'], next_source_offset: 40,
    });
    assert.equal(saves, 2);
  } finally {
    if (reopened?.state === 'active') rollbackCatchUpTransaction(reopened);
    if (first.state === 'active') rollbackCatchUpTransaction(first);
    delete globalThis.smeTestSaveChat;
  }
  assert.equal(getActiveCatchUpTransactionSnapshot(), null);
});
