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
 * Unified injection mode: merges all active tier content into a single
 * IN_PROMPT block instead of injecting each tier into its own named slot.
 *
 * injectUnified           - reads individual tier slots, composes them, clears
 *                           the individual slots, and injects the merged block
 * maybeInjectUnified      - calls injectUnified only when the setting is enabled
 * clearUnifiedSlot        - clears the unified slot and the stored breakdown
 * invalidateUnifiedCache  - removes a tier's cached content; call this whenever
 *                           an injector explicitly empties its slot so the cache
 *                           does not inject stale content on the next pass
 * getUnifiedTierBreakdown - returns per-tier token counts from the last pass
 *                           so updateTokenDisplay can still render tier colours
 */

import { extension_settings } from '../../../extensions.js';
import {
  extension_prompts,
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import {
  MODULE_NAME,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_UNIFIED,
  estimateTokens,
} from './constants.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { createInjectionTierBreakdown, createUnifiedInjectionPlan,
  projectUnifiedInjectionDiagnostics } from './injection-read-model.js';

/**
 * Canonical tier ordering for the unified block.
 *
 * Most-stable content comes first; most-immediate content comes last so the
 * model sees active goals and session details closest to its response
 * (recency bias in transformer attention).
 */
const TIER_ORDER = [
  { key: PROMPT_KEY_CANON, label: 'Canon', color: '#a05870' },
  { key: PROMPT_KEY_PROFILES, label: 'Profiles', color: '#5a9ea0' },
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: '#4a6fa5' },
  { key: PROMPT_KEY_RELATIONSHIPS, label: 'Relationships', color: '#a06078' },
  { key: PROMPT_KEY_EPISTEMIC, label: 'Perspectives', color: '#6b8e9e' },
  { key: PROMPT_KEY_STATE_LEDGER, label: 'State Ledger', color: '#8a7c5a' },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: '#5a8e5a' },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: '#a07840' },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: '#8e5a8e' },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: '#7a6ea5' },
  { key: PROMPT_KEY_TRIGGERED, label: 'Triggered', color: '#4f82b8' },
];

/** All individual keys that unified mode absorbs. */
const INDIVIDUAL_KEYS = TIER_ORDER.map((t) => t.key);

/**
 * Per-tier token breakdown from the last injectUnified call.
 * Exported so updateTokenDisplay can render per-tier colours even though all
 * content lives in one slot.
 * @type {Array<{key: string, label: string, color: string, tokens: number}>}
 */
let lastTierBreakdown = [];
let lastInjectionReadModel = null;

/**
 * Content cache keyed by prompt key. Holds the last known non-empty content
 * for each tier so that tiers not refreshed in the current extraction cycle
 * (canon, scenes) are not dropped from the unified block just because their
 * individual slots were cleared by the previous pass.
 * Reset on chat change via clearUnifiedSlot().
 * @type {Record<string, string>}
 */
let contentCache = {};

/**
 * Returns the per-tier token breakdown from the last injectUnified call.
 * @returns {Array<{key: string, label: string, color: string, tokens: number}>}
 */
export function getUnifiedTierBreakdown() {
  return createInjectionTierBreakdown(lastTierBreakdown);
}

/** Returns the last content-free unified selection projection. */
export function getUnifiedInjectionReadModel() {
  return projectUnifiedInjectionDiagnostics(lastInjectionReadModel);
}

/**
 * Clears the unified injection slot, the stored breakdown, and the content
 * cache. Call on chat change so stale content from a previous chat never
 * bleeds into a new one.
 */
export function clearUnifiedSlot() {
  setMacroContent(MACRO_NAMES.unified, '');
  setExtensionPrompt(PROMPT_KEY_UNIFIED, '', extension_prompt_types.NONE, 0);
  lastTierBreakdown = [];
  lastInjectionReadModel = null;
  contentCache = {};
}

/**
 * Removes a single tier's entry from the content cache.
 *
 * The cache bridges extraction gaps: when injectUnified runs, it clears all
 * individual tier slots so they cannot be double-injected alongside the unified
 * block. On the next call, slots that were not refreshed by their injector fall
 * back to the cache. However, if an injector explicitly empties its slot (e.g.
 * all memories were deleted), the cache would otherwise keep injecting stale
 * content. Call this function immediately after any setExtensionPrompt call that
 * writes an empty string to a tier slot.
 * @param {string} key - The PROMPT_KEY_* constant for the tier being cleared.
 */
export function invalidateUnifiedCache(key) {
  delete contentCache[key];
}

/**
 * Reads all individual tier slots (as written by their respective injectors),
 * records per-tier token counts, clears the individual slots, and injects
 * the merged content into PROMPT_KEY_UNIFIED as a single IN_PROMPT block.
 *
 * Tiers not refreshed in this cycle (e.g. canon, scenes when no break fired)
 * fall back to the content cache so they are not silently dropped from the
 * block just because their slot was cleared by the previous pass.
 *
 * Call this after all individual injectors have run for a given generation
 * cycle. Tiers with no content are skipped silently.
 */
export function injectUnified() {
  // For each tier: use the fresh slot value if present, otherwise fall back
  // to the cache. Update the cache whenever fresh content is available.
  const candidates = TIER_ORDER.map((tier, rank) => {
    const fresh = extension_prompts[tier.key]?.value ?? '';
    if (fresh.length > 0) contentCache[tier.key] = fresh;
    const content = fresh.length > 0 ? fresh : (contentCache[tier.key] ?? '');
    return {
      key: tier.key, label: tier.label, color: tier.color, rank, content,
      tokens: estimateTokens(content),
      provenance: fresh.length > 0 ? 'fresh_prompt_slot'
        : content.length > 0 ? 'cached_prompt_slot' : 'empty',
    };
  });

  const settings = extension_settings[MODULE_NAME];
  const plan = createUnifiedInjectionPlan({
    candidates,
    placement: {
      position: settings.unified_position ?? extension_prompt_types.IN_PROMPT,
      depth: settings.unified_depth ?? 0,
      role: settings.unified_role ?? extension_prompt_roles.SYSTEM,
    },
    macro_active: isMacroActive(MACRO_NAMES.unified),
  });
  lastInjectionReadModel = plan;

  lastTierBreakdown = createInjectionTierBreakdown(plan.selected.map((t) => ({
    key: t.key,
    label: t.label,
    color: t.color,
    tokens: estimateTokens(t.content),
  })));

  // Clear every individual slot - the unified block replaces them all.
  for (const key of INDIVIDUAL_KEYS) {
    setExtensionPrompt(key, '', extension_prompt_types.NONE, 0);
  }

  if (plan.selected.length === 0) {
    setMacroContent(MACRO_NAMES.unified, '');
    setExtensionPrompt(PROMPT_KEY_UNIFIED, '', extension_prompt_types.NONE, 0);
    return;
  }

  const unified = plan.selected.map((t) => t.content).join('\n\n');

  setMacroContent(MACRO_NAMES.unified, unified);
  if (plan.target === 'macro') {
    setExtensionPrompt(PROMPT_KEY_UNIFIED, '', extension_prompt_types.NONE, 0);
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_UNIFIED,
    unified,
    plan.placement.position,
    plan.placement.depth,
    false,
    plan.placement.role,
  );
}

/**
 * Calls injectUnified if the unified_injection setting is enabled.
 * Drop this call after every batch injection point (chat load, extraction
 * pass, compaction, scene break, group character switch, catch-up).
 */
export function maybeInjectUnified() {
  const settings = extension_settings[MODULE_NAME];
  if (settings.unified_injection) injectUnified();
}
