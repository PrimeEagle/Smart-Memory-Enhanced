/**
 * Smart Memory Enhanced - SillyTavern Extension
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
 * Pure display layer: all functions that read state and write to the DOM.
 * Zero coupling to index.js state variables - safe to import from anywhere.
 *
 * TOKEN_TIERS             - metadata for each injection tier (key, label, colour)
 * PERSONAL_TIERS          - per-character tiers shown in group-chat rows
 * getGroupMembers         - ordered list of character names in the current group
 * estimateCharPersonalTokens - stored token footprint for one character's personal tiers
 * updateTokenDisplay      - refreshes the token usage bar chart
 * setStatusMessage        - updates the status bar text in the settings panel header
 * setContinuityBadge      - updates the contradiction count badge in the header
 * showSearchResults       - renders a dismissible modal with /sme-search results
 * initTooltips            - wires up the floating tooltip on .sm-info elements
 * updateShortTermUI       - syncs the short-term summary textarea
 * updateCanonUI           - populates the canon display and status line
 * updateLongTermUI             - re-renders the long-term memories list and entity panel
 * updateRelationshipHistoryUI  - re-renders the relationship history panel with edit/delete/add controls
 * buildTypePicker         - builds a custom type-picker widget
 * initTypePickers         - registers the document-level close handler for type pickers
 * updateEmbeddingNotice   - shows/hides the embedding inactive notice
 * updateFreshStartUI      - syncs the fresh-start checkbox and body class
 * updateSessionUI         - re-renders the session memory list
 * updateScenesUI          - re-renders the scene history list
 * updateArcsUI            - re-renders the story arcs list
 * updateProfilesUI        - renders the profiles display panel
 * updateEntityPanel       - renders the entity registry panel
 * showEntityTimeline      - shows an inline timeline for a single entity
 * renderMemoriesList      - renders the long-term memories list with edit/delete controls
 * updateEpistemicUI       - re-renders the Perspectives & Secrets entry list with add/edit/delete controls
 */

import { extension_prompts, getMaxContextSize, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  MEMORY_TYPES,
  SESSION_TYPES,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_CANON,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
} from './constants.js';
import {
  loadCharacterMemories,
  getCharacterMemoryPolicy,
  saveCharacterMemories,
  injectMemories,
  loadRelationshipHistory,
  saveRelationshipHistory,
  injectRelationshipHistory,
  reconcileRelationshipHistoryCanonicalNames,
  reconcileRelationshipHistoryMap,
  getRelationshipHistoryPairDisplay,
  remapRelationshipHistoryEntity,
} from './longterm.js';
import { loadSessionMemories, saveSessionMemories, injectSessionMemories } from './session.js';
import { loadSceneHistory, saveSceneHistory } from './scenes.js';
import {
  loadArcs,
  saveArcs,
  deleteArc,
  resolveArcWithSummary,
  injectArcs,
  promoteArc,
  demoteArc,
  reopenArc,
  loadArcSummaries,
  saveArcSummaries,
  reverifyArcSummary,
  loadPersistentArcs,
  savePersistentArcs,
  loadGroupPersistentArcs,
  saveGroupPersistentArcs,
} from './arcs.js';
import { isRecordApprovedForPropagation } from './record-validation.js';
import { loadCanon } from './canon.js';
import { loadProfiles, reconcileProfileCanonicalNames, remapProfileEntity } from './profiles.js';
import {
  loadCharacterEntityRegistry,
  loadSessionEntityRegistry,
  saveCharacterEntityRegistry,
  saveSessionEntityRegistry,
  setEntityType,
  renameEntityById,
  deleteEntityById,
  mergeEntitiesById,
  mergeCanonicalEntityAcrossStores,
  reconcileCanonicalEntityRegistry,
} from './graph-migration.js';
import { buildCanonicalCharacterRoster, canonicalizeNarrativeNames, canonicalizeStructuredParticipants, deduplicateIdentityDecisions, normalizeSyntheticIdentityQualifier, reconcileCanonicalLedger, resolveCanonicalCharacterName } from './canonical-entities.js';
import { getUnifiedTierBreakdown } from './unified-inject.js';
import { hasEmbeddingFailed } from './embeddings.js';
import {
  getTierTrimStats,
  hasAnyTrimmedTier,
  hasTrimToastFired,
  markTrimToastFired,
  isChatLoadComplete,
} from './trim-stats.js';
import {
  loadEpistemicKnowledge,
  saveEpistemicKnowledge,
  injectEpistemicKnowledge,
  shrinkEpistemicBudgetIfPossible,
  reconcileEpistemicCanonicalNames,
  remapEpistemicEntity,
} from './epistemic.js';
import {
  getStateCard,
  setStateCard,
  deleteStateCard,
  migrateStateLedgerKey,
  renameStateLedgerEntity,
  isStateLedgerEnabled,
  injectStateLedger,
  STATE_CARD_FIELDS,
  STATE_CARD_TYPES,
  loadStateLedger,
  saveStateLedger,
} from './state-ledger.js';

// ---- Local helpers (not exported) ----------------------------------------

function getSettings() {
  return extension_settings[MODULE_NAME];
}

/** Returns the active character name, or null if no character is loaded. */
function getCurrentCharacterName() {
  const context = getContext();
  return context.name2 || context.characterName || null;
}

/**
 * Returns the character name the settings panel should operate on.
 * Reads from the DOM selector which is always in sync with the index.js
 * selectedGroupCharacter variable, so no state import is needed here.
 * @returns {string|null}
 */
function getSelectedCharacterName() {
  if (getContext().groupId) {
    return $('#sme_group_char_select').val() || null;
  }
  return getCurrentCharacterName();
}

// ---- Constants -----------------------------------------------------------

// Tier colours use OKLCH for perceptual uniformity: 10 hues at 36-degree
// intervals (360/10) with fixed lightness and chroma give maximum perceptual
// separation regardless of the display. oklch(62% 0.14 H).
const TIER_COLORS = {
  relationships: 'oklch(62% 0.14 0)',
  scenes: 'oklch(62% 0.14 36)',
  state: 'oklch(62% 0.14 72)',
  epistemic: 'oklch(62% 0.14 108)',
  shortterm: 'oklch(62% 0.14 144)',
  profiles: 'oklch(62% 0.14 180)',
  canon: 'oklch(62% 0.14 216)',
  longterm: 'oklch(62% 0.14 252)',
  session: 'oklch(62% 0.14 288)',
  arcs: 'oklch(62% 0.14 324)',
};

/**
 * Metadata for each injection tier used by the token usage display.
 * Order determines the visual stacking order in the bar chart.
 */
export const TOKEN_TIERS = [
  { key: PROMPT_KEY_LONG, label: 'Long-term', color: TIER_COLORS.longterm },
  { key: PROMPT_KEY_SESSION, label: 'Session', color: TIER_COLORS.session },
  { key: PROMPT_KEY_SHORT, label: 'Short-term', color: TIER_COLORS.shortterm },
  { key: PROMPT_KEY_CANON, label: 'Canon', color: TIER_COLORS.canon },
  { key: PROMPT_KEY_SCENES, label: 'Scenes', color: TIER_COLORS.scenes },
  { key: PROMPT_KEY_ARCS, label: 'Arcs', color: TIER_COLORS.arcs },
  { key: PROMPT_KEY_PROFILES, label: 'Profiles', color: TIER_COLORS.profiles },
  { key: PROMPT_KEY_RELATIONSHIPS, label: 'Relationships', color: TIER_COLORS.relationships },
  { key: PROMPT_KEY_EPISTEMIC, label: 'Perspectives', color: TIER_COLORS.epistemic },
  { key: PROMPT_KEY_STATE_LEDGER, label: 'State', color: TIER_COLORS.state },
];

// Personal tiers shown in per-character group rows. Shared tiers (session,
// scenes, arcs, short-term) are omitted - they are identical across all group
// members and already represented in the top bar.
export const PERSONAL_TIERS = [
  { key: 'longterm', label: 'Long-term', color: TIER_COLORS.longterm },
  { key: 'canon', label: 'Canon', color: TIER_COLORS.canon },
  { key: 'profiles', label: 'Profiles', color: TIER_COLORS.profiles },
];

// ---- Display functions ---------------------------------------------------

/**
 * Returns the ordered list of character names in the current group chat,
 * or null when not in a group chat.
 * @returns {string[]|null}
 */
export function getGroupMembers() {
  const context = getContext();
  if (!context.groupId) return null;
  const group = context.groups?.find((g) => g.id === context.groupId);
  if (!group) return null;
  return (group.members ?? [])
    .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
    .filter(Boolean);
}

/**
 * Estimates the stored token footprint of a character's personal memory tiers:
 * long-term memories, canon, and profiles. Does not include shared tiers
 * (session, scenes, arcs, short-term) which are identical for all group members.
 *
 * Reads from stored data rather than injected content, so values reflect the
 * full memory footprint before budget trimming.
 *
 * @param {string} charName
 * @returns {{ longterm: number, canon: number, profiles: number, total: number }}
 */
export function estimateCharPersonalTokens(charName) {
  const memories = loadCharacterMemories(charName).filter((m) => !m.superseded_by);
  const longtermTokens =
    memories.length > 0 ? estimateTokens(memories.map((m) => `- ${m.content}`).join('\n')) : 0;

  const canon = loadCanon(charName);
  const canonTokens = canon ? estimateTokens(canon) : 0;

  const profiles = loadProfiles(charName);
  const profileTokens = profiles
    ? estimateTokens(
        [profiles.character_state, profiles.world_state, profiles.relationship_matrix]
          .filter(Boolean)
          .join('\n'),
      )
    : 0;

  return {
    longterm: longtermTokens,
    canon: canonTokens,
    profiles: profileTokens,
    total: longtermTokens + canonTokens + profileTokens,
  };
}

/**
 * Reads the currently injected content for each tier from extension_prompts
 * and updates the token usage bar chart and totals line. In group chats,
 * also renders a compact per-character row for each group member showing their
 * stored personal memory footprint (long-term, canon, profiles).
 *
 * Called after any injection or chat change so the display stays current.
 * Uses the estimateTokens heuristic (~4 chars/token) - fast, synchronous,
 * accurate enough for budget tuning.
 */
export function updateTokenDisplay() {
  const bar = document.getElementById('sme_token_bar');
  const contextBar = document.getElementById('sme_context_bar');
  if (!bar || !contextBar) return;

  // ---- Top bar: actual injected content for the active character ----------

  // In unified mode the individual slots are empty - use the breakdown saved
  // by the last injectUnified call so tier colours are still visible.
  const settings = getSettings();
  const tiers = (
    settings.unified_injection
      ? getUnifiedTierBreakdown()
      : TOKEN_TIERS.map((t) => ({
          ...t,
          tokens: estimateTokens(extension_prompts[t.key]?.value ?? ''),
        }))
  ).filter((t) => t.tokens > 0);

  const total = tiers.reduce((sum, t) => sum + t.tokens, 0);
  // getContext().maxContext can be the API's stale/default value (often
  // 8,192) instead of the active preset's Context Size slider. Ask
  // SillyTavern's resolver so the display matches the generation settings.
  const maxContext = getMaxContextSize(0) || 0;

  // The first bar is the absolute share of the context window used by Smart
  // Memory. The second is deliberately always full, showing the relative mix
  // of tiers even when memory uses only a tiny fraction of a large context.
  contextBar.innerHTML = '';
  const contextPct = maxContext && total ? Math.min(100, (total / maxContext) * 100) : 0;
  const contextFill = document.createElement('div');
  contextFill.className = 'sm-token-segment sm-context-token-fill';
  contextFill.style.width = `${contextPct.toFixed(3)}%`;
  contextFill.title = `Smart Memory Enhanced: ~${total.toLocaleString()} of ${maxContext.toLocaleString()} context tokens (${contextPct.toFixed(1)}%)`;
  contextBar.appendChild(contextFill);

  bar.innerHTML = '';
  for (const tier of tiers) {
    const widthPct = total > 0 ? ((tier.tokens / total) * 100).toFixed(3) : 0;
    const sharePct = total > 0 ? ((tier.tokens / total) * 100).toFixed(0) : 0;
    const seg = document.createElement('div');
    seg.style.width = `${widthPct}%`;
    seg.style.background = tier.color;

    const trimStats = getTierTrimStats(tier.key);
    const isTrimmed = trimStats && trimStats.full > trimStats.injected;
    seg.className = isTrimmed ? 'sm-token-segment sm-token-trimmed' : 'sm-token-segment';

    if (isTrimmed) {
      const dropped = trimStats.full - trimStats.injected;
      seg.title =
        `${tier.label}: ~${tier.tokens.toLocaleString()} tokens injected (${sharePct}%)\n` +
        `~${dropped.toLocaleString()} tokens trimmed to fit budget`;
    } else {
      seg.title = `${tier.label}: ~${tier.tokens.toLocaleString()} tokens (${sharePct}%)`;
    }

    bar.appendChild(seg);
  }

  const contextPctDisplay = contextPct.toFixed(1);
  const usedEl = document.getElementById('sme_token_used');
  const maxEl = document.getElementById('sme_token_max');
  const pctEl = document.getElementById('sme_token_pct');
  if (usedEl) usedEl.textContent = `~${total.toLocaleString()}`;
  if (maxEl) maxEl.textContent = maxContext ? maxContext.toLocaleString() : '?';
  if (pctEl) pctEl.textContent = contextPctDisplay;

  // Fire a one-time notification the first time any tier is found to be trimming
  // content. Users who never open the settings panel will still see this once,
  // prompting them to check the token bar. Subsequent calls are silent.
  if (isChatLoadComplete() && hasAnyTrimmedTier() && !hasTrimToastFired()) {
    markTrimToastFired();
    toastr.warning(
      'One or more memory tiers are trimming content to stay within budget. Check the token bar in Smart Memory Enhanced settings.',
      'Smart Memory Enhanced',
      { timeOut: 8000, extendedTimeOut: 4000, closeButton: true },
    );
  }

  // ---- Per-character rows (group chats only) ------------------------------

  const groupRowsEl = document.getElementById('sme_token_group_rows');
  if (!groupRowsEl) return;

  const members = getGroupMembers();
  if (!members || members.length === 0) {
    groupRowsEl.style.display = 'none';
    return;
  }

  groupRowsEl.style.display = '';
  groupRowsEl.innerHTML = '';

  const activeChar = getSelectedCharacterName();

  for (const member of members) {
    const personal = estimateCharPersonalTokens(member);
    const isActive = member === activeChar;

    const row = document.createElement('div');
    row.className = 'sm-token-group-row' + (isActive ? ' sm-token-active' : '');
    row.title = `Click to view ${member}'s memories`;
    row.addEventListener('click', () => {
      $('#sme_group_char_select').val(member).trigger('change');
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'sm-token-group-name';
    nameEl.textContent = member;
    row.appendChild(nameEl);

    const barWrap = document.createElement('div');
    barWrap.className = 'sm-token-mini-bar-wrap';
    const miniBar = document.createElement('div');
    miniBar.className = 'sm-token-mini-bar';

    if (personal.total > 0) {
      for (const tier of PERSONAL_TIERS) {
        const tierTokens = personal[tier.key];
        if (tierTokens === 0) continue;
        const widthPct = ((tierTokens / personal.total) * 100).toFixed(1);
        const seg = document.createElement('div');
        seg.className = 'sm-token-segment';
        seg.style.width = `${widthPct}%`;
        seg.style.background = tier.color;
        seg.title = `${tier.label}: ~${tierTokens.toLocaleString()} tokens (stored)`;
        miniBar.appendChild(seg);
      }
    }

    barWrap.appendChild(miniBar);
    row.appendChild(barWrap);

    const countEl = document.createElement('span');
    countEl.className = 'sm-token-group-count';
    if (personal.total > 0) {
      countEl.textContent = `~${personal.total.toLocaleString()}`;
      countEl.title = 'Stored memory size before budget trimming';
    } else {
      countEl.textContent = 'no data';
    }
    row.appendChild(countEl);

    groupRowsEl.appendChild(row);
  }
}

/** Updates the status bar text shown at the top of the settings panel. */
export function setStatusMessage(msg) {
  $('#sme_status').text(msg);
}

/** Whether a memory has been quarantined pending an explicit user decision. */
function needsGroundingReview(memory) {
  return (
    memory?.validation_status === 'needs_review' ||
    (memory?.grounding_status === 'ungrounded' && memory?.validation_status !== 'approved' && memory?.validation_status !== 'rejected')
  );
}

function needsArcSummaryReview(summary) {
  return summary?.validation_status === 'needs_review' || summary?.semantic_support === 'not_checked';
}

/** Reviews derived arc prose independently from primary-memory review. */
function showArcSummaryReviewDialog(summaryId) {
  $('#sme_arc_summary_review_dialog').remove();
  const summaries = loadArcSummaries();
  const summary = summaries.find((item) => item.id === summaryId);
  if (!summary) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'sme_arc_summary_review_dialog';
  for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    dialog.addEventListener(eventName, (event) => event.stopPropagation());
  }
  const close = () => { dialog.close(); dialog.remove(); };
  const $card = $('<div class="sme_memory_review_card">');
  const $header = $('<div class="sme_memory_review_header">');
  $header.append($('<strong class="sme_memory_review_title">').text('Resolved Arc Summary Review'));
  $header.append($('<button class="menu_button" title="Close"><i class="fa-solid fa-xmark"></i></button>').on('click', (event) => {
    event.preventDefault(); event.stopPropagation(); close();
  }));
  $card.append($header);
  $card.append($('<div class="sme_memory_review_status">').text(
    (summary.validation_issues ?? []).join(' ') || 'This derived summary needs review before it can influence canon.',
  ));
  $card.append($('<label class="sme_memory_review_label">').text('Resolved arc'), $('<div class="sme_memory_review_sources">').text(summary.arc ?? 'No linked arc text was stored.'));
  const $summaryText = $('<textarea class="text_pole sme_memory_review_text">').val(summary.summary ?? '');
  $card.append($('<label class="sme_memory_review_label">').text('Summary'), $summaryText);
  const sourceIndices = [...new Set(summary.source_message_indices ?? [])].filter(Number.isInteger);
  const $sources = $('<div class="sme_memory_review_sources">').append($('<strong>').text('Source messages'));
  if (sourceIndices.length) {
    for (const index of sourceIndices) {
      $sources.append($('<button class="menu_button">').text(`Message ${index}`).on('click', () => {
        close(); scrollToMemorySource(index, index);
      }));
    }
  } else {
    $sources.append($('<span>').text('No direct chat-message links were stored.'));
  }
  $card.append($sources);
  const $footer = $('<div class="sme_memory_review_footer">');
  const finish = async (approved) => {
    const current = loadArcSummaries();
    const target = current.find((item) => item.id === summaryId);
    if (!target) return;
    target.validation_status = approved ? 'approved' : 'rejected';
    target.semantic_support = approved ? 'user_approved' : 'unsupported';
    target.validation_issues = approved ? [] : [...(target.validation_issues ?? []), 'Rejected during user review.'];
    await saveArcSummaries(current);
    updateArcsUI();
    const next = loadArcSummaries().find(needsArcSummaryReview);
    close();
    if (next) showArcSummaryReviewDialog(next.id);
  };
  $footer.append($('<button class="menu_button">Save & Reverify</button>').on('click', async (event) => {
    event.preventDefault(); event.stopPropagation();
    const current = loadArcSummaries();
    const target = current.find((item) => item.id === summaryId);
    if (!target || !$summaryText.val().trim()) return;
    target.summary = $summaryText.val().trim();
    await reverifyArcSummary(target);
    await saveArcSummaries(current);
    updateArcsUI();
    close();
  }));
  $footer.append($('<button class="menu_button sme_approve_grounding">Approve</button>').on('click', (event) => {
    event.preventDefault(); event.stopPropagation(); finish(true);
  }));
  $footer.append($('<button class="menu_button sme_reject_grounding">Reject</button>').on('click', (event) => {
    event.preventDefault(); event.stopPropagation(); finish(false);
  }));
  $footer.append($('<button class="menu_button">Close</button>').on('click', (event) => {
    event.preventDefault(); event.stopPropagation(); close();
  }));
  $card.append($footer);
  $(dialog).append($card).on('click', (event) => { event.stopPropagation(); if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  document.body.appendChild(dialog);
  dialog.showModal();
}

function groundingReviewMarkup(memory) {
  if (!needsGroundingReview(memory)) return '';
  const reason = (memory.validation_issues ?? ['No validated source messages.']).join(' ');
  const escapedReason = $('<div>').text(reason).html();
  return `<span class="sme_memory_review_badge" title="${escapedReason}"><i class="fa-solid fa-shield-halved"></i></span>
    <button class="sme_approve_grounding menu_button" data-memory-id="${memory.id || ''}" title="Approve this memory and allow it to be used"><i class="fa-solid fa-check"></i></button>
    <button class="sme_reject_grounding menu_button" data-memory-id="${memory.id || ''}" title="Reject this memory and keep it quarantined"><i class="fa-solid fa-xmark"></i></button>`;
}

function scrollToMemorySource(startIdx, endIdx) {
  const $startMsg = $(`#chat .mes[mesid="${startIdx}"]`);
  if (!$startMsg.length) return;
  if ($('#rm_extensions_block').hasClass('openDrawer')) {
    $('#extensions-settings-button .drawer-toggle').trigger('click');
  }
  setTimeout(() => {
    const $chat = $('#chat');
    const scrollTarget = $startMsg.offset().top - $chat.offset().top + $chat.scrollTop();
    $chat.animate({ scrollTop: scrollTarget }, 400);
    for (let i = startIdx; i <= endIdx; i++) {
      const $message = $(`#chat .mes[mesid="${i}"]`);
      if ($message.length) {
        $message.addClass('sme_source_flash');
        setTimeout(() => $message.removeClass('sme_source_flash'), 2400);
      }
    }
  }, 300);
}

function showMemoryReviewDialog(memoryId, scope, characterName = null) {
  $('#sme_memory_review_dialog').remove();
  const load = () =>
    scope === 'session' ? loadSessionMemories() : loadCharacterMemories(characterName);
  const save = async (memories) => {
    if (scope === 'session') {
      await saveSessionMemories(memories);
      await injectSessionMemories();
      updateSessionUI();
    } else {
      saveCharacterMemories(characterName, memories);
      saveSettingsDebounced();
      await injectMemories(characterName);
      renderMemoriesList(memories, characterName);
    }
  };
  const memories = load();
  const memory = memories.find((item) => item.id === memoryId);
  if (!memory) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'sme_memory_review_dialog';
  for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    dialog.addEventListener(eventName, (event) => event.stopPropagation());
  }
  const $card = $('<div class="sme_memory_review_card">');
  const $header = $('<div class="sme_memory_review_header">');
  const reviewTitle = scope === 'session' ? 'Session Memory Review' : 'Long-Term Memory Review';
  $header.append(
    $('<div>').append(
      $('<strong class="sme_memory_review_title">').text(reviewTitle),
    ),
  );
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  $header.append($('<button class="menu_button" title="Close"><i class="fa-solid fa-xmark"></i></button>').on('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  }));
  $card.append($header);

  const reviewReason = needsGroundingReview(memory)
    ? (memory.validation_issues ?? ['No validated source messages.']).join(' ')
    : memory.validation_status === 'approved'
      ? 'Approved during user review.'
      : 'Source claims validated.';
  $card.append($('<div class="sme_memory_review_status">').text(reviewReason));
  const $textarea = $('<textarea class="text_pole sme_memory_review_text">').val(memory.content ?? '');
  $card.append($('<label class="sme_memory_review_label">Memory text</label>'), $textarea);

  const $sources = $('<div class="sme_memory_review_sources">');
  $sources.append($('<strong>').text('Source messages'));
  if (Array.isArray(memory.source_messages) && memory.source_messages.length > 0) {
    for (const [start, end] of memory.source_messages) {
      $sources.append(
        $('<button class="menu_button">')
          .text(start === end ? `Message ${start}` : `Messages ${start}–${end}`)
          .on('click', () => {
            close();
            scrollToMemorySource(start, end);
          }),
      );
    }
  } else {
    $sources.append($('<span>').text('No verified source links are available.'));
  }
  $card.append($sources);

  const $footer = $('<div class="sme_memory_review_footer">');
  const reviewIds = memories.filter(needsGroundingReview).map((item) => item.id);
  const reviewPosition = reviewIds.indexOf(memoryId);
  if (reviewIds.length > 1) {
    $footer.append($('<button class="menu_button">Previous</button>').prop('disabled', reviewPosition <= 0).on('click', () => {
      close();
      showMemoryReviewDialog(reviewIds[reviewPosition - 1], scope, characterName);
    }));
    $footer.append($('<button class="menu_button">Next</button>').prop('disabled', reviewPosition >= reviewIds.length - 1).on('click', () => {
      close();
      showMemoryReviewDialog(reviewIds[reviewPosition + 1], scope, characterName);
    }));
  }
  $footer.append($('<button class="menu_button">Save</button>').on('click', async () => {
    const current = load();
    const target = current.find((item) => item.id === memoryId);
    if (!target || !$textarea.val().trim()) return;
    target.content = $textarea.val().trim();
    await save(current);
    close();
  }));
  if (needsGroundingReview(memory)) {
    const finishReview = async (status) => {
      const current = load();
      const target = current.find((item) => item.id === memoryId);
      if (!target) return;
      target.validation_status = status;
      target.validation_issues = status === 'approved'
        ? []
        : [...(target.validation_issues ?? []), 'Rejected during user review.'];
      await save(current);
      const next = load().find(needsGroundingReview);
      close();
      // Remain in the review surface: advance to the next queued record, or
      // reopen this now-reviewed record when the queue has been exhausted.
      showMemoryReviewDialog(next?.id ?? memoryId, scope, characterName);
    };
    $footer.append($('<button class="menu_button sme_approve_grounding">Approve</button>').on('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finishReview('approved');
    }));
    $footer.append($('<button class="menu_button sme_reject_grounding">Reject</button>').on('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finishReview('rejected');
    }));
  }
  $footer.append($('<button class="menu_button sme_memory_review_delete">Delete</button>').on('click', async () => {
    const current = load().filter((item) => item.id !== memoryId);
    await save(current);
    close();
  }));
  $card.append($footer);
  $(dialog).append($card).on('click', (event) => {
    event.stopPropagation();
    if (event.target === dialog) close();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  $textarea.trigger('focus');
}

/**
 * Shows the non-blocking error total for an in-progress Memorize Chat run and
 * adjusts the status colour without changing the current progress message.
 *
 * @param {number} count
 */
export function setCatchUpErrorCount(count) {
  const $status = $('#sme_status');
  const $count = $('#sme_catch_up_error_count');
  const safeCount = Math.max(0, Number(count) || 0);

  $status.removeClass('sme_status_warning sme_status_error');
  $count.removeClass('sme_catch_up_errors_many').hide().text('');

  if (safeCount === 0) return;

  if (safeCount <= 10) {
    $status.addClass('sme_status_warning');
  } else {
    $status.addClass('sme_status_error');
    $count.addClass('sme_catch_up_errors_many');
  }

  $count.text(`${safeCount} ${safeCount === 1 ? 'error' : 'errors'} during this run`).show();
}

/**
 * Updates the continuity badge shown in the settings panel header.
 * Called after the Profile B auto-check completes each AI turn.
 * @param {number|null} count - Contradiction count from checkContinuity, or null to clear.
 */
export function setContinuityBadge(count) {
  const $badge = $('#sme_continuity_badge');
  $badge.removeClass('sme_continuity_badge_clean sme_continuity_badge_warn');
  if (count === null) {
    $badge.hide();
    return;
  }
  if (count === 0) {
    $badge.addClass('sme_continuity_badge_clean').text('clean').show();
    // Positive state is transient - hide after 4 s so it doesn't linger.
    setTimeout(() => $badge.hide(), 4000);
  } else {
    $badge
      .addClass('sme_continuity_badge_warn')
      .text(`${count} conflict${count === 1 ? '' : 's'}`)
      .show();
  }
}

/**
 * Displays memory search results in a dismissible modal overlay.
 * Called by the /sme-search slash command.
 * @param {string} query - The original search query.
 * @param {Array<{mem: Object, score: number}>} results - Top-K scored memories, sorted descending.
 */
export function showSearchResults(query, results) {
  $('#sme_search_overlay').remove();

  // Use a <dialog> element so it renders in the browser's top layer, immune
  // to ST's transformed ancestors that trap position:fixed divs on mobile.
  const dialog = document.createElement('dialog');
  dialog.id = 'sme_search_overlay';

  const card = $('<div class="sme_search_card">');
  card.append($('<h3>Memory Search Results</h3>'));
  card.append(
    $('<p class="sme_search_query_label">').text(
      `Query: "${query}" - ${results.length} result${results.length === 1 ? '' : 's'}`,
    ),
  );

  if (results.length === 0) {
    card.append($('<p>').text('No matching memories found.'));
  } else {
    const $list = $('<ul class="sme_search_list">');
    for (const { mem, score } of results) {
      const $item = $('<li class="sme_search_item">');
      $item.append(
        $('<span class="sme_search_badge sme_search_badge_tier">').text(mem._tier),
        $('<span>').addClass(`sme_search_badge sme_type_${mem.type}`).text(mem.type),
        $('<span class="sme_search_content">').text(String(mem.content || '')),
        $('<span class="sme_search_score">').text(`${Math.round(score * 100)}%`),
      );
      $list.append($item);
    }
    card.append($list);
  }

  const $footer = $('<div class="sme_search_footer">');
  const $dismiss = $('<button>Dismiss</button>').addClass('menu_button');
  const dismiss = () => {
    dialog.close();
    dialog.remove();
  };
  $dismiss.on('click', dismiss);
  $(dialog).on('click', (e) => {
    if (e.target === dialog) dismiss();
  });
  $footer.append($dismiss);
  card.append($footer);
  $(dialog).append(card);
  document.body.appendChild(dialog);
  dialog.showModal();
}

/**
 * Injects a single #sme-tooltip div into <body> and wires up hover/focus
 * events on all .sm-info elements inside the settings panel.
 *
 * Using position:fixed on the tooltip div means it escapes ST's
 * overflow:hidden extensions panel and is never clipped at the edge.
 */
export function initTooltips() {
  // Remove any previous tooltip element before creating a new one.
  // Guards against the settings panel being re-rendered (e.g. on extension
  // reload) which would otherwise append a second tooltip div to the body.
  document.getElementById('sme-tooltip')?.remove();
  const tooltip = document.createElement('div');
  tooltip.id = 'sme-tooltip';
  document.body.appendChild(tooltip);

  const panel = document.getElementById('smart_memory_enhanced_settings');
  if (!panel) return;

  panel.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.sm-info');
    if (!target?.dataset.tooltip) return;
    tooltip.textContent = target.dataset.tooltip;
    const rect = target.getBoundingClientRect();
    // Prefer showing below the icon; flip above if too close to the bottom.
    const spaceBelow = window.innerHeight - rect.bottom;
    // Use the tooltip's actual rendered width to clamp the left position,
    // falling back to 260 before the first render when offsetWidth is 0.
    const tooltipWidth = tooltip.offsetWidth || 260;
    tooltip.style.left = `${Math.min(rect.left, window.innerWidth - tooltipWidth - 8)}px`;
    tooltip.style.top =
      spaceBelow > 80 ? `${rect.bottom + 6}px` : `${rect.top - tooltip.offsetHeight - 6}px`;
    tooltip.classList.add('sm-tooltip-visible');
  });

  panel.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.sm-info')) return;
    tooltip.classList.remove('sm-tooltip-visible');
  });
}

/** Syncs the short-term summary textarea with the current summary text. */
export function updateShortTermUI(summary) {
  $('#sme_current_summary').val(summary || '');
}

/**
 * Updates the Canon section UI to reflect the currently stored canon for the
 * given character. Populates the display textarea and status line.
 * @param {string|null} characterName
 */
export function updateCanonUI(characterName) {
  const canon = characterName ? loadCanon(characterName) : null;
  $('#sme_canon_display').val(canon?.text || '');
  if (canon) {
    const arcCount = loadArcSummaries().filter(isRecordApprovedForPropagation).length;
    $('#sme_canon_status').text(
      `Canon: ${estimateTokens(canon.text)} tokens, sourced from ${arcCount} arc summar${arcCount === 1 ? 'y' : 'ies'}.`,
    );
  } else {
    $('#sme_canon_status').text('');
  }
}

/** Re-renders the long-term memories list and entity panel for the given character. */
export function updateLongTermUI(characterName) {
  const policy = characterName ? getCharacterMemoryPolicy(characterName) : 'full';
  $('#sme_character_memory_policy').val(policy).prop('disabled', !characterName);
  const isProtected = policy === 'read_only' || policy === 'disabled';
  const policyText = {
    full: 'Full: this card can create, retain, and inject reusable memories.',
    chat_local: 'Chat-Local Only: starts with a fresh local store and never copies reusable-card history into this chat.',
    read_only: 'Read-Only: existing card memories can be used, but this card cannot be changed.',
    disabled: 'Disabled: card-scoped memory is neither injected nor updated.',
  }[policy];
  $('#sme_character_policy_notice').text(characterName
    ? `${policyText} Shared chat tiers (summary, session, scenes, arcs, and State Ledger) remain chat-wide.`
    : 'Select a character card to set its policy.');
  $('#sme_generate_canon, #sme_add_relationship, #sme_clear_relationships, #sme_epistemic_add, #sme_epistemic_clear')
    .prop('disabled', isProtected)
    .attr('title', isProtected ? 'Blocked by this card\'s memory policy' : '');
  const memories = characterName ? loadCharacterMemories(characterName) : [];
  renderMemoriesList(memories, characterName);
  updateEntityPanel(characterName);
}

/**
 * Renders the relationship history panel for the given character.
 * Each pair is shown as an editable row with subject, arrow, target,
 * descriptors, magnitude, and delete/edit controls.
 * @param {string|null} characterName
 */
export function updateRelationshipHistoryUI(characterName) {
  const $list = $('#sme_relationships_list');
  $list.empty();

  const history = characterName ? loadRelationshipHistory(characterName) : {};
  const pairs = Object.entries(history);

  if (pairs.length === 0) {
    $list.append('<div class="sme_no_char">No relationship history yet.</div>');
    return;
  }

  for (const [key, state] of pairs) {
    const [subject, target] = key.split('→').map((s) => s.trim());
    const descriptors = state.descriptors ?? [];
    const displayPair = getRelationshipHistoryPairDisplay(key, state);
    // Display as "word(magnitude), word(magnitude)" for per-descriptor magnitudes.
    const descriptorStr = descriptors.map((d) => `${d.word}(${d.magnitude})`).join(', ');
    // For the edit form, serialize as "word(magnitude), ..." so it round-trips cleanly.
    const descriptorFieldVal = descriptorStr;

    const $row = $('<div class="sme_memory_item">');

    const $content = $('<div class="sme_memory_content">').text(
      `${subject} → ${target}: ${descriptorStr}`,
    );

    $content.text(`${displayPair.subject} → ${displayPair.target}: ${descriptorStr}`);

    const $editBtn = $('<button class="sme_memory_action menu_button" title="Edit">')
      .append('<i class="fa-solid fa-pencil"></i>')
      .on('click', () => {
        // Populate the add form for editing this pair.
        $('#sme_rel_subject').val(displayPair.subject);
        $('#sme_rel_target').val(displayPair.target);
        $('#sme_rel_descriptors').val(descriptorFieldVal);
        $('#sme_relationship_add_form').show();
        // Store the key being edited so save can delete the old one.
        $('#sme_relationship_add_form').data('editing', key);
        $('#sme_rel_subject').focus();
      });

    const $deleteBtn = $(
      '<button class="sme_memory_action sme_memory_delete menu_button" title="Delete">',
    )
      .append('<i class="fa-solid fa-trash-can"></i>')
      .on('click', async () => {
        const h = loadRelationshipHistory(characterName);
        delete h[key];
        saveRelationshipHistory(characterName, h);
        saveSettingsDebounced();
        injectRelationshipHistory(characterName);
        updateRelationshipHistoryUI(characterName);
        updateTokenDisplay();
      });

    $row.append($content, $editBtn, $deleteBtn);
    $list.append($row);
  }
}

/**
 * Builds a custom type-picker widget to replace the native <select>.
 * Native selects don't allow reliable per-option background styling in
 * Chromium/Electron because the select's own background bleeds into the
 * open dropdown, overriding option colors inconsistently.
 *
 * The returned element exposes its current value via $(el).data('value').
 * Clicking outside any open picker collapses it - register the document
 * handler once at init via initTypePickers().
 *
 * @param {string[]} types - ordered list of type values
 * @returns {jQuery} div.sm-type-picker
 */
export function buildTypePicker(types) {
  const initial = types[0];
  const $picker = $('<div class="sm-type-picker">').attr('data-value', initial);
  const $current = $('<div class="sm-type-picker-current">')
    .attr('data-value', initial)
    .text(initial);
  const $list = $('<div class="sm-type-picker-list">');

  types.forEach((t) => {
    $list.append($('<div class="sm-type-option">').attr('data-value', t).text(t));
  });

  $picker.append($current, $list);

  $current.on('click', (e) => {
    e.stopPropagation();
    // Close any other open pickers first.
    $('.sm-type-picker').not($picker).removeClass('open');
    $picker.toggleClass('open');
  });

  $list.on('click', '.sm-type-option', function () {
    const val = $(this).data('value');
    $picker.attr('data-value', val).removeClass('open');
    $current.attr('data-value', val).text(val);
  });

  return $picker;
}

/**
 * Registers a single document-level click handler that closes all open
 * type pickers when the user clicks outside them. Called once at init.
 */
export function initTypePickers() {
  $(document).on('click.smTypePicker', (e) => {
    if (!$(e.target).closest('.sm-type-picker').length) {
      $('.sm-type-picker').removeClass('open');
    }
  });
}

/**
 * Shows or hides the embedding inactive notice at the top of the settings panel.
 * Visible when embeddings are disabled in settings OR when an API call has
 * failed this session (meaning the model is enabled but unreachable).
 */
export function updateEmbeddingNotice() {
  const settings = getSettings();
  const inactive = !settings.embedding_enabled || hasEmbeddingFailed();
  $('#sme_embedding_notice').toggle(inactive);
}

/** Syncs the Fresh Start checkbox state. */
export function updateFreshStartUI(freshStart) {
  $('#sme_read_only').prop('checked', !!freshStart);
  $('body').toggleClass('sme-read-only', !!freshStart);
}

/**
 * Re-renders the session memory list with per-entry edit and delete buttons.
 * Shows a placeholder when no session memories exist yet.
 */
export function updateSessionUI() {
  const memories = loadSessionMemories();
  const $list = $('#sme_session_list');
  $list.empty();

  const reviewCount = memories.filter(needsGroundingReview).length;
  if (reviewCount > 0) {
    $list.append(
      `<div class="sme_review_queue_notice"><i class="fa-solid fa-shield-halved"></i> ${reviewCount} memor${reviewCount === 1 ? 'y needs' : 'ies need'} grounding review. <button class="sme_open_review_queue menu_button"><i class="fa-solid fa-list-check"></i> Open Review Queue</button></div>`,
    );
  }

  $list.find('.sme_open_review_queue').on('click', () => {
    const first = memories.find(needsGroundingReview);
    if (first) showMemoryReviewDialog(first.id, 'session');
  });

  if (memories.length === 0) {
    $list.append('<div class="sme_no_char">No session memories yet.</div>');
  }

  const sortedSession = [...memories].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const hasRetiredSession = sortedSession.some((m) => m.superseded_by);

  if (hasRetiredSession) {
    const $toggle = $(
      '<button class="sme_toggle_retired menu_button" style="margin-bottom:6px;font-size:0.8em;">' +
        '<i class="fa-solid fa-eye-slash"></i> Show retired memories</button>',
    );
    $list.append($toggle);
    $toggle.on('click', function () {
      const showing = $list.find('.sme_memory_item.sme_memory_retired').first().is(':visible');
      $list.find('.sme_memory_item.sme_memory_retired').toggle(!showing);
      $(this).html(
        `<i class="fa-solid ${showing ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showing ? 'Show' : 'Hide'} retired memories`,
      );
    });
  }

  sortedSession.forEach((mem, idx) => {
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sme_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sme_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sme_superseded_by_link menu_button" data-superseded-by="${mem.superseded_by}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sme_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';
    const groundingReview = groundingReviewMarkup(mem);

    const importanceDots = '●'.repeat(mem.importance ?? 1);
    const expiration = mem.expiration ?? 'session';
    const $item = $(`
            <div class="sme_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${mem.id || ''}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sme_memory_type sme_type_${mem.type}">${mem.type}</span>
                <span class="sme_memory_importance sme_importance_${mem.importance ?? 1}" title="Importance ${mem.importance ?? 1}/3">${importanceDots}</span>
                <span class="sme_memory_expiration sme_expiration_${expiration}" title="Expires: ${expiration}">${expiration}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}${groundingReview}
                <button class="sme_memory_text sme_memory_open menu_button" data-memory-id="${mem.id || ''}" title="Open memory review">${$('<div>').text(mem.content).html()}</button>
                ${Array.isArray(mem.source_messages) && mem.source_messages.length > 0 ? `<button class="sme_jump_source menu_button" data-source-start="${mem.source_messages[mem.source_messages.length - 1][0]}" data-source-end="${mem.source_messages[mem.source_messages.length - 1][1]}" title="Jump to source message"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}
                <button class="sme_edit_session_memory menu_button" data-index="${idx}" title="Edit this memory" ${isRetired ? 'style="display:none"' : ''}>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sme_delete_session_memory menu_button" data-index="${idx}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  // Jump-to-replacement handler for "→ superseded by" links.
  $list.find('.sme_superseded_by_link').on('click', function () {
    const targetId = $(this).data('superseded-by');
    if (!targetId) return;
    const $target = $list.find(`.sme_memory_item[data-memory-id="${targetId}"]`);
    if (!$target.length) return;
    // Ensure the target is visible - if it is also retired, make sure retired items are shown.
    if (!$target.is(':visible')) {
      $list.find('.sme_memory_item.sme_memory_retired').show();
      $list
        .find('.sme_toggle_retired')
        .html('<i class="fa-solid fa-eye"></i> Hide retired memories');
    }
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    $target.addClass('sme_memory_highlight');
    setTimeout(() => $target.removeClass('sme_memory_highlight'), 1500);
  });

  $list.find('.sme_jump_source').on('click', function () {
    const startIdx = parseInt($(this).data('source-start'), 10);
    const endIdx = parseInt($(this).data('source-end'), 10);
    const $startMsg = $(`#chat .mes[mesid="${startIdx}"]`);
    if (!$startMsg.length) return;
    // Close the extensions panel so the chat is visible when the scroll lands.
    if ($('#rm_extensions_block').hasClass('openDrawer')) {
      $('#extensions-settings-button .drawer-toggle').trigger('click');
    }
    // Scroll to the first message in the source range.
    setTimeout(() => {
      const $chat = $('#chat');
      const scrollTarget = $startMsg.offset().top - $chat.offset().top + $chat.scrollTop();
      $chat.animate({ scrollTop: scrollTarget }, 400);
      // Flash all messages in the range so the user can see what produced this memory.
      const FLASH_DURATION_MS = 2400; // 3 pulses × 0.8 s each
      for (let i = startIdx; i <= endIdx; i++) {
        const $m = $(`#chat .mes[mesid="${i}"]`);
        if ($m.length) {
          $m.addClass('sme_source_flash');
          setTimeout(() => $m.removeClass('sme_source_flash'), FLASH_DURATION_MS);
        }
      }
    }, 300);
  });

  $list.find('.sme_memory_open').on('click', function () {
    showMemoryReviewDialog($(this).data('memory-id'), 'session');
  });

  $list.find('.sme_edit_session_memory').on('click', async function () {
    showMemoryReviewDialog($(this).closest('.sme_memory_item').data('memory-id'), 'session');
    return;
    const idx = parseInt($(this).data('index'), 10);
    const $item = $(this).closest('.sme_memory_item');
    const $textSpan = $item.find('.sme_memory_text');
    const current = loadSessionMemories();
    if (!current[idx]) return;

    // Replace text span with an inline textarea for editing.
    const $textarea = $('<textarea class="sme_memory_edit_input">').val(current[idx].content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    // Swap edit/delete buttons with save/cancel.
    $(this).hide();
    $item.find('.sme_delete_session_memory').hide();
    const $save = $(
      '<button class="sme_save_session_memory menu_button" title="Save">Save</button>',
    );
    const $cancel = $(
      '<button class="sme_cancel_session_memory menu_button" title="Cancel">Cancel</button>',
    );
    $item.append($save, $cancel);

    $save.on('click', async () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const memories = loadSessionMemories();
      if (!memories[idx]) return;
      memories[idx].content = newContent;
      await saveSessionMemories(memories);
      await injectSessionMemories();
      updateSessionUI();
    });

    $cancel.on('click', () => updateSessionUI());
  });

  $list.find('.sme_delete_session_memory').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const context = getContext();
    const meta = context.chatMetadata?.[META_KEY];
    if (!meta?.sessionMemories) return;
    meta.sessionMemories.splice(idx, 1);
    await context.saveMetadata();
    injectSessionMemories();
    updateSessionUI();
  });

  $list.find('.sme_approve_grounding, .sme_reject_grounding').on('click', async function () {
    const id = $(this).data('memory-id');
    const memories = loadSessionMemories();
    const memory = memories.find((item) => item.id === id);
    if (!memory) return;
    const approved = $(this).hasClass('sme_approve_grounding');
    memory.validation_status = approved ? 'approved' : 'rejected';
    memory.validation_issues = approved ? [] : [...(memory.validation_issues ?? []), 'Rejected during user review.'];
    await saveSessionMemories(memories);
    await injectSessionMemories();
    updateSessionUI();
  });

  // Add memory form at the bottom of the list.
  $list.next('.sme_add_memory_form').remove();
  const $addForm = $(`
    <div class="sme_add_memory_form">
      <input type="text" class="sme_add_memory_input" placeholder="New session memory...">
      <button class="sme_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $addForm.prepend(buildTypePicker(SESSION_TYPES));
  $list.after($addForm);

  $addForm.find('.sme_add_memory_btn').on('click', async () => {
    const type = $addForm.find('.sm-type-picker').data('value');
    const content = $addForm.find('.sme_add_memory_input').val().trim();
    if (!content) return;
    const memories = loadSessionMemories();
    memories.push({
      type,
      content,
      importance: 2,
      expiration: 'session',
      ts: Date.now(),
      consolidated: true,
      confidence: 1.0,
      persona_relevance: 1,
      intimacy_relevance: 1,
      retrieval_count: 0,
      last_confirmed_ts: Date.now(),
    });
    await saveSessionMemories(memories);
    await injectSessionMemories();
    updateSessionUI();
  });
}

/** Re-renders the scene history list. */
export function updateScenesUI() {
  const history = loadSceneHistory();
  const $list = $('#sme_scenes_list');
  $list.empty();

  if (history.length === 0) {
    $list.append('<div class="sme_no_char">No scenes recorded yet.</div>');
    return;
  }

  history.forEach((s, i) => {
    const range = Number.isInteger(s.source_start_index) && Number.isInteger(s.source_end_index)
      ? ` &middot; messages ${s.source_start_index + 1}-${s.source_end_index + 1}`
      : '';
    const method = s.detected_by ? ` &middot; ${s.detected_by}` : '';
    const validation = s.validation_status && s.validation_status !== 'validated' ? ` &middot; ${s.validation_status}` : '';
    const canJump = Number.isInteger(s.source_start_index);
    $list.append(
      `<div class="sme_scene_item"><div><b>Scene ${i + 1}:</b> ${$('<div>').text(s.summary).html()}</div><small class="sm-muted">${range}${method}${validation}</small><span class="sme_scene_actions">${canJump ? `<button class="sme_jump_scene menu_button" data-index="${i}" title="Jump to the source messages"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}<button class="sme_resummarize_scene menu_button" data-index="${i}" title="Generate this summary again from its source messages"><i class="fa-solid fa-rotate"></i></button><button class="sme_edit_scene menu_button" data-index="${i}" title="Edit scene summary"><i class="fa-solid fa-pencil"></i></button><button class="sme_delete_scene menu_button" data-index="${i}" title="Delete scene"><i class="fa-solid fa-trash-can"></i></button></span></div>`,
    );
  });
}

/** Re-renders the story arcs list with per-arc edit, resolve, and add buttons. */
export function updateArcsUI() {
  const arcs = loadArcs();
  const $list = $('#sme_arcs_list');
  const $resolvedList = $('#sme_resolved_arcs_list');
  const $resolvedSection = $('#sme_resolved_arcs_section');
  $list.empty();
  $resolvedList.empty();

  const ctx = getContext();
  const groupId = ctx.groupId ?? null;
  const charName = groupId ? null : getCurrentCharacterName();
  const canPin = !!(charName || groupId);

  const activeArcs = arcs.filter((a) => !a.resolved);
  const resolvedArcs = arcs.filter((a) => a.resolved);

  if (activeArcs.length === 0) {
    $list.append('<div class="sme_no_char">No open story threads.</div>');
  }

  arcs.forEach((arc, idx) => {
    const isPersistent = !!arc.persistent;
    const isResolved = !!arc.resolved;

    if (isResolved) {
      const $item = $(`
              <div class="sme_arc_item sme_arc_persistent sme_arc_resolved" data-index="${idx}">
                  <span class="sme_arc_text">${$('<div>').text(arc.content).html()}</span>
                  <button class="sme_reopen_arc menu_button" data-index="${idx}" title="Re-open this thread"><i class="fa-solid fa-rotate-left"></i></button>
                  <button class="sme_remove_resolved_arc menu_button" data-index="${idx}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
              </div>
          `);
      $resolvedList.append($item);
    } else {
      const pinTitle = isPersistent
        ? 'Unpin - keep only in this chat'
        : 'Pin - carry this thread into future chats';
      const $item = $(`
              <div class="sme_arc_item${isPersistent ? ' sme_arc_persistent' : ''}" data-index="${idx}">
                  <span class="sme_arc_text">${$('<div>').text(arc.content).html()}</span>
                  ${canPin ? `<button class="sme_pin_arc menu_button${isPersistent ? ' sme_pin_active' : ''}" data-index="${idx}" title="${pinTitle}"><i class="fa-solid fa-thumbtack"></i></button>` : ''}
                  <button class="sme_edit_arc menu_button" data-index="${idx}" title="Edit this arc">
                      <i class="fa-solid fa-pencil"></i>
                  </button>
                  <button class="sme_resolve_arc menu_button" data-index="${idx}" title="Resolve this thread and generate an arc summary. Best used right after the thread concludes in the story - the summary is built from recent scene context, so resolving old threads may produce vague results.">
                      <i class="fa-solid fa-check"></i>
                  </button>
                  <button class="sme_delete_arc menu_button" data-index="${idx}" title="Delete this thread without summarising">
                      <i class="fa-solid fa-trash-can"></i>
                  </button>
              </div>
          `);
      $list.append($item);
    }
  });

  // Show the resolved section only when there are resolved arcs.
  $resolvedSection.toggle(resolvedArcs.length > 0);
  const pendingSummaries = loadArcSummaries().filter(needsArcSummaryReview);
  if (pendingSummaries.length > 0) {
    const $notice = $('<div class="sme_review_queue_notice">').append(
      $('<span>').html(`<i class="fa-solid fa-shield-halved"></i> ${pendingSummaries.length} resolved arc ${pendingSummaries.length === 1 ? 'summary needs' : 'summaries need'} review.`),
      $('<button class="menu_button">Review Resolved Summaries</button>').on('click', (event) => {
        event.preventDefault(); event.stopPropagation(); showArcSummaryReviewDialog(pendingSummaries[0].id);
      }),
      $('<button class="menu_button">Reverify All</button>').on('click', async (event) => {
        event.preventDefault(); event.stopPropagation();
        const current = loadArcSummaries();
        const pending = current.filter(needsArcSummaryReview);
        let checked = 0;
        for (const summary of pending) {
          try {
            await reverifyArcSummary(summary);
            checked++;
          } catch (error) {
            console.warn('[Smart Memory Enhanced] Could not reverify a resolved arc summary:', error);
          }
        }
        if (checked) await saveArcSummaries(current);
        updateArcsUI();
      }),
    );
    $resolvedList.prepend($notice);
    $resolvedSection.toggle(true);
  }

  $resolvedList.find('.sme_reopen_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await reopenArc(idx, charName, groupId);
    injectArcs();
    updateArcsUI();
  });

  $resolvedList.find('.sme_remove_resolved_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const arc = loadArcs()[idx];
    if (!arc) return;
    await deleteArc(idx, charName);
    if (groupId) {
      const gP = loadGroupPersistentArcs(groupId);
      saveGroupPersistentArcs(
        groupId,
        gP.filter((p) => p.content !== arc.content),
      );
    } else if (charName) {
      const cP = loadPersistentArcs(charName);
      savePersistentArcs(
        charName,
        cP.filter((p) => p.content !== arc.content),
      );
    }
    injectArcs();
    updateArcsUI();
  });

  $list.find('.sme_pin_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const arc = loadArcs()[idx];
    if (!arc) return;
    if (arc.persistent) {
      await demoteArc(idx, charName, groupId);
    } else {
      await promoteArc(idx, charName, groupId);
    }
    injectArcs();
    updateArcsUI();
  });

  $list.find('.sme_edit_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const $item = $(this).closest('.sme_arc_item');
    const $textSpan = $item.find('.sme_arc_text');
    const current = loadArcs();
    if (!current[idx]) return;

    const $textarea = $('<textarea class="sme_memory_edit_input">').val(current[idx].content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    $(this).hide();
    $item.find('.sme_pin_arc').hide();
    $item.find('.sme_delete_arc').hide();
    const $save = $('<button class="sme_save_arc menu_button" title="Save">Save</button>');
    const $cancel = $('<button class="sme_cancel_arc menu_button" title="Cancel">Cancel</button>');
    $item.append($save, $cancel);

    $save.on('click', async () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const arcs = loadArcs();
      if (!arcs[idx]) return;
      const oldContent = arcs[idx].content;
      const isPersistent = !!arcs[idx].persistent;
      arcs[idx].content = newContent;
      await saveArcs(arcs);
      // Mirror content edits into the persistent store so the updated text
      // carries into future chats instead of the old version resurfacing.
      if (isPersistent) {
        if (groupId) {
          const gPersistent = loadGroupPersistentArcs(groupId);
          const match = gPersistent.find((p) => p.content === oldContent);
          if (match) {
            match.content = newContent;
            saveGroupPersistentArcs(groupId, gPersistent);
          }
        } else if (charName) {
          const cPersistent = loadPersistentArcs(charName);
          const match = cPersistent.find((p) => p.content === oldContent);
          if (match) {
            match.content = newContent;
            savePersistentArcs(charName, cPersistent);
          }
        }
      }
      injectArcs();
      updateArcsUI();
    });

    $cancel.on('click', () => updateArcsUI());
  });

  $list.find('.sme_resolve_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    const summaryGenerated = await resolveArcWithSummary(idx, charName, groupId);
    if (summaryGenerated) {
      $(document).trigger('smart_memory_enhanced:arc_resolved_with_summary', [charName, groupId]);
    }
    injectArcs();
    updateArcsUI();
  });

  $list.find('.sme_delete_arc').on('click', async function () {
    const idx = parseInt($(this).data('index'), 10);
    await deleteArc(idx, charName);
    injectArcs();
    updateArcsUI();
  });

  // Add arc form at the bottom of the list.
  $list.next('.sme_add_memory_form').remove();
  const $addForm = $(`
    <div class="sme_add_memory_form">
      <input type="text" class="sme_add_memory_input" placeholder="New story thread...">
      <button class="sme_add_memory_btn menu_button" title="Add arc">Add</button>
    </div>
  `);
  $list.after($addForm);

  $addForm.find('.sme_add_memory_btn').on('click', async () => {
    const content = $addForm.find('.sme_add_memory_input').val().trim();
    if (!content) return;
    const arcs = loadArcs();
    arcs.push({ content, ts: Date.now() });
    await saveArcs(arcs);
    injectArcs();
    updateArcsUI();
  });
}

/**
 * Updates the profiles display panel with the current stored profiles.
 * Shows a placeholder when no profiles exist yet.
 * @param {{character_state: string, world_state: string, relationship_matrix: string}|null} profiles
 */
export function updateProfilesUI(profiles) {
  const $display = $('#sme_profiles_display');
  $display.empty();

  if (!profiles) {
    $display.append('<span class="sm-muted">No profiles generated yet.</span>');
    return;
  }

  const sections = [
    { key: 'character_state', label: 'Character state' },
    { key: 'world_state', label: 'World state' },
    { key: 'relationship_matrix', label: 'Current Relationships' },
  ];

  let hasContent = false;
  for (const { key, label } of sections) {
    const text = profiles[key];
    if (!text) continue;
    $display.append($('<span class="sme_profiles_section-label">').text(label + ':'));
    $display.append($('<div>').text(text));
    hasContent = true;
  }

  if (!hasContent) {
    $display.append('<span class="sm-muted">No profiles generated yet.</span>');
  }
}

/**
 * Renders the entity registry panel, combining long-term (extension_settings)
 * and session-scoped (chatMetadata) entities. Each entity row shows its type
 * badge, canonical name, memory count, and last-seen message index. Clicking
 * an entity row opens its timeline view.
 *
 * @param {string|null} characterName - Current character name for long-term registry lookup.
 */
/** Safely reconciles unambiguous canonical entity aliases without opening UI. */
export async function reconcileCanonicalEntities(characterName) {
  const ltEntities = characterName ? loadCharacterEntityRegistry(characterName) : [];
  const sessionEntities = loadSessionEntityRegistry();
  const longtermMemories = characterName ? loadCharacterMemories(characterName) : [];
  const sessionMemories = loadSessionMemories();
  // Final reconciliation needs the active persona plus approved chat-local
  // characters in the same authoritative roster used for every store.
  const roster = buildCanonicalCharacterRoster(getContext(), { includeChatLocalApproved: true });
  const rewriteStoredNarratives = (memories) => memories.reduce((count, memory) => {
    if (typeof memory.content !== 'string') return count;
    const narrative = canonicalizeNarrativeNames(memory.content, roster);
    if (!narrative.replacements.length) return count;
    memory.content = narrative.text;
    memory.identity_replacements = narrative.replacements;
    return count + narrative.replacements.length;
  }, 0);
  const longtermRewrites = rewriteStoredNarratives(longtermMemories);
  const sessionRewrites = rewriteStoredNarratives(sessionMemories);
  const ltReport = characterName ? reconcileCanonicalEntityRegistry(ltEntities, getContext(), longtermMemories) : { changed: false, matched: [], merged: [], skipped: [], unmatched: [] };
  const sessionReport = reconcileCanonicalEntityRegistry(sessionEntities, getContext(), sessionMemories);
  // Chat-local card stores are independent of the selected card. Reconcile all
  // of them so a unique active persona alias such as Kyle -> Kyle Holland does
  // not survive in an off-screen group member's local registry.
  const meta = getContext().chatMetadata?.[META_KEY] ?? {};
  const localReports = [];
  let localRewrites = 0;
  let localRelationshipPairsMerged = 0;
  for (const [localName, localRegistry] of Object.entries(meta.card_local_entities ?? {})) {
    const localMemories = meta.card_local_memories?.[localName] ?? [];
    localRewrites += rewriteStoredNarratives(localMemories);
    localReports.push(reconcileCanonicalEntityRegistry(localRegistry, getContext(), localMemories));
  }
  for (const [localName, history] of Object.entries(meta.card_local_relationships ?? {})) {
    const relationshipResult = reconcileRelationshipHistoryMap(history, roster);
    if (!relationshipResult.changed) continue;
    meta.card_local_relationships[localName] = relationshipResult.history;
    localRelationshipPairsMerged += relationshipResult.merged;
  }
  // A canonical name may have been repaired independently in card-local and
  // session stores. Collapse those surviving stable-ID variants now, before
  // any relationship or structured-store reconciliation consumes them.
  const allReports = [ltReport, sessionReport, ...localReports];
  let crossStoreEntityMerges = 0;
  let crossStoreReferencesRedirected = 0;
  for (const report of allReports) {
    for (const merge of report.merged ?? []) {
      if (!merge.sourceId || !merge.targetId) continue;
      const result = mergeCanonicalEntityAcrossStores(merge.sourceId, merge.targetId, getContext());
      if (result.merged) { crossStoreEntityMerges++; crossStoreReferencesRedirected += result.referencesRedirected; }
    }
  }
  const registryGroups = [ltEntities, sessionEntities, ...Object.values(meta.card_local_entities ?? {})].filter(Array.isArray);
  const canonicalGroups = new Map();
  for (const entity of registryGroups.flat()) {
    const key = entity?.canonical_card_id || String(entity?.name ?? '').trim().toLowerCase();
    if (!key || !entity?.id) continue;
    (canonicalGroups.get(key) ?? canonicalGroups.set(key, []).get(key)).push(entity);
  }
  for (const entities of canonicalGroups.values()) {
    if (entities.length < 2) continue;
    // Prefer the session record as the chat-wide canonical target, then the
    // first full-name/card-backed record. This preserves the most broadly
    // shared graph identity without altering narrative text.
    const target = entities.find((entity) => sessionEntities.includes(entity))
      ?? entities.find((entity) => entity.canonical_card_id)
      ?? entities[0];
    for (const source of entities) {
      if (source.id === target.id) continue;
      const result = mergeCanonicalEntityAcrossStores(source.id, target.id, getContext());
      if (result.merged) { crossStoreEntityMerges++; crossStoreReferencesRedirected += result.referencesRedirected; }
    }
  }

  const rewriteNarrativeRecords = (records, keys) => records.reduce((count, record) => {
    for (const key of keys) {
      if (typeof record?.[key] !== 'string') continue;
      const narrative = canonicalizeNarrativeNames(record[key], roster);
      if (!narrative.replacements.length) continue;
      record[key] = narrative.text;
      record.identity_replacements = narrative.replacements;
      count += narrative.replacements.length;
    }
    return count;
  }, 0);
  const scenes = loadSceneHistory();
  const arcs = loadArcs();
  const summaries = loadArcSummaries();
  const ledger = loadStateLedger();
  const reconciledLedger = reconcileCanonicalLedger(ledger, roster);
  const ledgerRewrites = JSON.stringify(ledger) === JSON.stringify(reconciledLedger) ? 0 : 1;
  const reviewQueue = getSettings().identity_review_queue ?? [];
  let syntheticReviewNamesRemoved = 0;
  const normalizedReviewQueue = reviewQueue.map((item) => {
    const normalized = normalizeSyntheticIdentityQualifier(item?.candidateName, roster.characters ?? []);
    if (!normalized.qualifier_removed) return item;
    syntheticReviewNamesRemoved++;
    return { ...item, candidateName: normalized.normalized_name, candidateKey: normalized.normalized_name.toLowerCase(), qualifier_type: normalized.qualifier_type };
  });
  const dedupedReviewQueue = deduplicateIdentityDecisions(normalizedReviewQueue, 'identity-review');
  const reviewDecisionDuplicatesRemoved = reviewQueue.length - dedupedReviewQueue.length;
  if (reviewDecisionDuplicatesRemoved || syntheticReviewNamesRemoved) getSettings().identity_review_queue = dedupedReviewQueue;
  const sceneRewrites = rewriteNarrativeRecords(scenes, ['summary']);
  const arcRewrites = rewriteNarrativeRecords(arcs, ['content']);
  const summaryRewrites = rewriteNarrativeRecords(summaries, ['summary', 'arc']);
  const rewriteParticipantLists = (records) => records.reduce((count, record) => {
    const original = Array.isArray(record?.character_participants) ? record.character_participants : [];
    if (!original.length) return count;
    const canonical = canonicalizeStructuredParticipants(original, roster);
    const references = original.flatMap((displayName) => {
      const resolution = resolveCanonicalCharacterName(displayName, roster);
      return resolution.status === 'resolved' && resolution.canonicalId
        ? [{ entity_id: resolution.canonicalId, canonical_name: resolution.canonicalName, display_name_at_time: String(displayName).trim(), alias_type: resolution.reason ?? 'canonical-name' }]
        : [];
    });
    const changed = JSON.stringify(original) !== JSON.stringify(canonical.names);
    const referencesChanged = references.length > 0 && JSON.stringify(record.participant_references ?? []) !== JSON.stringify(references);
    if (!changed && !referencesChanged) return count;
    record.character_participants = canonical.names;
    if (references.length) record.participant_references = references;
    return count + 1;
  }, 0);
  const sceneParticipantRewrites = rewriteParticipantLists(scenes);
  const arcParticipantRewrites = rewriteParticipantLists(arcs);
  if (ltReport.changed || longtermRewrites > 0) {
    saveCharacterEntityRegistry(characterName, ltEntities);
    saveCharacterMemories(characterName, longtermMemories);
    saveSettingsDebounced();
  }
  if (sessionReport.changed || sessionRewrites > 0 || localReports.some((report) => report.changed) || localRewrites > 0 || crossStoreEntityMerges > 0) {
    await saveSessionEntityRegistry(sessionEntities);
    await saveSessionMemories(sessionMemories);
  }
  if (sceneRewrites || sceneParticipantRewrites) await saveSceneHistory(scenes);
  if (arcRewrites || arcParticipantRewrites) await saveArcs(arcs);
  if (summaryRewrites) await saveArcSummaries(summaries);
  if (ledgerRewrites) await saveStateLedger(reconciledLedger);
  const rosterCharacterNames = (roster.characters ?? [])
    .filter((entry) => entry.source === 'character-card')
    .map((entry) => entry.canonicalName);
  const persistentRelationshipStores = Object.entries(extension_settings[MODULE_NAME]?.characters ?? {})
    .filter(([, store]) => store?.relationship_history)
    .map(([name]) => name);
  const structuredStoreNames = [...new Set([characterName, ...rosterCharacterNames, ...persistentRelationshipStores].filter(Boolean))];
  let relationshipStoresReconciled = 0;
  let persistentRelationshipPairsMerged = 0;
  let epistemicStoresReconciled = 0;
  for (const storeName of structuredStoreNames) {
    const relationshipResult = reconcileRelationshipHistoryCanonicalNames(storeName);
    if (relationshipResult.changed) {
      relationshipStoresReconciled++;
      persistentRelationshipPairsMerged += relationshipResult.merged ?? 0;
    }
    if (reconcileEpistemicCanonicalNames(storeName)) epistemicStoresReconciled++;
  }
  const profileNames = [...new Set([...structuredStoreNames, ...Object.keys(meta.profiles ?? {})].filter(Boolean))];
  let profilesReconciled = 0;
  for (const profileName of profileNames) {
    if (await reconcileProfileCanonicalNames(profileName)) profilesReconciled++;
  }
  // Final read-only integrity audit. Reconciliation has already applied every
  // safe redirect above; this catches a dangling reference before the staged
  // transaction commits, without deleting uncertain user data.
  const knownEntityIds = new Set([
    ...registryGroups.flat().map((entity) => entity?.id),
    ...(roster.characters ?? []).map((entry) => entry?.id),
  ].filter(Boolean));
  const staleEntityReferences = [];
  const auditReferences = (records, store, field = 'entities') => {
    for (const record of records ?? []) {
      for (const id of record?.[field] ?? []) {
        const entityId = typeof id === 'string' ? id : id?.entity_id;
        if (entityId && !knownEntityIds.has(entityId)) staleEntityReferences.push({ store, record_id: record?.id ?? null, entity_id: entityId });
      }
    }
  };
  auditReferences(longtermMemories, 'longterm');
  auditReferences(sessionMemories, 'session');
  for (const [localName, records] of Object.entries(meta.card_local_memories ?? {})) auditReferences(records, `card-local:${localName}`);
  auditReferences(scenes, 'scenes', 'participant_references');
  auditReferences(arcs, 'arcs', 'participant_references');
  // State Ledger cards use a single canonical card link rather than the
  // memory-style `entities` list.  Check it separately so the audit covers
  // every structured store without treating free-form state-card text as an
  // identity reference.
  for (const [ledgerKey, fields] of Object.entries(reconciledLedger ?? {})) {
    const entityId = fields?._canonical_card_id;
    if (entityId && !knownEntityIds.has(entityId)) {
      staleEntityReferences.push({ store: 'state-ledger', record_id: ledgerKey, entity_id: entityId });
    }
  }
  const integrityAudit = {
    stale_entity_references: staleEntityReferences,
    checked_stores: ['longterm', 'session', 'card-local', 'scenes', 'arcs', 'state-ledger'],
    duplicate_canonical_entities: [...canonicalGroups.values()].filter((entries) => entries.length > 1).map((entries) => entries.map((entity) => entity.id)),
    identity_review_items: dedupedReviewQueue.length,
    status: staleEntityReferences.length ? 'degraded' : 'clean',
  };
  return {
    matched: [...ltReport.matched, ...sessionReport.matched, ...localReports.flatMap((report) => report.matched)],
    merged: [...ltReport.merged, ...sessionReport.merged, ...localReports.flatMap((report) => report.merged)],
    skipped: [...ltReport.skipped, ...sessionReport.skipped, ...localReports.flatMap((report) => report.skipped)],
    unmatched: [...ltReport.unmatched, ...sessionReport.unmatched, ...localReports.flatMap((report) => report.unmatched)],
    identity_outcomes: [...(ltReport.outcomes ?? []), ...(sessionReport.outcomes ?? []), ...localReports.flatMap((report) => report.outcomes ?? [])],
    narrative_rewrites: longtermRewrites + sessionRewrites + localRewrites + sceneRewrites + arcRewrites + summaryRewrites + ledgerRewrites,
    participant_lists_rewritten: sceneParticipantRewrites + arcParticipantRewrites,
    persona_roster_size: (roster.characters ?? []).filter((entry) => entry.source === 'user-persona').length,
    card_local_reports: localReports,
    cross_store_entity_merges: crossStoreEntityMerges,
    cross_store_references_redirected: crossStoreReferencesRedirected,
    relationship_pairs_merged: localRelationshipPairsMerged + persistentRelationshipPairsMerged,
    state_ledger_keys_reconciled: ledgerRewrites,
    identity_decision_duplicates_removed: reviewDecisionDuplicatesRemoved,
    synthetic_review_names_removed: syntheticReviewNamesRemoved,
    profiles_reconciled: profilesReconciled,
    relationship_stores_reconciled: relationshipStoresReconciled,
    epistemic_stores_reconciled: epistemicStoresReconciled,
    integrity_audit: integrityAudit,
  };
}

export function updateEntityPanel(characterName) {
  const $panel = $('#sme_entity_panel');
  $panel.empty();

  const ltEntities = characterName ? loadCharacterEntityRegistry(characterName) : [];
  const sessionEntities = loadSessionEntityRegistry();
  const characterPolicy = characterName ? getCharacterMemoryPolicy(characterName) : 'full';

  const $reconcile = $('<button class="menu_button sme_reconcile_entities"><i class="fa-solid fa-wand-magic-sparkles"></i> Reconcile Canonical Entities</button>');
  $reconcile.attr('title', 'Safely merge existing unambiguous card-name variants. Ambiguous names are left unchanged.');
  $reconcile.on('click', async () => {
    const report = await reconcileCanonicalEntities(characterName);
    updateEntityPanel(characterName);
    const dialog = document.createElement('dialog');
    dialog.className = 'sme_reconcile_dialog';
    for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      dialog.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const closeReport = () => {
      dialog.close();
      dialog.remove();
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeReport();
    });
    const $report = $('<div class="sme_reconcile_report">').append('<h3>Canonical reconciliation results</h3>');
    const addSection = (label, rows, formatter) => {
      if (!rows.length) return;
      const $section = $('<div class="sme_reconcile_report_section">').append($('<strong>').text(label));
      const $list = $('<ul>');
      rows.forEach((row) => $list.append($('<li>').text(formatter(row))));
      $section.append($list); $report.append($section);
    };
    addSection('Matched', report.matched, (row) => `${row.name} → ${row.canonicalName} (${row.match})`);
    addSection('Merged', report.merged, (row) => `${row.name} → ${row.canonicalName} (${row.match})`);
    addSection('Needs review', report.skipped, (row) => `${row.name}: ${row.reason}`);
    addSection('No card match', report.unmatched, (row) => `${row.name}: ${row.reason}`);
    if (report.narrative_rewrites > 0) {
      $report.append($('<p class="sm-muted">').text(`${report.narrative_rewrites} deterministic card/persona name rewrite(s) applied to stored memories.`));
    }
    if (!$report.find('li').length) $report.append('<p class="sm-muted">No eligible character entries needed reconciliation.</p>');
    $report.append($('<button class="menu_button">Close</button>').on('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeReport();
    }));
    $(dialog).append($report); document.body.appendChild(dialog); dialog.showModal();
  });
  $panel.append($reconcile);
  const reviewQueue = getSettings().identity_review_queue ?? [];
  if (reviewQueue.length) {
    const $review = $(`<button class="menu_button sme_identity_review"><i class="fa-solid fa-shield-halved"></i> Review identity candidates (${reviewQueue.length})</button>`);
    $review.on('click', () => {
      const dialog = document.createElement('dialog');
      // SillyTavern listens for document-level clicks to close drawers. Keep
      // every interaction inside this modal from reaching those handlers.
      for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        dialog.addEventListener(eventName, (event) => event.stopPropagation());
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
      });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      const $card = $('<div class="sme_memory_review_card">').append('<h3>Identity candidate review</h3><p class="sm-muted">Approve only an identity you can verify. Pending candidates remain quarantined until you decide.</p>');
      $card.on('click', (event) => event.stopPropagation());
      const removeItem = (item) => {
        getSettings().identity_review_queue = (getSettings().identity_review_queue ?? []).filter((entry) => entry.id !== item.id);
        saveSettingsDebounced();
      };
      for (const item of reviewQueue) {
        const $row = $('<div class="sme_identity_review_row">');
        $row.append($('<strong>').text(item.candidateName));
        $row.append($('<div class="sm-muted">').text(`${item.reason} Seen ${item.occurrences ?? 1} time(s).`));
        if (item.canonicalName) {
          $row.append($('<div class="sm-muted">').text(`Suggested canonical identity: ${item.canonicalName}.`));
        }
        if ((item.memoryIds ?? []).length) {
          $row.append($('<div class="sm-muted">').text(`Evidence records: ${(item.memoryIds ?? []).length}.`));
        }
        const approve = async (canonicalName) => {
          const target = ltEntities.find((entity) => entity.name === canonicalName || entity.canonical_card_id === item.canonicalId)
            ?? sessionEntities.find((entity) => entity.name === canonicalName || entity.canonical_card_id === item.canonicalId);
          if (!target) {
            $row.find('.sme_identity_review_notice').remove();
            $row.append($('<div class="sme_identity_review_notice">').text(`Cannot approve yet: no stored entity exists for ${canonicalName}. The candidate remains pending.`));
            return;
          }
          getSettings().identity_aliases ??= {};
          getSettings().identity_aliases[item.candidateKey ?? item.candidateName.toLowerCase()] = {
            canonicalName: target.name,
            canonicalId: target.canonical_card_id ?? item.canonicalId ?? null,
            approvedAt: Date.now(),
          };
          target.aliases = [...new Set([...(target.aliases ?? []), item.candidateName])];
          const linkMemories = (memories) => {
            for (const memory of memories) {
              if (!(item.memoryIds ?? []).includes(memory.id)) continue;
              memory.entities = [...new Set([...(memory.entities ?? []), target.id])];
              target.memory_ids = [...new Set([...(target.memory_ids ?? []), memory.id])];
            }
          };
          const longtermMemories = characterName ? loadCharacterMemories(characterName) : [];
          const sessionMemories = loadSessionMemories();
          linkMemories(longtermMemories); linkMemories(sessionMemories);
          if (characterName) {
            saveCharacterEntityRegistry(characterName, ltEntities);
            saveCharacterMemories(characterName, longtermMemories);
          }
          await saveSessionEntityRegistry(sessionEntities);
          await saveSessionMemories(sessionMemories);
          removeItem(item);
          $row.remove();
          updateEntityPanel(characterName);
        };
        const choices = item.canonicalName ? [item.canonicalName] : (item.candidates ?? []);
        for (const canonicalName of choices) {
          $row.append($('<button class="menu_button">').text(`Approve as ${canonicalName}`).on('click', () => approve(canonicalName)));
        }
        const $dismiss = $('<button class="menu_button">Dismiss permanently</button>').on('click', () => {
          removeItem(item); $row.remove();
        });
        $row.append($dismiss);
        $card.append($row);
      }
      $card.append($('<button class="menu_button">Close</button>').on('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
      }));
      $(dialog).append($card); document.body.appendChild(dialog); dialog.showModal();
    });
    $panel.append($review);
  }

  // Merge by canonical name + type (case-insensitive) rather than by UUID.
  // The lt and session registries are independent stores with separate UUIDs,
  // so the same named entity (e.g. "Senjin") will have different ids in each.
  // Keying by name|type avoids collisions when two distinct entities share a
  // name but differ by type (e.g. a place "Hollow" vs. a character "Hollow").
  const byName = new Map();
  for (const e of ltEntities) {
    const key = `${e.name.toLowerCase().trim()}|${e.type ?? 'unknown'}`;
    byName.set(key, { ...e, memory_ids: [...(e.memory_ids ?? [])] });
  }
  for (const e of sessionEntities) {
    const key = `${e.name.toLowerCase().trim()}|${e.type ?? 'unknown'}`;
    if (byName.has(key)) {
      // Merge memory_ids and update last_seen.
      const merged = byName.get(key);
      for (const id of e.memory_ids ?? []) {
        if (!merged.memory_ids.includes(id)) merged.memory_ids.push(id);
      }
      merged.last_seen = Math.max(merged.last_seen ?? 0, e.last_seen ?? 0);
    } else {
      byName.set(key, { ...e, memory_ids: [...(e.memory_ids ?? [])] });
    }
  }

  const entities = [...byName.values()].sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));

  if (entities.length === 0) {
    $panel.append('<span class="sm-muted">No entities extracted yet.</span>');
    return;
  }

  const TYPE_ICONS = {
    character: 'fa-user',
    place: 'fa-location-dot',
    object: 'fa-cube',
    faction: 'fa-users',
    concept: 'fa-lightbulb',
    unknown: 'fa-question',
  };

  const ENTITY_TYPES = ['character', 'place', 'object', 'faction', 'concept', 'unknown'];

  // Helper: persist type or merge changes across both registries, then re-render.
  const persistAndRefresh = async () => {
    if (characterName) {
      const lt = loadCharacterEntityRegistry(characterName);
      saveCharacterEntityRegistry(characterName, lt);
      saveSettingsDebounced();
    }
    const session = loadSessionEntityRegistry();
    await saveSessionEntityRegistry(session);
    updateEntityPanel(characterName);
  };

  // Entity IDs are repaired by mergeEntitiesById; these stores keep readable
  // entity names, so redirect their references before the UI is refreshed.
  const redirectMergedReferences = async (sourceName, targetName) => {
    if (!characterName) return;
    remapRelationshipHistoryEntity(characterName, sourceName, targetName);
    remapEpistemicEntity(characterName, sourceName, targetName);
    await remapProfileEntity(characterName, sourceName, targetName);
    injectRelationshipHistory(characterName);
  };

  for (const entity of entities) {
    const icon = TYPE_ICONS[entity.type] ?? 'fa-tag';
    const memCount = Array.isArray(entity.memory_ids) ? entity.memory_ids.length : 0;
    const lastSeen = entity.last_seen != null ? `msg #${entity.last_seen}` : 'unknown';
    const safeName = $('<div>').text(entity.name).html();
    const rejectedAliases = entity.rejected_aliases ?? [];
    const rejectedBadge = rejectedAliases.length
      ? `<span class="sme_entity_rejected_badge" title="Rejected identity candidates: ${$('<div>').text(rejectedAliases.join(', ')).html()}"><i class="fa-solid fa-shield-halved"></i> ${rejectedAliases.length}</span>`
      : '';

    const $row = $(`
      <div class="sme_entity_row" data-entity-id="${entity.id}" style="position:relative;">
        <span class="sme_entity_type_badge sme_entity_type_${entity.type}" data-clickable title="Click to change type">
          <i class="fa-solid ${icon}"></i> ${entity.type}
        </span>
        <span class="sme_entity_name">${safeName}</span>
        ${rejectedBadge}
        <span class="sme_entity_meta">${memCount} ${memCount === 1 ? 'memory' : 'memories'} &middot; last seen ${lastSeen}</span>
        <button class="sme_entity_rename_btn menu_button" title="Rename this entity">
          <i class="fa-solid fa-pencil"></i>
        </button>
        <button class="sme_entity_merge_btn menu_button" title="Merge into another entity">
          <i class="fa-solid fa-code-merge"></i>
        </button>
        <button class="sme_entity_timeline_btn menu_button" title="View timeline for this entity">
          <i class="fa-solid fa-timeline"></i>
        </button>
        <button class="sme_entity_delete_btn menu_button" title="Delete this entity">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `);

    if (characterPolicy === 'read_only' || characterPolicy === 'disabled') {
      $row.find('.sme_entity_type_badge, button').prop('disabled', true).attr('title', 'Blocked by this card\'s memory policy');
    }

    // Type-picker: clicking the badge opens an inline dropdown to change the type.
    $row.find('.sme_entity_type_badge').on('click', (e) => {
      e.stopPropagation();
      $panel.find('.sme_entity_type_picker').remove();

      const $picker = $('<div class="sme_entity_type_picker">');
      for (const t of ENTITY_TYPES) {
        const tIcon = TYPE_ICONS[t] ?? 'fa-tag';
        const $opt = $(
          `<div class="sme_entity_type_option sme_entity_type_${t}"><i class="fa-solid ${tIcon}"></i> ${t}</div>`,
        );
        $opt.on('click', async (ev) => {
          ev.stopPropagation();
          $picker.remove();
          const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
          const sessReg = loadSessionEntityRegistry();
          setEntityType(entity.id, t, ltReg);
          setEntityType(entity.id, t, sessReg);
          // Migrate state card to the new key so it stays coupled to the entity.
          if (t !== entity.type) await migrateStateLedgerKey(entity.name, entity.type, t);
          await persistAndRefresh();
        });
        $picker.append($opt);
      }

      // Position below the badge and close on outside click.
      $row.append($picker);
      const closeOnOutside = (ev) => {
        if (!$picker[0].contains(ev.target)) {
          $picker.remove();
          $(document).off('click', closeOnOutside);
        }
      };
      setTimeout(() => $(document).on('click', closeOnOutside), 0);
    });

    $row.find('.sme_entity_rename_btn').on('click', async (e) => {
      e.stopPropagation();
      const newName = window.prompt(`Rename ${entity.name}:`, entity.name);
      if (newName == null) return;
      const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
      const sessReg = loadSessionEntityRegistry();
      const trimmedName = newName.trim();
      const conflict = [...ltReg, ...sessReg].find((entry) =>
        entry.id !== entity.id && entry.type === entity.type && entry.name.toLowerCase() === trimmedName.toLowerCase(),
      );
      if (conflict) {
        window.alert(`A ${entity.type} named "${trimmedName}" already exists. Use Merge instead.`);
        return;
      }
      const ltResult = renameEntityById(entity.id, newName, ltReg);
      const sessionResult = renameEntityById(entity.id, newName, sessReg);
      const result = ltResult.renamed ? ltResult : sessionResult;
      if (!result.renamed) {
        window.alert(result.reason);
        return;
      }
      await renameStateLedgerEntity(result.oldName, result.newName, entity.type);
      await redirectMergedReferences(result.oldName, result.newName);
      await persistAndRefresh();
    });

    // Merge button: shows a select of all other entity names.
    $row.find('.sme_entity_merge_btn').on('click', (e) => {
      e.stopPropagation();
      $panel.find('.sme_entity_type_picker').remove();

      const otherEntities = entities.filter((en) => en.id !== entity.id);
      if (otherEntities.length === 0) return;

      const $picker = $('<div class="sme_entity_type_picker">');
      $picker.append(
        $('<div style="font-size:0.75em;opacity:0.6;padding:2px 8px 4px;">Merge into:</div>'),
      );
      for (const target of otherEntities) {
        const label = target.name + (target.type !== 'unknown' ? ` (${target.type})` : '');
        const safeLabel = $('<div>').text(label).html();
        const $opt = $(`<div class="sme_entity_type_option">${safeLabel}</div>`);
        $opt.on('click', async (ev) => {
          ev.stopPropagation();
          $picker.remove();

          const srcCard = getStateCard(entity.name, entity.type);
          const dstCard = getStateCard(target.name, target.type);

          // If both entities have state cards and the ledger is enabled, ask which to keep.
          // When the ledger is disabled, silently keep the destination card.
          if (isStateLedgerEnabled() && srcCard && dstCard) {
            const $modal = $(`
              <dialog class="sme_state_merge_modal">
                <div class="sme_state_merge_modal_inner">
                  <div class="sme_state_merge_title">Both entities have state cards</div>
                  <div class="sme_state_merge_body">
                    Merging <strong>${$('<span>').text(entity.name).html()}</strong> into
                    <strong>${$('<span>').text(target.name).html()}</strong> will discard one state card.
                    Which card should survive?
                  </div>
                  <div class="sme_state_merge_actions">
                    <button class="menu_button sme_state_keep_src">Keep "${$('<span>').text(entity.name).html()}" card</button>
                    <button class="menu_button sme_state_keep_dst">Keep "${$('<span>').text(target.name).html()}" card</button>
                    <button class="menu_button sme_state_cancel">Cancel</button>
                  </div>
                </div>
              </dialog>
            `);

            const closeModal = () => {
              $modal[0].close();
              $modal.remove();
            };
            // Escape key: treat as cancel.
            $modal[0].addEventListener('cancel', closeModal);

            const doMerge = async (keepSrc) => {
              closeModal();
              const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
              const ltMems = characterName ? loadCharacterMemories(characterName) : [];
              const sessReg = loadSessionEntityRegistry();
              const sessMems = loadSessionMemories();
              mergeEntitiesById(entity.id, target.id, ltReg, ltMems, sessReg, sessMems);
              if (characterName) {
                saveCharacterEntityRegistry(characterName, ltReg);
                saveCharacterMemories(characterName, ltMems);
              }
              await saveSessionEntityRegistry(sessReg);
              await saveSessionMemories(sessMems);
              // Discard the loser card, copy the winner card to the surviving key.
              await deleteStateCard(entity.name, entity.type);
              await deleteStateCard(target.name, target.type);
              const winnerFields = keepSrc ? srcCard : dstCard;
              await setStateCard(target.name, target.type, winnerFields);
              await redirectMergedReferences(entity.name, target.name);
              await persistAndRefresh();
            };

            $modal.find('.sme_state_keep_src').on('click', () => doMerge(true));
            $modal.find('.sme_state_keep_dst').on('click', () => doMerge(false));
            $modal.find('.sme_state_cancel').on('click', closeModal);
            document.body.appendChild($modal[0]);
            $modal[0].showModal();
            return;
          }

          const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
          const ltMems = characterName ? loadCharacterMemories(characterName) : [];
          const sessReg = loadSessionEntityRegistry();
          const sessMems = loadSessionMemories();
          mergeEntitiesById(entity.id, target.id, ltReg, ltMems, sessReg, sessMems);
          if (characterName) {
            saveCharacterEntityRegistry(characterName, ltReg);
            saveCharacterMemories(characterName, ltMems);
          }
          await saveSessionEntityRegistry(sessReg);
          await saveSessionMemories(sessMems);
          // If only the source had a card, copy it to the surviving (target) key.
          if (srcCard) {
            await deleteStateCard(entity.name, entity.type);
            await setStateCard(target.name, target.type, srcCard);
          }
          await redirectMergedReferences(entity.name, target.name);
          await persistAndRefresh();
        });
        $picker.append($opt);
      }

      $row.append($picker);
      const closeOnOutside = (ev) => {
        if (!$picker[0].contains(ev.target)) {
          $picker.remove();
          $(document).off('click', closeOnOutside);
        }
      };
      setTimeout(() => $(document).on('click', closeOnOutside), 0);
    });

    $row.find('.sme_entity_timeline_btn').on('click', (e) => {
      e.stopPropagation();
      showEntityTimeline(entity, characterName);
    });

    $row.find('.sme_entity_delete_btn').on('click', async (e) => {
      e.stopPropagation();
      $panel.find('.sme_entity_type_picker').remove();

      const doDelete = async () => {
        const ltReg = characterName ? loadCharacterEntityRegistry(characterName) : [];
        const ltMems = characterName ? loadCharacterMemories(characterName) : [];
        const sessReg = loadSessionEntityRegistry();
        const sessMems = loadSessionMemories();
        deleteEntityById(entity.id, ltReg, ltMems);
        deleteEntityById(entity.id, sessReg, sessMems);
        if (characterName) {
          saveCharacterEntityRegistry(characterName, ltReg);
          saveCharacterMemories(characterName, ltMems);
        }
        await saveSessionEntityRegistry(sessReg);
        await saveSessionMemories(sessMems);
        // Clean up any associated state card.
        if (STATE_CARD_TYPES.has(entity.type)) await deleteStateCard(entity.name, entity.type);
        await persistAndRefresh();
      };

      // Warn before discarding a populated state card - only when the ledger is enabled.
      // When disabled, the card is silently deleted alongside the entity.
      if (
        isStateLedgerEnabled() &&
        STATE_CARD_TYPES.has(entity.type) &&
        getStateCard(entity.name, entity.type)
      ) {
        $row.find('.sme_delete_state_warning').remove();
        const $warn = $(`
          <div class="sme_delete_state_warning">
            <span>This entity has a state card. Delete anyway?</span>
            <button class="menu_button sme_delete_anyway">Delete</button>
            <button class="menu_button sme_delete_cancel">Cancel</button>
          </div>
        `);
        $warn.find('.sme_delete_anyway').on('click', async () => {
          $warn.remove();
          await doDelete();
        });
        $warn.find('.sme_delete_cancel').on('click', () => $warn.remove());
        $row.append($warn);
        return;
      }

      await doDelete();
    });

    $panel.append($row);

    // State card subsection - only when the ledger is enabled and the entity type supports state cards.
    if (isStateLedgerEnabled() && STATE_CARD_TYPES.has(entity.type)) {
      const fields = STATE_CARD_FIELDS[entity.type] ?? [];
      const existingCard = getStateCard(entity.name, entity.type);

      const $section = $('<div class="sme_state_card_section">');

      // Summary header line: shows populated fields or a placeholder.
      const summaryParts = existingCard
        ? fields.filter((f) => existingCard[f]).map((f) => `${f}: ${existingCard[f]}`)
        : [];
      const summaryText = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No state card';
      const $header = $(
        `<div class="sme_state_card_header sm-muted">${$('<div>').text(summaryText).html()}</div>`,
      );

      const $editBtn = $(
        `<button class="sme_state_card_edit_btn menu_button" title="${existingCard ? 'Edit state card' : 'Add state card'}">
          <i class="fa-solid ${existingCard ? 'fa-pen' : 'fa-plus'}"></i>
        </button>`,
      );

      const $headerRow = $('<div class="sme_state_card_header_row">');
      $headerRow.append($header, $editBtn);
      $section.append($headerRow);

      // Editor: hidden until the edit button is clicked.
      const $editor = $('<div class="sme_state_card_editor" style="display:none;">');
      const $inputs = {};
      for (const f of fields) {
        const $field = $('<div class="sme_state_card_field">');
        const label = f.replace(/_/g, ' ');
        const currentVal = existingCard?.[f] ?? '';
        const safeId = `sme_sc_${entity.id}_${f}`;
        $field.append(`<label for="${safeId}">${label}</label>`);
        const $inp = $(`<input type="text" id="${safeId}" class="text_pole" value="">`);
        $inp.val(currentVal);
        $field.append($inp);
        $inputs[f] = $inp;
        $editor.append($field);
      }

      const $actions = $('<div class="sme_state_card_actions">');
      const $saveBtn = $('<button class="menu_button">Save</button>');
      const $cancelBtn = $('<button class="menu_button">Cancel</button>');
      const $clearBtn = $(
        '<button class="menu_button sme_state_card_clear_btn">Clear card</button>',
      );
      $actions.append($saveBtn, $cancelBtn, existingCard ? $clearBtn : null);
      $editor.append($actions);
      $section.append($editor);

      $editBtn.on('click', (e) => {
        e.stopPropagation();
        const opening = !$editor.is(':visible');
        $editor.toggle(opening);
        const $icon = $editBtn.find('i');
        if (opening) {
          $icon.removeClass('fa-pen fa-plus').addClass('fa-times');
        } else {
          $icon.removeClass('fa-times').addClass(existingCard ? 'fa-pen' : 'fa-plus');
        }
      });

      $saveBtn.on('click', async (e) => {
        e.stopPropagation();
        const newFields = {};
        for (const f of fields) {
          const v = ($inputs[f].val() ?? '').trim();
          if (v) newFields[f] = v;
        }
        await setStateCard(entity.name, entity.type, newFields);
        injectStateLedger();
        updateEntityPanel(characterName);
        updateTokenDisplay();
      });

      $cancelBtn.on('click', (e) => {
        e.stopPropagation();
        $editor.hide();
      });

      $clearBtn.on('click', async (e) => {
        e.stopPropagation();
        await deleteStateCard(entity.name, entity.type);
        injectStateLedger();
        updateEntityPanel(characterName);
        updateTokenDisplay();
      });

      $panel.append($section);
    } else if (isStateLedgerEnabled() && entity.type === 'unknown') {
      // Model failed to classify this entity - hint that retyping it unlocks the state card.
      $panel.append(
        '<div class="sme_state_card_section sm-muted" style="font-size:0.85em;padding:2px 0 4px 4px;">' +
          '<i class="fa-solid fa-circle-info"></i> Change type to enable state card' +
          '</div>',
      );
    }
  }
}

/**
 * Shows a CSS-only vertical timeline of memories involving a specific entity.
 * Memories are ordered by valid_from (falling back to ts), with retired entries
 * shown in muted style. Renders inline below the entity row.
 *
 * @param {Object} entity - The entity object from the registry.
 * @param {string|null} characterName - Current character name.
 */
export function showEntityTimeline(entity, characterName) {
  const $panel = $('#sme_entity_panel');

  // Remove any existing timeline (toggle if same entity).
  const existingEntityId = $panel.find('.sme_entity_timeline').data('entity-id');
  $panel.find('.sme_entity_timeline').remove();
  if (existingEntityId === entity.id) return;

  const ltMemories = characterName ? loadCharacterMemories(characterName) : [];
  const sessionMems = loadSessionMemories();
  const allMemories = [...ltMemories, ...sessionMems];

  const memIds = new Set(Array.isArray(entity.memory_ids) ? entity.memory_ids : []);
  const linked = allMemories
    .filter((m) => m.id && memIds.has(m.id))
    .sort((a, b) => (a.valid_from ?? a.ts ?? 0) - (b.valid_from ?? b.ts ?? 0));

  const $timeline = $('<div class="sme_entity_timeline">').attr('data-entity-id', entity.id);
  $timeline.append(
    $(`<div class="sme_entity_timeline_header">`).text(
      `Timeline: ${entity.name} (${linked.length} ${linked.length === 1 ? 'memory' : 'memories'})`,
    ),
  );

  if (linked.length === 0) {
    $timeline.append('<div class="sme_timeline_empty sm-muted">No linked memories found.</div>');
  } else {
    const $list = $('<div class="sme_timeline_list">');
    for (const mem of linked) {
      const isRetired = Boolean(mem.superseded_by);
      const when =
        mem.valid_from != null
          ? `msg #${mem.valid_from}`
          : mem.ts != null
            ? new Date(mem.ts).toLocaleString()
            : 'unknown';
      const $entry = $(`
        <div class="sme_timeline_entry${isRetired ? ' sme_timeline_entry_retired' : ''}">
          <div class="sme_timeline_dot"></div>
          <div class="sme_timeline_body">
            <span class="sme_timeline_when">${when}</span>
            <span class="sme_memory_type sme_type_${mem.type}">${mem.type}</span>
            ${isRetired ? '<span class="sme_memory_retired_badge">retired</span>' : ''}
            <span class="sme_timeline_text">${$('<div>').text(mem.content).html()}</span>
          </div>
        </div>
      `);
      $list.append($entry);
    }
    $timeline.append($list);
  }

  // Insert the timeline after the entity row for this entity.
  const $entityRow = $panel.find(`.sme_entity_row[data-entity-id="${entity.id}"]`);
  if ($entityRow.length) {
    $entityRow.after($timeline);
  } else {
    $panel.append($timeline);
  }
}

/**
 * Renders the long-term memories list with per-memory edit and delete buttons.
 * Shows a placeholder message when no character is selected or no memories exist.
 * @param {Array} memories - Memory array for the character.
 * @param {string|null} characterName - Character name, used for save/inject calls.
 */
export function renderMemoriesList(memories, characterName) {
  const $list = $('#sme_memories_list');
  $list.empty();

  if (!characterName) {
    $list.append('<div class="sme_no_char">No character selected.</div>');
    return;
  }

  if (memories.length === 0) {
    $list.append('<div class="sme_no_char">No memories stored yet for this character.</div>');
  }

  const reviewCount = memories.filter(needsGroundingReview).length;
  if (reviewCount > 0) {
    $list.append(
      `<div class="sme_review_queue_notice"><i class="fa-solid fa-shield-halved"></i> ${reviewCount} memor${reviewCount === 1 ? 'y needs' : 'ies need'} grounding review. <button class="sme_open_review_queue menu_button"><i class="fa-solid fa-list-check"></i> Open Review Queue</button></div>`,
    );
  }

  $list.find('.sme_open_review_queue').on('click', () => {
    const first = memories.find(needsGroundingReview);
    if (first) showMemoryReviewDialog(first.id, 'longterm', characterName);
  });

  const sorted = [...memories].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const hasRetired = sorted.some((m) => m.superseded_by);

  // "Show retired" toggle - only rendered when retired memories exist.
  if (hasRetired) {
    const $toggle = $(
      '<button class="sme_toggle_retired menu_button" style="margin-bottom:6px;font-size:0.8em;">' +
        '<i class="fa-solid fa-eye-slash"></i> Show retired memories</button>',
    );
    $list.append($toggle);
    $toggle.on('click', function () {
      const showing = $list.find('.sme_memory_item.sme_memory_retired').first().is(':visible');
      $list.find('.sme_memory_item.sme_memory_retired').toggle(!showing);
      $(this).html(
        `<i class="fa-solid ${showing ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showing ? 'Show' : 'Hide'} retired memories`,
      );
    });
  }

  sorted.forEach((mem, idx) => {
    const isRetired = Boolean(mem.superseded_by);
    const hasConflict = Array.isArray(mem.contradicts) && mem.contradicts.length > 0;
    const retiredClass = isRetired ? ' sme_memory_retired' : '';
    const retiredBadge = isRetired
      ? '<span class="sme_memory_retired_badge" title="This memory was superseded by a newer fact">retired</span>'
      : '';
    const supersededByLink = isRetired
      ? `<button class="sme_superseded_by_link menu_button" data-superseded-by="${mem.superseded_by}" title="Jump to the memory that replaced this one">→ superseded by</button>`
      : '';
    const conflictBadge = hasConflict
      ? `<span class="sme_memory_conflict_badge" title="This memory conflicts with ${mem.contradicts.length} other ${mem.contradicts.length === 1 ? 'memory' : 'memories'} - run the continuity checker to review"><i class="fa-solid fa-triangle-exclamation"></i></span>`
      : '';
    const groundingReview = groundingReviewMarkup(mem);

    const importanceDots = '●'.repeat(mem.importance ?? 1);
    const expiration = mem.expiration ?? 'permanent';
    const $item = $(`
            <div class="sme_memory_item${retiredClass}" data-index="${idx}" data-memory-id="${mem.id || ''}" ${isRetired ? 'style="display:none"' : ''}>
                <span class="sme_memory_type sme_type_${mem.type}">${mem.type}</span>
                <span class="sme_memory_importance sme_importance_${mem.importance ?? 1}" title="Importance ${mem.importance ?? 1}/3">${importanceDots}</span>
                <span class="sme_memory_expiration sme_expiration_${expiration}" title="Expires: ${expiration}">${expiration}</span>
                ${retiredBadge}${supersededByLink}${conflictBadge}${groundingReview}
                <button class="sme_memory_text sme_memory_open menu_button" data-memory-id="${mem.id || ''}" title="Open memory review">${$('<div>').text(mem.content).html()}</button>
                ${Array.isArray(mem.source_messages) && mem.source_messages.length > 0 && mem.source_chat_id === getContext().chatId ? `<button class="sme_jump_source menu_button" data-source-start="${mem.source_messages[mem.source_messages.length - 1][0]}" data-source-end="${mem.source_messages[mem.source_messages.length - 1][1]}" title="Jump to source message"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}
                <button class="sme_edit_memory menu_button" data-memory-id="${mem.id || ''}" title="Edit this memory" ${isRetired ? 'style="display:none"' : ''}>
                    <i class="fa-solid fa-pencil"></i>
                </button>
                <button class="sme_delete_memory menu_button" data-memory-id="${mem.id || ''}" title="Delete this memory">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `);
    $list.append($item);
  });

  // Jump-to-replacement handler for "→ superseded by" links.
  $list.find('.sme_superseded_by_link').on('click', function () {
    const targetId = $(this).data('superseded-by');
    if (!targetId) return;
    const $target = $list.find(`.sme_memory_item[data-memory-id="${targetId}"]`);
    if (!$target.length) return;
    // Target is an active (non-retired) memory, so it should already be visible.
    // If it happens to be retired too, show retired entries first.
    if (!$target.is(':visible')) {
      $list.find('.sme_memory_item.sme_memory_retired').show();
      $list
        .find('.sme_toggle_retired')
        .html('<i class="fa-solid fa-eye"></i> Hide retired memories');
    }
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    $target.addClass('sme_memory_highlight');
    setTimeout(() => $target.removeClass('sme_memory_highlight'), 1500);
  });

  $list.find('.sme_jump_source').on('click', function () {
    const startIdx = parseInt($(this).data('source-start'), 10);
    const endIdx = parseInt($(this).data('source-end'), 10);
    const $startMsg = $(`#chat .mes[mesid="${startIdx}"]`);
    if (!$startMsg.length) return;
    // Close the extensions panel so the chat is visible when the scroll lands.
    if ($('#rm_extensions_block').hasClass('openDrawer')) {
      $('#extensions-settings-button .drawer-toggle').trigger('click');
    }
    // Scroll to the first message in the source range.
    setTimeout(() => {
      const $chat = $('#chat');
      const scrollTarget = $startMsg.offset().top - $chat.offset().top + $chat.scrollTop();
      $chat.animate({ scrollTop: scrollTarget }, 400);
      // Flash all messages in the range so the user can see what produced this memory.
      const FLASH_DURATION_MS = 2400; // 3 pulses × 0.8 s each
      for (let i = startIdx; i <= endIdx; i++) {
        const $m = $(`#chat .mes[mesid="${i}"]`);
        if ($m.length) {
          $m.addClass('sme_source_flash');
          setTimeout(() => $m.removeClass('sme_source_flash'), FLASH_DURATION_MS);
        }
      }
    }, 300);
  });

  $list.find('.sme_memory_open').on('click', function () {
    showMemoryReviewDialog($(this).data('memory-id'), 'longterm', characterName);
  });

  $list.find('.sme_edit_memory').on('click', function () {
    showMemoryReviewDialog($(this).data('memory-id'), 'longterm', characterName);
    return;
    const memId = $(this).data('memory-id');
    const $item = $(this).closest('.sme_memory_item');
    const $textSpan = $item.find('.sme_memory_text');
    const current = loadCharacterMemories(characterName);
    const mem = current.find((m) => m.id === memId);
    if (!mem) return;

    // Replace text span with an inline textarea for editing.
    const $textarea = $('<textarea class="sme_memory_edit_input">').val(mem.content);
    $textSpan.replaceWith($textarea);
    $textarea.trigger('focus');

    // Swap edit/delete buttons with save/cancel.
    $(this).hide();
    $item.find('.sme_delete_memory').hide();
    const $save = $('<button class="sme_save_memory menu_button" title="Save">Save</button>');
    const $cancel = $(
      '<button class="sme_cancel_memory menu_button" title="Cancel">Cancel</button>',
    );
    $item.append($save, $cancel);

    $save.on('click', () => {
      const newContent = $textarea.val().trim();
      if (!newContent) return;
      const memories = loadCharacterMemories(characterName);
      const target = memories.find((m) => m.id === memId);
      if (!target) return;
      target.content = newContent;
      saveCharacterMemories(characterName, memories);
      saveSettingsDebounced();
      injectMemories(characterName).catch(console.error);
      renderMemoriesList(loadCharacterMemories(characterName), characterName);
    });

    $cancel.on('click', () =>
      renderMemoriesList(loadCharacterMemories(characterName), characterName),
    );
  });

  $list.find('.sme_delete_memory').on('click', function () {
    const memId = $(this).data('memory-id');
    const current = loadCharacterMemories(characterName);
    const idx = current.findIndex((m) => m.id === memId);
    if (idx === -1) return;
    current.splice(idx, 1);
    saveCharacterMemories(characterName, current);
    saveSettingsDebounced();
    renderMemoriesList(current, characterName);
  });

  $list.find('.sme_approve_grounding, .sme_reject_grounding').on('click', function () {
    const id = $(this).data('memory-id');
    const memories = loadCharacterMemories(characterName);
    const memory = memories.find((item) => item.id === id);
    if (!memory) return;
    const approved = $(this).hasClass('sme_approve_grounding');
    memory.validation_status = approved ? 'approved' : 'rejected';
    memory.validation_issues = approved ? [] : [...(memory.validation_issues ?? []), 'Rejected during user review.'];
    saveCharacterMemories(characterName, memories);
    saveSettingsDebounced();
    injectMemories(characterName).catch(console.error);
    renderMemoriesList(memories, characterName);
  });

  // Add memory form at the bottom of the list.
  $list.next('.sme_add_memory_form').remove();
  const $addForm = $(`
    <div class="sme_add_memory_form">
      <input type="text" class="sme_add_memory_input" placeholder="New memory...">
      <button class="sme_add_memory_btn menu_button" title="Add memory">Add</button>
    </div>
  `);
  $addForm.prepend(buildTypePicker(MEMORY_TYPES));
  $list.after($addForm);

  $addForm.find('.sme_add_memory_btn').on('click', () => {
    const type = $addForm.find('.sm-type-picker').data('value');
    const content = $addForm.find('.sme_add_memory_input').val().trim();
    if (!content) return;
    const memories = loadCharacterMemories(characterName);
    memories.push({
      type,
      content,
      importance: 2,
      expiration: 'permanent',
      ts: Date.now(),
      consolidated: true,
      confidence: 1.0,
      persona_relevance: type === 'relationship' ? 3 : 1,
      intimacy_relevance: type === 'preference' ? 3 : 1,
      retrieval_count: 0,
      last_confirmed_ts: Date.now(),
    });
    saveCharacterMemories(characterName, memories);
    saveSettingsDebounced();
    injectMemories(characterName).catch(console.error);
    renderMemoriesList(loadCharacterMemories(characterName), characterName);
  });
}

// ---- Perspectives & Secrets UI ------------------------------------------

const EPISTEMIC_TYPE_LABELS = {
  knows: 'Knows',
  suspects: 'Suspects',
  unaware: 'Unaware',
  believes: 'Believes (false)',
  hiding: 'Hiding',
};

/**
 * Re-renders the Perspectives & Secrets entry list for a character.
 * Each entry gets an edit and delete button. An add form is appended after the list.
 * believes and hiding entries are grouped behind a spoiler to avoid unintentional
 * player-side reveals in collaborative RP.
 *
 * @param {string|null} characterName - Card character name (storage key).
 */
export function updateEpistemicUI(characterName) {
  const $list = $('#sme_epistemic_list');
  $list.empty();

  const entries = characterName ? loadEpistemicKnowledge(characterName) : [];

  if (entries.length === 0) {
    $list.append('<div class="sme_no_char">No perspective entries yet.</div>');
    return;
  }

  const spoilerTypes = new Set(['believes', 'hiding']);
  const open = entries.filter((e) => !spoilerTypes.has(e.type));
  const secret = entries.filter((e) => spoilerTypes.has(e.type));

  /**
   * Builds and appends a single entry row to a target container.
   * @param {Object} entry
   * @param {jQuery} $target
   */
  function appendEntryRow(entry, $target) {
    const typeLabel = EPISTEMIC_TYPE_LABELS[entry.type] ?? entry.type;
    const displayText =
      entry.type === 'hiding'
        ? `${entry.subject} / ${typeLabel} from ${entry.target}: ${entry.content}`
        : `${entry.subject} / ${typeLabel}: ${entry.content}`;

    const $row = $('<div class="sme_memory_item">');
    const $content = $('<div class="sme_memory_content">').text(displayText);

    const $editBtn = $('<button class="sme_memory_action menu_button" title="Edit">')
      .append('<i class="fa-solid fa-pencil"></i>')
      .on('click', () => {
        $('#sme_ep_type').val(entry.type);
        $('#sme_ep_subject').val(entry.subject);
        $('#sme_ep_target').val(entry.target ?? '');
        $('#sme_ep_content').val(entry.content);
        // Show target field only for hiding type.
        $('.sme_ep_target_field').toggle(entry.type === 'hiding');
        $('#sme_epistemic_add_form').data('editing', entry.id).show();
        $('#sme_ep_subject').focus();
      });

    const $deleteBtn = $(
      '<button class="sme_memory_action sme_memory_delete menu_button" title="Delete">',
    )
      .append('<i class="fa-solid fa-trash-can"></i>')
      .on('click', () => {
        const current = loadEpistemicKnowledge(characterName);
        saveEpistemicKnowledge(
          characterName,
          current.filter((e) => e.id !== entry.id),
        );
        shrinkEpistemicBudgetIfPossible(characterName, characterName);
        injectEpistemicKnowledge(characterName, characterName);
        updateEpistemicUI(characterName);
        updateTokenDisplay();
      });

    $row.append($content, $editBtn, $deleteBtn);
    $target.append($row);
  }

  for (const entry of open) appendEntryRow(entry, $list);

  // Always render the spoiler block so the user knows it exists and can tell
  // whether any believes/hiding entries were extracted.
  const $details = $('<details class="sme_epistemic_spoiler">');
  const $summary = $(`
    <summary class="sme_epistemic_spoiler_summary">
      <span class="sme_spoiler_closed"><i class="fa-solid fa-lock"></i> Spoiler - false beliefs and hidden secrets <em>(click to reveal)</em></span>
      <span class="sme_spoiler_open"><i class="fa-solid fa-lock-open"></i> False beliefs and hidden secrets <em>(click to hide)</em></span>
    </summary>
  `);

  // Intercept the open action to warn before revealing spoiler content.
  // Closing needs no confirmation - the user has already seen the content.
  $summary.on('click', (e) => {
    if (!$details.prop('open')) {
      e.preventDefault();
      if (
        confirm(
          'This will reveal hidden character secrets - false beliefs and things the character is concealing.\n\nOpen spoiler?',
        )
      ) {
        $details.prop('open', true);
      }
    }
  });

  $details.append($summary);

  if (secret.length === 0) {
    $details.append(
      '<div class="sme_no_char" style="padding: 4px 0;">No false beliefs or hidden secrets found.</div>',
    );
  } else {
    for (const entry of secret) appendEntryRow(entry, $details);
  }

  $list.append($details);
}
