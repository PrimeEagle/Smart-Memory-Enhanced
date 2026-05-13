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
 * Lightweight registry that tracks per-tier trim statistics.
 *
 * Each inject function reports its full content size and its injected size.
 * The token bar reads these stats to show a visual indicator when a tier is
 * actively dropping content to stay within budget.
 *
 * reportTierTrimStats - records injected vs full token counts for a tier
 * getTierTrimStats    - returns the stored stats for a tier key
 * clearTierTrimStats  - resets all stats (call on chat change)
 */

/** @type {Object.<string, {injected: number, full: number}>} */
const _stats = {};

/**
 * Records the injected and full (pre-trim) token counts for a tier.
 * Call this from every inject function after building and trimming content.
 *
 * @param {string} key - The injection slot key (PROMPT_KEY_* constant).
 * @param {number} injected - Tokens actually injected after budget trimming.
 * @param {number} full - Tokens the full content would have needed before trimming.
 */
export function reportTierTrimStats(key, injected, full) {
  _stats[key] = { injected, full };
}

/**
 * Returns the stored trim stats for a tier, or null if none recorded yet.
 *
 * @param {string} key
 * @returns {{injected: number, full: number}|null}
 */
export function getTierTrimStats(key) {
  return _stats[key] ?? null;
}

/**
 * Resets all stored trim stats. Call on chat change so stale data from a
 * previous chat does not show false alarms on the new one.
 */
export function clearTierTrimStats() {
  for (const k of Object.keys(_stats)) delete _stats[k];
}
