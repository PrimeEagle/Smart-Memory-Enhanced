/**
 * Smart Memory - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Continuity checker: manually triggered contradiction detection and optional
 * auto-repair injection.
 *
 * Gathers all established facts (short-term summary, long-term memories,
 * session memories) and asks the model whether the last AI response contradicts
 * any of them. Results are shown in the UI - not auto-applied.
 *
 * When auto-repair is enabled and contradictions are found, a second model call
 * generates a brief corrective note that is injected into the prompt for the
 * next AI turn, then automatically cleared after that response is rendered.
 *
 * Manual-only because running this automatically on every message would be
 * too expensive on local hardware (RTX 2080 / 8GB VRAM).
 *
 * checkContinuity     - runs a contradiction check against the last AI message
 * generateRepair      - generates a corrective note from a contradiction list
 * injectRepair        - stores the repair note and injects it into the prompt
 * clearRepair         - removes the pending repair from storage and the prompt
 * loadAndInjectRepair - restores a stored repair injection on chat load
 */

import { generateMemoryExtract, getMemoryRequestBudget } from './generate.js';
import { applyPromptOverride, PROMPT_TASKS } from './prompt-config.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { power_user } from '../../../../scripts/power-user.js';
import { MODULE_NAME, META_KEY, PROMPT_KEY_REPAIR, estimateTokens } from './constants.js';
import { buildContinuityPrompt, buildRepairPrompt } from './prompts.js';
import { loadCharacterMemories } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { parseContinuityVerdict } from './parsers.js';
import { smLog } from './logging.js';
import { makeExtractionPreflight } from './extraction-window-utils.js';
import { selectContinuityFactBlocks, validateContinuityRepair } from './continuity-utils.js';
import { beginContinuityEvent, updateContinuityEvent, finishContinuityEvent, recordContinuityRepairLifecycle } from './live-memory-health.js';

/**
 * Collects all established facts into a single labelled text block.
 * Pulls from the short-term summary, long-term memories, and session memories
 * so the model has the full picture of what is "known" for this chat.
 * @param {string} characterName
 * @returns {string} Multi-section fact block, or empty string if nothing is stored.
 */
function gatherEstablishedFactBlocks(characterName) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  const parts = [];
  const add = (source, text, count = 1) => { if (text?.trim()) parts.push({ source, text, count }); };

  // The character card is the canonical source of truth - check it first.
  // Characters may contradict their card (wrong gender, species, etc.) in ways
  // that no extracted memory would catch, especially in a fresh chat.
  // Look up by name so group chat checks use the responder's card, not the
  // ST-active character (context.characterId) which may be a different member.
  const char = context.characters?.find((c) => c.name === characterName);
  if (char) {
    const cardParts = [];
    if (char.description) cardParts.push(char.description);
    if (char.personality) cardParts.push('Personality: ' + char.personality);
    if (char.scenario) cardParts.push('Scenario: ' + char.scenario);
    if (cardParts.length > 0) {
      add('character_card', '-- CHARACTER CARD --\n' + cardParts.join('\n'));
    }
  }

  // Include the active user persona description so the checker does not flag
  // accurate descriptions of the user's character as contradictions.
  const personaDesc = power_user?.persona_description?.trim();
  if (personaDesc) {
    add('persona', '-- USER PERSONA --\n' + personaDesc);
  }

  if (meta?.summary) {
    add('summary', '-- STORY SUMMARY --\n' + meta.summary);
  }

  if (characterName) {
    const longterm = loadCharacterMemories(characterName).filter((m) => !m.superseded_by);
    if (longterm.length > 0) {
      for (const memory of longterm) add('longterm', `-- LONG-TERM MEMORY --\n[${memory.type}] ${memory.content}`);
    }
  }

  const session = loadSessionMemories().filter((m) => !m.superseded_by);
  if (session.length > 0) {
    for (const memory of session) add('session', `-- SESSION DETAIL --\n[${memory.type}] ${memory.content}`);
  }

  return parts;
}

function gatherEstablishedFacts(characterName) {
  return gatherEstablishedFactBlocks(characterName).map((block) => block.text).join('\n\n');
}

// chatMetadata key under META_KEY where the pending repair note is stored.
const REPAIR_KEY = 'pendingRepair';
const REPAIR_LIFECYCLE_KEY = 'pendingRepairLifecycle';

function repairOwnerKey(context) {
  return String(context.chatId ?? context.groupId ?? context.characterId ?? context.name2 ?? '').trim() || null;
}

/**
 * Runs a continuity check against the last AI message in the current chat.
 * Gathers established facts from all memory tiers and asks the model whether
 * the latest response contradicts any of them.
 * @param {string} characterName - Used to load the correct long-term memories.
 * @returns {Promise<string[]>} Array of contradiction descriptions, or [] if clean or on error.
 */
export async function checkContinuityDetailed(characterName, { trigger = 'manual' } = {}) {
  const settings = extension_settings[MODULE_NAME];
  const context = getContext();
  const metadata = context.chatMetadata?.[META_KEY];
  const lastAiMessage = context.chat
    ?.slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const blocks = gatherEstablishedFactBlocks(characterName);
  const sourceCounts = Object.fromEntries(['character_card', 'persona', 'summary', 'longterm', 'session'].map((source) => [source, blocks.filter((block) => block.source === source).length]));
  const sourceTokens = Object.fromEntries(Object.keys(sourceCounts).map((source) => [source, blocks.filter((block) => block.source === source).reduce((total, block) => total + estimateTokens(block.text), 0)]));
  const responseLength = settings.continuity_response_length ?? 300;
  const budget = getMemoryRequestBudget(responseLength);
  const event = beginContinuityEvent(metadata, {
    chat_turn_id: context.chat?.length ?? null, group_mode: Boolean(context.groupId), trigger,
    target_status: characterName ? 'available' : 'missing', fact_sources: sourceCounts,
    input_tokens: sourceTokens, latest_response_tokens: estimateTokens(lastAiMessage?.mes ?? ''),
  });
  const complete = (result) => ({ ...result, event_id: event?.event_id ?? null });
  if (!lastAiMessage) {
    finishContinuityEvent(metadata, event, { terminal_outcome: 'empty_response', parser_outcome: 'not_started', attention_reason_codes: ['no_latest_ai_response'] });
    return complete({ outcome: 'empty_response', contradictions: [], attention: true });
  }
  if (!blocks.length) {
    finishContinuityEvent(metadata, event, { terminal_outcome: 'prevented', attention_reason_codes: ['no_established_facts'] });
    return complete({ outcome: 'prevented', contradictions: [], attention: true });
  }
  const render = (facts) => applyPromptOverride(buildContinuityPrompt(facts, lastAiMessage.mes), PROMPT_TASKS.CONTINUITY, characterName);
  const selection = selectContinuityFactBlocks(blocks, {
    buildPrompt: render, estimateTokens,
    preflight: (prompt) => makeExtractionPreflight({ prompt, estimateTokens, configuredContextLimit: budget.configuredContextLimit, reservedOutputTokens: budget.reservedOutputTokens, safetyMargin: budget.safetyMargin }),
  });
  updateContinuityEvent(metadata, event, { preflight: selection.preflight, selection });
  if (!selection.facts.trim() || !selection.preflight.fits) {
    finishContinuityEvent(metadata, event, { terminal_outcome: 'prevented', attention_reason_codes: ['continuity_request_exceeds_budget'] });
    return complete({ outcome: 'prevented', contradictions: [], attention: true });
  }
  try {
    const response = await generateMemoryExtract(render(selection.facts), {
      responseLength: settings.continuity_response_length ?? 300,
    });
    const verdict = parseContinuityVerdict(response);
    const attention = ['empty_response', 'malformed_or_unusable_response'].includes(verdict.outcome);
    finishContinuityEvent(metadata, event, { terminal_outcome: verdict.outcome, provider_outcome: 'completed', parser_outcome: verdict.outcome, contradiction_count: verdict.contradictions.length, attention_reason_codes: attention ? [verdict.outcome] : [] });
    return complete({ ...verdict, attention });
  } catch (err) {
    console.error('[Smart Memory Enhanced] Continuity check failed:', err);
    finishContinuityEvent(metadata, event, { terminal_outcome: 'provider_failure', provider_outcome: 'provider_failure', parser_outcome: 'not_started', attention_reason_codes: ['provider_failure'] });
    return complete({ outcome: 'provider_failure', contradictions: [], attention: true, error: err });
  }
}

/** Backward-compatible list-only continuity API. */
export async function checkContinuity(characterName, options) {
  return (await checkContinuityDetailed(characterName, options)).contradictions;
}

/**
 * Generates a brief corrective context note from a list of contradictions.
 * Called after checkContinuity finds issues and auto-repair is enabled.
 * @param {string[]} contradictions - Array of contradiction descriptions.
 * @param {string} characterName - Used to load the correct long-term memories.
 * @returns {Promise<string>} The corrective note text.
 */
export async function generateRepair(contradictions, characterName, { continuityEventId = null } = {}) {
  const settings = extension_settings[MODULE_NAME];
  const facts = gatherEstablishedFacts(characterName);
  const prompt = buildRepairPrompt(contradictions, facts);

  const note = await generateMemoryExtract(applyPromptOverride(prompt, PROMPT_TASKS.CONTINUITY, characterName), {
    responseLength: settings.continuity_response_length ?? 300,
  });

  const validation = validateContinuityRepair(note, estimateTokens);
  smLog('[Smart Memory Enhanced] Repair note outcome:', validation.valid ? 'usable' : validation.reason);
  const metadata = getContext().chatMetadata?.[META_KEY];
  if (!validation.valid) recordContinuityRepairLifecycle(metadata, continuityEventId, 'repair_rejected', validation.reason);
  else recordContinuityRepairLifecycle(metadata, continuityEventId, 'repair_generated');
  return validation.valid ? validation.note : null;
}

/**
 * Stores a repair note in chatMetadata and injects it into the prompt at
 * depth 0 IN_CHAT so it sits immediately before the next AI response.
 * The note is one-shot - clearRepair() removes it after the next render.
 * @param {string} repairNote - The corrective note text.
 */
export function injectRepair(repairNote, { continuityEventId = null } = {}) {
  const context = getContext();
  if (!context.chatMetadata) return;
  const validation = validateContinuityRepair(repairNote, estimateTokens);
  if (!validation.valid) return { queued: false, reason: validation.reason };
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  const metadata = context.chatMetadata[META_KEY];
  metadata[REPAIR_KEY] = validation.note;
  metadata[REPAIR_LIFECYCLE_KEY] = {
    continuity_event_id: continuityEventId, owner_key: repairOwnerKey(context),
    target_turn: context.chat?.length ?? null, state: 'repair_queued', created_at: Date.now(),
  };
  recordContinuityRepairLifecycle(metadata, continuityEventId, 'repair_queued');
  context.saveMetadata()?.catch(console.error);

  setExtensionPrompt(
    PROMPT_KEY_REPAIR,
    `[Continuity correction - apply to this response: ${validation.note}]`,
    extension_prompt_types.IN_CHAT,
    0,
    false,
    extension_prompt_roles.SYSTEM,
  );
  return { queued: true, estimated_tokens: validation.estimated_tokens };
}

/**
 * Removes the pending repair note from chatMetadata and clears the injection
 * slot. Called after the next AI message is rendered.
 */
export function clearRepair(reason = 'repair_cancelled') {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]) {
    const metadata = context.chatMetadata[META_KEY];
    if (metadata[REPAIR_KEY]) {
      metadata[REPAIR_LIFECYCLE_KEY] = { ...(metadata[REPAIR_LIFECYCLE_KEY] ?? {}), state: reason, cleared_at: Date.now() };
      recordContinuityRepairLifecycle(metadata, metadata[REPAIR_LIFECYCLE_KEY]?.continuity_event_id, reason);
    }
    delete metadata[REPAIR_KEY];
    context.saveMetadata()?.catch(console.error);
  }
  setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
}

/**
 * Restores a stored repair injection on chat load. If a repair note was queued
 * before the chat was closed or switched, this re-injects it so it is still
 * active for the next AI turn.
 */
export function loadAndInjectRepair() {
  const context = getContext();
  const metadata = context.chatMetadata?.[META_KEY];
  const repair = metadata?.[REPAIR_KEY];
  const lifecycle = metadata?.[REPAIR_LIFECYCLE_KEY];
  if (repair && lifecycle?.owner_key && lifecycle.owner_key !== repairOwnerKey(context)) {
    clearRepair('repair_expired');
    return;
  }
  if (repair) {
    if (metadata[REPAIR_LIFECYCLE_KEY]) {
      metadata[REPAIR_LIFECYCLE_KEY].state = 'repair_restored';
      recordContinuityRepairLifecycle(metadata, metadata[REPAIR_LIFECYCLE_KEY].continuity_event_id, 'repair_restored');
    }
    setExtensionPrompt(
      PROMPT_KEY_REPAIR,
      `[Continuity correction - apply to this response: ${repair}]`,
      extension_prompt_types.IN_CHAT,
      0,
      false,
      extension_prompt_roles.SYSTEM,
    );
  } else {
    setExtensionPrompt(PROMPT_KEY_REPAIR, '', extension_prompt_types.NONE, 0);
  }
}
