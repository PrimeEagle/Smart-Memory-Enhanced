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
 * reportTierTrimStats  - records injected vs full token counts for a tier
 * getTierTrimStats     - returns the stored stats for a tier key
 * clearTierTrimStats   - resets all stats (call on chat change)
 * hasAnyTrimmedTier    - returns true when at least one tier is over budget
 * markTrimToastFired   - records that the one-time trim toast has been shown
 * hasTrimToastFired    - returns true if the toast has already been shown
 * resetTrimToastFlag   - clears the flag (call on chat change)
 */

/** @type {Object.<string, {injected: number, full: number}>} */
const _stats = {};

/** Prevents the one-time "content trimmed" toast from re-firing mid-chat. */
let _trimToastFired = false;

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

// Tiers excluded from the trim warning toast. Short-term is excluded because
// the compaction summary self-corrects on the next compaction pass anyway -
// transient overshoot is normal and not actionable by the user.
const TOAST_EXEMPT_KEYS = new Set(['smart_memory_short']);

/**
 * Returns true if at least one non-exempt tier has reported trimmed content
 * this chat. Short-term is excluded since it self-corrects on the next
 * compaction pass.
 * @returns {boolean}
 */
export function hasAnyTrimmedTier() {
  return Object.entries(_stats).some(([k, s]) => !TOAST_EXEMPT_KEYS.has(k) && s.full > s.injected);
}

/** Records that the one-time trim notification has been shown for this chat. */
export function markTrimToastFired() {
  _trimToastFired = true;
}

/** Returns true if the trim toast has already fired for this chat. */
export function hasTrimToastFired() {
  return _trimToastFired;
}

/** Resets the trim toast flag. Call on chat change alongside clearTierTrimStats. */
export function resetTrimToastFlag() {
  _trimToastFired = false;
}
