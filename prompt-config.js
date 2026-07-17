/**
 * Scoped prompt customization for Smart Memory Enhanced.
 *
 * Overrides are deliberately treated as additional task instructions rather
 * than replacements for the generated prompt. The extension still owns the
 * dynamic chat/memory context and the parser contract, so a customization
 * cannot accidentally remove required tagged-output instructions.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { META_KEY, MODULE_NAME } from './constants.js';

export const PROMPT_TASKS = Object.freeze({
  LONGTERM_EXTRACTION: 'longterm_extraction',
  SESSION_EXTRACTION: 'session_extraction',
  SCENE_SUMMARY: 'scene_summary',
  ARC_EXTRACTION: 'arc_extraction',
  CANON: 'canon',
  PROFILES: 'profiles',
  RELATIONSHIPS: 'relationships',
  EPISTEMIC: 'epistemic',
  STATE_LEDGER: 'state_ledger',
  COMPACTION: 'compaction',
  RECAP: 'recap',
  CONTINUITY: 'continuity',
});

export const PROMPT_TASK_LABELS = Object.freeze({
  [PROMPT_TASKS.LONGTERM_EXTRACTION]: 'Long-Term Memory Extraction',
  [PROMPT_TASKS.SESSION_EXTRACTION]: 'Session Memory Extraction',
  [PROMPT_TASKS.SCENE_SUMMARY]: 'Scene Summary',
  [PROMPT_TASKS.ARC_EXTRACTION]: 'Story Arc Extraction',
  [PROMPT_TASKS.CANON]: 'Canon Generation',
  [PROMPT_TASKS.PROFILES]: 'Character & World Profiles',
  [PROMPT_TASKS.RELATIONSHIPS]: 'Relationship History',
  [PROMPT_TASKS.EPISTEMIC]: 'Perspectives & Secrets',
  [PROMPT_TASKS.STATE_LEDGER]: 'State Ledger',
  [PROMPT_TASKS.COMPACTION]: 'Short-Term Compaction',
  [PROMPT_TASKS.RECAP]: 'Away Recap',
  [PROMPT_TASKS.CONTINUITY]: 'Continuity Check',
});

export const PROMPT_PRESETS = Object.freeze({
  precise: {
    label: 'Precise',
    instruction: 'Prefer concrete, directly supported facts. Be conservative: omit uncertain inferences and avoid decorative wording.',
  },
  concise: {
    label: 'Concise',
    instruction: 'Prefer the fewest clear records that preserve important facts. Avoid restating the same fact in different words.',
  },
  detailed: {
    label: 'Detailed',
    instruction: 'Capture consequential specifics, motivations, changes, and constraints when the source clearly supports them. Do not invent details.',
  },
});

function settingsStore() {
  const settings = extension_settings[MODULE_NAME];
  settings.prompt_overrides ??= { global: {}, presets: {} };
  settings.prompt_overrides.global ??= {};
  settings.prompt_overrides.presets ??= {};
  return settings.prompt_overrides;
}

function characterStore(characterName, create = true) {
  if (!characterName) return null;
  const settings = extension_settings[MODULE_NAME];
  if (create) settings.characters ??= {};
  const character = settings.characters?.[characterName];
  if (!character && !create) return null;
  if (create) settings.characters[characterName] ??= {};
  const target = settings.characters[characterName];
  if (create) target.prompt_overrides ??= {};
  return target.prompt_overrides ?? null;
}

function chatStore(create = true) {
  const context = getContext();
  if (!context.chatMetadata && !create) return null;
  if (create) context.chatMetadata ??= {};
  if (create) context.chatMetadata[META_KEY] ??= {};
  const memory = context.chatMetadata?.[META_KEY];
  if (create) memory.prompt_overrides ??= {};
  return memory?.prompt_overrides ?? null;
}

export function getPromptOverride(task, scope, characterName = null) {
  const store = scope === 'global'
    ? settingsStore().global
    : scope === 'character'
      ? characterStore(characterName, false)
      : chatStore(false);
  return store?.[task] ?? '';
}

export function setPromptOverride(task, scope, value, characterName = null) {
  const store = scope === 'global'
    ? settingsStore().global
    : scope === 'character'
      ? characterStore(characterName)
      : chatStore();
  if (!store) return;
  const trimmed = String(value ?? '').trim();
  if (trimmed) store[task] = trimmed;
  else delete store[task];
}

export function resolvePromptOverride(task, characterName = null) {
  // Chat is intentionally checked first: it is the most specific scope.
  return getPromptOverride(task, 'chat', characterName)
    || getPromptOverride(task, 'character', characterName)
    || getPromptOverride(task, 'global', characterName)
    || '';
}

export function resetPromptOverride(task, scope, characterName = null) {
  setPromptOverride(task, scope, '', characterName);
}

/** Returns an exportable, JSON-safe snapshot of all three override scopes. */
export function exportPromptOverrides(characterName = null) {
  return {
    format: 'smart-memory-enhanced-prompt-overrides',
    version: 1,
    global: { ...settingsStore().global },
    character: { ...(characterStore(characterName, false) ?? {}) },
    chat: { ...(chatStore(false) ?? {}) },
  };
}

export function importPromptOverrides(payload, characterName = null) {
  if (!payload || payload.format !== 'smart-memory-enhanced-prompt-overrides' || payload.version !== 1) {
    throw new Error('This is not a Smart Memory Enhanced prompt-override export.');
  }
  for (const [scope, entries] of Object.entries({ global: payload.global, character: payload.character, chat: payload.chat })) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const [task, value] of Object.entries(entries)) {
      if (Object.values(PROMPT_TASKS).includes(task) && typeof value === 'string') {
        setPromptOverride(task, scope, value, characterName);
      }
    }
  }
}

/**
 * Adds the effective override while retaining the extension-authored parser
 * contract inside basePrompt. This prevents editable instructions from making
 * a task silently unparsable.
 */
export function applyPromptOverride(basePrompt, task, characterName = null) {
  const override = resolvePromptOverride(task, characterName);
  if (!override) return basePrompt;
  return `Additional instructions from the user (follow when compatible with the required output format):\n${override}\n\n${basePrompt}`;
}
