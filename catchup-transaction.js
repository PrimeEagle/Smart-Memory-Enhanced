/**
 * Staged persistence for Memorize Chat chunks. Storage helpers call
 * saveChatMetadata() as usual; while a transaction is active, it records that
 * metadata changed instead of saving intermediate, half-processed state.
 */
import { getRequestHeaders, saveChat, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';

let activeTransaction = null;
let transactionSequence = 0;

function transactionOwner(context, ownership = {}) {
  return {
    chat_id: context?.chatId ?? null,
    group_id: context?.groupId ?? null,
    logical_run_id: ownership.logical_run_id ?? null,
    attempt_number: ownership.attempt_number ?? null,
    page_instance_id: ownership.page_instance_id ?? null,
    phase: ownership.phase ?? null,
    tier: ownership.tier ?? null,
    owner: ownership.owner ?? null,
    source_range: ownership.source_range ?? null,
  };
}

function terminalSnapshot(transaction) {
  if (!transaction) return null;
  return {
    transaction_id: transaction.transaction_id,
    state: transaction.state,
    terminal_disposition: transaction.terminal_disposition ?? null,
    owner: structuredClone(transaction.owner ?? {}),
    metadata_dirty: transaction.metadataDirty === true,
    started_at: transaction.started_at ?? null,
    settled_at: transaction.settled_at ?? null,
    exact_reason_code: transaction.exact_reason_code ?? null,
  };
}

export function beginCatchUpTransaction(context, ownership = {}) {
  if (activeTransaction?.state === 'active') {
    const error = new Error('A Smart Memory catch-up transaction is already active.');
    error.code = 'SME_CATCHUP_TRANSACTION_ALREADY_ACTIVE';
    error.sme_transaction_state = terminalSnapshot(activeTransaction);
    throw error;
  }
  activeTransaction = {
    transaction_id: `catchup-tx-${Date.now()}-${++transactionSequence}`,
    state: 'active',
    terminal_disposition: null,
    owner: transactionOwner(context, ownership),
    started_at: Date.now(),
    settled_at: null,
    context,
    metadataExisted: Object.prototype.hasOwnProperty.call(context.chatMetadata ?? {}, META_KEY),
    metadataBefore: structuredClone(context.chatMetadata?.[META_KEY] ?? {}),
    settingsBefore: structuredClone(extension_settings[MODULE_NAME] ?? {}),
    metadataDirty: false,
  };
  return activeTransaction;
}

export function getActiveCatchUpTransactionSnapshot() {
  return activeTransaction?.state === 'active' ? terminalSnapshot(activeTransaction) : null;
}

function belongsToActiveTransaction(context) {
  if (!activeTransaction) return false;
  const activeContext = activeTransaction.context;
  // getContext() returns a new wrapper object in some SillyTavern call paths
  // (including Fresh Start's tier helpers). Those wrappers still point to the
  // same metadata object and chat identity, so object identity alone would
  // let an intermediate save bypass the transaction.
  return context === activeContext || (
    context.chatMetadata === activeContext.chatMetadata
    && (context.chatId ?? null) === (activeContext.chatId ?? null)
    && (context.groupId ?? null) === (activeContext.groupId ?? null)
  );
}

export async function saveChatMetadata(context) {
  if (belongsToActiveTransaction(context)) {
    activeTransaction.metadataDirty = true;
    return;
  }
  await context.saveMetadata();
}

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, structuredClone(snapshot));
}

export function rollbackCatchUpTransaction(transaction) {
  if (!transaction) return null;
  if (transaction.state !== 'active') return terminalSnapshot(transaction);
  const { context, metadataExisted, metadataBefore, settingsBefore } = transaction;
  try {
    if (!context.chatMetadata) context.chatMetadata = {};
    if (metadataExisted) context.chatMetadata[META_KEY] = structuredClone(metadataBefore);
    else delete context.chatMetadata[META_KEY];
    restoreObject(extension_settings[MODULE_NAME], settingsBefore);
    transaction.state = 'rolled_back';
    transaction.terminal_disposition = 'rolled_back';
    transaction.exact_reason_code ??= 'controller_requested_rollback';
  } catch (error) {
    transaction.state = 'rollback_failed_with_exact_state';
    transaction.terminal_disposition = 'rollback_failed_with_exact_state';
    transaction.exact_reason_code = 'transaction_snapshot_restore_failed';
    error.code ??= 'SME_CATCHUP_TRANSACTION_ROLLBACK_FAILED';
    error.sme_transaction_state = terminalSnapshot(transaction);
    throw error;
  } finally {
    transaction.settled_at = Date.now();
    if (activeTransaction === transaction) activeTransaction = null;
  }
  return terminalSnapshot(transaction);
}

function makeSaveError(response, label) {
  const error = new Error(`${label} responded with ${response.status}`);
  error.status = response.status;
  error.retryAfter = response.headers.get('Retry-After');
  return error;
}

async function saveGroupChatDirect(context) {
  const group = context.groups?.find((entry) => entry.id === context.groupId);
  if (!group?.chat_id) throw new Error('Cannot save group chat: the active group or chat ID was not found.');
  const header = { chat_metadata: { ...(context.chatMetadata ?? {}) }, user_name: 'unused', character_name: 'unused' };
  const response = await fetch('/api/chats/group/save', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ id: group.chat_id, chat: [header, ...(context.chat ?? [])], force: false }),
  });
  if (!response.ok) throw makeSaveError(response, 'Group chat save');
}

/** Commits the staged metadata with errors propagated to the caller. */
export async function commitCatchUpTransaction(transaction) {
  if (!transaction) throw new Error('Cannot commit a missing catch-up transaction.');
  if (transaction.state === 'committed') return terminalSnapshot(transaction);
  if (transaction.state !== 'active' || activeTransaction !== transaction) {
    const error = new Error('Cannot commit an inactive catch-up transaction.');
    error.code = 'SME_CATCHUP_TRANSACTION_INACTIVE_COMMIT';
    error.sme_transaction_state = terminalSnapshot(transaction);
    throw error;
  }
  try {
    if (transaction.metadataDirty) {
      if (transaction.context.groupId) await saveGroupChatDirect(transaction.context);
      else await saveChat();
    }
    transaction.state = 'committed';
    transaction.terminal_disposition = 'committed';
    transaction.settled_at = Date.now();
    activeTransaction = null;
    return terminalSnapshot(transaction);
  } catch (error) {
    try {
      rollbackCatchUpTransaction(transaction);
      transaction.state = 'commit_failed_with_exact_state';
      transaction.terminal_disposition = 'commit_failed_with_exact_state';
      transaction.exact_reason_code = 'durable_commit_failed_snapshot_restored';
      transaction.settled_at = Date.now();
    } catch (rollbackError) {
      rollbackError.cause ??= error;
      throw rollbackError;
    }
    error.code ??= 'SME_CATCHUP_TRANSACTION_COMMIT_FAILED';
    error.sme_transaction_state = terminalSnapshot(transaction);
    throw error;
  }
}

/**
 * Recovers a same-chat in-memory lock only after the controller has proven that
 * no handler is running. The caller supplies that proof; this function never
 * silently clears an active transaction.
 */
export function recoverStaleCatchUpTransaction(context, {
  controller_idle = false, reason_code = 'stale_in_memory_transaction_lock',
} = {}) {
  if (activeTransaction?.state !== 'active') return { recovered: false, reason_code: 'no_active_transaction' };
  if (!controller_idle) return { recovered: false, reason_code: 'controller_not_proven_idle', transaction: terminalSnapshot(activeTransaction) };
  if (!belongsToActiveTransaction(context)) return { recovered: false, reason_code: 'transaction_belongs_to_different_chat', transaction: terminalSnapshot(activeTransaction) };
  activeTransaction.exact_reason_code = reason_code;
  const transaction = activeTransaction;
  const settled = rollbackCatchUpTransaction(transaction);
  return { recovered: true, reason_code, transaction: settled };
}

/**
 * Persists a safe recovery subrange while keeping the enclosing chunk
 * transaction open. A later rollback returns to this newly committed boundary,
 * so completed overflow children are neither lost nor duplicated.
 */
export async function checkpointCatchUpTransaction(transaction) {
  if (!transaction || transaction !== activeTransaction || transaction.state !== 'active') throw new Error('Cannot checkpoint an inactive catch-up transaction.');
  try {
    saveSettingsDebounced();
    saveSettingsDebounced.flush?.();
    if (transaction.metadataDirty) {
      if (transaction.context.groupId) await saveGroupChatDirect(transaction.context);
      else await saveChat();
    }
    transaction.metadataBefore = structuredClone(transaction.context.chatMetadata?.[META_KEY] ?? {});
    transaction.settingsBefore = structuredClone(extension_settings[MODULE_NAME] ?? {});
    transaction.metadataDirty = false;
  } catch (error) {
    rollbackCatchUpTransaction(transaction);
    error.sme_context_overflow_checkpoint_failure = true;
    throw error;
  }
}
