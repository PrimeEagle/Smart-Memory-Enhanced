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
 * Macro injection: registers Smart Memory content as SillyTavern macros.
 *
 * Each memory tier exposes a {{smartmemory-*}} macro that injects its content
 * wherever the user places the token in a character card or instruct template.
 * Inject functions update the cache on every call so macros always return
 * fresh content without requiring a separate generation pass.
 *
 * MACRO_NAMES              - canonical macro name strings for all 8 tiers
 * setMacroContent          - stores tier content in the cache (called by inject fns)
 * isMacroActive            - true when the macro should handle placement for a tier
 * registerSmartMemoryMacros - registers all macros with the ST macro system at init
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { macros as stMacros } from '../../../../scripts/macros/macro-system.js';
import { MODULE_NAME } from './constants.js';

/**
 * Canonical macro names for all 8 injectable memory tiers.
 * These strings are what users place in character cards or instruct templates.
 */
export const MACRO_NAMES = {
  shortterm: 'smartmemory-shortterm',
  longterm: 'smartmemory-longterm',
  session: 'smartmemory-session',
  scenes: 'smartmemory-scenes',
  arcs: 'smartmemory-arcs',
  relationships: 'smartmemory-relationships',
  canon: 'smartmemory-canon',
  profiles: 'smartmemory-profiles',
};

// Content cache keyed by macro name. Updated by inject functions so the macro
// handler always returns the latest formatted output without an extra model call.
const contentCache = new Map();

/**
 * Stores content in the macro cache for a given tier.
 * Called by each inject function on every path (content or clear) so the
 * macro always returns an accurate value even when the tier produces nothing.
 * @param {string} macroName - One of the MACRO_NAMES values.
 * @param {string|null} content - Formatted content string, or null/empty to clear.
 */
export function setMacroContent(macroName, content) {
  contentCache.set(macroName, content ?? '');
}

// Character card fields that ST renders through substituteParams, which resolves
// macros. These are the locations where auto-detection will find macro tokens.
const CARD_FIELDS = ['system_prompt', 'description', 'personality', 'scenario', 'mes_example'];

/**
 * Returns true when the named macro should handle prompt placement for its tier.
 *
 * Active conditions (all must hold):
 *  - unified_injection is off (the two modes are incompatible - unified builds a
 *    single block from all tiers and has no place to insert individual macros)
 *  - Either macros_enabled is true (manual override, e.g. for instruct templates)
 *    OR the macro token appears in one of the current character card's fields
 *    (auto-detection for the common case of users editing their card)
 *
 * @param {string} macroName - One of the MACRO_NAMES values.
 * @returns {boolean}
 */
export function isMacroActive(macroName) {
  const settings = extension_settings[MODULE_NAME];
  // Macro injection and unified injection build the prompt differently and
  // cannot coexist. Unified takes precedence since it is the more intentional mode.
  if (settings?.unified_injection) return false;
  // Manual override: user set macros_enabled to force macro mode for all tiers.
  // Necessary for instruct templates, which we cannot scan from the card fields.
  if (settings?.macros_enabled) return true;
  // Auto-detection: look for the {{macro-name}} token in character card fields.
  const token = `{{${macroName}}}`;
  const context = getContext();
  const char = context.characters?.find((c) => c.name === context.name2);
  if (!char) return false;
  return CARD_FIELDS.some((f) => typeof char[f] === 'string' && char[f].includes(token));
}

/**
 * Registers all 8 Smart Memory macros with the SillyTavern macro system.
 * Called once at extension load time. The cache starts empty so each macro
 * returns an empty string until the first inject call populates it.
 */
export function registerSmartMemoryMacros() {
  for (const [tierKey, macroName] of Object.entries(MACRO_NAMES)) {
    stMacros.register(macroName, {
      category: stMacros.category.MISC,
      description: `Smart Memory: ${tierKey} tier content`,
      returns: 'Formatted memory tier content, empty string if tier is disabled or has no data',
      handler: () => contentCache.get(macroName) ?? '',
    });
  }
}
