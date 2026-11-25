import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { META_KEY, MODULE_NAME } from '../constants.js';
import { runMemorizeStartupReleaseGate } from '../memorize-architecture-gates.js';

const transactionUrl = new URL('../catchup-transaction.js', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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
  beginCatchUpTransaction, createCatchUpTransactionLease,
  getActiveCatchUpTransactionSnapshot, mutateAndCheckpointCatchUpTransaction,
  rollbackCatchUpTransaction, saveChatMetadata,
} = await import(transactionUrl);
hooks.deregister();

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
