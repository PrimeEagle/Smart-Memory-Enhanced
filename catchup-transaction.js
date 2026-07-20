/**
 * Staged persistence for Memorize Chat chunks. Storage helpers call
 * saveChatMetadata() as usual; while a transaction is active, it records that
 * metadata changed instead of saving intermediate, half-processed state.
 */
import { getRequestHeaders, saveChat } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY } from './constants.js';

let activeTransaction = null;

export function beginCatchUpTransaction(context) {
  if (activeTransaction) throw new Error('A Smart Memory catch-up transaction is already active.');
  activeTransaction = {
    context,
    metadataExisted: Object.prototype.hasOwnProperty.call(context.chatMetadata ?? {}, META_KEY),
    metadataBefore: structuredClone(context.chatMetadata?.[META_KEY] ?? {}),
    settingsBefore: structuredClone(extension_settings[MODULE_NAME] ?? {}),
    metadataDirty: false,
  };
  return activeTransaction;
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
  const { context, metadataExisted, metadataBefore, settingsBefore } = transaction;
  if (!context.chatMetadata) context.chatMetadata = {};
  if (metadataExisted) context.chatMetadata[META_KEY] = structuredClone(metadataBefore);
  else delete context.chatMetadata[META_KEY];
  restoreObject(extension_settings[MODULE_NAME], settingsBefore);
  activeTransaction = null;
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
  try {
    if (transaction.metadataDirty) {
      if (transaction.context.groupId) await saveGroupChatDirect(transaction.context);
      else await saveChat();
    }
    activeTransaction = null;
  } catch (error) {
    rollbackCatchUpTransaction(transaction);
    throw error;
  }
}
