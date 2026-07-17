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
import {
  buildSummaryPrompt,
  RECAP_PROMPT,
  buildSessionExtractionPrompt,
  buildSceneDetectPrompt,
  SCENE_SUMMARY_PROMPT,
  buildArcExtractionPrompt,
  buildArcSummaryPrompt,
  buildContinuityPrompt,
  buildExtractionPrompt,
  buildProfileGenerationPrompt,
  buildCanonSummaryPrompt,
  buildRelationshipDeltaPrompt,
  buildEpistemicExtractionPrompt,
  buildStateCardPrompt,
} from './prompts.js';

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

/**
 * Returns the original extension prompt with clearly marked sample values.
 * Runtime chat text and memory records are intentionally not exposed in the
 * settings panel, but this lets users inspect the real prompt instructions.
 */
export function getDefaultPromptPreview(task) {
  const sampleChat = '[CHAT HISTORY IS INSERTED HERE]';
  const sampleMemories = '[STORED MEMORIES ARE INSERTED HERE]';
  const sampleRoster = '[CANONICAL CHARACTER ROSTER IS INSERTED HERE]';
  switch (task) {
    case PROMPT_TASKS.LONGTERM_EXTRACTION:
      return buildExtractionPrompt(sampleChat, sampleMemories, '[ACTIVE CHARACTER]', sampleRoster);
    case PROMPT_TASKS.SESSION_EXTRACTION:
      return buildSessionExtractionPrompt(sampleChat, sampleMemories, sampleMemories, sampleRoster);
    case PROMPT_TASKS.SCENE_SUMMARY:
      return `${buildSceneDetectPrompt('[CURRENT MESSAGE]', '[PREVIOUS MESSAGE]')}\n\n--- Scene summary ---\n\n${SCENE_SUMMARY_PROMPT.replace('{{scene_text}}', sampleChat)}`;
    case PROMPT_TASKS.ARC_EXTRACTION:
      return `${buildArcExtractionPrompt(sampleChat, '[OPEN ARCS ARE INSERTED HERE]')}\n\n--- Arc resolution summary ---\n\n${buildArcSummaryPrompt('[ARC]', '[SCENE SUMMARIES]', sampleMemories)}`;
    case PROMPT_TASKS.CANON:
      return buildCanonSummaryPrompt('[ACTIVE CHARACTER]', ['[RESOLVED ARC SUMMARY]'], sampleMemories);
    case PROMPT_TASKS.PROFILES:
      return buildProfileGenerationPrompt('[ACTIVE CHARACTER]', sampleMemories, sampleMemories, [{ name: '[ENTITY]', type: 'character' }], sampleRoster);
    case PROMPT_TASKS.RELATIONSHIPS:
      return buildRelationshipDeltaPrompt(sampleChat, '[CURRENT RELATIONSHIP STATE]', '[CHARACTER CARD EXCERPT]', sampleRoster);
    case PROMPT_TASKS.EPISTEMIC:
      return buildEpistemicExtractionPrompt(sampleChat, ['[PARTICIPANT]'], [], sampleRoster);
    case PROMPT_TASKS.STATE_LEDGER:
      return buildStateCardPrompt(sampleChat, [{ name: '[ENTITY]', type: 'character' }], sampleRoster);
    case PROMPT_TASKS.COMPACTION:
      return buildSummaryPrompt(sampleMemories);
    case PROMPT_TASKS.RECAP:
      return RECAP_PROMPT;
    case PROMPT_TASKS.CONTINUITY:
      return buildContinuityPrompt(sampleMemories, '[LATEST AI RESPONSE]');
    default:
      return '';
  }
}

export function listPromptPresets() {
  return {
    builtIn: Object.entries(PROMPT_PRESETS).map(([id, preset]) => ({
      id: `builtin:${id}`,
      label: preset.label,
      instruction: preset.instruction,
      custom: false,
    })),
    custom: Object.entries(settingsStore().presets)
      .filter(([, instruction]) => typeof instruction === 'string' && instruction.trim())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, instruction]) => ({ id: `custom:${name}`, label: name, instruction, custom: true })),
  };
}

export function saveCustomPromptPreset(name, instruction) {
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  const cleanInstruction = String(instruction ?? '').trim();
  if (!cleanName || cleanName.length > 60) throw new Error('Preset names must be between 1 and 60 characters.');
  if (!cleanInstruction) throw new Error('Enter instructions before saving a preset.');
  if (Object.values(PROMPT_PRESETS).some((preset) => preset.label.toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('That name is reserved for a built-in preset.');
  }
  settingsStore().presets[cleanName] = cleanInstruction;
  return cleanName;
}

export function deleteCustomPromptPreset(name) {
  delete settingsStore().presets[String(name ?? '')];
}

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
    presets: { ...settingsStore().presets },
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
  if (payload.presets && typeof payload.presets === 'object' && !Array.isArray(payload.presets)) {
    for (const [name, instruction] of Object.entries(payload.presets)) {
      if (typeof instruction === 'string') saveCustomPromptPreset(name, instruction);
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
