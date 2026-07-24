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
 * Settings management: default values, settings migration, and UI binding.
 *
 * defaultSettings  - canonical default values for all extension_settings keys
 * loadSettings     - merges defaults + runs field migrations on startup
 * bindSettingsUI   - wires all settings panel controls; takes a ctrl object
 *                    with getter/setter properties for index.js state variables
 *                    so this module never imports from index.js
 */

import {
  extension_prompt_types,
  extension_prompt_roles,
  setExtensionPrompt,
  saveSettingsDebounced,
  getMaxContextSize,
  stopGeneration,
} from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../scripts/popup.js';
import { power_user } from '../../../../scripts/power-user.js';
import { user_avatar } from '../../../../scripts/personas.js';
import { getContext, extension_settings } from '../../../extensions.js';
import {
  estimateTokens,
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
  generateMemoryId,
} from './constants.js';
import {
  memory_sources,
  fetchOllamaModels,
  onMemoryRequestRetry,
  retryTransientMemoryOperation,
} from './generate.js';
import {
  beginCatchUpTransaction,
  commitCatchUpTransaction,
  rollbackCatchUpTransaction,
  saveChatMetadata,
} from './catchup-transaction.js';
import { runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  clearCharacterMemories,
  clearRelationshipHistory,
  loadRelationshipHistory,
  saveRelationshipHistory,
  injectRelationshipHistory,
  getRelationshipHistoryPair,
  isFreshStart,
  setFreshStart,
  getReadOnlyStartIndex,
  setReadOnlyStartIndex,
  getReadOnlyStartTime,
  getCharacterMemoryPolicy,
  setCharacterMemoryPolicy,
} from './longterm.js';
import {
  clearEpistemicKnowledge,
  extractEpistemicKnowledge,
  injectEpistemicKnowledge,
  isEpistemicEnabled,
  loadEpistemicKnowledge,
  saveEpistemicKnowledge,
  resetEpistemicWarnFlag,
} from './epistemic.js';
import { hideChatMessageRange } from '../../../../scripts/chats.js';
import { generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  clearSessionMemories,
  purgeSessionMemoriesSince,
} from './session.js';
import {
  summarizeScene,
  sceneSimilarity,
  injectSceneHistory,
  loadSceneHistory,
  saveSceneHistory,
  clearSceneHistory,
  createSceneRecord,
  detectSceneBreakAI,
  detectSceneBreakHeuristic,
} from './scenes.js';
import { extractArcs, injectArcs, clearArcs, clearArcSummaries, loadArcSummaries, saveArcSummaries } from './arcs.js';
import { isRecordApprovedForPropagation } from './record-validation.js';
import { runModelTest } from './model-test.js';
import {
  PROMPT_TASKS,
  PROMPT_TASK_LABELS,
  listPromptProfiles,
  getPromptProfile,
  getPromptProfileAssignment,
  setPromptProfileAssignment,
  resolvePromptProfileId,
  savePromptProfile,
  updatePromptProfile,
  deletePromptProfile,
  renamePromptProfile,
  getDefaultPromptPreview,
  getLivePromptInspection,
  getPromptOverride,
  setPromptOverride,
  resetPromptOverride,
  resolvePromptOverride,
  exportPromptOverrides,
  importPromptOverrides,
} from './prompt-config.js';

/** Set to true while a model test is running to allow cancellation. */
let modelTestRunning = false;

/**
 * Apply a user-initiated chat cleanup as one persisted operation. The storage
 * helpers used by the cleanup continue to call saveChatMetadata(), but the
 * active transaction stages those requests until the complete cleanup is
 * ready. This avoids queuing several overlapping SillyTavern chat saves.
 */
async function runStagedChatCleanup(context, mutate) {
  const transaction = beginCatchUpTransaction(context);
  try {
    await mutate();
    // Direct metadata edits (for example deleting the summary) also need to
    // mark the transaction dirty when no tier-specific helper did so.
    await saveChatMetadata(context);
    await retryTransientMemoryOperation(() => commitCatchUpTransaction(transaction));
  } catch (error) {
    rollbackCatchUpTransaction(transaction);
    throw error;
  }
}

/**
 * Final transaction-bound integrity gate. It runs after all catch-up tiers,
 * before diagnostics and the one final chat save, so a failure rolls the full
 * final phase back rather than committing a partly reconciled graph.
 */
async function runFinalIntegrityReconciliation(characterName) {
  const startedAt = performance.now();
  const reconciliation = await reconcileCanonicalEntities(characterName);
  const summaries = loadArcSummaries();
  let quarantinedSummaries = 0;
  for (const summary of summaries) {
    const status = summary?.resolution_decision?.status;
    if (!status || status === 'resolved') continue;
    summary.grounding_status = 'derived';
    summary.validation_status = 'needs_review';
    summary.semantic_support = 'unsupported';
    summary.verification_state = 'resolution_reclassified';
    summary.validation_issues = [...new Set([...(summary.validation_issues ?? []), `Arc resolution is ${status}, not resolved.`])];
    quarantinedSummaries++;
  }
  if (quarantinedSummaries) await saveArcSummaries(summaries);
  const result = {
    ...reconciliation,
    quarantined_arc_summaries: quarantinedSummaries,
    duration_ms: Math.round(performance.now() - startedAt),
  };
  if (extension_settings[MODULE_NAME]?.verbose_logging) {
    console.debug('[Smart Memory Enhanced] Final reconciliation timing:', {
      duration_ms: result.duration_ms,
      relationship_pairs_merged: result.relationship_pairs_merged ?? 0,
      cross_store_entity_merges: result.cross_store_entity_merges ?? 0,
    });
  }
  return result;
}
import { checkContinuity, generateRepair, injectRepair, clearRepair } from './continuity.js';
import {
  getHardwareProfile,
  getEmbeddingBatch,
  clearEmbeddingFailed,
  saveEmbeddingApiKey,
  hasEmbeddingApiKey,
} from './embeddings.js';
import { clearCanon, generateCanon, injectCanon, saveCanon } from './canon.js';
import { clearSessionEntityRegistry } from './graph-migration.js';
import {
  clearCanonicalRuntimeContextSnapshot,
  setCanonicalRuntimeContextSnapshot,
  snapshotCanonicalRuntimeContext,
} from './canonical-entities.js';
import {
  clearStateLedger,
  injectStateLedger,
  isStateLedgerEnabled,
  runStateCardExtraction,
} from './state-ledger.js';
import { generateProfiles, injectProfiles, clearProfiles, loadProfiles } from './profiles.js';
import { clearUnifiedSlot, injectUnified, maybeInjectUnified } from './unified-inject.js';
import { getTierHWStats, clearTierStats } from './trim-stats.js';
import { showMemoryGraph } from './graph.js';
import {
  setStatusMessage,
  updateLongTermUI,
  updateRelationshipHistoryUI,
  updateEpistemicUI,
  updateSessionUI,
  updateScenesUI,
  updateArcsUI,
  updateShortTermUI,
  updateCanonUI,
  updateProfilesUI,
  updateFreshStartUI,
  updateEntityPanel,
  updateTokenDisplay,
  reconcileCanonicalEntities,
  updateEmbeddingNotice,
  setCatchUpErrorCount,
} from './ui.js';

/**
 * Builds the explicit live-persona input used for a long-running Memorize
 * Chat.  `user_avatar` plus `power_user.personas` is SillyTavern's selected
 * persona registry; serialized/imported chat headers are only fallbacks.
 */
function getLivePersonaCaptureContext(context) {
  const metadataPersonaKey = context?.chatMetadata?.persona ?? context?.chatMetadata?.[META_KEY]?.persona_key ?? null;
  const selectedPersonaKey = String(user_avatar || metadataPersonaKey || context?.personaId || context?.persona_id || '').trim();
  const configuredName = selectedPersonaKey ? power_user?.personas?.[selectedPersonaKey] : null;
  const existing = context?.activePersona ?? context?.persona ?? {};
  const personaName = String(configuredName ?? existing?.name ?? context?.userName ?? context?.name1 ?? '').trim();
  const descriptor = selectedPersonaKey ? power_user?.persona_descriptions?.[selectedPersonaKey] : null;
  return {
    ...context,
    activePersonaKey: selectedPersonaKey || null,
    activePersona: {
      ...existing,
      id: existing?.id ?? selectedPersonaKey ?? null,
      avatar: existing?.avatar ?? selectedPersonaKey ?? null,
      name: personaName,
      aliases: existing?.aliases ?? [],
      previous_names: existing?.previous_names ?? existing?.historical_aliases ?? [],
      description: existing?.description ?? descriptor?.description ?? '',
    },
  };
}

/** Keeps legacy camelCase arc diagnostics as export aliases of snake_case. */
function normalizeArcExtractionDiagnostics(diagnostics) {
  const aliases = {
    completed: 'request_completed', providerError: 'provider_error', returnedNone: 'returned_none',
    malformedOutput: 'malformed_output', parsedCandidates: 'parsed_candidates', acceptedOpenThreads: 'accepted_open_threads',
    rejectedCompletedEvents: 'rejected_completed_events', rejectedBackgroundFacts: 'rejected_background_facts',
    rejectedRelationshipStates: 'rejected_relationship_states', rejectedSceneDetails: 'rejected_scene_details',
    rejectedMalformed: 'rejected_malformed', participantRepairs: 'participant_repairs', participantReviewItems: 'participant_review_items',
    malformedRequest: 'malformed_request', inputTokenBudget: 'input_token_budget', inputTokenEstimate: 'input_token_estimate',
    inputMessages: 'input_messages', omittedMessages: 'omitted_messages', truncatedMessage: 'truncated_message', terminalOutcome: 'terminal_outcome',
  };
  for (const [camel, snake] of Object.entries(aliases)) {
    // terminal_outcome is the single canonical *string* outcome.  Treating
    // it like a numeric counter turned values such as
    // "completed_with_candidates" into 0 during export.
    if (snake === 'terminal_outcome') {
      const value = diagnostics?.[snake] ?? diagnostics?.[camel] ?? null;
      diagnostics[snake] = value;
      diagnostics[camel] = value;
      continue;
    }
    const value = Math.max(Number(diagnostics?.[snake] ?? 0), Number(diagnostics?.[camel] ?? 0));
    diagnostics[snake] = value;
    diagnostics[camel] = value;
  }
  return diagnostics;
}

/** One canonical scoped identity-observation key for terminal accounting. */
export function makeTerminalObservationKey(sourceStore, sourceRecordId) {
  const store = String(sourceStore ?? 'unknown').trim().replace(/\s+/g, ' ').toLowerCase();
  const record = String(sourceRecordId ?? '').trim();
  return record ? `${store}::${record}` : null;
}

// ---- Default settings ---------------------------------------------------

export const defaultSettings = {
  enabled: true,
  settings_mode: 'simple',
  extraction_frequency: 'medium',

  // LLM source for all memory operations (extraction, summarization, recap)
  source: memory_sources.main,

  // Ollama direct source settings
  ollama_url: 'http://localhost:11434',
  ollama_model: '',

  // OpenAI Compatible source settings
  openai_compat_url: '',
  openai_compat_key: '',
  openai_compat_model: '',

  // ST connection profile source: ID of the saved profile to use for extraction
  connection_profile_id: null,
  connection_profile_context_sizes: {},

  // Maximum tokens the Memory LLM may generate per extraction call.
  // 8192 covers any thinking model comfortably. -1 means unlimited (Ollama only).
  generation_budget: 8192,

  // Provider requests are serialized by default and transient failures retry.
  provider_max_concurrency: 1,
  provider_request_delay_ms: 2000,
  provider_max_retries: 5,

  // Minimum number of AI messages between long-term and session injection refreshes.
  // 1 = refresh on every extraction pass (default / current behaviour).
  // Higher values keep the injected block stable for longer, preserving prompt cache
  // hits on cloud APIs. Chat history covers the gap for recent events.
  injection_refresh_period: 1,

  // OpenAI Compatible embedding API key
  embedding_api_key: '',

  // Short-term (compaction)
  compaction_enabled: true,
  compaction_threshold: 80,
  compaction_keep_recent: 10,
  compaction_response_length: 2000,
  compaction_position: extension_prompt_types.IN_PROMPT,
  compaction_depth: 0,
  compaction_role: extension_prompt_roles.SYSTEM,
  compaction_template: 'Story so far:\n{{summary}}',

  // Consolidation (shared across tiers)
  consolidation_enabled: true,
  longterm_consolidation_threshold_fact: 4,
  longterm_consolidation_threshold_relationship: 3,
  longterm_consolidation_threshold_preference: 3,
  longterm_consolidation_threshold_event: 4,
  session_consolidation_threshold_scene: 3,
  session_consolidation_threshold_revelation: 3,
  session_consolidation_threshold_development: 3,
  session_consolidation_threshold_detail: 3,

  // Long-term
  longterm_enabled: true,
  longterm_extract_every: 3,
  longterm_max_memories: 25,
  longterm_response_length: 600,
  longterm_inject_budget: 500,
  longterm_position: extension_prompt_types.IN_PROMPT,
  longterm_depth: 2,
  longterm_role: extension_prompt_roles.SYSTEM,
  longterm_triggered_depth: 4,
  longterm_triggers_enabled: false,
  longterm_template: 'Memories from previous conversations:\n{{memories}}',

  // Relationship history
  relationships_enabled: true,
  relationships_inject_budget: 250,
  relationships_position: extension_prompt_types.IN_CHAT,
  relationships_depth: 5,
  relationships_role: extension_prompt_roles.SYSTEM,
  relationships_template: 'Relationship history:\n{{relationships}}',

  // Identity review decisions. Approved aliases are intentionally separate
  // from model-discovered aliases; the review queue retains unresolved items.
  identity_review_queue: [],
  identity_aliases: {},

  // Session memory
  session_enabled: true,
  session_extract_every: 3,
  session_max_memories: 30,
  session_response_length: 500,
  session_inject_budget: 400,
  session_position: extension_prompt_types.IN_CHAT,
  session_depth: 3,
  session_role: extension_prompt_roles.SYSTEM,
  session_template: 'Details from this session:\n{{session}}',

  // Scene detection
  scene_enabled: true,
  scene_ai_detect: false,
  // scene_max_history is retained only as a migration source for older data.
  scene_max_history: 5,
  scene_archive_max: 100,
  scene_inject_count: 5,
  scene_min_messages: 3,
  scene_summary_length: 200,
  scene_inject_budget: 300,
  scene_position: extension_prompt_types.IN_CHAT,
  scene_depth: 6,
  scene_role: extension_prompt_roles.SYSTEM,

  // Story arcs
  arcs_enabled: true,
  arcs_max: 10,
  arcs_response_length: 400,
  arcs_inject_budget: 700,
  arcs_position: extension_prompt_types.IN_CHAT,
  arcs_depth: 2,
  arcs_role: extension_prompt_roles.SYSTEM,
  arc_summary_response_length: 300,
  canon_response_length: 600,
  canon_enabled: true,
  canon_inject_budget: 800,
  canon_position: extension_prompt_types.IN_PROMPT,
  canon_depth: 0,
  canon_role: extension_prompt_roles.SYSTEM,
  canon_template: 'Character history:\n{{canon}}',

  // Away recap
  recap_enabled: true,
  recap_threshold_hours: 4,
  recap_response_length: 300,

  // Continuity
  continuity_response_length: 300,
  continuity_auto_check: true,
  continuity_auto_repair: false,

  // Semantic embedding deduplication
  embedding_enabled: true,
  embedding_source: 'ollama',
  embedding_url: '',
  embedding_model: 'nomic-embed-text',
  embedding_keep: false,

  // Character/world profiles
  profiles_enabled: true,
  profiles_stale_threshold_minutes: 30,
  // 0 = regenerate only on extraction passes; positive = also regenerate every N
  // messages even if extraction did not run (Profile B only - too expensive on local).
  profiles_regen_every: 0,
  profiles_response_length: 600,
  profiles_inject_budget: 400,
  profiles_position: extension_prompt_types.IN_PROMPT,
  profiles_depth: 1,
  profiles_role: extension_prompt_roles.SYSTEM,
  profiles_template: '{{profiles}}',

  // Perspectives & Secrets (epistemic tracking)
  epistemic_enabled: true,
  epistemic_inject_unaware: true,
  epistemic_secondhand_framing: true,
  epistemic_response_length: 400,
  epistemic_max_per_subject_per_scene: 5,
  epistemic_inject_budget: 200,
  epistemic_depth: 1,
  epistemic_position: extension_prompt_types.IN_CHAT,
  epistemic_role: extension_prompt_roles.SYSTEM,

  // State Ledger (structured entity state cards)
  state_ledger_enabled: false,
  state_ledger_requires_grounding: true,
  state_ledger_inject_budget: 200,
  state_ledger_depth: 1,
  state_ledger_position: extension_prompt_types.IN_CHAT,
  state_ledger_role: extension_prompt_roles.SYSTEM,

  // Hardware profile - 'auto' | 'a' | 'b'
  // 'auto': detect from memory source (ollama/webllm -> A, main/openai_compat -> B)
  // 'a': force Profile A (local/low-VRAM behaviour)
  // 'b': force Profile B (hosted/high-performance behaviour)
  hardware_profile: 'auto',

  // Automatically reallocate the per-tier token budget after each extraction pass,
  // based on actual observed demand. Tiers with unused headroom give it to tiers
  // that are trimming content. The configured total budget is treated as a hard cap.
  // Off by default so manually tuned advanced budgets are not overwritten.
  auto_tune_budgets: false,

  // Show a non-blocking activity indicator while background extraction is running.
  // Gives users a visible signal that Smart Memory Enhanced is working so they know not
  // to send a new message until it finishes.
  show_activity_indicator: true,

  // Verbose logging - when false, operational extraction/migration logs are
  // suppressed. Errors (console.error) are always shown regardless of this flag.
  verbose_logging: false,

  // Experimental: merge all tier content into a single IN_PROMPT block instead
  // of injecting each tier into its own named slot at different depths/positions.
  unified_injection: false,
  unified_position: 2, // extension_prompt_types.IN_PROMPT (Before Main Prompt)
  unified_depth: 0,
  unified_role: 0, // extension_prompt_roles.SYSTEM

  // Force macro injection mode for all tiers regardless of character card content.
  // Use this when macros are placed in instruct templates (which cannot be auto-detected
  // from character card fields). Auto-detection handles the common case of macros placed
  // in the system prompt or other card fields without needing this toggle.
  macros_enabled: false,

  // Prompt Studio global overrides and preset storage. Character and chat
  // overrides live with their respective character/chat data.
  prompt_overrides: { global: {}, presets: {} },

  // Per-character memory storage (populated at runtime by longterm.js)
  characters: {},
};

// ---- Settings mode helpers -----------------------------------------------

// Extraction frequency presets for the simple-mode dropdown.
const EXTRACTION_FREQUENCY_MAP = { low: 5, medium: 3, high: 1 };

// Fixed proportions for the simplified total-budget slider. Each value is a
// fraction of the total that gets allocated to that tier. Must sum to 1.0.
const BUDGET_RATIOS = {
  longterm: 0.16,
  session: 0.13,
  scenes: 0.1,
  arcs: 0.13,
  canon: 0.18,
  profiles: 0.13,
  relationships: 0.08,
  epistemic: 0.06,
  state_ledger: 0.06,
};

/**
 * Returns the sum of all per-tier inject budgets from current settings.
 * Used to initialise the simplified slider from existing advanced values.
 * @param {Object} s - Settings object.
 * @returns {number}
 */
function totalBudgetFromSettings(s) {
  return (
    (s.longterm_inject_budget ?? 500) +
    (s.session_inject_budget ?? 400) +
    (s.scene_inject_budget ?? 300) +
    (s.arcs_inject_budget ?? 700) +
    (s.canon_inject_budget ?? 800) +
    (s.profiles_inject_budget ?? 400) +
    (s.relationships_inject_budget ?? 250) +
    (s.epistemic_inject_budget ?? 200) +
    (s.state_ledger_inject_budget ?? 200)
  );
}

/**
 * Distributes a total token budget across tiers using BUDGET_RATIOS and
 * writes the results directly into the settings object. Rounds to nearest 50
 * to match the step granularity of the individual sliders.
 * @param {number} total
 * @param {Object} s - Settings object (mutated in place).
 */
function applyTotalBudget(total, s) {
  const snap = (v) => Math.max(50, Math.round(v / 50) * 50);
  s.longterm_inject_budget = snap(total * BUDGET_RATIOS.longterm);
  s.session_inject_budget = snap(total * BUDGET_RATIOS.session);
  s.scene_inject_budget = snap(total * BUDGET_RATIOS.scenes);
  s.arcs_inject_budget = snap(total * BUDGET_RATIOS.arcs);
  s.canon_inject_budget = snap(total * BUDGET_RATIOS.canon);
  s.profiles_inject_budget = snap(total * BUDGET_RATIOS.profiles);
  s.relationships_inject_budget = snap(total * BUDGET_RATIOS.relationships);
  s.epistemic_inject_budget = snap(total * BUDGET_RATIOS.epistemic);
  s.state_ledger_inject_budget = snap(total * BUDGET_RATIOS.state_ledger);
}

/**
 * Re-injects all memory tiers using the current budget settings and refreshes
 * the token bar. Called after any budget slider change so the trim indicators
 * clear immediately without waiting for the next message.
 *
 * Awaits the two async inject calls (injectMemories, injectSessionMemories) so
 * that updateTokenDisplay sees fully populated trim stats rather than the stale
 * values from the previous injection cycle.
 *
 * @param {string|null} characterName - Active character (or group selection).
 */
async function reinjectAfterBudgetChange(characterName) {
  loadAndInjectSummary();
  await injectMemories(characterName);
  injectRelationshipHistory(characterName);
  await injectSessionMemories();
  injectSceneHistory();
  injectArcs();
  injectCanon(characterName);
  injectProfiles(characterName);
  injectEpistemicKnowledge(characterName, characterName);
  injectStateLedger();
  maybeInjectUnified();
  updateTokenDisplay();
}

// Minimum budget any tier will be reduced to during auto-tune, and the headroom
// multiplier applied above actual demand so the next message doesn't immediately
// hit the limit again.
const AUTO_TUNE_FLOOR = 50;
const AUTO_TUNE_HEADROOM = 1.15;

// Maps each tunable tier to its settings key and DOM element IDs.
// Short-term is excluded - it self-corrects via regeneration rather than budget tuning.
const TUNABLE_TIERS = [
  {
    promptKey: PROMPT_KEY_LONG,
    setting: 'longterm_inject_budget',
    defaultBudget: 500,
    slider: 'sme_longterm_inject_budget',
    display: 'sme_longterm_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_SESSION,
    setting: 'session_inject_budget',
    defaultBudget: 400,
    slider: 'sme_session_inject_budget',
    display: 'sme_session_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_CANON,
    setting: 'canon_inject_budget',
    defaultBudget: 800,
    slider: 'sme_canon_inject_budget',
    display: 'sme_canon_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_SCENES,
    setting: 'scene_inject_budget',
    defaultBudget: 300,
    slider: 'sme_scene_inject_budget',
    display: 'sme_scene_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_ARCS,
    setting: 'arcs_inject_budget',
    defaultBudget: 700,
    slider: 'sme_arcs_inject_budget',
    display: 'sme_arcs_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_PROFILES,
    setting: 'profiles_inject_budget',
    defaultBudget: 400,
    slider: 'sme_profiles_inject_budget',
    display: 'sme_profiles_inject_budget_value',
    fmt: (v) => `${v} tokens`,
  },
  {
    promptKey: PROMPT_KEY_RELATIONSHIPS,
    setting: 'relationships_inject_budget',
    defaultBudget: 250,
    slider: 'sme_relationships_inject_budget',
    display: 'sme_relationships_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_EPISTEMIC,
    setting: 'epistemic_inject_budget',
    defaultBudget: 200,
    slider: 'sme_epistemic_inject_budget',
    display: 'sme_epistemic_inject_budget_value',
    fmt: (v) => String(v),
  },
  {
    promptKey: PROMPT_KEY_STATE_LEDGER,
    setting: 'state_ledger_inject_budget',
    defaultBudget: 200,
    slider: 'sme_state_ledger_inject_budget',
    display: 'sme_state_ledger_inject_budget_value',
    fmt: (v) => String(v),
  },
];

/**
 * Redistributes the per-tier token budget based on observed demand.
 * Tiers reporting unused headroom give it to tiers that are trimming.
 * The sum of all tier budgets never exceeds the current configured total.
 *
 * Only runs when `auto_tune_budgets` is enabled. Safe to call after every
 * extraction pass - does nothing if no trim stats have been recorded yet
 * or if no tier's demand has changed enough to warrant an update.
 *
 * @param {string|null} characterName - Active character (or group selection).
 */
export function autoTuneBudgets(characterName) {
  const s = extension_settings[MODULE_NAME];
  if (!s.auto_tune_budgets) return;

  const snap = (v, floor) => Math.max(floor ?? AUTO_TUNE_FLOOR, Math.round(v / 50) * 50);

  // Compute target budget for each tier from its actual demand.
  // Uses the high water mark so group chat budgets are sized for the greediest
  // character seen this session, not just whichever character injected last.
  // Tiers with no recorded stats (disabled or never injected) keep their
  // current budget so they are not silently shrunk.
  // The per-tier defaultBudget acts as a hard floor: auto-tune can grow a tier
  // above its default when demand is high, but never shrinks it below, so
  // characters with light content do not end up with sub-default budgets.
  const targets = TUNABLE_TIERS.map((tier) => {
    const stats = getTierHWStats(tier.promptKey);
    if (!stats || stats.full === 0) {
      return { tier, budget: s[tier.setting] };
    }
    return { tier, budget: snap(stats.full * AUTO_TUNE_HEADROOM, tier.defaultBudget) };
  });

  // In simple mode the user has set an explicit total budget cap; honour it by
  // scaling targets down if they exceed it. In advanced mode each tier slider
  // is independent and there is no user-set total, so auto-tune sets each tier
  // to exactly what it needs without a cap constraint.
  if ((s.settings_mode ?? 'simple') === 'simple') {
    const totalCap = totalBudgetFromSettings(s);
    const totalTarget = targets.reduce((sum, t) => sum + t.budget, 0);
    if (totalTarget > totalCap) {
      const scale = totalCap / totalTarget;
      for (const t of targets) {
        t.budget = Math.max(snap(t.tier.defaultBudget ?? AUTO_TUNE_FLOOR), snap(t.budget * scale));
      }
    }
  }

  // Apply any changes and update DOM sliders.
  let changed = false;
  for (const { tier, budget } of targets) {
    if (s[tier.setting] !== budget) {
      s[tier.setting] = budget;
      $(`#${tier.slider}`).val(budget);
      $(`#${tier.display}`).text(tier.fmt(budget));
      // Invalidate stale trim stats for this tier. reinjectAfterBudgetChange fires
      // async inject calls (injectMemories, injectSessionMemories) without awaiting
      // them, so updateTokenDisplay may run before those Promises resolve and see
      // the load-pass trim data rather than the fresh post-tune data. Clearing here
      // ensures the token bar shows no trim until the next real injection reports.
      clearTierStats(tier.promptKey);
      changed = true;
    }
  }

  if (changed) {
    saveSettingsDebounced();
    reinjectAfterBudgetChange(characterName);
  }
}

/**
 * Shows or hides advanced-only controls based on the current settings mode.
 * Also syncs the simplified budget slider value from the current per-tier totals.
 * @param {'simple'|'advanced'} mode
 */
function applySettingsMode(mode) {
  const isSimple = mode === 'simple';
  $('.sm-advanced-only').toggle(!isSimple);
  $('.sm-simple-only').toggle(isSimple);
  if (isSimple) {
    const total = totalBudgetFromSettings(extension_settings[MODULE_NAME]);
    $('#sme_total_budget').val(total);
    $('#sme_total_budget_value').text(total);
  }
}

// ---- Settings loading and migration -------------------------------------

/**
 * Merges defaultSettings into extension_settings for any missing keys.
 * Preserves existing values so user configuration is not overwritten on update.
 */
export function loadSettings() {
  if (!extension_settings[MODULE_NAME]) {
    // Enhanced always starts from its own settings namespace. It neither
    // requires nor imports configuration from the original Smart Memory.
    extension_settings[MODULE_NAME] = {};
  }
  const hadSceneInjectCount = Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'scene_inject_count');
  const hadSceneArchiveMax = Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'scene_archive_max');
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (extension_settings[MODULE_NAME][key] === undefined) {
      extension_settings[MODULE_NAME][key] = value;
    }
  }

  // Scene history used to use one setting as both a storage cap and injection
  // limit. Preserve the old value as the visible injection count while giving
  // the archive a safer independent capacity.
  if (!hadSceneInjectCount) {
    extension_settings[MODULE_NAME].scene_inject_count = extension_settings[MODULE_NAME].scene_max_history ?? 5;
  }
  if (!hadSceneArchiveMax) {
    extension_settings[MODULE_NAME].scene_archive_max = 100;
  }

  // Migration: replace old bracket-wrapped template defaults with plain-text equivalents.
  // Only affects users who never customized these fields (exact match on the old default).
  // Bracket notation in injections bleeds into RP output - the model mimics it.
  const TEMPLATE_MIGRATIONS = {
    compaction_template: {
      from: '[Story so far:\n{{summary}}]',
      to: 'Story so far:\n{{summary}}',
    },
    longterm_template: {
      from: '[Memories from previous conversations:\n{{memories}}]',
      to: 'Memories from previous conversations:\n{{memories}}',
    },
    session_template: {
      from: '[Details from this session:\n{{session}}]',
      to: 'Details from this session:\n{{session}}',
    },
  };
  for (const [key, migration] of Object.entries(TEMPLATE_MIGRATIONS)) {
    if (extension_settings[MODULE_NAME][key] === migration.from) {
      extension_settings[MODULE_NAME][key] = migration.to;
    }
  }

  // Migration: raise compaction response length from 1500 to 2000.
  // 1500 tokens was too tight for a 9-section summary, causing truncated output.
  if (extension_settings[MODULE_NAME].compaction_response_length === 1500) {
    extension_settings[MODULE_NAME].compaction_response_length = 2000;
  }

  // Migration: raise arc injection budget to 700.
  // 400 was too tight once the adaptive budget applies a 0.8x multiplier during intimate
  // scenes, dropping the oldest arc from injection. 200 is the pre-1.3.0 default.
  if (
    extension_settings[MODULE_NAME].arcs_inject_budget === 200 ||
    extension_settings[MODULE_NAME].arcs_inject_budget === 400
  ) {
    extension_settings[MODULE_NAME].arcs_inject_budget = 700;
  }

  // Migration: longterm_consolidate -> consolidation_enabled (now controls both tiers).
  // If a user had explicitly disabled long-term consolidation, carry that intent forward.
  if (
    Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'longterm_consolidate') &&
    !Object.prototype.hasOwnProperty.call(extension_settings[MODULE_NAME], 'consolidation_enabled')
  ) {
    extension_settings[MODULE_NAME].consolidation_enabled =
      extension_settings[MODULE_NAME].longterm_consolidate;
  }
}

// ---- Settings UI binding ------------------------------------------------

/**
 * Shows a toastr error notification for a failed Smart Memory Enhanced operation.
 * Used by all manual button handlers so failures are visible to the user.
 * @param {string} operation - Short label for what failed (e.g. "Summary generation").
 * @param {Error} err - The caught error.
 */
function showError(operation, err) {
  console.error(`[Smart Memory Enhanced] ${operation} failed:`, err);
  toastr.error(`${operation} failed. Check the browser console for details.`, 'Smart Memory Enhanced', {
    timeOut: 6000,
    positionClass: 'toast-bottom-right',
  });
}

/**
 * Binds all settings panel controls to their corresponding settings values.
 * Each control reads from extension_settings[MODULE_NAME] on mount and writes
 * back on change, calling saveSettingsDebounced() to persist.
 *
 * @param {Object} ctrl - Getter/setter proxy for index.js module-level state:
 *   extractionRunning, compactionRunning, consolidationRunning, catchUpCancelled,
 *   sceneMessageBuffer, sceneBufferLastIndex, selectedGroupCharacter.
 *   Also carries callbacks: clearAllInjections, onChatChanged,
 *   getSelectedCharacterName, getStableExtractionWindowWithFallback.
 */
export function bindSettingsUI(ctrl) {
  const s = extension_settings[MODULE_NAME];

  /**
   * Returns true and shows a warning toast if a catch-up or compaction is
   * currently running. Use this to block manual extract/clear buttons that
   * would conflict with an in-progress background job.
   * @returns {boolean}
   */
  function isCatchUpRunning() {
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
      toastr.warning(
        'Cannot do this while Memorize Chat is running. Cancel it first.',
        'Smart Memory Enhanced',
        {
          timeOut: 4000,
          positionClass: 'toast-bottom-right',
        },
      );
      return true;
    }
    return false;
  }

  const clearChatLocalCharacterData = (context, characterName = null) => {
    const keys = [
      'card_local_memories',
      'card_local_relationships',
      'card_local_epistemic',
      'card_local_entities',
      'card_local_canon',
    ];
    for (const metadataKey of [META_KEY, MODULE_NAME]) {
      const metadata = context.chatMetadata?.[metadataKey];
      if (!metadata) continue;
      for (const key of keys) {
        if (!metadata[key]) continue;
        if (characterName) delete metadata[key][characterName];
        else delete metadata[key];
      }
    }
  };

  /**
   * Runs extraction on messages generated during the read-only window, then
   * lifts the gate without purging or ghosting anything. Called when the user
   * chooses to commit a read-only session rather than discard it.
   *
   * Session memories are already present (extraction was gated, not deleted).
   * This function fills in the missing tiers: long-term, arcs, and profiles.
   *
   * @param {number} startIndex - Chat index where the read-only window began.
   * @returns {Promise<void>}
   */
  async function commitReadOnlyWindow(startIndex) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];
    const windowMessages = (context.chat ?? [])
      .slice(startIndex)
      .filter((m) => m.mes && !m.is_system);

    if (windowMessages.length === 0) return;

    const characterName = ctrl.getSelectedCharacterName();
    const characterNames = (() => {
      if (!context.groupId) return characterName ? [characterName] : [];
      const group = context.groups?.find((g) => g.id === context.groupId);
      if (!group) return characterName ? [characterName] : [];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => context.characters.find((c) => c.avatar === avatar)?.name)
        .filter(Boolean);
    })();

    setStatusMessage('Committing read-only session...');

    for (const name of characterNames) {
      if (settings.longterm_enabled) {
        const nameWindow = context.groupId
          ? windowMessages.filter((m) => m.is_user || m.name === name)
          : windowMessages;
        if (nameWindow.length > 0) {
          await extractAndStoreMemories(name, nameWindow).catch((err) =>
            console.error('[Smart Memory Enhanced] Commit long-term extraction error:', err),
          );
          if (settings.consolidation_enabled) {
            await consolidateMemories(name).catch((err) =>
              console.error('[Smart Memory Enhanced] Commit consolidation error:', err),
            );
          }
        }
      }
      if (settings.profiles_enabled && name) {
        await generateProfiles(name)
          .then((profiles) => {
            if (profiles) {
              injectProfiles(name);
              updateProfilesUI(profiles);
            }
          })
          .catch((err) => console.error('[Smart Memory Enhanced] Commit profile generation error:', err));
      }
    }

    if (settings.arcs_enabled) {
      await extractArcs(windowMessages).catch((err) =>
        console.error('[Smart Memory Enhanced] Commit arc extraction error:', err),
      );
    }

    saveSettingsDebounced();
    setStatusMessage('Session committed.');
  }

  // Prevent section-header enable checkboxes from toggling the <details> open/closed
  // when clicked. Without this, clicking the checkbox both changes the setting and
  // collapses the section, which is never what the user intends.
  $(document).on('click', '.sm-section-toggle', (e) => e.stopPropagation());

  // ---- Master toggle --------------------------------------------------
  $('#sme_enabled')
    .prop('checked', s.enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].enabled) {
        // Remove all injections immediately so nothing lingers in the prompt.
        ctrl.clearAllInjections();
      } else {
        // Restore injections from stored data so the user picks up where they left off.
        ctrl.onChatChanged();
      }
    });

  // ---- Settings mode toggle -------------------------------------------
  $('#sme_settings_mode_advanced')
    .prop('checked', s.settings_mode === 'advanced')
    .on('change', function () {
      const mode = $(this).prop('checked') ? 'advanced' : 'simple';
      extension_settings[MODULE_NAME].settings_mode = mode;
      saveSettingsDebounced();
      applySettingsMode(mode);
      applyInjectionOverrideUI();
    });

  // ---- Simplified total budget slider ---------------------------------
  $('#sme_total_budget')
    .val(totalBudgetFromSettings(s))
    .on('input', function () {
      const total = parseInt($(this).val(), 10);
      $('#sme_total_budget_value').text(total);
      applyTotalBudget(total, extension_settings[MODULE_NAME]);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_reset_budgets').on('click', function () {
    const cur = extension_settings[MODULE_NAME];
    const budgetKeys = [
      'longterm_inject_budget',
      'session_inject_budget',
      'scene_inject_budget',
      'arcs_inject_budget',
      'canon_inject_budget',
      'profiles_inject_budget',
      'relationships_inject_budget',
      'epistemic_inject_budget',
      'state_ledger_inject_budget',
    ];
    for (const key of budgetKeys) {
      cur[key] = defaultSettings[key];
    }
    // Sync all slider DOM elements to the restored values.
    for (const { setting, slider, display, fmt } of TUNABLE_TIERS) {
      $(`#${slider}`).val(cur[setting]);
      $(`#${display}`).text(fmt(cur[setting]));
    }
    // Sync the simple-mode total slider.
    const total = totalBudgetFromSettings(cur);
    $('#sme_total_budget').val(total);
    $('#sme_total_budget_value').text(total);
    saveSettingsDebounced();
    reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
  });

  // Apply initial mode on load.
  applySettingsMode(s.settings_mode ?? 'simple');

  // ---- Group chat character selector ----------------------------------
  $('#sme_group_char_select').on('change', async function () {
    const selection = $(this).val() || null;
    ctrl.selectedGroupCharacter = selection;
    updateLongTermUI(ctrl.selectedGroupCharacter);
    updateRelationshipHistoryUI(ctrl.selectedGroupCharacter);
    updateEpistemicUI(ctrl.selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(ctrl.selectedGroupCharacter);
    updateProfilesUI(loadProfiles(ctrl.selectedGroupCharacter));
    // Re-inject the character-specific slots so updateTokenDisplay reads
    // the selected character's content rather than whoever responded last.
    // onGroupMemberDrafted will overwrite these again before the next Generate().
    await injectMemories(selection);
    if (ctrl.selectedGroupCharacter !== selection) return;
    await injectSessionMemories();
    injectCanon(selection);
    injectProfiles(selection);
    maybeInjectUnified();
    updateTokenDisplay();
    autoTuneBudgets(selection);
    refreshPromptStudio();
  });

  // ---- Prompt Studio ----------------------------------------------------
  const promptTaskValues = Object.values(PROMPT_TASKS);
  const $promptTask = $('#sme_prompt_task');
  for (const task of promptTaskValues) {
    $promptTask.append($('<option>', { value: task, text: PROMPT_TASK_LABELS[task] }));
  }

  function promptStudioCharacter() {
    return ctrl.getSelectedCharacterName();
  }

  let activePromptPresetId = 'builtin:default';
  let promptPresetDraft = {};

  function activePromptPreset() { return getPromptProfile(activePromptPresetId); }

  function fillProfileSelect(selector, assignment, { inherit = false, disabled = false } = {}) {
    const $select = $(selector).empty();
    if (inherit) $select.append($('<option>', { value: '', text: 'Inherit' }));
    const profiles = listPromptProfiles();
    for (const profile of [...profiles.builtIn, ...profiles.custom]) {
      $select.append($('<option>', { value: profile.id, text: profile.label }));
    }
    $select.val(assignment || '');
    $select.prop('disabled', disabled);
  }

  function refreshAssignments() {
    const characterName = promptStudioCharacter();
    fillProfileSelect('#sme_prompt_global_profile', getPromptProfileAssignment('global'));
    fillProfileSelect('#sme_prompt_chat_profile', getPromptProfileAssignment('chat', characterName), { inherit: true });
    fillProfileSelect('#sme_prompt_character_profile', getPromptProfileAssignment('character', characterName), { inherit: true, disabled: !characterName });
    $('#sme_prompt_character_profile_label').text(characterName ? `Character: ${characterName}` : 'Character (none selected)');
  }

  function refreshPromptPresetChoices(selected = activePromptPresetId) {
    const $preset = $('#sme_prompt_preset').empty();
    const profiles = listPromptProfiles();
    for (const [label, entries] of [['Built-in presets', profiles.builtIn], ['My prompt presets', profiles.custom]]) {
      if (!entries.length) continue;
      const $group = $('<optgroup>', { label });
      for (const profile of entries) $group.append($('<option>', { value: profile.id, text: profile.label }));
      $preset.append($group);
    }
    activePromptPresetId = getPromptProfile(selected) ? selected : resolvePromptProfileId(promptStudioCharacter());
    $preset.val(activePromptPresetId);
    promptPresetDraft = { ...(activePromptPreset()?.tasks ?? {}) };
    updatePromptPresetToolbar();
  }

  function updatePromptPresetToolbar() {
    const editable = !!activePromptPreset()?.custom;
    $('#sme_prompt_preset_save, #sme_prompt_preset_rename, #sme_prompt_preset_delete').prop('disabled', !editable);
  }

  function refreshPromptStudio() {
    const task = $promptTask.val();
    $('#sme_prompt_default').val(getDefaultPromptPreview(task));
    $('#sme_prompt_override').val(promptPresetDraft[task] ?? '');
    refreshAssignments();
  }

  $promptTask.on('change', refreshPromptStudio);
  $('#sme_prompt_override').on('input', function () { promptPresetDraft[$promptTask.val()] = $(this).val(); });
  $('#sme_prompt_preset').on('change', function () {
    activePromptPresetId = $(this).val();
    refreshPromptPresetChoices(activePromptPresetId);
    refreshPromptStudio();
  });
  $('#sme_prompt_global_profile').on('change', function () { setPromptProfileAssignment('global', $(this).val()); saveSettingsDebounced(); refreshPromptPresetChoices($(this).val()); refreshPromptStudio(); });
  $('#sme_prompt_character_profile').on('change', function () { setPromptProfileAssignment('character', $(this).val(), promptStudioCharacter()); saveSettingsDebounced(); refreshPromptStudio(); });
  $('#sme_prompt_chat_profile').on('change', async function () { setPromptProfileAssignment('chat', $(this).val(), promptStudioCharacter()); await getContext().saveMetadata?.(); refreshPromptStudio(); });

  $('#sme_prompt_preset_new').on('click', async function () {
    const name = await callGenericPopup('Name this Smart Memory Enhanced prompt preset:', POPUP_TYPE.INPUT);
    if (!name) return;
    try { const id = savePromptProfile(name, promptPresetDraft); saveSettingsDebounced(); refreshPromptPresetChoices(id); refreshPromptStudio(); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_save').on('click', function () {
    try { updatePromptProfile(activePromptPresetId, promptPresetDraft); saveSettingsDebounced(); toastr.success('Prompt preset updated.', 'Smart Memory Enhanced'); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_rename').on('click', async function () {
    const preset = activePromptPreset();
    if (!preset?.custom) return;
    const name = await callGenericPopup('Rename this Smart Memory Enhanced prompt preset:', POPUP_TYPE.INPUT, preset.label);
    if (!name || name === preset.label) return;
    try { const id = renamePromptProfile(activePromptPresetId, name); saveSettingsDebounced(); refreshPromptPresetChoices(id); refreshPromptStudio(); }
    catch (err) { toastr.warning(err.message, 'Smart Memory Enhanced'); }
  });
  $('#sme_prompt_preset_restore').on('click', function () { promptPresetDraft = { ...(activePromptPreset()?.tasks ?? {}) }; refreshPromptStudio(); });
  $('#sme_prompt_preset_delete').on('click', async function () {
    const preset = activePromptPreset();
    if (!preset?.custom) return;
    if (!(await callGenericPopup(`Delete prompt preset "${preset.label}"?`, POPUP_TYPE.CONFIRM))) return;
    deletePromptProfile(activePromptPresetId); saveSettingsDebounced(); refreshPromptPresetChoices('builtin:default'); refreshPromptStudio();
  });
  $('#sme_prompt_reset').on('click', function () { promptPresetDraft[$promptTask.val()] = ''; refreshPromptStudio(); });
  $('#sme_prompt_preview').on('click', function () {
    const task = $promptTask.val();
    const effective = promptPresetDraft[task] ?? '';
    const source = effective ? `EFFECTIVE ADDITIONAL INSTRUCTIONS:\n${effective}\n\n` : '';
    callGenericPopup(`${source}PROTECTED BUILT-IN PROMPT:\n${getDefaultPromptPreview(task)}`, POPUP_TYPE.DISPLAY);
  });
  $('#sme_prompt_inspect_live').on('click', function () {
    try {
      const task = $promptTask.val();
      const inspection = getLivePromptInspection(task, promptStudioCharacter());
      const heading = `LIVE PROMPT INSPECTOR\nTask: ${PROMPT_TASK_LABELS[task]}\nCharacter: ${inspection.characterName || '(none)'}\nPrompt preset: ${inspection.profileId}\nEvidence: ${inspection.evidence.chatMessages} chat messages, ${inspection.evidence.longterm} long-term memories, ${inspection.evidence.session} session memories, ${inspection.evidence.scenes} scenes, ${inspection.evidence.arcs} arcs\n\n${inspection.note}\n\n--- EFFECTIVE PROMPT SENT TO THE PROVIDER ---\n\n`;
      callGenericPopup(heading + inspection.prompt, POPUP_TYPE.DISPLAY);
    } catch (error) {
      toastr.error(error.message || 'Could not build the live prompt inspection.', 'Smart Memory Enhanced');
    }
  });
  $('#sme_prompt_preset_export').on('click', function () {
    try {
      const preset = activePromptPreset();
      const text = JSON.stringify({ format: 'smart-memory-enhanced-prompt-preset', version: 2, name: preset.label, tasks: promptPresetDraft }, null, 2);
      const blob = new Blob([text], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `smart-memory-enhanced-prompt-preset-${preset.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      toastr.error(err.message || 'Could not export prompt preset.', 'Smart Memory Enhanced');
    }
  });
  $('#sme_prompt_preset_import_button').on('click', () => $('#sme_prompt_preset_import').trigger('click'));
  $('#sme_prompt_preset_import').on('change', async function () {
    const file = this.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.format !== 'smart-memory-enhanced-prompt-preset' || payload?.version !== 2 || !payload?.tasks) throw new Error('This is not a full Smart Memory Enhanced prompt preset.');
      const name = payload.name;
      const id = savePromptProfile(name, payload.tasks, { overwrite: true });
      saveSettingsDebounced();
      refreshPromptPresetChoices(id); refreshPromptStudio();
      toastr.success(`Imported prompt preset “${name}”.`, 'Smart Memory Enhanced');
    } catch (err) {
      toastr.error(err.message || 'Could not import prompt preset.', 'Smart Memory Enhanced');
    }
    this.value = '';
  });
  $('#sme_prompt_export').on('click', function () {
    const text = JSON.stringify(exportPromptOverrides(promptStudioCharacter()), null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'smart-memory-enhanced-prompt-overrides.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $('#sme_prompt_import').on('click', () => $('#sme_prompt_import_file').trigger('click'));
  $('#sme_prompt_import_file').on('change', async function () {
    const file = this.files?.[0];
    if (!file) return;
    try {
      importPromptOverrides(JSON.parse(await file.text()), promptStudioCharacter());
      saveSettingsDebounced();
      await getContext().saveMetadata?.();
      refreshPromptStudio();
      toastr.success('Prompt overrides imported.', 'Smart Memory Enhanced');
    } catch (err) {
      toastr.error(err.message || 'Could not import prompt overrides.', 'Smart Memory Enhanced');
    }
    this.value = '';
  });
  refreshPromptPresetChoices();
  refreshPromptStudio();

  // Also retains a run report when the final chat save fails and its staged
  // metadata must be rolled back. Export Diagnostics must still be useful in
  // that exact failure case.
  let latestExportDiagnostics = null;
  const exportCatchUpDiagnostics = () => {
    const metadata = getContext().chatMetadata?.[META_KEY];
    const report = latestExportDiagnostics ?? metadata?.catch_up_diagnostics;
    if (!report) return toastr.info('No Memorize Chat diagnostics are available for this chat yet.', 'Smart Memory Enhanced');
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'smart-memory-enhanced-diagnostics.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $('#sme_export_diagnostics').prop('disabled', !getContext().chatMetadata?.[META_KEY]?.catch_up_diagnostics).on('click', exportCatchUpDiagnostics);
  $('#sme_preview_catch_up').on('click', async () => {
    const context = getContext();
    const messages = (context.chat ?? []).filter((message) => message.mes && !message.is_system);
    const tokenEstimate = messages.reduce((total, message) => total + estimateTokens(`${message.name}: ${message.mes}`), 0);
    const chunkBudget = Math.max(500, Math.floor(getMaxContextSize(0) * 0.35));
    let scenes = 0;
    for (const message of messages) if (detectSceneBreakHeuristic(message.mes ?? '')) scenes++;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return toastr.warning('No character is active.', 'Smart Memory Enhanced');
    const button = $('#sme_preview_catch_up').prop('disabled', true);
    try {
      const [longterm, session, arcs] = await Promise.all([
        extractAndStoreMemories(characterName, messages, null, { dryRun: true }),
        extractSessionMemories(messages, null, { dryRun: true }),
        extractArcs(messages, characterName, null, { dryRun: true }),
      ]);
      const candidates = [...(longterm?.candidates ?? []), ...(session?.candidates ?? [])];
      const reviewCount = candidates.filter((candidate) => candidate.validation_status === 'needs_review').length;
      latestExportDiagnostics = {
        version: 1, created_at: Date.now(), dry_run: true,
        workload: { messages: messages.length, token_estimate: tokenEstimate, chunk_estimate: Math.ceil(tokenEstimate / chunkBudget), heuristic_scene_candidates: scenes },
        longterm, session, arcs,
      };
      $('#sme_export_diagnostics').prop('disabled', false);
      await callGenericPopup(
        `Dry run complete - no memories or entities were saved.\n\n${messages.length} usable messages\n~${tokenEstimate.toLocaleString()} chat tokens\n~${Math.ceil(tokenEstimate / chunkBudget)} extraction chunks\n${scenes} heuristic scene-break candidates\n${longterm?.candidates?.length ?? 0} long-term candidates\n${session?.candidates?.length ?? 0} session candidates\n${arcs?.candidates?.length ?? 0} story-arc candidates\n${arcs?.resolved_candidates ?? 0} potential arc resolutions\n${reviewCount} candidates need grounding review\n\nExport Diagnostics contains the candidate details.`,
        POPUP_TYPE.DISPLAY,
      );
    } catch (error) {
      showError('Dry run', error);
    } finally {
      button.prop('disabled', false);
    }
  });

  // ---- LLM source -----------------------------------------------------

  /**
   * Shows or hides the per-source settings sections based on the current source.
   * @param {string} source
   */
  function updateSourceSections(source) {
    $('#sme_ollama_settings').toggle(source === memory_sources.ollama);
    $('#sme_openai_compat_settings').toggle(source === memory_sources.openai_compatible);
    $('#sme_connection_profile_settings').toggle(source === memory_sources.connection_profile);
  }

  /**
   * Populates the connection profile picker with all profiles saved in the connection manager.
   * Shows a placeholder if the connection manager has no profiles or is unavailable.
   */
  function populateConnectionProfilePicker() {
    const $select = $('#sme_connection_profile_id');
    $select.empty();
    const profiles = extension_settings?.connectionManager?.profiles ?? [];
    // Filter by mode (cc = Chat Completion, tc = Text Completion). This covers all
    // sub-types including ollama, koboldcpp, etc. - profile.api holds the sub-type
    // string, not the top-level mode, so filtering by api would exclude most profiles.
    const compatible = profiles.filter((p) => p.mode === 'cc' || p.mode === 'tc');
    if (compatible.length === 0) {
      $select.append('<option value="">- no compatible profiles found -</option>');
      return;
    }
    compatible
      .slice()
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .forEach((p) => {
        $select.append($('<option>', { value: p.id, text: p.name ?? p.id }));
      });
    // Restore previously saved selection, or auto-save the first option so the
    // setting is never null when profiles are available (the browser auto-selects
    // the first option but does not fire a change event, so we save it explicitly).
    const saved = extension_settings[MODULE_NAME].connection_profile_id;
    if (saved && compatible.some((p) => p.id === saved)) {
      $select.val(saved);
    } else {
      const firstId = compatible[0].id;
      $select.val(firstId);
      extension_settings[MODULE_NAME].connection_profile_id = firstId;
      saveSettingsDebounced();
    }
  }

  /**
   * Fetches installed Ollama models and populates the model dropdown.
   * On success: shows the select and hides the manual text input.
   * On failure: hides the select and reveals the manual text input so users
   * who cannot reach Ollama from their browser (e.g. accessing ST remotely
   * via a different address) can still type a model name directly.
   */
  async function refreshOllamaModels() {
    const $select = $('#sme_ollama_model');
    const $manual = $('#sme_ollama_model_manual');
    const $btn = $('#sme_ollama_refresh');
    const prevModel = extension_settings[MODULE_NAME].ollama_model;
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels();
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append($('<option>', { value: name, text: name }));
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        extension_settings[MODULE_NAME].ollama_model = best;
        saveSettingsDebounced();
      }
      // Fetch succeeded - use the dropdown and hide the manual fallback.
      $select.show();
      $manual.hide();
      $btn.show();
    } catch (err) {
      toastr.error(
        `Could not reach Ollama at ${extension_settings[MODULE_NAME].ollama_url || 'http://localhost:11434'}. Is it running?`,
        'Smart Memory Enhanced',
      );
      console.error('[Smart Memory Enhanced] Ollama model fetch failed:', err);
      // Fetch failed - reveal the manual text input and hide the refresh
      // button (it would just fail again until Ollama is reachable).
      $select.hide();
      $manual.val(prevModel ?? '').show();
      $btn.hide();
    } finally {
      $btn.prop('disabled', false);
    }
  }

  /**
   * Fetches installed Ollama models and populates the embedding model dropdown.
   * Uses the embedding-specific URL so users can point embeddings at a separate
   * Ollama instance. Falls back to the manual text input on failure.
   */
  async function refreshEmbeddingModels() {
    const $select = $('#sme_embedding_model');
    const $manual = $('#sme_embedding_model_manual');
    const $btn = $('#sme_embedding_refresh');
    const prevModel = extension_settings[MODULE_NAME].embedding_model;
    const embeddingUrl = extension_settings[MODULE_NAME].embedding_url || 'http://localhost:11434';
    $btn.prop('disabled', true);
    try {
      const models = await fetchOllamaModels(embeddingUrl);
      $select.empty();
      if (models.length === 0) {
        $select.append('<option value="">No models found</option>');
      } else {
        models.forEach((name) => {
          $select.append($('<option>', { value: name, text: name }));
        });
        const best = models.includes(prevModel) ? prevModel : models[0];
        $select.val(best);
        extension_settings[MODULE_NAME].embedding_model = best;
        clearEmbeddingFailed();
        updateEmbeddingNotice();
        saveSettingsDebounced();
      }
      $select.show();
      $manual.hide();
      $btn.show();
    } catch (err) {
      toastr.error(`Could not reach Ollama at ${embeddingUrl}. Is it running?`, 'Smart Memory Enhanced');
      console.error('[Smart Memory Enhanced] Embedding model fetch failed:', err);
      $select.hide();
      $manual.val(prevModel ?? '').show();
      $btn.hide();
    } finally {
      $btn.prop('disabled', false);
    }
  }

  const currentSource = s.source ?? memory_sources.main;
  $('#sme_source')
    .val(currentSource)
    .on('change', function () {
      const source = $(this).val();
      extension_settings[MODULE_NAME].source = source;
      saveSettingsDebounced();
      updateSourceSections(source);
      if (source === memory_sources.ollama && !extension_settings[MODULE_NAME].ollama_model) {
        refreshOllamaModels();
      }
      // Re-evaluate auto-detected hardware profile label when source changes.
      updateProfileLabel();
    });

  updateSourceSections(currentSource);

  // Connection profile picker
  populateConnectionProfilePicker();
  $('#sme_connection_profile_id').on('change', function () {
    extension_settings[MODULE_NAME].connection_profile_id = $(this).val() || null;
    const sizes = extension_settings[MODULE_NAME].connection_profile_context_sizes ?? {};
    $('#sme_connection_profile_context_size').val(sizes[$(this).val()] ?? '');
    saveSettingsDebounced();
  });
  const selectedProfileId = s.connection_profile_id;
  $('#sme_connection_profile_context_size')
    .val(s.connection_profile_context_sizes?.[selectedProfileId] ?? '')
    .on('change', function () {
      const profileId = extension_settings[MODULE_NAME].connection_profile_id;
      if (!profileId) return;
      const sizes = (extension_settings[MODULE_NAME].connection_profile_context_sizes ??= {});
      const value = parseInt($(this).val(), 10);
      if (value > 0) sizes[profileId] = value;
      else delete sizes[profileId];
      saveSettingsDebounced();
    });

  // Ollama URL field
  $('#sme_ollama_url')
    .val(s.ollama_url ?? 'http://localhost:11434')
    .on('change', function () {
      extension_settings[MODULE_NAME].ollama_url = $(this).val().trim();
      saveSettingsDebounced();
      // Refresh models when the URL changes so the list reflects the new instance.
      refreshOllamaModels();
    });

  // Ollama model dropdown - saves on selection change.
  $('#sme_ollama_model').on('change', function () {
    extension_settings[MODULE_NAME].ollama_model = $(this).val();
    saveSettingsDebounced();
  });

  // Manual text fallback - saves on blur/change so a typed name persists
  // across reloads even when Ollama is not reachable from this browser.
  $('#sme_ollama_model_manual').on('change', function () {
    extension_settings[MODULE_NAME].ollama_model = $(this).val().trim();
    saveSettingsDebounced();
  });

  // Populate Ollama model list on load if Ollama is already selected.
  if (currentSource === memory_sources.ollama) {
    refreshOllamaModels();
  }

  // Ollama refresh button
  $('#sme_ollama_refresh').on('click', () => refreshOllamaModels());

  // OpenAI Compatible fields
  $('#sme_openai_compat_url')
    .val(s.openai_compat_url ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].openai_compat_url = $(this).val().trim();
      saveSettingsDebounced();
    });

  $('#sme_openai_compat_key')
    .val(s.openai_compat_key ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].openai_compat_key = $(this).val();
      saveSettingsDebounced();
    });

  $('#sme_openai_compat_model')
    .val(s.openai_compat_model ?? '')
    .on('input', function () {
      extension_settings[MODULE_NAME].openai_compat_model = $(this).val().trim();
      saveSettingsDebounced();
    });

  // Generation budget slider + unlimited checkbox
  const genBudget = s.generation_budget ?? 8192;
  const isUnlimited = genBudget === -1;
  $('#sme_generation_budget')
    .val(isUnlimited ? 8192 : genBudget)
    .prop('disabled', isUnlimited)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      $('#sme_generation_budget_value').text(val.toLocaleString() + ' tokens');
      extension_settings[MODULE_NAME].generation_budget = val;
      saveSettingsDebounced();
    });
  $('#sme_generation_budget_unlimited')
    .prop('checked', isUnlimited)
    .on('change', function () {
      const unlimited = $(this).is(':checked');
      $('#sme_generation_budget').prop('disabled', unlimited);
      const val = unlimited ? -1 : parseInt($('#sme_generation_budget').val(), 10);
      $('#sme_generation_budget_value').text(
        unlimited ? 'Unlimited' : val.toLocaleString() + ' tokens',
      );
      extension_settings[MODULE_NAME].generation_budget = val;
      saveSettingsDebounced();
    });
  $('#sme_generation_budget_value').text(
    isUnlimited ? 'Unlimited' : genBudget.toLocaleString() + ' tokens',
  );

  $('#sme_provider_max_concurrency')
    .val(s.provider_max_concurrency ?? 1)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_max_concurrency = Math.max(1, parseInt($(this).val(), 10) || 1);
      saveSettingsDebounced();
    });
  $('#sme_provider_request_delay_ms')
    .val(s.provider_request_delay_ms ?? 2000)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_request_delay_ms = Math.max(0, parseInt($(this).val(), 10) || 0);
      saveSettingsDebounced();
    });
  $('#sme_provider_max_retries')
    .val(s.provider_max_retries ?? 5)
    .on('change', function () {
      extension_settings[MODULE_NAME].provider_max_retries = Math.max(0, parseInt($(this).val(), 10) || 0);
      saveSettingsDebounced();
    });

  // Hardware profile override
  const PROFILE_LABELS = {
    a: 'Profile A: local / low-VRAM - minimal model calls, heuristic-only signals.',
    b: 'Profile B: hosted / high-performance - richer extraction, all retrieval signals active.',
  };

  /** Updates the descriptive label below the hardware profile select. */
  function updateProfileLabel() {
    const active = getHardwareProfile();
    $('#sme_hardware_profile_label').text(PROFILE_LABELS[active] ?? '');
  }

  /**
   * Dims and disables settings that only apply to Profile B when Profile A is
   * active, so users are not confused by controls that silently do nothing.
   */
  function syncProfileGating() {
    const isB = getHardwareProfile() === 'b';
    $('#smart_memory_enhanced_settings .sm-profile-b-only').each(function () {
      $(this).toggleClass('sm-gated', !isB);
      $(this).find('input, select, button').prop('disabled', !isB);
    });
  }

  $('#sme_hardware_profile')
    .val(s.hardware_profile ?? 'auto')
    .on('change', function () {
      extension_settings[MODULE_NAME].hardware_profile = $(this).val();
      saveSettingsDebounced();
      updateProfileLabel();
      syncProfileGating();
    });

  updateProfileLabel();
  syncProfileGating();

  // ---- Model test button --------------------------------------------------

  $('#sme_model_test_btn').on('click', async function () {
    const $btn = $(this);
    const $result = $('#sme_model_test_result');

    const resetBtn = () =>
      $btn
        .prop('disabled', false)
        .html(
          '<i class="fa-solid fa-flask"></i> <span>Test Extraction Model <span class="sm-info" data-tooltip="Runs a fixed test scenario through all extraction tiers. Use this to check whether your configured model is suitable for Smart Memory Enhanced before committing to a session.">ⓘ</span></span>',
        );

    // If a test is already running, cancel it and give immediate feedback.
    if (modelTestRunning) {
      modelTestRunning = false;
      stopGeneration();
      $btn
        .prop('disabled', true)
        .html('<i class="fa-solid fa-spinner fa-spin"></i> <span>Cancelling...</span>');
      $result
        .show()
        .html(
          '<div class="sme_model_test_running"><i class="fa-solid fa-spinner fa-spin"></i> Cancelling extraction test...</div>',
        );
      return;
    }

    modelTestRunning = true;
    $btn.html('<i class="fa-solid fa-circle-stop"></i> <span>Stop Testing</span>');
    $result
      .show()
      .html(
        '<div class="sme_model_test_running"><i class="fa-solid fa-spinner fa-spin"></i> Running extraction test...</div>',
      );

    let outcome;
    try {
      outcome = await runModelTest(() => !modelTestRunning);
    } catch (err) {
      console.error('[Smart Memory Enhanced] Model test failed:', err);
      $result.html(
        '<div class="sme_model_test_fail"><i class="fa-solid fa-circle-xmark"></i> Test failed with an error. Check the browser console for details.</div>',
      );
      modelTestRunning = false;
      resetBtn();
      return;
    }

    modelTestRunning = false;
    resetBtn();

    if (outcome.cancelled) {
      $result.html(
        '<div class="sme_model_test_running"><i class="fa-solid fa-circle-xmark"></i> Test cancelled.</div>',
      );
      return;
    }

    if (outcome.failedTier) {
      $result.html(
        `<div class="sme_model_test_fail"><i class="fa-solid fa-circle-xmark"></i> <strong>${outcome.failedTier}</strong> returned no output. Your model may not be suitable for Smart Memory Enhanced, or may need a stronger prompt style. Consider trying a different model.</div>`,
      );
      return;
    }

    // All tiers passed - render paginated tier review.
    const tiers = outcome.tiers;
    let current = 0;

    $result.html(`
      <div class="sme_model_test_pass_header">
        <i class="fa-solid fa-circle-check"></i> All tiers returned output.
      </div>
      <div id="sme_model_test_tier_area"></div>
    `);

    function renderTier() {
      const tier = tiers[current];
      const sc = tier.scenario;
      const scenarioLines = sc.messages.map((m) => `${m.name}: ${m.mes ?? m.text}`).join('\n');
      const charactersNote = `Characters: ${sc.characters.join(', ')}`;
      const readWarning = sc.showReadWarning
        ? 'Read through this before judging - it is the only way to catch invented facts that look plausible.'
        : 'Reference scenario for this tier.';
      const $area = $('<div>');
      $area.append(
        $('<div class="sme_model_test_tier_name">').html(
          `${tier.name} <span class="sme_model_test_tier_pos">${current + 1} / ${tiers.length}</span>`,
        ),
      );
      const $details = $('<details class="sme_model_test_scenario">');
      $details.append($('<summary>').text('View test scenario'));
      $details.append(
        $('<p class="sme_model_test_scenario_note">').text(`${charactersNote}. ${readWarning}`),
      );
      $details.append(
        $('<textarea class="sme_model_test_output text_pole" readonly>').val(scenarioLines),
      );
      $area.append($details);
      $area.append($('<div class="sme_model_test_tier_hint">').text(tier.hint));
      $area.append(
        $('<textarea class="sme_model_test_output text_pole" readonly>').val(tier.items.join('\n')),
      );
      const $nav = $('<div class="sme_model_test_nav">');
      $nav.append(
        $('<button class="menu_button sme_model_test_prev">')
          .prop('disabled', current === 0)
          .html('&#8592; Previous'),
      );
      $nav.append(
        $('<button class="menu_button sme_model_test_next">')
          .prop('disabled', current === tiers.length - 1)
          .html('Next &#8594;'),
      );
      $area.append($nav);
      $('#sme_model_test_tier_area').empty().append($area);
      $area.find('.sme_model_test_prev').on('click', () => {
        if (current > 0) {
          current--;
          renderTier();
        }
      });
      $area.find('.sme_model_test_next').on('click', () => {
        if (current < tiers.length - 1) {
          current++;
          renderTier();
        }
      });
    }

    renderTier();
  });

  $('#sme_extraction_frequency')
    .val(s.extraction_frequency ?? 'medium')
    .on('change', function () {
      const freq = $(this).val();
      const every = EXTRACTION_FREQUENCY_MAP[freq] ?? 3;
      const settings = extension_settings[MODULE_NAME];
      settings.extraction_frequency = freq;
      settings.longterm_extract_every = every;
      settings.session_extract_every = every;
      saveSettingsDebounced();
      // Keep the advanced sliders in sync so switching to advanced mode shows the right values.
      $('#sme_longterm_extract_every').val(every);
      $('#sme_longterm_extract_every_value').text(every);
      $('#sme_session_extract_every').val(every);
      $('#sme_session_extract_every_value').text(every);
    });

  // ---- Short-term (compaction) ----------------------------------------
  $('#sme_compaction_enabled')
    .prop('checked', s.compaction_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_compaction_threshold')
    .val(s.compaction_threshold)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_threshold = val;
      $('#sme_compaction_threshold_value').text(val + '%');
      saveSettingsDebounced();
    });
  $('#sme_compaction_threshold_value').text(s.compaction_threshold + '%');

  $('#sme_compaction_response_length')
    .val(s.compaction_response_length)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].compaction_response_length = val;
      $('#sme_compaction_response_length_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_compaction_response_length_value').text(s.compaction_response_length);

  $('#sme_compaction_template')
    .val(s.compaction_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_compaction_position"][value="${s.compaction_position}"]`).prop('checked', true);
  $('input[name="sme_compaction_position"]').on('change', function () {
    extension_settings[MODULE_NAME].compaction_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_compaction_depth')
    .val(s.compaction_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].compaction_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_compaction_role')
    .val(s.compaction_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].compaction_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- Canon ----------------------------------------------------------

  $('#sme_canon_enabled')
    .prop('checked', s.canon_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].canon_enabled) {
        setExtensionPrompt(PROMPT_KEY_CANON, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectCanon(ctrl.getSelectedCharacterName());
        updateTokenDisplay();
      }
    });

  $('#sme_canon_inject_budget')
    .val(s.canon_inject_budget)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].canon_inject_budget = val;
      $('#sme_canon_inject_budget_value').text(val);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });
  $('#sme_canon_inject_budget_value').text(s.canon_inject_budget);

  $('#sme_canon_template')
    .val(s.canon_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_canon_position"][value="${s.canon_position}"]`).prop('checked', true);
  $('input[name="sme_canon_position"]').on('change', function () {
    extension_settings[MODULE_NAME].canon_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_canon_depth')
    .val(s.canon_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].canon_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_canon_role')
    .val(s.canon_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].canon_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // Allow manual edits to the canon textarea to take effect immediately.
  $('#sme_canon_display').on('input', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    const val = $(this).val().trim();
    if (val) {
      saveCanon(characterName, val);
      injectCanon(characterName);
    } else {
      clearCanon(characterName);
    }
    updateTokenDisplay();
  });

  $('#sme_summarize_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.compactionRunning) return;
    ctrl.compactionRunning = true;
    setStatusMessage('Extracting short-term memories...');
    $(this).prop('disabled', true);
    try {
      const summary = await runCompaction();
      if (summary) {
        injectSummary(summary);
        updateShortTermUI(summary);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage('Summary updated.');
      }
    } catch (err) {
      showError('Summary generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      ctrl.compactionRunning = false;
    }
  });

  $('#sme_generate_canon').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character loaded.', 'Smart Memory Enhanced');
      return;
    }
    if (loadArcSummaries().filter(isRecordApprovedForPropagation).length === 0) {
      toastr.warning(
        'Canon requires at least one verified resolved arc summary. Review or resolve a story arc first.',
        'Smart Memory Enhanced',
      );
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating canon summary...');
    try {
      const text = await generateCanon(characterName);
      if (text) {
        injectCanon(characterName);
        updateCanonUI(characterName);
        maybeInjectUnified();
        updateTokenDisplay();
        setStatusMessage('Canon summary updated.');
      } else {
        setStatusMessage('');
        toastr.warning('Canon generation returned no output.', 'Smart Memory Enhanced');
      }
    } catch (err) {
      showError('Canon generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // Allow manual edits to the summary textarea to take effect immediately.
  $('#sme_current_summary').on('input', function () {
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    const val = $(this).val();
    context.chatMetadata[META_KEY].summary = val;
    context.saveMetadata();
    injectSummary(val);
  });

  // ---- Consolidation --------------------------------------------------
  $('#sme_consolidate_enabled')
    .prop('checked', s.consolidation_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].consolidation_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  for (const [type, defVal] of [
    ['fact', 4],
    ['relationship', 3],
    ['preference', 3],
    ['event', 4],
  ]) {
    const key = `longterm_consolidation_threshold_${type}`;
    const spanId = `#sme_longterm_threshold_${type}_value`;
    $(`#sme_longterm_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  for (const [type, defVal] of [
    ['scene', 3],
    ['revelation', 3],
    ['development', 3],
    ['detail', 3],
  ]) {
    const key = `session_consolidation_threshold_${type}`;
    const spanId = `#sme_session_threshold_${type}_value`;
    $(`#sme_session_threshold_${type}`)
      .val(s[key] ?? defVal)
      .on('input', function () {
        const val = parseInt($(this).val(), 10);
        extension_settings[MODULE_NAME][key] = val;
        $(spanId).text(val);
        saveSettingsDebounced();
      });
    $(spanId).text(s[key] ?? defVal);
  }

  // ---- Long-term memory -----------------------------------------------
  $('#sme_longterm_enabled')
    .prop('checked', s.longterm_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectMemories(ctrl.getSelectedCharacterName()).catch(console.error);
    });

  $('#sme_longterm_extract_every')
    .val(s.longterm_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_extract_every = val;
      $('#sme_longterm_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_longterm_extract_every_value').text(s.longterm_extract_every);

  $('#sme_longterm_max_memories')
    .val(s.longterm_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_max_memories = val;
      $('#sme_longterm_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_longterm_max_memories_value').text(s.longterm_max_memories);

  $('#sme_longterm_template')
    .val(s.longterm_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_longterm_position"][value="${s.longterm_position}"]`).prop('checked', true);
  $('input[name="sme_longterm_position"]').on('change', function () {
    extension_settings[MODULE_NAME].longterm_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_longterm_depth')
    .val(s.longterm_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].longterm_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_role')
    .val(s.longterm_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_triggered_depth')
    .val(s.longterm_triggered_depth ?? 4)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_triggered_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_longterm_triggers_enabled')
    .prop('checked', s.longterm_triggers_enabled ?? false)
    .on('change', function () {
      extension_settings[MODULE_NAME].longterm_triggers_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_longterm_inject_budget_value').text(s.longterm_inject_budget ?? 500);
  $('#sme_longterm_inject_budget')
    .val(s.longterm_inject_budget ?? 500)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].longterm_inject_budget = v;
      $('#sme_longterm_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  // ---- Relationship history controls ------------------------------------
  $('#sme_relationships_enabled')
    .prop('checked', s.relationships_enabled ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].relationships_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      const characterName = ctrl.getSelectedCharacterName();
      injectRelationshipHistory(characterName);
    });

  $('#sme_relationships_inject_budget_value').text(s.relationships_inject_budget ?? 250);
  $('#sme_relationships_inject_budget')
    .val(s.relationships_inject_budget ?? 250)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].relationships_inject_budget = v;
      $('#sme_relationships_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_relationships_position"][value="${s.relationships_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_relationships_position"]').on('change', function () {
    extension_settings[MODULE_NAME].relationships_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_relationships_depth')
    .val(s.relationships_depth ?? 5)
    .on('input', function () {
      extension_settings[MODULE_NAME].relationships_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_relationships_role')
    .val(s.relationships_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].relationships_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- Relationship history panel buttons -----------------------------
  $('#sme_add_relationship').on('click', function () {
    $('#sme_relationship_add_form').removeData('editing').show();
    $('#sme_rel_subject').val('').focus();
    $('#sme_rel_target').val('');
    $('#sme_rel_descriptors').val('');
  });

  $('#sme_rel_cancel').on('click', function () {
    $('#sme_relationship_add_form').removeData('editing').hide();
  });

  $('#sme_rel_save').on('click', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;

    const subject = $('#sme_rel_subject').val().trim();
    const target = $('#sme_rel_target').val().trim();
    const descriptorsRaw = $('#sme_rel_descriptors').val().trim();

    if (!subject || !target || !descriptorsRaw) return;

    // Parse "word(magnitude), word(magnitude)" format. Words without an explicit
    // magnitude get the default "medium".
    const VALID_MAGNITUDES = new Set(['low', 'medium', 'high']);
    const descriptors = descriptorsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t) => {
        const m = /\((\s*low|medium|high\s*)\)/i.exec(t);
        const magnitude = m ? m[1].trim().toLowerCase() : 'medium';
        const word = t
          .replace(/\([^)]*\)/g, '')
          .replace(/[^a-z\s-]/gi, '')
          .trim()
          .toLowerCase();
        return VALID_MAGNITUDES.has(word) ? null : { word, magnitude };
      })
      .filter(Boolean);

    if (descriptors.length === 0) return;
    const key = `${subject}→${target}`;

    const pair = getRelationshipHistoryPair(subject, target);
    const h = loadRelationshipHistory(characterName);

    // If editing an existing pair under a different key, remove the old entry.
    const editingKey = $('#sme_relationship_add_form').data('editing');
    if (editingKey && editingKey !== pair.key) delete h[editingKey];

    h[pair.key] = {
      descriptors,
      subject_name: pair.subject.displayName,
      target_name: pair.target.displayName,
      subject_canonical_card_id: pair.subject.cardId,
      target_canonical_card_id: pair.target.cardId,
      updatedAt: Date.now(),
    };
    saveRelationshipHistory(characterName, h);
    saveSettingsDebounced();
    injectRelationshipHistory(characterName);
    updateRelationshipHistoryUI(characterName);
    $('#sme_relationship_add_form').removeData('editing').hide();
  });

  $('#sme_clear_relationships').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (
      !(await callGenericPopup(
        `Clear all relationship history for "${characterName}"?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;
    clearRelationshipHistory(characterName);
    saveSettingsDebounced();
    injectRelationshipHistory(null);
    updateRelationshipHistoryUI(characterName);
  });

  // ---- Perspectives & Secrets bindings -----------------------------------

  $('#sme_epistemic_enabled')
    .prop('checked', s.epistemic_enabled ?? true)
    .on('change', async function () {
      const enabling = $(this).prop('checked');
      if (enabling && getHardwareProfile() === 'a') {
        const confirmed = await callGenericPopup(
          'Perspectives & Secrets works best with a cloud-based LLM or a strong capable local model (e.g. Gemma 4).\n\nWeaker models may produce low-quality extractions. Use the model test in the Configuration section to check whether your model is up to the task.',
          POPUP_TYPE.CONFIRM,
          '',
          { okButton: 'I understand', cancelButton: 'Cancel' },
        );
        if (!confirmed) {
          $(this).prop('checked', false);
          return;
        }
      }
      extension_settings[MODULE_NAME].epistemic_enabled = enabling;
      saveSettingsDebounced();
      const characterName = ctrl.getSelectedCharacterName();
      injectEpistemicKnowledge(characterName, characterName);
    });

  $('#sme_epistemic_inject_unaware')
    .prop('checked', s.epistemic_inject_unaware ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_inject_unaware = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_epistemic_secondhand_framing')
    .prop('checked', s.epistemic_secondhand_framing ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_secondhand_framing = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_epistemic_inject_budget_value').text(s.epistemic_inject_budget ?? 200);
  $('#sme_epistemic_inject_budget')
    .val(s.epistemic_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].epistemic_inject_budget = v;
      $('#sme_epistemic_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_epistemic_position"][value="${s.epistemic_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_epistemic_position"]').on('change', function () {
    extension_settings[MODULE_NAME].epistemic_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_epistemic_depth')
    .val(s.epistemic_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].epistemic_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_epistemic_role')
    .val(s.epistemic_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].epistemic_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // ---- State Ledger bindings ---------------------------------------------

  $('#sme_state_ledger_enabled')
    .prop('checked', s.state_ledger_enabled ?? false)
    .on('change', async function () {
      const enabling = $(this).prop('checked');
      if (enabling && getHardwareProfile() === 'a') {
        const confirmed = await callGenericPopup(
          'State Ledger works best with a cloud-based LLM or a strong capable local model (e.g. Gemma 4).\n\nWeaker models may invent field values that are not in the scene, producing inaccurate entity state. Use the model test in the Configuration section to check whether your model is up to the task.',
          POPUP_TYPE.CONFIRM,
          '',
          { okButton: 'I understand', cancelButton: 'Cancel' },
        );
        if (!confirmed) {
          $(this).prop('checked', false);
          return;
        }
      }
      extension_settings[MODULE_NAME].state_ledger_enabled = enabling;
      saveSettingsDebounced();
      injectStateLedger();
    });

  $('#sme_state_ledger_inject_budget_value').text(s.state_ledger_inject_budget ?? 200);
  $('#sme_state_ledger_inject_budget')
    .val(s.state_ledger_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].state_ledger_inject_budget = v;
      $('#sme_state_ledger_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $(`input[name="sme_state_ledger_position"][value="${s.state_ledger_position ?? 1}"]`).prop(
    'checked',
    true,
  );
  $('input[name="sme_state_ledger_position"]').on('change', function () {
    extension_settings[MODULE_NAME].state_ledger_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_state_ledger_depth')
    .val(s.state_ledger_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].state_ledger_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_state_ledger_role')
    .val(s.state_ledger_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].state_ledger_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  // Show/hide the target field when type changes to/from "hiding".
  $('#sme_ep_type').on('change', function () {
    $('.sme_ep_target_field').toggle($(this).val() === 'hiding');
  });

  $('#sme_epistemic_add').on('click', function () {
    $('#sme_ep_type').val('knows');
    $('#sme_ep_subject').val('');
    $('#sme_ep_target').val('');
    $('#sme_ep_content').val('');
    $('.sme_ep_target_field').hide();
    $('#sme_epistemic_add_form').removeData('editing').show();
    $('#sme_ep_subject').focus();
  });

  $('#sme_ep_cancel').on('click', function () {
    $('#sme_epistemic_add_form').removeData('editing').hide();
  });

  $('#sme_ep_save').on('click', function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;

    const type = $('#sme_ep_type').val();
    const subject = $('#sme_ep_subject').val().trim();
    const target = type === 'hiding' ? $('#sme_ep_target').val().trim() : '';
    const content = $('#sme_ep_content').val().trim();

    if (!subject || !content) return;
    if (type === 'hiding' && !target) return;

    const entries = loadEpistemicKnowledge(characterName);
    const editingId = $('#sme_epistemic_add_form').data('editing');

    if (editingId) {
      // Update the existing entry in place.
      const idx = entries.findIndex((e) => e.id === editingId);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], type, subject, target, content };
      }
    } else {
      entries.push({ id: generateMemoryId(), type, subject, target, content, ts: Date.now() });
    }

    saveEpistemicKnowledge(characterName, entries);
    injectEpistemicKnowledge(characterName, characterName);
    updateEpistemicUI(characterName);
    updateTokenDisplay();
    $('#sme_epistemic_add_form').removeData('editing').hide();
  });

  $('#sme_epistemic_clear').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (
      !(await callGenericPopup(
        `Clear all Perspectives & Secrets entries for "${characterName}"?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;
    clearEpistemicKnowledge(characterName);
    injectEpistemicKnowledge(null, null);
    updateEpistemicUI(characterName);
    updateTokenDisplay();
  });

  $('#sme_read_only').on('change', async function () {
    const val = $(this).prop('checked');
    await setFreshStart(val);

    if (val) {
      // Record where this read-only window starts so we know which messages
      // to ghost if the user disables it later. setReadOnlyStartIndex also
      // records the current timestamp for session memory purging.
      const context = getContext();
      await setReadOnlyStartIndex(context.chat?.length ?? 0);
      $('body').addClass('sm-read-only');
    } else {
      const startIndex = getReadOnlyStartIndex();
      const startTime = getReadOnlyStartTime();
      const context = getContext();
      const endIndex = (context.chat?.length ?? 1) - 1;
      const hasWindow = startIndex !== null && endIndex >= startIndex;

      const commit = hasWindow
        ? await callGenericPopup(
            'Commit memories from this read-only session?\n\n' +
              'Yes - Keep session memories and extract long-term memories from this window.\n' +
              'No - Discard all memories and hide messages from this window.',
            POPUP_TYPE.CONFIRM,
          )
        : false;

      if (commit) {
        // Lift the gate and process the window as if it had always been active.
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
        await commitReadOnlyWindow(startIndex);
      } else {
        // Discard: purge session memories then ghost the messages.
        if (startTime !== null) {
          await purgeSessionMemoriesSince(startTime).catch((err) =>
            console.error('[Smart Memory Enhanced] Session memory purge failed:', err),
          );
        }
        if (hasWindow) {
          await hideChatMessageRange(startIndex, endIndex, false);
        }
        await setReadOnlyStartIndex(null);
        $('body').removeClass('sm-read-only');
      }
    }

    await injectMemories(ctrl.getSelectedCharacterName());
    await injectSessionMemories();
    updateSessionUI();
  });

  $('#sme_character_memory_policy').on('change', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    setCharacterMemoryPolicy(characterName, $(this).val());
    saveSettingsDebounced();
    await injectMemories(characterName);
    updateLongTermUI(characterName);
    updateTokenDisplay();
  });

  $('#sme_extract_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (ctrl.extractionRunning || ctrl.consolidationRunning) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    ctrl.extractionRunning = true;
    $(this).prop('disabled', true);
    setStatusMessage(`Extracting memories for ${characterName}...`);
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 20);
      const count = await extractAndStoreMemories(characterName, recentMessages, setStatusMessage);
      saveSettingsDebounced();
      updateLongTermUI(characterName);
      updateRelationshipHistoryUI(characterName);
      updateEpistemicUI(characterName);
      setStatusMessage(
        count > 0
          ? `${count} new memor${count === 1 ? 'y' : 'ies'} saved for ${characterName}.`
          : `No new memories found for ${characterName}.`,
      );
    } catch (err) {
      showError('Memory extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
      ctrl.extractionRunning = false;
    }
  });

  $('#sme_clear_memories').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) return;
    if (!(await callGenericPopup(`Clear all memories for "${characterName}"?`, POPUP_TYPE.CONFIRM)))
      return;
    clearCharacterMemories(characterName);
    clearRelationshipHistory(characterName);
    clearEpistemicKnowledge(characterName);
    clearCanon(characterName);
    saveSettingsDebounced();
    updateLongTermUI(characterName);
    updateCanonUI(characterName);
    updateRelationshipHistoryUI(characterName);
    updateEpistemicUI(characterName);
    injectMemories(null).catch(console.error);
    injectRelationshipHistory(null);
    injectEpistemicKnowledge(null, null);
    injectStateLedger();
    setStatusMessage('Memories cleared.');
  });

  // ---- Session memory -------------------------------------------------
  $('#sme_session_enabled')
    .prop('checked', s.session_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSessionMemories();
    });

  $('#sme_session_extract_every')
    .val(s.session_extract_every)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_extract_every = val;
      $('#sme_session_extract_every_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_session_extract_every_value').text(s.session_extract_every);

  $('#sme_session_max_memories')
    .val(s.session_max_memories)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_max_memories = val;
      $('#sme_session_max_memories_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_session_max_memories_value').text(s.session_max_memories);

  $('#sme_session_template')
    .val(s.session_template)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_template = $(this).val();
      saveSettingsDebounced();
    });

  $(`input[name="sme_session_position"][value="${s.session_position}"]`).prop('checked', true);
  $('input[name="sme_session_position"]').on('change', function () {
    extension_settings[MODULE_NAME].session_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_session_depth')
    .val(s.session_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].session_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_session_role')
    .val(s.session_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].session_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_session_inject_budget_value').text(s.session_inject_budget ?? 400);
  $('#sme_session_inject_budget')
    .val(s.session_inject_budget ?? 400)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].session_inject_budget = v;
      $('#sme_session_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_session_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (isFreshStart()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting session memories...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 40);
      const count = await extractSessionMemories(recentMessages);
      await injectSessionMemories();
      updateSessionUI();
      updateTokenDisplay();
      setStatusMessage(
        count > 0
          ? `${count} session item${count === 1 ? '' : 's'} saved.`
          : 'No new session items found.',
      );
    } catch (err) {
      showError('Session extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_session').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all session memories for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    try {
      await runStagedChatCleanup(getContext(), async () => {
        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearStateLedger();
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Clear session persistence failed:', err);
      setStatusMessage('Session memories were not cleared because the chat could not be saved.');
      toastr.error('Could not save the cleared session memories. Please try again.', 'Smart Memory Enhanced');
      return;
    }
    injectSessionMemories();
    injectStateLedger();
    updateSessionUI();
    setStatusMessage('Session memories cleared.');
  });

  // ---- Scene detection ------------------------------------------------
  $('#sme_scene_enabled')
    .prop('checked', s.scene_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectSceneHistory();
    });

  $('#sme_scene_ai_detect')
    .prop('checked', s.scene_ai_detect)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_ai_detect = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_scene_inject_count')
    .val(s.scene_inject_count)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_inject_count = val;
      $('#sme_scene_inject_count_value').text(val);
      saveSettingsDebounced();
      injectSceneHistory();
    });
  $('#sme_scene_inject_count_value').text(s.scene_inject_count);
  $('#sme_scene_archive_max')
    .val(s.scene_archive_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_archive_max = val;
      $('#sme_scene_archive_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_scene_archive_max_value').text(s.scene_archive_max);

  $(`input[name="sme_scene_position"][value="${s.scene_position}"]`).prop('checked', true);
  $('input[name="sme_scene_position"]').on('change', function () {
    extension_settings[MODULE_NAME].scene_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_scene_depth')
    .val(s.scene_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].scene_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_scene_role')
    .val(s.scene_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].scene_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_scene_inject_budget_value').text(s.scene_inject_budget ?? 300);
  $('#sme_scene_inject_budget')
    .val(s.scene_inject_budget ?? 300)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].scene_inject_budget = v;
      $('#sme_scene_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_scenes_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Summarizing current scene...');
    try {
      const context = getContext();
      // Use buffered messages since last break if available, else fall back to
      // the last 40 messages - capped to avoid overflowing the model context.
      const messages =
        ctrl.sceneMessageBuffer.length > 0 ? ctrl.sceneMessageBuffer : context.chat.slice(-40);
      const sceneResult = await summarizeScene(messages);
      if (sceneResult?.summary) {
        const history = loadSceneHistory();
        history.push(createSceneRecord(sceneResult.summary, messages, {
          detected_by: 'manual',
          character_participants: sceneResult.characterParticipants,
        }));
        await saveSceneHistory(history);
        // Reset the buffer - we just archived what was in it.
        ctrl.sceneMessageBuffer = [];
        ctrl.sceneBufferLastIndex = -1;
        injectSceneHistory();
        updateScenesUI();
        updateTokenDisplay();
        setStatusMessage('Scene added to history.');
      } else {
        setStatusMessage('Scene summary failed.');
      }
    } catch (err) {
      showError('Scene extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_scenes').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all scene history for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearSceneHistory();
    injectSceneHistory();
    updateScenesUI();
    setStatusMessage('Scene history cleared.');
  });

  // Delegated because the archive list is re-rendered after each change.
  $(document)
    .off('click.smeSceneArchive', '.sme_jump_scene, .sme_edit_scene, .sme_delete_scene, .sme_resummarize_scene')
    .on('click.smeSceneArchive', '.sme_jump_scene, .sme_edit_scene, .sme_delete_scene, .sme_resummarize_scene', async function (event) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number($(this).data('index'));
      const history = loadSceneHistory();
      const scene = history[index];
      if (!scene) return;

      if ($(this).hasClass('sme_jump_scene')) {
        const message = $(`#chat .mes[mesid="${scene.source_start_index}"]`)[0];
        if (message) message.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else toastr.info(`Source message ${scene.source_start_index + 1} is not currently rendered in the chat.`, 'Smart Memory Enhanced');
        return;
      }

      if ($(this).hasClass('sme_edit_scene')) {
        const summary = await callGenericPopup('Edit scene summary:', POPUP_TYPE.INPUT, scene.summary);
        if (summary === false || summary === null || !String(summary).trim()) return;
        history[index] = { ...scene, summary: String(summary).trim(), detected_by: 'manual' };
      } else if ($(this).hasClass('sme_delete_scene')) {
        if (!(await callGenericPopup('Delete this scene from the archive?', POPUP_TYPE.CONFIRM))) return;
        history.splice(index, 1);
      } else {
        const context = getContext();
        const messages = (scene.source_message_indices ?? []).map((sourceIndex) => context.chat[sourceIndex]).filter(Boolean);
        if (messages.length === 0) {
          toastr.warning('This archived scene has no readable source range to summarize again.', 'Smart Memory Enhanced');
          return;
        }
        const sceneResult = await summarizeScene(messages);
        if (!sceneResult?.summary) return;
        history[index] = createSceneRecord(sceneResult.summary, messages, {
          id: scene.id,
          source_memory_ids: scene.source_memory_ids ?? [],
          detected_by: 'manual',
          character_participants: sceneResult.characterParticipants,
        });
      }
      await saveSceneHistory(history);
      injectSceneHistory();
      updateScenesUI();
      updateTokenDisplay();
    });

  // ---- Story arcs -----------------------------------------------------
  $('#sme_arcs_enabled')
    .prop('checked', s.arcs_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      injectArcs();
    });

  $('#sme_arcs_max')
    .val(s.arcs_max)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_max = val;
      $('#sme_arcs_max_value').text(val);
      saveSettingsDebounced();
    });
  $('#sme_arcs_max_value').text(s.arcs_max);

  $(`input[name="sme_arcs_position"][value="${s.arcs_position}"]`).prop('checked', true);
  $('input[name="sme_arcs_position"]').on('change', function () {
    extension_settings[MODULE_NAME].arcs_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
  });

  $('#sme_arcs_depth')
    .val(s.arcs_depth)
    .on('input', function () {
      extension_settings[MODULE_NAME].arcs_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_arcs_role')
    .val(s.arcs_role)
    .on('change', function () {
      extension_settings[MODULE_NAME].arcs_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
    });

  $('#sme_arcs_inject_budget_value').text(s.arcs_inject_budget ?? 200);
  $('#sme_arcs_inject_budget')
    .val(s.arcs_inject_budget ?? 200)
    .on('input', function () {
      const v = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].arcs_inject_budget = v;
      $('#sme_arcs_inject_budget_value').text(v);
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });

  $('#sme_extract_arcs_now').on('click', async function () {
    if (isCatchUpRunning()) return;
    $(this).prop('disabled', true);
    setStatusMessage('Extracting story arcs...');
    try {
      const context = getContext();
      const recentMessages = ctrl.getStableExtractionWindowWithFallback(context.chat, 100);
      const count = await extractArcs(recentMessages);
      injectArcs();
      updateArcsUI();
      setStatusMessage(
        count > 0 ? `${count} arc${count === 1 ? '' : 's'} found.` : 'No new arcs found.',
      );
    } catch (err) {
      showError('Arc extraction', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_clear_arcs').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (!(await callGenericPopup('Clear all story arcs for this chat?', POPUP_TYPE.CONFIRM)))
      return;
    await clearArcs();
    injectArcs();
    updateArcsUI();
    setStatusMessage('Arcs cleared.');
  });

  // ---- Away recap -----------------------------------------------------
  $('#sme_recap_enabled')
    .prop('checked', s.recap_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].recap_enabled = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_recap_threshold')
    .val(s.recap_threshold_hours)
    .on('input', function () {
      const val = parseFloat($(this).val());
      extension_settings[MODULE_NAME].recap_threshold_hours = val;
      $('#sme_recap_threshold_value').text(val + 'h');
      saveSettingsDebounced();
    });
  $('#sme_recap_threshold_value').text(s.recap_threshold_hours + 'h');

  $('#sme_recap_now').on('click', async function () {
    $(this).prop('disabled', true);
    setStatusMessage('Generating recap...');
    try {
      const recap = await generateRecap();
      if (recap) {
        displayRecap(recap);
        setStatusMessage('Recap displayed.');
      } else {
        setStatusMessage('Recap failed.');
      }
    } catch (err) {
      showError('Recap generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  // ---- Catch Up -------------------------------------------------------

  // Maximum messages per catch-up chunk. Acts as a hard cap even when messages
  // are very short, so the model always has some turn-by-turn structure to work with.
  const CATCH_UP_CHUNK_SIZE = 20;

  // Token budget for chat content per catch-up chunk is computed dynamically
  // from the configured context size at the time catch-up runs - see below.

  $('#sme_catch_up').on('click', async function () {
    if (ctrl.extractionRunning || ctrl.compactionRunning) {
      toastr.warning('An extraction is already running.', 'Smart Memory Enhanced', { timeOut: 3000 });
      return;
    }
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No character is active.', 'Smart Memory Enhanced', { timeOut: 3000 });
      return;
    }

    // In group chats, build the full list of active member names so long-term
    // extraction runs for every character, not just the one in the selector.
    // Solo chats collapse to a single-element array using the active character.
    const catchUpContext = getContext();
    // Capture the *live* persona before any confirmation dialog or provider
    // call. Imported JSONL headers can contain placeholder persona fields, so
    // final reconciliation must never rediscover this from serialized chat
    // metadata after a long run.
    const canonicalRuntimeContext = snapshotCanonicalRuntimeContext(getLivePersonaCaptureContext(catchUpContext));
    const catchUpCharacterNames = (() => {
      if (!catchUpContext.groupId) return [characterName];
      const group = catchUpContext.groups?.find((g) => g.id === catchUpContext.groupId);
      if (!group) return [characterName];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => catchUpContext.characters.find((c) => c.avatar === avatar)?.name)
        .filter(Boolean);
    })();

    // Warn if memories already exist for any character in the list.
    const existingMemories = catchUpCharacterNames.some(
      (name) => loadCharacterMemories(name).length > 0,
    );
    if (existingMemories) {
      if (
        !(await callGenericPopup(
          'Memories already exist for one or more characters. Running Memorize Chat again may add near-duplicate entries on top of existing ones.\n\nContinue?',
          POPUP_TYPE.CONFIRM,
        ))
      )
        return;
    }

    // The catch-up loop holds extractionRunning=true for its entire duration.
    // This blocks the background extraction path in onCharacterMessageRendered
    // from running concurrently, so consolidationRunning does not need a
    // separate check here - no other path can interleave with catch-up while
    // extractionRunning is set.
    ctrl.extractionRunning = true;
    ctrl.compactionRunning = true;
    ctrl.catchUpCancelled = false;
    setCanonicalRuntimeContextSnapshot(canonicalRuntimeContext);
    let catchUpErrorCount = 0;
    const runResult = {
      totalChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      retriedRequests: 0,
      extractionFailuresByTier: {},
      saveFailures: 0,
      providerFailures: [],
      errors: [],
      warnings: [],
      warningsSuppressed: 0,
      status: 'completed',
      chunks: [],
      arcResolution: { resolved: 0, still_open: 0, abandoned: 0, superseded: 0, insufficient_evidence: 0 },
      arcExtraction: { attempted: 0, request_completed: 0, provider_error: 0, http_status: null, error_class: null, non_retryable: false, returned_none: 0, malformed_output: 0, parsed_candidates: 0, accepted_open_threads: 0, rejected_completed_events: 0, rejected_background_facts: 0, rejected_relationship_states: 0, rejected_scene_details: 0, rejected_malformed: 0, participant_repairs: 0, participant_review_items: 0, terminal_reconciled: false, malformed_request: 0, input_token_budget: 0, input_token_estimate: 0, input_messages: 0, omitted_messages: 0, truncated_message: false, terminal_outcome: null },
      arcPipeline: { classifiedResolved: 0, generationAttempted: 0, generatorNone: 0, generatorMalformed: 0, preverificationRejected: 0, verifiedSupported: 0, verifiedAmbiguous: 0, verifiedUnsupported: 0, persisted: 0, providerError: 0, records: [] },
      sessionExtraction: {
        emitted: 0,
        validated: 0,
        missingProvenance: 0,
        repairAttempts: 0,
        repairRecovered: 0,
        repairEligible: 0,
        repairProviderError: 0,
        repairReturnedNone: 0,
        repairMalformed: 0,
        repairStillInvalid: 0,
        repairSemanticallyUnsupported: 0,
        repairAccepted: 0,
        rejectedByValidation: 0,
        providerFailures: 0,
        providerReturnedNone: 0,
        malformedOutput: 0,
        terminalDispositions: {
          accepted_validated: 0,
          accepted_after_citation_repair: 0,
          missing_provenance: 0,
          semantic_support_rejected: 0,
          malformed_candidate: 0,
          duplicate_same_pass: 0,
          duplicate_existing: 0,
          provider_or_parser_error: 0,
          provider_returned_none: 0,
        },
      },
      profiles: { profiles_attempted: 0, profiles_parsed: 0, profiles_saved: 0, malformed_output: 0, malformed_output_details: [], attempts: [], sections_detected: { character_state: 0, world_state: 0, relationship_matrix: 0 }, fields: { accepted_exact: 0, accepted_normalized: 0, preserved_prior: 0, dropped_conflict: 0, dropped_speculative: 0, dropped_invalid_label: 0, dropped_unsupported: 0, dropped_malformed: 0 }, relationship_conflict_details: [], sections_parsed: 0, stale_fields_dropped: 0, speculative_fields_dropped: 0, unsupported_fields_dropped: 0, prior_fields_preserved: 0, relationship_conflicts_dropped: 0, relationshipConflictsDropped: 0, speculativeCurrentFieldsDropped: 0, preservedPriorFields: 0 },
      identity_review: { existing_at_start: extension_settings[MODULE_NAME]?.identity_review_queue?.length ?? 0, created_this_run: 0, resolved_this_run: 0, removed_as_duplicate: 0, remaining_at_end: extension_settings[MODULE_NAME]?.identity_review_queue?.length ?? 0 },
      finalReconciliation: { attempted: 0, completed: 0, rolled_back: false, failure_stage: null, error_class: null, error_message: null, persona_roster_size: 0, persona_aliases_merged: 0, card_local_entities_merged: 0, relationship_pairs_merged: 0, participant_lists_rewritten: 0, synthetic_parentheticals_removed: 0, identity_decision_duplicates_removed: 0, resolved_review_items_removed: 0, stale_entity_references: 0, unsafe_merge_candidates: 0, unsafe_merge_candidates_rejected: 0, safe_merge_candidates_completed: 0, review_items_created: 0, integrity_audit: null, personaRosterSize: 0, personaAliasesMerged: 0, cardLocalEntitiesMerged: 0, relationshipPairsMerged: 0, participantListsRewritten: 0, syntheticParentheticalsRemoved: 0 },
      runtimeContext: canonicalRuntimeContext,
      quality: { status: 'clean', reasons: [] },
    };
    let currentChunkFailed = false;
    let finalTransaction = null;
    const recordCatchUpError = (label, err, tier = null, isSave = false) => {
      catchUpErrorCount++;
      setCatchUpErrorCount(catchUpErrorCount);
      currentChunkFailed = true;
      if (tier) runResult.extractionFailuresByTier[tier] = (runResult.extractionFailuresByTier[tier] ?? 0) + 1;
      if (isSave) runResult.saveFailures++;
      runResult.errors.push({
        label,
        tier,
        persistence: isSave,
        message: String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').slice(0, 300),
      });
      if (err?.sme_request_diagnostics) {
        runResult.providerFailures.push({
          label,
          tier,
          ...err.sme_request_diagnostics,
        });
      }
      console.error(`[Smart Memory Enhanced] Catch-up ${label}:`, err);
    };
    const recordCatchUpWarning = (label, err, tier = null) => {
      // Avoid turning a repeated optional-provider failure (such as AI scene
      // detection) into a massive diagnostics payload that threatens the final
      // chat save itself.
      if (runResult.warnings.length < 50) {
        runResult.warnings.push({
          label,
          tier,
          message: String(err?.message ?? err ?? 'Unknown warning').replace(/\s+/g, ' ').slice(0, 300),
        });
      } else {
        runResult.warningsSuppressed++;
      }
      console.warn(`[Smart Memory Enhanced] Catch-up ${label}:`, err);
    };
    const runNonfatalPresentationTask = async (label, task) => {
      try {
        await task();
      } catch (err) {
        // Prompt/UI refresh does not change durable memories. Never let it
        // roll back a multi-hour extraction transaction.
        recordCatchUpWarning(`${label} warning`, err, 'presentation');
      }
    };
    const unsubscribeRetry = onMemoryRequestRetry(() => runResult.retriedRequests++);
    setCatchUpErrorCount(0);
    $('#sme_catch_up').hide();
    $('#sme_cancel_catch_up').show().prop('disabled', false);

    try {
      const context = getContext();
      const settings = extension_settings[MODULE_NAME];

      // Use the stable window first so an in-progress trailing swipe candidate
      // is not ingested during catch-up.
      const stableChat = ctrl.getStableExtractionWindowWithFallback(
        context.chat,
        context.chat.length,
      );

      // Filter to real messages only so system/hidden entries don't inflate
      // the chunk count or confuse the model.
      const allMessages = stableChat
        .map((message, stableIndex) => {
          // Non-enumerable metadata is intentionally omitted from chat saves.
          // It lets every catch-up extraction retain source indices from the
          // original chat after system messages have been filtered out.
          const originalIndex = context.chat.indexOf(message);
          Object.defineProperty(message, '__sme_original_index', { value: originalIndex >= 0 ? originalIndex : stableIndex, configurable: true });
          return message;
        })
        .filter((m) => m.mes && !m.is_system);
      const total = allMessages.length;

      // Process the chat in token-limited chunks sequentially. Each extraction
      // function loads its existing results and passes them as context to the
      // model, so each chunk naturally builds on what the previous one found.
      // Budget = 35% of the configured context size, leaving the remainder for
      // prompt overhead (instructions, existing memories) and the model response.
      const catchUpTokenBudget = Math.max(500, Math.floor(getMaxContextSize(0) * 0.35));
      let i = 0;
      while (i < total) {
        if (ctrl.catchUpCancelled) break;
        currentChunkFailed = false;

        // Yield to the browser event loop at the start of each chunk so the
        // UI remains responsive and the cancel button stays clickable even
        // when individual model calls complete quickly (e.g. cached responses).
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Build the chunk by accumulating messages until the token budget or
        // the message cap is reached. Always include at least one message so
        // a single very long message does not stall the loop forever.
        const chunk = [];
        let chunkTokens = 0;
        for (let j = i; j < total && chunk.length < CATCH_UP_CHUNK_SIZE; j++) {
          const msg = allMessages[j];
          const msgTokens = estimateTokens(`${msg.name}: ${msg.mes}`);
          if (chunk.length > 0 && chunkTokens + msgTokens > catchUpTokenBudget) break;
          chunk.push(msg);
          chunkTokens += msgTokens;
        }
        const processed = Math.min(i + chunk.length, total);
        const pct = Math.round((processed / total) * 100);
        const chunkTransaction = beginCatchUpTransaction(catchUpContext);
        setStatusMessage(
          `Catching up... (${i}/${total} messages, ${Math.round((i / total) * 100)}%)`,
        );

        if (settings.longterm_enabled && !isFreshStart()) {
          for (const name of catchUpCharacterNames) {
            // Filter chunk to this character's messages + user messages, matching
            // the Phase 2 per-character window filtering used in automatic extraction.
            const nameChunk = catchUpContext.groupId
              ? chunk.filter((m) => m.is_user || m.name === name)
              : chunk;
            if (nameChunk.length === 0) continue;
            setStatusMessage(
              `Catching up... (${i}/${total} messages - extracting long-term for ${name})`,
            );
            await extractAndStoreMemories(name, nameChunk, setStatusMessage).catch((err) => {
              recordCatchUpError('long-term extraction error (chunk)', err, 'long-term');
            });
            // Consolidate after each chunk so near-duplicates are collapsed before
            // the next chunk can add more similar entries.
            if (settings.consolidation_enabled) {
              setStatusMessage(`Catching up... (${i}/${total} messages - consolidating ${name})`);
              await consolidateMemories(name).catch((err) => {
                recordCatchUpError('long-term consolidation error (chunk)', err, 'long-term');
              });
            }
          }
        }
        if (settings.session_enabled && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - extracting session)`);
          await extractSessionMemories(chunk, null, { sessionDiagnostics: runResult.sessionExtraction }).catch((err) => {
            recordCatchUpError('session extraction error (chunk)', err, 'session');
          });
          setStatusMessage(`Catching up... (${i}/${total} messages - consolidating session)`);
          await consolidateSessionMemories().catch((err) => {
            recordCatchUpError('session consolidation error (chunk)', err, 'session');
          });
        }
        if (isStateLedgerEnabled() && !isFreshStart()) {
          setStatusMessage(`Catching up... (${i}/${total} messages - updating state ledger)`);
          await runStateCardExtraction(characterName, chunk).catch((err) => {
            recordCatchUpError('State Ledger extraction error (chunk)', err, 'state-ledger');
          });
        }

        // Re-inject after each chunk so the token display reflects what is
        // actually stored, not just what was injected before catch-up started.
        // Wrap with .catch so an embedding failure here does not abort the
        // entire catch-up run via the outer catch block.
        if (settings.longterm_enabled && characterName) {
          await injectMemories(characterName).catch((err) => {
            recordCatchUpError('long-term injection error', err);
          });
        }
        if (settings.session_enabled) {
          await injectSessionMemories().catch((err) => {
            recordCatchUpError('session injection error', err);
          });
        }
        if (settings.arcs_enabled) {
          await runNonfatalPresentationTask('Story Arc injection', () => injectArcs());
        }
        if (settings.relationships_enabled) {
          await runNonfatalPresentationTask('Relationship History injection', () => injectRelationshipHistory(characterName));
        }

        // Advance lastExtractCutoff so the normal extraction window starts from
        // where catch-up left off rather than re-processing the same messages.
        const cuMeta = catchUpContext.chatMetadata?.[META_KEY];
        if (cuMeta) {
          const lastChunkMsg = chunk[chunk.length - 1];
          const chatIdx = lastChunkMsg
            ? catchUpContext.chat.lastIndexOf(lastChunkMsg)
            : catchUpContext.chat.length - 1;
          const cuCutoff =
            chatIdx >= 0 && lastChunkMsg && !lastChunkMsg.is_user && !lastChunkMsg.is_system
              ? chatIdx
              : chatIdx + 1;
          if (cuCutoff > (cuMeta.lastExtractCutoff ?? 0)) {
            cuMeta.lastExtractCutoff = cuCutoff;
          }
        }

        try {
          await retryTransientMemoryOperation(() => commitCatchUpTransaction(chunkTransaction));
        } catch (err) {
          // The transaction restores both chat metadata and extension state.
          // This chunk is deliberately not treated as completed or committed.
          recordCatchUpError('chunk persistence error', err, null, true);
        }

        // Update progress and token display after each chunk so the user can
        // see memories accumulating in real time rather than only at the end.
        setStatusMessage(`Catching up... (${processed}/${total} messages, ${pct}%)`);
        await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());

        runResult.totalChunks++;
        runResult.chunks.push({
          number: runResult.totalChunks,
          source_start_index: chunk[0]?.__sme_original_index ?? null,
          source_end_index: chunk.at(-1)?.__sme_original_index ?? null,
          message_count: chunk.length,
          token_estimate: chunkTokens,
          status: currentChunkFailed ? 'partial' : 'completed',
        });
        if (currentChunkFailed) runResult.failedChunks++;
        else runResult.completedChunks++;

        i += chunk.length;
      }

      // Scene detection and the final cross-tier passes run after the chunk
      // loop. Keep one transaction open for this whole phase so their metadata
      // writes do not fall back to individual SillyTavern chat saves.
      finalTransaction = beginCatchUpTransaction(catchUpContext);

      if (!ctrl.catchUpCancelled) {
        // Complete the evidence tiers before scenes and arcs. This gives later
        // stages a stable, consolidated store and avoids creating a new arc
        // after the final identity-reconciliation phase has already begun.
        if (settings.longterm_enabled && settings.consolidation_enabled) {
          for (const name of catchUpCharacterNames) {
            setStatusMessage(`Consolidating long-term memories for ${name}...`);
            await consolidateMemories(name, true).catch((err) => {
              recordCatchUpError('final long-term consolidation error', err);
            });
          }
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }
        if (settings.session_enabled) {
          setStatusMessage('Consolidating session memories...');
          await consolidateSessionMemories(true).catch((err) => {
            recordCatchUpError('final session consolidation error', err);
          });
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }

        // Scene: walk through the full chat detecting and summarizing scenes.
        // When scene_ai_detect is enabled, AI detection runs on each AI message
        // (matching normal flow). When disabled, the heuristic is used instead.
        if (settings.scene_enabled) {
          setStatusMessage('Detecting scene breaks...');
          const sceneHistory = loadSceneHistory();
          const minMessages = settings.scene_min_messages ?? 3;
          let sceneBuffer = [];
          let sceneCount = 0;
          const sceneAudit = { candidates: 0, generated: 0, duplicates: 0, failed: 0, detection_failed: 0, heuristic_break_candidates: 0, ai_breaks_added: 0, ai_breaks_removed: 0, final_break_indices: [], scene_boundary_source: [], scene_detector_model_request_count: 0, boundary_candidates_evaluated: 0, requests_sent: 0, average_candidates_per_request: 0, batched_requests: 0, fallback_boundaries: 0 };
          let prevAiMsg = '';

          /**
           * Deduplicates a candidate summary against the last three stored scenes,
           * mirroring the check in processSceneBreak. Returns true if the summary
           * is too similar to an existing entry and should be skipped.
           */
          const isDuplicateScene = async (candidate) => {
            const recent = sceneHistory.slice(-3);
            for (const prev of recent) {
              const { score, semantic } = await sceneSimilarity(candidate, prev.summary);
              const threshold = semantic ? 0.82 : 0.55;
              if (score >= threshold) return true;
            }
            return false;
          };

          for (let msgIdx = 0; msgIdx < allMessages.length; msgIdx++) {
            if (ctrl.catchUpCancelled) break;
            const msg = allMessages[msgIdx];
            sceneBuffer.push(msg);

            const msgText = msg.mes ?? '';
            const isAiMsg = !msg.is_user;

            if (isAiMsg && settings.scene_ai_detect) {
              setStatusMessage(`Detecting scene breaks... (${msgIdx + 1}/${allMessages.length})`);
              sceneAudit.scene_detector_model_request_count++;
              sceneAudit.boundary_candidates_evaluated++;
              sceneAudit.requests_sent++;
            }

            // AI detection only runs on AI messages - user messages are skipped,
            // matching the behaviour of the normal CHARACTER_MESSAGE_RENDERED path.
            const isBreak = settings.scene_ai_detect
              ? isAiMsg &&
                sceneBuffer.length >= minMessages &&
                (await detectSceneBreakAI(msgText, prevAiMsg, (err) => {
                sceneAudit.detection_failed++;
                sceneAudit.fallback_boundaries++;
                  recordCatchUpWarning('AI scene-break detection warning', err, 'scenes');
                }))
              : detectSceneBreakHeuristic(msgText) && sceneBuffer.length >= minMessages;

            if (isAiMsg) prevAiMsg = msgText;

            if (isBreak) {
              const boundarySource = settings.scene_ai_detect ? 'ai-confirmation' : 'heuristic';
              if (settings.scene_ai_detect) sceneAudit.ai_breaks_added++;
              else sceneAudit.heuristic_break_candidates++;
              sceneAudit.final_break_indices.push(msg.__sme_original_index ?? msgIdx);
              sceneAudit.scene_boundary_source.push({ index: msg.__sme_original_index ?? msgIdx, source: boundarySource });
              sceneCount++;
              sceneAudit.candidates++;
              setStatusMessage(`Summarizing scene ${sceneCount}...`);
              const sceneResult = await summarizeScene(sceneBuffer).catch((err) => {
                recordCatchUpError('scene summary error', err);
                sceneAudit.failed++;
                return null;
              });
              if (sceneResult?.summary && !(await isDuplicateScene(sceneResult.summary))) {
                sceneHistory.push(createSceneRecord(sceneResult.summary, sceneBuffer, {
                  detected_by: settings.scene_ai_detect ? 'ai' : 'heuristic',
                  boundary_source: boundarySource,
                  detection_message_index: msg.__sme_original_index ?? null,
                  character_participants: sceneResult.characterParticipants,
                }));
                sceneAudit.generated++;
              } else if (sceneResult?.summary) {
                sceneAudit.duplicates++;
              }
              if (isEpistemicEnabled() && !isFreshStart()) {
                setStatusMessage(
                  `Summarizing scene ${sceneCount}... (extracting epistemic knowledge)`,
                );
                await extractEpistemicKnowledge(sceneBuffer, characterName).catch((err) => {
                  recordCatchUpError('epistemic extraction error', err);
                });
              }
              sceneBuffer = [];
            }
          }

          // Summarize any remaining messages after the last break as the current scene.
          if (!ctrl.catchUpCancelled && sceneBuffer.length >= minMessages) {
            sceneAudit.candidates++;
            const sceneResult = await summarizeScene(sceneBuffer).catch((err) => {
              recordCatchUpError('final scene summary error', err);
              sceneAudit.failed++;
              return null;
            });
            if (sceneResult?.summary && !(await isDuplicateScene(sceneResult.summary))) {
              sceneHistory.push(createSceneRecord(sceneResult.summary, sceneBuffer, {
                detected_by: 'final',
                boundary_source: 'final-fallback',
                detection_message_index: sceneBuffer.at(-1)?.__sme_original_index ?? null,
                character_participants: sceneResult.characterParticipants,
              }));
              sceneAudit.generated++;
            } else if (sceneResult?.summary) {
              sceneAudit.duplicates++;
            }
            if (isEpistemicEnabled() && !isFreshStart()) {
              setStatusMessage('Extracting epistemic knowledge from final scene...');
              await extractEpistemicKnowledge(sceneBuffer, characterName).catch((err) => {
                recordCatchUpError('final epistemic extraction error', err);
              });
            }
          }

          await saveSceneHistory(sceneHistory).catch((err) => {
            recordCatchUpError('scene history save error', err);
          });
          sceneAudit.average_candidates_per_request = sceneAudit.requests_sent ? Number((sceneAudit.boundary_candidates_evaluated / sceneAudit.requests_sent).toFixed(2)) : 0;
          runResult.sceneDetection = { ...sceneAudit, retained: loadSceneHistory().length, injected: Math.min(loadSceneHistory().length, settings.scene_inject_count ?? 5) };
          ctrl.sceneMessageBuffer = [];
          ctrl.sceneBufferLastIndex = -1;
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }

        // Extract arcs once against the complete, consolidated chat after the
        // scene and epistemic passes. This is intentionally not per chunk:
        // otherwise a later chunk can create or resolve identities after the
        // staged final reconciliation has consumed an earlier partial graph.
        if (settings.arcs_enabled && !isFreshStart()) {
          setStatusMessage('Extracting and resolving story arcs...');
          await extractArcs(allMessages, characterName, null, {
            arcResolutionStats: runResult.arcResolution,
            arcPipeline: runResult.arcPipeline,
            arcExtraction: runResult.arcExtraction,
          }).catch((err) => {
            recordCatchUpError('arc extraction error (final)', err, 'arcs');
          });
        }

        // Short-term compaction runs once at the end - it uses the real token
        // count to decide what to include, so chunking doesn't apply.
        if (settings.compaction_enabled) {
          setStatusMessage('Extracting short-term memories...');
          await runCompaction({ includeLastMessage: true })
            .then((summary) => {
              if (summary) {
                injectSummary(summary);
                updateShortTermUI(summary);
              }
            })
            .catch((err) => {
              recordCatchUpError('compaction error', err);
            });
          await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
        }
      }

      // Generate character & world profiles once at the end of a completed run.
      // Skipped on cancel - partial data may produce low-quality profiles.
      if (!ctrl.catchUpCancelled && settings.profiles_enabled) {
        for (const name of catchUpCharacterNames) {
          setStatusMessage(`Generating character & world profiles for ${name}...`);
          runResult.profiles.profiles_attempted++;
          let profileTerminal = null;
          const profiles = await generateProfiles(name, null, {
            throwOnFailure: true,
            onTerminal: (detail) => { profileTerminal = detail; },
          }).catch((err) => {
            recordCatchUpError(err?.sme_profile_malformed_output
              ? `${name} profile generation produced unparseable output`
              : `${name} profile generation error`, err);
            return null;
          });
          if (profileTerminal) runResult.profiles.attempts.push(profileTerminal);
          if (profileTerminal?.terminal_outcome === 'preserved_prior' || profileTerminal?.terminal_outcome === 'rejected_unparseable') {
            runResult.profiles.malformed_output++;
            runResult.profiles.malformed_output_details.push(profileTerminal);
            continue;
          }
          // Update UI with the selected character's profiles - other characters'
          // profiles are stored but only the active character is displayed.
          if (profiles && name === characterName) {
            injectProfiles(name);
            updateProfilesUI(profiles);
          }
          if (profiles) {
            runResult.profiles.profiles_parsed++;
            runResult.profiles.profiles_saved++;
            runResult.profiles.sections_parsed++;
            for (const section of ['character_state', 'world_state', 'relationship_matrix']) {
              if (profiles[section]) runResult.profiles.sections_detected[section]++;
            }
            runResult.profiles.stale_fields_dropped += profiles.stale_field_rejections?.length ?? 0;
            runResult.profiles.speculative_fields_dropped += profiles.speculative_field_rejections?.length ?? 0;
            runResult.profiles.unsupported_fields_dropped += profiles.field_grounding_rejections?.length ?? 0;
            // field_validation is the sole accumulator.  Legacy summary
            // counters below are derived from it, preventing the same field
            // disposition from being counted once here and once in the loop.
            for (const [field, value] of Object.entries(profiles.field_validation ?? {})) {
              runResult.profiles.fields[field] = (runResult.profiles.fields[field] ?? 0) + Number(value ?? 0);
            }
            runResult.profiles.prior_fields_preserved = runResult.profiles.fields.preserved_prior;
            runResult.profiles.relationship_conflicts_dropped = runResult.profiles.fields.dropped_conflict;
            runResult.profiles.relationship_conflict_details.push(...(profiles.relationship_field_details ?? []));
            runResult.profiles.speculativeCurrentFieldsDropped = runResult.profiles.speculative_fields_dropped;
            runResult.profiles.relationshipConflictsDropped = runResult.profiles.relationship_conflicts_dropped;
            runResult.profiles.preservedPriorFields = runResult.profiles.prior_fields_preserved;
          }
        }
        // If the selected character wasn't in the group (edge case), inject
        // whatever profiles exist for them anyway.
        if (!catchUpCharacterNames.includes(characterName)) {
          injectProfiles(characterName);
        }
      }

      // Re-injection and panel refresh are presentation-only. Isolate every
      // task so a DOM, prompt-slot, or embedding problem cannot abort the
      // staged data commit near the end of a long run.
      await runNonfatalPresentationTask('Long-term memory injection', () => injectMemories(characterName));
      await runNonfatalPresentationTask('Relationship History injection', () => injectRelationshipHistory(characterName));
      await runNonfatalPresentationTask('Session memory injection', () => injectSessionMemories());
      await runNonfatalPresentationTask('Scene History injection', () => injectSceneHistory());
      await runNonfatalPresentationTask('Story Arc injection', () => injectArcs());
      await runNonfatalPresentationTask('State Ledger injection', () => injectStateLedger());
      await runNonfatalPresentationTask('Perspectives & Secrets injection', () => {
        resetEpistemicWarnFlag();
        return injectEpistemicKnowledge(characterName, characterName, false, true, true);
      });
      await runNonfatalPresentationTask('Profile injection', () => injectProfiles(characterName));
      await runNonfatalPresentationTask('Entity Registry refresh', () => updateEntityPanel(characterName));
      await runNonfatalPresentationTask('Long-term memory panel refresh', () => updateLongTermUI(characterName));
      await runNonfatalPresentationTask('Relationship History panel refresh', () => updateRelationshipHistoryUI(characterName));
      await runNonfatalPresentationTask('Perspectives & Secrets panel refresh', () => updateEpistemicUI(characterName));
      await runNonfatalPresentationTask('Session memory panel refresh', () => updateSessionUI());
      await runNonfatalPresentationTask('Scene History panel refresh', () => updateScenesUI());
      await runNonfatalPresentationTask('Story Arc panel refresh', () => updateArcsUI());
      await runNonfatalPresentationTask('Profile panel refresh', () => updateProfilesUI(loadProfiles(characterName)));
      // Catch-up can surface first-name variants that only become resolvable
      // after the full roster and extracted evidence are available.
      const reconciliationSnapshot = {
        metadata: structuredClone(catchUpContext.chatMetadata?.[META_KEY] ?? {}),
        settings: structuredClone(extension_settings[MODULE_NAME] ?? {}),
      };
      let reconciliation;
      runResult.finalReconciliation.attempted = 1;
      try {
        reconciliation = await runFinalIntegrityReconciliation(characterName);
        if (reconciliation.integrity_audit?.status === 'unsafe') {
          const error = new Error('Unsafe canonical identity merge was rejected during final reconciliation.');
          error.sme_failure_stage = 'identity_integrity';
          // Diagnostics describe a proposal/audit, not staged chat state.
          // Preserve a compact copy if a genuinely structural integrity
          // failure requires rolling the staged mutations back.
          error.sme_reconciliation_diagnostics = {
            identity_outcomes: structuredClone(reconciliation.identity_outcomes ?? []),
            integrity_audit: structuredClone(reconciliation.integrity_audit ?? null),
            persona_roster_size: reconciliation.persona_roster_size ?? 0,
            rejected_unsafe_merges: structuredClone(reconciliation.integrity_audit?.rejected_unsafe_merges ?? []),
          };
          throw error;
        }
        runResult.finalReconciliation.completed = 1;
      } catch (err) {
        // Roll back only the partially-applied reconciliation edits while
        // preserving scenes, profiles, and every earlier validated tier.
        // The final staged transaction still protects the later chat save.
        catchUpContext.chatMetadata[META_KEY] = reconciliationSnapshot.metadata;
        extension_settings[MODULE_NAME] = reconciliationSnapshot.settings;
        recordCatchUpError('final reconciliation error', err, 'identity');
        runResult.finalReconciliation.rolled_back = true;
        runResult.finalReconciliation.failure_stage = err?.sme_failure_stage ?? 'final_reconciliation';
        runResult.finalReconciliation.error_class = err?.name ?? 'Error';
        runResult.finalReconciliation.error_message = String(err?.message ?? err ?? 'Unknown reconciliation error').replace(/\s+/g, ' ').slice(0, 300);
        const retained = err?.sme_reconciliation_diagnostics ?? null;
        reconciliation = {
          // A rollback reverses durable changes, not the compact evidence of
          // why the final audit rejected them. Export it so the failed
          // candidate can be diagnosed without retaining prompts or chat text.
          matched: [], merged: [], skipped: retained?.rejected_unsafe_merges ?? [], unmatched: [], card_local_reports: [],
          identity_outcomes: retained?.identity_outcomes ?? [],
          persona_roster_size: retained?.persona_roster_size ?? 0,
          participant_lists_rewritten: 0, resolved_review_items_removed: 0,
          integrity_audit: retained?.integrity_audit ?? { stale_entity_references: [], status: 'degraded' }, quarantined_arc_summaries: 0,
        };
      }
      runResult.identityResolution = {
        matched: reconciliation.matched.length,
        merged: reconciliation.merged.length,
        needs_review: reconciliation.skipped.length,
        unmatched: reconciliation.unmatched.length,
        quarantined_arc_summaries: reconciliation.quarantined_arc_summaries,
      };
      const deduplicatedTerminalOutcomes = [...(reconciliation.identity_outcomes ?? [])].filter(Boolean).reduce((records, outcome) => {
        // A source record ID is only unique within its store. Preserve one
        // physical terminal record per scoped observation; a different
        // terminal decision for the same composite key is a real conflict.
        const key = makeTerminalObservationKey(outcome.source_store, outcome.source_record_id);
        if (!key) return records;
        const prior = records.get(key);
        if (!prior) records.set(key, { ...outcome, terminal_key: key, source_record_ids: [...new Set((outcome.source_record_ids ?? []).filter(Boolean))] });
        else {
          prior.source_record_ids = [...new Set([...(prior.source_record_ids ?? []), ...(outcome.source_record_ids ?? [])].filter(Boolean))];
          prior._conflicting_terminal_outcomes ??= [];
          if (`${prior.terminal_outcome}|${prior.canonical_target_id ?? prior.targetId ?? prior.canonicalName ?? ''}` !== `${outcome.terminal_outcome}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`) prior._conflicting_terminal_outcomes.push(outcome);
        }
        return records;
      }, new Map());
      const sourceRecordKeys = new Set((reconciliation.identity_outcomes ?? [])
        .map((outcome) => makeTerminalObservationKey(outcome.source_store, outcome.source_record_id))
        .filter(Boolean));
      const terminalsBySource = new Map();
      const missingSourceTerminals = [];
      for (const outcome of deduplicatedTerminalOutcomes.values()) {
        const sourceId = String(outcome.source_record_id ?? '').trim();
        if (!sourceId) { missingSourceTerminals.push(outcome); continue; }
        const sourceKey = makeTerminalObservationKey(outcome.source_store, sourceId);
        (terminalsBySource.get(sourceKey) ?? terminalsBySource.set(sourceKey, []).get(sourceKey)).push(outcome);
      }
      const conflictingTerminalRecords = [
        ...missingSourceTerminals.map((outcome) => ({ candidate: outcome.candidate ?? null, source_store: outcome.source_store ?? null, reason: 'missing_source_record_id' })),
        ...[...terminalsBySource.entries()].flatMap(([sourceKey, outcomes]) => {
          const distinct = new Set(outcomes.map((outcome) => `${outcome.terminal_outcome ?? ''}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`));
          return distinct.size > 1 ? [{ source_key: sourceKey, outcomes: [...distinct] }] : [];
        }),
      ];
      const finalTerminalRecords = [...terminalsBySource.values()]
        .filter((outcomes) => new Set(outcomes.map((outcome) => `${outcome.terminal_outcome ?? ''}|${outcome.canonical_target_id ?? outcome.targetId ?? outcome.canonicalName ?? ''}`)).size === 1)
        .map(([outcome]) => outcome);
      const finalTerminalKeys = new Set(finalTerminalRecords.map((outcome) => outcome.terminal_key ?? makeTerminalObservationKey(outcome.source_store, outcome.source_record_id)).filter(Boolean));
      const missingTerminalKeys = [...sourceRecordKeys].filter((key) => !finalTerminalKeys.has(key));
      const unexpectedTerminalKeys = [...finalTerminalKeys].filter((key) => !sourceRecordKeys.has(key));
      runResult.identityResolution.source_records_total = sourceRecordKeys.size;
      runResult.identityResolution.terminal_records_total = terminalsBySource.size;
      runResult.identityResolution.source_terminal_keys = [...sourceRecordKeys].slice(0, 100);
      runResult.identityResolution.final_terminal_keys = [...finalTerminalKeys].slice(0, 100);
      runResult.identityResolution.missing_terminal_keys = missingTerminalKeys.slice(0, 100);
      runResult.identityResolution.unexpected_terminal_keys = unexpectedTerminalKeys.slice(0, 100);
      runResult.identityResolution.duplicate_source_keys = [];
      runResult.identityResolution.duplicate_terminal_keys = [];
      runResult.identityResolution.terminal_reconciled = missingTerminalKeys.length === 0 && unexpectedTerminalKeys.length === 0 && conflictingTerminalRecords.length === 0;
      runResult.identityResolution.duplicate_terminal_records_removed = Math.max(0, (reconciliation.identity_outcomes ?? []).length - deduplicatedTerminalOutcomes.size);
      runResult.identityResolution.conflicting_terminal_records = conflictingTerminalRecords;
      runResult.identityResolutionDetails = {
        matched: reconciliation.matched.map(({ name, canonicalName, reason_code }) => ({ candidate: name, decision: 'matched', target: canonicalName, reason_code })),
        merged: reconciliation.merged.map(({ name, canonicalName, reason_code }) => ({ candidate: name, decision: 'merged', target: canonicalName, reason_code })),
        needs_review: reconciliation.skipped.map(({ name, reason, reason_code }) => ({ candidate: name, decision: 'needs_review', reason, reason_code })),
        unmatched: reconciliation.unmatched.map(({ name, reason, reason_code }) => ({ candidate: name, decision: 'unmatched', reason, reason_code })),
        // Initial extraction decisions may be useful for debugging, but only
        // these final terminal records determine completion quality.
        extraction_stage: [],
        final_reconciliation_stage: reconciliation.identity_outcomes ?? [],
        final_terminal_records: [...finalTerminalRecords.values()],
        terminal_outcomes: [...finalTerminalRecords.values()],
        target_selection_traces: reconciliation.target_selection_traces ?? [],
      };
      const logicalReviewItems = [...finalTerminalRecords.values()]
        .filter((outcome) => ['unsafe_identity_merge_rejected', 'exact_target_name_mismatch', 'stored_card_id_name_conflict'].includes(outcome.reason_code))
        .reduce((items, outcome) => {
          const sourceIdentity = outcome.source_card_id ?? outcome.source_persona_id ?? outcome.source_record_id;
          const targetIdentity = outcome.proposed_target_card_id ?? outcome.target_card_id ?? outcome.proposed_target_record_id ?? outcome.targetId ?? 'none';
          const key = `${sourceIdentity}::${targetIdentity}::${outcome.reason_code}`;
          const item = items.get(key) ?? {
            source_identity: sourceIdentity,
            proposed_target_identity: targetIdentity,
            reason_code: outcome.reason_code,
            affected_source_records: [], affected_stores: [], observation_count: 0,
          };
          item.observation_count++;
          item.affected_source_records.push(outcome.source_record_id);
          item.affected_stores.push(outcome.source_store);
          items.set(key, item);
          return items;
        }, new Map());
      runResult.identityResolution.logical_review_items = [...logicalReviewItems.values()].map((item) => ({
        ...item,
        affected_source_records: [...new Set(item.affected_source_records.filter(Boolean))],
        affected_stores: [...new Set(item.affected_stores.filter(Boolean))],
      }));
      runResult.finalReconciliation.persona_aliases_merged = reconciliation.merged.filter((entry) => entry.reason_code === 'unique_active_persona_first_name').length;
      runResult.finalReconciliation.card_local_entities_merged = reconciliation.card_local_reports?.reduce((count, report) => count + report.merged.length, 0) ?? 0;
      runResult.finalReconciliation.relationship_pairs_merged = (reconciliation.relationship_pairs_merged ?? 0) + reconciliation.merged.filter((entry) => entry.reason_code === 'canonical_duplicate_merge').length;
      // Count only records actually removed from durable storage; detecting or
      // renaming a review label is not equivalent to completing cleanup.
      runResult.finalReconciliation.synthetic_parentheticals_removed = reconciliation.durable_entities_removed ?? 0;
      runResult.finalReconciliation.identity_decision_duplicates_removed = reconciliation.identity_decision_duplicates_removed ?? 0;
      runResult.finalReconciliation.persona_roster_size = reconciliation.persona_roster_size ?? 0;
      runResult.finalReconciliation.participant_lists_rewritten = reconciliation.participant_lists_rewritten ?? 0;
      runResult.finalReconciliation.resolved_review_items_removed = reconciliation.resolved_review_items_removed ?? 0;
      runResult.finalReconciliation.integrity_audit = reconciliation.integrity_audit ?? null;
      runResult.finalReconciliation.duration_ms = reconciliation.duration_ms ?? null;
      runResult.finalReconciliation.stale_entity_references = reconciliation.integrity_audit?.stale_entity_references?.length ?? 0;
      runResult.finalReconciliation.unsafe_merge_candidates = reconciliation.integrity_audit?.unsafe_merge_candidates ?? 0;
      runResult.finalReconciliation.unsafe_merge_candidates_rejected = reconciliation.integrity_audit?.unsafe_merge_candidates_rejected ?? 0;
      runResult.finalReconciliation.safe_merge_candidates_completed = reconciliation.integrity_audit?.safe_merge_candidates_completed ?? 0;
      runResult.finalReconciliation.review_items_created = reconciliation.integrity_audit?.review_items_created ?? 0;
      runResult.identity_review.created_this_run = reconciliation.integrity_audit?.review_items_created ?? 0;
      runResult.identity_review.resolved_this_run = reconciliation.resolved_review_items_removed ?? 0;
      runResult.identity_review.removed_as_duplicate = reconciliation.identity_decision_duplicates_removed ?? 0;
      runResult.identity_review.remaining_at_end = reconciliation.integrity_audit?.identity_review_items ?? runResult.identity_review.existing_at_start;
      runResult.finalReconciliation.personaRosterSize = runResult.finalReconciliation.persona_roster_size;
      runResult.finalReconciliation.personaAliasesMerged = runResult.finalReconciliation.persona_aliases_merged;
      runResult.finalReconciliation.cardLocalEntitiesMerged = runResult.finalReconciliation.card_local_entities_merged;
      runResult.finalReconciliation.relationshipPairsMerged = runResult.finalReconciliation.relationship_pairs_merged;
      runResult.finalReconciliation.participantListsRewritten = runResult.finalReconciliation.participant_lists_rewritten;
      runResult.finalReconciliation.syntheticParentheticalsRemoved = runResult.finalReconciliation.synthetic_parentheticals_removed;
      // Finalize the one canonical arc outcome before evaluating quality.
      // Compatibility aliases are derived from it, never maintained as a
      // separately-updated second state.
      normalizeArcExtractionDiagnostics(runResult.arcExtraction);
      if (!runResult.arcExtraction.terminal_outcome && runResult.arcExtraction.request_completed > 0) {
        runResult.arcExtraction.terminal_outcome = runResult.arcExtraction.parsed_candidates > 0
          ? 'completed_with_candidates'
          : 'completed_no_candidates';
        runResult.arcExtraction.terminalOutcome = runResult.arcExtraction.terminal_outcome;
      }
      const qualityReasons = [];
      const sessionFailureRatio = runResult.sessionExtraction.emitted > 0
        ? runResult.sessionExtraction.missingProvenance / runResult.sessionExtraction.emitted
        : 0;
      const sessionTerminalTotal = Object.entries(runResult.sessionExtraction.terminalDispositions ?? {})
        // `provider_or_parser_error` can represent already-parsed candidates
        // whose later verification failed. `provider_returned_none` is only a
        // request-level outcome and therefore has no candidate to reconcile.
        .filter(([name]) => name !== 'provider_returned_none')
        .reduce((total, [, count]) => total + Number(count ?? 0), 0);
      runResult.sessionExtraction.terminalTotal = sessionTerminalTotal;
      runResult.sessionExtraction.terminalReconciled = sessionTerminalTotal === runResult.sessionExtraction.emitted;
      if (!runResult.sessionExtraction.terminalReconciled) qualityReasons.push({
        code: 'session_terminal_dispositions_unreconciled',
        tier: 'session',
        message: `${runResult.sessionExtraction.emitted} parsed candidates but ${sessionTerminalTotal} terminal dispositions.`,
      });
      if (sessionFailureRatio > 0.5) qualityReasons.push({
        code: 'session_provenance_quarantine_majority',
        tier: 'session',
        message: `${runResult.sessionExtraction.validated} validated, ${runResult.sessionExtraction.missingProvenance} quarantined for missing citations.`,
      });
      if (runResult.sessionExtraction.malformedOutput > 0) qualityReasons.push({
        code: 'session_malformed_provider_output',
        tier: 'session',
        message: `${runResult.sessionExtraction.malformedOutput} session extraction response${runResult.sessionExtraction.malformedOutput === 1 ? '' : 's'} contained no parseable structured records.`,
      });
      if (runResult.arcPipeline.classifiedResolved >= 2 && runResult.arcPipeline.persisted === 0) qualityReasons.push({
        code: 'resolved_arcs_without_persisted_summaries',
        tier: 'arcs',
        message: `${runResult.arcPipeline.classifiedResolved} arcs resolved but no summaries persisted.`,
      });
      if ((runResult.sceneDetection?.detection_failed ?? 0) > 0) qualityReasons.push({
        code: 'scene_detection_provider_failures',
        tier: 'scenes',
        message: `${runResult.sceneDetection.detection_failed} AI scene-break check${runResult.sceneDetection.detection_failed === 1 ? '' : 's'} failed; heuristic detection continued.`,
      });
      if (runResult.finalReconciliation.error) qualityReasons.push({
        code: 'final_reconciliation_failed',
        tier: 'identity',
        message: 'Final canonical reconciliation failed and was rolled back; validated tier data was preserved.',
      });
      if (runResult.profiles.relationship_conflicts_dropped > 0) qualityReasons.push({
        code: 'profile_relationship_conflicts_dropped',
        tier: 'profiles',
        message: `${runResult.profiles.relationship_conflicts_dropped} unsupported profile relationship field${runResult.profiles.relationship_conflicts_dropped === 1 ? '' : 's'} dropped; canonical values were preserved.`,
      });
      const identityFailures = runResult.identityResolution.logical_review_items?.length ?? 0;
      if (identityFailures > 0) qualityReasons.push({
        code: 'identity_reconciliation_failure_volume',
        tier: 'identity',
        message: `${identityFailures} unsafe identity merge pattern${identityFailures === 1 ? '' : 's'} blocked across ${runResult.identityResolution.logical_review_items.reduce((count, item) => count + item.observation_count, 0)} store observations.`,
      });
      if ((reconciliation.integrity_audit?.stale_entity_references?.length ?? 0) > 0) qualityReasons.push({
        code: 'stale_entity_references_remaining',
        tier: 'identity',
        count: reconciliation.integrity_audit.stale_entity_references.length,
        message: `${reconciliation.integrity_audit.stale_entity_references.length} entity reference${reconciliation.integrity_audit.stale_entity_references.length === 1 ? '' : 's'} remain after reconciliation.`,
      });
      if ((reconciliation.integrity_audit?.text_identity_mismatches?.length ?? 0) > 0) qualityReasons.push({
        code: 'text_identity_links_quarantined',
        tier: 'identity',
        message: `${reconciliation.integrity_audit.text_link_repair_counters?.unique_logical_links_repaired ?? reconciliation.integrity_audit.text_identity_mismatches.length} unique legacy entity link${(reconciliation.integrity_audit.text_link_repair_counters?.unique_logical_links_repaired ?? reconciliation.integrity_audit.text_identity_mismatches.length) === 1 ? '' : 's'} ${reconciliation.integrity_audit.text_link_repair_counters?.physical_repair_observations > 1 ? `were repaired across ${reconciliation.integrity_audit.text_link_repair_counters.physical_repair_observations} store observations.` : 'was repaired.'}`,
      });
      const repairs = runResult.sessionExtraction;
      const repairTerminalTotal = (repairs.repairAccepted ?? 0) + (repairs.repairProviderError ?? 0) + (repairs.repairReturnedNone ?? 0) + (repairs.repairMalformed ?? 0) + (repairs.repairStillInvalid ?? 0) + (repairs.repairSemanticallyUnsupported ?? 0);
      repairs.repairTerminalReconciled = repairTerminalTotal === (repairs.repairAttempts ?? 0) && (repairs.repairAttempts ?? 0) <= (repairs.repairEligible ?? 0);
      if (!repairs.repairTerminalReconciled) qualityReasons.push({
        code: 'session_citation_repair_counters_unreconciled',
        tier: 'session',
        message: `${repairs.repairAttempts ?? 0} citation-repair candidates but ${repairTerminalTotal} repair terminal outcomes.`,
      });
      const requiredIdentityInvariants = [
        // Keep snapshot capture, roster construction, and identity validity
        // separate. A historical avatar filename is an opaque stable key and
        // must never make a populated Aaron-style runtime snapshot look absent.
        ['active_persona_snapshot_present', Boolean(runResult.runtimeContext?.active_persona?.canonical_name), 'active_persona_snapshot_missing'],
        ['active_persona_roster_entry_present', !runResult.runtimeContext?.active_persona?.canonical_name || runResult.finalReconciliation.persona_roster_size > 0, 'active_persona_roster_entry_missing'],
        ['active_persona_stable_id_present', Boolean(runResult.runtimeContext?.active_persona?.stable_persona_id), 'active_persona_invalid'],
        ['deterministic_persona_aliases_resolved', !runResult.runtimeContext?.active_persona?.canonical_name || !(reconciliation.integrity_audit?.persona_aliases?.persona_aliases_unresolved), 'A deterministic active-persona alias remains unresolved.'],
        ['no_duplicate_canonical_entities', !(reconciliation.integrity_audit?.duplicate_canonical_entities?.length), 'Duplicate canonical entity records remain after reconciliation.'],
        ['relationship_pair_keys_canonical', !(reconciliation.integrity_audit?.relationship_pair_key_issues?.length), 'Relationship History contains a non-canonical pair key.'],
        ['relationship_history_integrity_completed', !(reconciliation.integrity_audit?.relationship_integrity_errors?.length), 'Relationship History integrity could not evaluate one or more pair keys.'],
        ['no_deterministic_synthetic_identities', !(reconciliation.integrity_audit?.synthetic_identity_remaining?.length), 'A deterministic synthetic parenthetical identity remains in durable storage.'],
        ['unsafe_identity_merge_blocked', !(reconciliation.integrity_audit?.blocked_unsafe_identity_merges?.length), 'An unsafe identity merge was blocked; the affected candidate remains separate for review.'],
        ['identity_terminal_totals_reconcile', runResult.identityResolution.terminal_reconciled, 'Final identity terminal records were duplicated or did not reconcile.'],
        ['review_records_deduplicated', !(reconciliation.integrity_audit?.duplicate_review_records?.length), 'Duplicate identity review records remain.'],
        ['session_dispositions_reconcile', runResult.sessionExtraction.terminalReconciled, 'Session candidate terminal dispositions did not reconcile.'],
        ['arc_extraction_terminal_outcome_present', !settings.arcs_enabled || Boolean(runResult.arcExtraction.terminalOutcome), 'Arc extraction has no terminal diagnostic outcome.'],
        ['required_profile_generation_completed', !settings.profiles_enabled || (runResult.profiles?.profiles_saved ?? 0) > 0 || catchUpErrorCount > 0, 'Profile generation did not produce a saved profile.'],
        ['integrity_audit_consistent', ['clean', 'repaired', 'degraded', 'unsafe', 'failed'].includes(reconciliation.integrity_audit?.status), 'Integrity audit returned an invalid status.'],
      ];
      for (const [code, passed, message] of requiredIdentityInvariants) {
        if (!passed) qualityReasons.push({ code, tier: 'identity', message });
      }
      runResult.quality = { status: qualityReasons.length ? 'degraded' : 'clean', reasons: qualityReasons };
      await runNonfatalPresentationTask('Unified memory injection', () => maybeInjectUnified());
      await runNonfatalPresentationTask('Token usage refresh', () => updateTokenDisplay());
      saveSettingsDebounced();

      // Persist the final diagnostics with the same staged commit. The status
      // is a pre-commit projection; a failed final commit is then recorded and
      // reflected in the user-visible completion status below.
      const projectedStatus = ctrl.catchUpCancelled
        ? 'cancelled'
        : catchUpErrorCount > 0
          ? (runResult.completedChunks === 0 && runResult.failedChunks > 0 ? 'failed' : 'partial')
          : 'completed';
      // Compact exportable diagnostics deliberately exclude chat text and raw provider output while retaining run-level failure information.
      const diagnostics = {
        version: 1,
        created_at: Date.now(),
        status: projectedStatus,
        operational_status: projectedStatus,
        chunks: runResult.chunks,
        sceneDetection: runResult.sceneDetection ?? null,
        tiers: runResult.extractionFailuresByTier,
        identityResolution: runResult.identityResolution ?? null,
        identityResolutionDetails: runResult.identityResolutionDetails ?? null,
        persistence_failures: runResult.saveFailures,
        retried_requests: runResult.retriedRequests,
        errors: catchUpErrorCount,
        error_details: runResult.errors,
        warnings: runResult.warnings,
        warnings_suppressed: runResult.warningsSuppressed,
        parser_debris_cleanup: catchUpContext.chatMetadata?.[META_KEY]?.parser_debris_cleanup ?? null,
        arc_summary_verification: summarizeArcSummaryVerification(loadArcSummaries()),
        arcResolution: runResult.arcResolution,
        arcExtraction: runResult.arcExtraction,
        arcPipeline: runResult.arcPipeline,
        provider_failures: runResult.providerFailures,
        sessionExtraction: runResult.sessionExtraction,
        profiles: runResult.profiles,
        finalReconciliation: runResult.finalReconciliation,
        runtime_context: runResult.runtimeContext,
        quality: runResult.quality,
      };
      if (!catchUpContext.chatMetadata) catchUpContext.chatMetadata = {};
      if (!catchUpContext.chatMetadata[META_KEY]) catchUpContext.chatMetadata[META_KEY] = {};
      catchUpContext.chatMetadata[META_KEY].catch_up_diagnostics = diagnostics;
      latestExportDiagnostics = diagnostics;
      try {
        await retryTransientMemoryOperation(() => commitCatchUpTransaction(finalTransaction));
      } catch (err) {
        recordCatchUpError('final persistence error', err, null, true);
        diagnostics.status = 'partial';
        diagnostics.operational_status = 'partial';
        diagnostics.errors = catchUpErrorCount;
        diagnostics.persistence_failures = runResult.saveFailures;
        diagnostics.error_details = runResult.errors;
        diagnostics.final_persistence_error = String(err?.message ?? err ?? 'Unknown persistence error').replace(/\s+/g, ' ').slice(0, 300);
        // The transaction rollback removes saved metadata, but this session
        // copy remains available through Export Diagnostics.
        latestExportDiagnostics = diagnostics;
      } finally {
        finalTransaction = null;
      }

      if (ctrl.catchUpCancelled) {
        runResult.status = 'cancelled';
        setStatusMessage('Catch-up cancelled.');
        toastr.warning('Catch-up cancelled. Partial results have been saved.', 'Smart Memory Enhanced', {
          timeOut: 5000,
          positionClass: 'toast-bottom-right',
        });
      } else if (catchUpErrorCount > 0) {
        runResult.status = runResult.completedChunks === 0 && runResult.failedChunks > 0 ? 'failed' : 'partial';
        const persistenceDetail = runResult.saveFailures > 0
          ? `, ${runResult.saveFailures} persistence failure${runResult.saveFailures === 1 ? '' : 's'}`
          : '';
        const lateStageLabels = [...new Set(runResult.errors
          .map((entry) => entry.label)
          .filter((label) => !/\(chunk\)|chunk persistence/i.test(label)))];
        const lateStageDetail = lateStageLabels.length
          ? ` Late-stage failure${lateStageLabels.length === 1 ? '' : 's'}: ${lateStageLabels.join('; ')}.`
          : '';
        setStatusMessage(
          `Catch-up ${runResult.status}: ${runResult.completedChunks}/${runResult.totalChunks} chunks completed, ${runResult.failedChunks} failed${persistenceDetail}.${lateStageDetail}`,
        );
        toastr.warning(
          `Catch-up ${runResult.status}. ${runResult.failedChunks} chunk${runResult.failedChunks === 1 ? '' : 's'} failed${persistenceDetail} after ${runResult.retriedRequests} retr${runResult.retriedRequests === 1 ? 'y' : 'ies'}.${lateStageDetail}`,
          'Smart Memory Enhanced',
          { timeOut: 8000, positionClass: 'toast-bottom-right' },
        );
      } else {
        const sceneAudit = runResult.sceneDetection;
        const sceneSummary = sceneAudit
          ? ` Scenes: ${sceneAudit.candidates} detected, ${sceneAudit.generated} generated, ${sceneAudit.duplicates} duplicates, ${sceneAudit.failed} failed, ${sceneAudit.retained} archived, ${sceneAudit.injected} injected.`
          : '';
        const qualityDetail = runResult.quality.status === 'degraded'
          ? ` Data quality degraded: ${runResult.quality.reasons.map((reason) => reason.message).join(' ')}`
          : '';
        setStatusMessage(`Catch-up complete.${qualityDetail}${sceneSummary}`);
        const notifier = runResult.quality.status === 'degraded' ? toastr.warning : toastr.success;
        notifier(`Full catch-up extraction finished.${qualityDetail}${sceneSummary}`, 'Smart Memory Enhanced', {
          timeOut: runResult.quality.status === 'degraded' ? 8000 : 4000,
          positionClass: 'toast-bottom-right',
        });
      }
      $('#sme_export_diagnostics').prop('disabled', false);
    } catch (err) {
      if (finalTransaction) rollbackCatchUpTransaction(finalTransaction);
      recordCatchUpError('run failure', err);
      showError('Catch-up', err);
      setStatusMessage('Catch-up failed.');
    } finally {
      clearCanonicalRuntimeContextSnapshot();
      unsubscribeRetry();
      $('#sme_cancel_catch_up').hide();
      $('#sme_catch_up').show();
      ctrl.extractionRunning = false;
      ctrl.compactionRunning = false;
      ctrl.catchUpCancelled = false;
    }
  });

  $('#sme_cancel_catch_up').on('click', function () {
    ctrl.catchUpCancelled = true;
    $(this).prop('disabled', true);
    setStatusMessage('Cancelling...');
  });

  // ---- Clear Chat Context ---------------------------------------------
  $('#sme_clear_chat_context').on('click', async function () {
    if (isCatchUpRunning()) return;
    if (
      !(await callGenericPopup(
        'Clear all Smart Memory Enhanced context for this chat?\n\nPerspectives & Secrets entries are also cleared.\nLong-term memories, relationship history, state cards, canon, and pinned arcs are not affected.',
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;

    const characterName = ctrl.getSelectedCharacterName();
    const context = getContext();
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    try {
      await runStagedChatCleanup(context, async () => {
        // Wipe short-term summary state.
        delete context.chatMetadata[META_KEY].summary;
        delete context.chatMetadata[META_KEY].summaryEnd;
        delete context.chatMetadata[META_KEY].summaryUpdated;

        // Clear the other chat-scoped tiers.
        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearSceneHistory();
        await clearArcs();
        await clearArcSummaries();
        await clearProfiles();
        // Chat-Local Only stores are part of this chat, not reusable character
        // history. Forget This Chat must remove them for every group member.
        clearChatLocalCharacterData(context);
        // Epistemic knowledge is extension_settings-scoped (persists across chats)
        // and is intentionally NOT cleared here - same reasoning as state ledger.
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Forget This Chat persistence failed:', err);
      setStatusMessage('Chat context was not cleared because the chat could not be saved.');
      toastr.error('Could not save the cleared chat context. Please try again.', 'Smart Memory Enhanced');
      return;
    }

    // Clearing chatMetadata means loadAndInjectSummary will clear the slot.
    loadAndInjectSummary();
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectProfiles(characterName);
    injectStateLedger();
    injectEpistemicKnowledge(characterName, characterName);

    updateShortTermUI(null);
    updateEpistemicUI(characterName);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateProfilesUI(null);
    updateEntityPanel(characterName);
    updateTokenDisplay();
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
    setCatchUpErrorCount(0);
    setStatusMessage('Chat context cleared.');
  });

  // ---- Fresh Start ----------------------------------------------------
  $('#sme_fresh_start_button').on('click', async function () {
    if (isCatchUpRunning()) return;
    const characterName = ctrl.getSelectedCharacterName();
    const freshStartContext = getContext();
    const freshStartCharacterNames = (() => {
      if (!freshStartContext.groupId) return characterName ? [characterName] : [];
      const group = freshStartContext.groups?.find((entry) => entry.id === freshStartContext.groupId);
      if (!group) return characterName ? [characterName] : [];
      return group.members
        .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
        .map((avatar) => freshStartContext.characters.find((card) => card.avatar === avatar)?.name)
        .filter(Boolean);
    })();
    const nameLabel = freshStartCharacterNames.length > 1
      ? `${freshStartCharacterNames.length} active group characters`
      : characterName ? `"${characterName}"` : 'this character';
    if (
      !(await callGenericPopup(
        `Fresh Start for ${nameLabel} - this will permanently delete all Smart Memory Enhanced data for this character and chat.\n\nThis cannot be undone. Continue?`,
        POPUP_TYPE.CONFIRM,
      ))
    )
      return;

    // Clear all chat-scoped tiers.
    const context = freshStartContext;
    if (!context.chatMetadata) context.chatMetadata = {};
    if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
    try {
      await runStagedChatCleanup(context, async () => {
        // Group token rows represent every active member's personal stores.
        // Fresh Start therefore clears each active member, not merely the
        // card currently selected in the settings selector.
        for (const memberName of freshStartCharacterNames) {
          clearCharacterMemories(memberName);
          clearRelationshipHistory(memberName);
          clearEpistemicKnowledge(memberName);
          clearCanon(memberName);
          await clearProfiles(memberName);
        }

        delete context.chatMetadata[META_KEY].summary;
        delete context.chatMetadata[META_KEY].summaryEnd;
        delete context.chatMetadata[META_KEY].summaryUpdated;
        delete context.chatMetadata[META_KEY].lastExtractCutoff;

        await clearSessionMemories();
        await clearSessionEntityRegistry();
        await clearSceneHistory();
        await clearArcs();
        await clearArcSummaries();
        await clearStateLedger();
        // These stores belong to this chat, so keeping another group
        // member's local data would leave an apparently uncleared bar.
        clearChatLocalCharacterData(context);
      });
    } catch (err) {
      console.error('[Smart Memory Enhanced] Fresh Start persistence failed:', err);
      setStatusMessage('Fresh Start was not saved. Nothing was cleared. Please try again.');
      toastr.error('Could not save Fresh Start. Nothing was cleared.', 'Smart Memory Enhanced');
      return;
    }
    // Character-scoped stores live in extension settings. Do not schedule that
    // separate persistence write until the chat transaction has committed.
    if (freshStartCharacterNames.length) saveSettingsDebounced();
    // Dismiss any open recap modal.
    $('#sme_recap_overlay').remove();

    // Clear all injection slots.
    loadAndInjectSummary();
    await injectMemories(characterName);
    injectRelationshipHistory(characterName);
    injectSessionMemories();
    injectSceneHistory();
    injectArcs();
    injectEpistemicKnowledge(characterName, characterName);
    injectCanon(characterName);
    injectProfiles(characterName);
    injectStateLedger();

    updateShortTermUI(null);
    updateLongTermUI(characterName);
    updateRelationshipHistoryUI(characterName);
    updateEpistemicUI(characterName);
    updateFreshStartUI(isFreshStart());
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateCanonUI(characterName);
    updateProfilesUI(null);
    updateTokenDisplay();
    ctrl.sceneMessageBuffer = [];
    ctrl.sceneBufferLastIndex = -1;
    setCatchUpErrorCount(0);
    setStatusMessage('Fresh start complete.');
    toastr.success(`All memories cleared for ${nameLabel}.`, 'Smart Memory Enhanced', {
      timeOut: 4000,
      positionClass: 'toast-bottom-right',
    });
  });

  // ---- Embedding deduplication ----------------------------------------

  /**
   * Shows or hides source-specific UI elements based on the current embedding_source setting.
   * Ollama shows the model dropdown + refresh button + keep-in-memory.
   * OpenAI Compatible shows a plain model text field and hides Ollama-only controls.
   */
  function applyEmbeddingSourceUI() {
    const src = extension_settings[MODULE_NAME].embedding_source ?? 'ollama';
    const isOllama = src === 'ollama';
    $('#sme_embedding_model_ollama_row').toggle(isOllama);
    $('#sme_embedding_model_openai_row').toggle(!isOllama);
    $('#sme_embedding_api_key_row').toggle(!isOllama);
    $('#sme_embedding_keep_row').toggle(isOllama);
    $('#sme_embedding_install_hint_ollama').toggle(isOllama);
    $('#sme_embedding_install_hint_openai').toggle(!isOllama);
    if (!isOllama) {
      // Sync the OpenAI model text field with the stored setting.
      $('#sme_embedding_model_openai').val(extension_settings[MODULE_NAME].embedding_model ?? '');
      // Show whether a key is stored - never populate the field with the actual value.
      $('#sme_embedding_api_key')
        .val('')
        .attr('placeholder', hasEmbeddingApiKey() ? '(key stored)' : 'sk-...');
    }
  }

  $('#sme_embedding_enabled')
    .prop('checked', s.embedding_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_enabled = $(this).prop('checked');
      $('#sme_embedding_config').toggle(extension_settings[MODULE_NAME].embedding_enabled);
      // Reset failure flag so the next attempt gets a clean slate.
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
    });
  $('#sme_embedding_config').toggle(s.embedding_enabled);

  $('#sme_embedding_source')
    .val(s.embedding_source ?? 'ollama')
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_source = $(this).val();
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      applyEmbeddingSourceUI();
      saveSettingsDebounced();
      if (extension_settings[MODULE_NAME].embedding_source === 'ollama') {
        refreshEmbeddingModels();
      }
    });

  $('#sme_embedding_url')
    .val(s.embedding_url ?? '')
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_url = $(this).val().trim();
      clearEmbeddingFailed();
      $('#sme_embedding_test_result').text('');
      updateEmbeddingNotice();
      saveSettingsDebounced();
      if ((extension_settings[MODULE_NAME].embedding_source ?? 'ollama') === 'ollama') {
        refreshEmbeddingModels();
      }
    });

  // Embedding model dropdown - saves on selection change.
  $('#sme_embedding_model').on('change', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // Manual text fallback - shown when Ollama is not reachable from the browser.
  $('#sme_embedding_model_manual').on('input', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val().trim();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // OpenAI Compatible model text field.
  $('#sme_embedding_model_openai').on('input', function () {
    extension_settings[MODULE_NAME].embedding_model = $(this).val().trim();
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
    updateEmbeddingNotice();
    saveSettingsDebounced();
  });

  // OpenAI Compatible embedding API key field - stored in extension_settings.
  $('#sme_embedding_api_key').on('change', function () {
    const value = $(this).val().trim();
    saveEmbeddingApiKey(value);
    $(this)
      .val('')
      .attr('placeholder', hasEmbeddingApiKey() ? '(key stored)' : 'sk-...');
    clearEmbeddingFailed();
    $('#sme_embedding_test_result').text('');
  });

  applyEmbeddingSourceUI();

  // Refresh button and auto-load on settings open (Ollama only).
  $('#sme_embedding_refresh').on('click', () => refreshEmbeddingModels());
  if (s.embedding_enabled && (s.embedding_source ?? 'ollama') === 'ollama') {
    refreshEmbeddingModels();
  }

  $('#sme_embedding_keep')
    .prop('checked', s.embedding_keep)
    .on('change', function () {
      extension_settings[MODULE_NAME].embedding_keep = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_embedding_test').on('click', async function () {
    const $btn = $(this);
    const $result = $('#sme_embedding_test_result');
    $btn.prop('disabled', true);
    $result.text('Testing...');
    try {
      const map = await getEmbeddingBatch(['smart memory test']);
      if (map.size > 0) {
        $result.html('<span style="color: var(--green, #5a8)">Connected</span>');
        clearEmbeddingFailed();
        updateEmbeddingNotice();
      } else {
        $result.html(
          '<span style="color: var(--warning, #ca6)">No response - check URL and model name</span>',
        );
      }
    } catch {
      $result.html(
        '<span style="color: var(--warning, #ca6)">Connection failed - is Ollama running?</span>',
      );
    } finally {
      $btn.prop('disabled', false);
    }
  });

  // "Set up embeddings" link in the notice scrolls to the dedup section.
  $('#sme_embedding_notice_link').on('click', function (e) {
    e.preventDefault();
    const $dedup = $('#sme_embedding_enabled').closest('details');
    if ($dedup.length) {
      $dedup.prop('open', true);
      $dedup[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  updateEmbeddingNotice();

  // ---- Profiles -------------------------------------------------------
  $('#sme_profiles_enabled')
    .prop('checked', s.profiles_enabled)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_enabled = $(this).prop('checked');
      saveSettingsDebounced();
      if (!extension_settings[MODULE_NAME].profiles_enabled) {
        setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
        updateTokenDisplay();
      } else {
        injectProfiles(ctrl.getSelectedCharacterName());
      }
    });

  const $profilesThresholdVal = $('#sme_profiles_stale_threshold_value');
  const formatProfilesThreshold = (v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`);
  $profilesThresholdVal.text(formatProfilesThreshold(s.profiles_stale_threshold_minutes ?? 30));
  $('#sme_profiles_stale_threshold')
    .val(s.profiles_stale_threshold_minutes ?? 30)
    .on('input', function () {
      const v = Number($(this).val());
      $profilesThresholdVal.text(formatProfilesThreshold(v));
      extension_settings[MODULE_NAME].profiles_stale_threshold_minutes = v;
      saveSettingsDebounced();
    });

  const $regenEveryVal = $('#sme_profiles_regen_every_value');
  const formatRegenEvery = (v) => (v === 0 ? 'extraction only' : `${v} msg${v === 1 ? '' : 's'}`);
  $regenEveryVal.text(formatRegenEvery(s.profiles_regen_every ?? 0));
  $('#sme_profiles_regen_every')
    .val(s.profiles_regen_every ?? 0)
    .on('input', function () {
      const v = Number($(this).val());
      $regenEveryVal.text(formatRegenEvery(v));
      extension_settings[MODULE_NAME].profiles_regen_every = v;
      saveSettingsDebounced();
    });

  $('#sme_profiles_regenerate').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    if (!characterName) {
      toastr.warning('No active character - profiles need a character.', 'Smart Memory Enhanced', {
        timeOut: 3000,
        positionClass: 'toast-bottom-right',
      });
      return;
    }
    $(this).prop('disabled', true);
    setStatusMessage('Generating profiles...');
    try {
      const profiles = await generateProfiles(characterName);
      if (profiles) {
        injectProfiles(characterName);
        updateProfilesUI(profiles);
        setStatusMessage('Profiles updated.');
      } else {
        setStatusMessage('Profile generation returned no output.');
      }
    } catch (err) {
      showError('Profile generation', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  const $profilesBudgetVal = $('#sme_profiles_inject_budget_value');
  $('#sme_profiles_inject_budget')
    .val(s.profiles_inject_budget ?? 400)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      extension_settings[MODULE_NAME].profiles_inject_budget = val;
      $profilesBudgetVal.text(val + ' tokens');
      saveSettingsDebounced();
      reinjectAfterBudgetChange(ctrl.getSelectedCharacterName());
    });
  $profilesBudgetVal.text((s.profiles_inject_budget ?? 400) + ' tokens');

  const currentProfilesPosition = s.profiles_position ?? extension_prompt_types.IN_PROMPT;
  $(`input[name="sme_profiles_position"][value="${currentProfilesPosition}"]`).prop('checked', true);
  $('input[name="sme_profiles_position"]').on('change', function () {
    extension_settings[MODULE_NAME].profiles_position = parseInt($(this).val(), 10);
    saveSettingsDebounced();
    injectProfiles(ctrl.getSelectedCharacterName());
  });

  $('#sme_profiles_depth')
    .val(s.profiles_depth ?? 1)
    .on('input', function () {
      extension_settings[MODULE_NAME].profiles_depth = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  $('#sme_profiles_role')
    .val(s.profiles_role ?? extension_prompt_roles.SYSTEM)
    .on('change', function () {
      extension_settings[MODULE_NAME].profiles_role = parseInt($(this).val(), 10);
      saveSettingsDebounced();
      injectProfiles(ctrl.getSelectedCharacterName());
    });

  updateProfilesUI(loadProfiles(ctrl.getSelectedCharacterName()));

  // ---- Entity graph -------------------------------------------------------
  $('#sme_open_graph_btn').on('click', () => {
    showMemoryGraph(ctrl.getSelectedCharacterName());
  });

  // ---- Continuity checker ---------------------------------------------
  $('#sme_auto_check')
    .prop('checked', s.continuity_auto_check)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_check = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_auto_repair')
    .prop('checked', s.continuity_auto_repair)
    .on('change', function () {
      extension_settings[MODULE_NAME].continuity_auto_repair = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Notifications --------------------------------------------------
  $('#sme_show_activity_indicator')
    .prop('checked', s.show_activity_indicator ?? true)
    .on('change', function () {
      extension_settings[MODULE_NAME].show_activity_indicator = $(this).prop('checked');
      saveSettingsDebounced();
    });

  // ---- Developer / debug ----------------------------------------------
  $('#sme_verbose_logging')
    .prop('checked', s.verbose_logging)
    .on('change', function () {
      extension_settings[MODULE_NAME].verbose_logging = $(this).prop('checked');
      saveSettingsDebounced();
    });

  $('#sme_auto_tune_budgets')
    .prop('checked', s.auto_tune_budgets ?? false)
    .on('change', function () {
      extension_settings[MODULE_NAME].auto_tune_budgets = $(this).prop('checked');
      saveSettingsDebounced();
      if ($(this).prop('checked')) autoTuneBudgets(ctrl.getSelectedCharacterName());
    });

  // Hides per-tier injection position/depth/role blocks when either unified
  // injection or macro mode is active - those controls have no effect in either mode.
  // Budget and template blocks stay visible: they still affect content trimming and
  // formatting even when placement is handled externally.
  function applyInjectionOverrideUI() {
    const cur = extension_settings[MODULE_NAME];
    const unified = cur.unified_injection ?? false;
    const macros = cur.macros_enabled ?? false;
    const hide = unified || macros;
    const advanced = (cur.settings_mode ?? 'simple') === 'advanced';
    // Per-tier position/depth/role blocks are advanced-only and hidden by override modes.
    // Both conditions must be met to show them: advanced mode on and no override active.
    // Exclude sme_unified_position - it belongs to the unified block's own settings.
    $('[name$="_position"]:not([name="sme_unified_position"]), #sme_longterm_triggered_depth')
      .closest('.sm-block')
      .toggle(!hide && advanced);
    // Unified sub-settings are only relevant when unified injection is on,
    // macro mode is off, and advanced mode is active.
    $('#sme_unified_settings').toggle(unified && !macros && advanced);
  }

  $('#sme_unified_injection')
    .prop('checked', s.unified_injection ?? false)
    .on('change', function () {
      const enabled = $(this).prop('checked');
      extension_settings[MODULE_NAME].unified_injection = enabled;
      saveSettingsDebounced();
      applyInjectionOverrideUI();
      if (enabled) {
        injectUnified();
      } else {
        // Restore individual slots from stored data so the normal path
        // resumes immediately without waiting for the next generation.
        const characterName = ctrl.getSelectedCharacterName();
        clearUnifiedSlot();
        const summary = loadAndInjectSummary();
        updateShortTermUI(summary);
        injectMemories(characterName);
        injectSessionMemories();
        injectSceneHistory();
        injectArcs();
        injectCanon(characterName);
        injectProfiles(characterName);
      }
      updateTokenDisplay();
    });
  $('[name="sme_unified_position"]')
    .filter(`[value="${s.unified_position ?? 2}"]`)
    .prop('checked', true);
  $('[name="sme_unified_position"]').on('change', function () {
    extension_settings[MODULE_NAME].unified_position = Number($(this).val());
    saveSettingsDebounced();
    maybeInjectUnified();
  });

  $('#sme_unified_depth')
    .val(s.unified_depth ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].unified_depth = Number($(this).val());
      saveSettingsDebounced();
      maybeInjectUnified();
    });

  $('#sme_unified_role')
    .val(s.unified_role ?? 0)
    .on('change', function () {
      extension_settings[MODULE_NAME].unified_role = Number($(this).val());
      saveSettingsDebounced();
      maybeInjectUnified();
    });

  const refreshPeriod = s.injection_refresh_period ?? 1;
  $('#sme_injection_refresh_period')
    .val(refreshPeriod)
    .on('input', function () {
      const val = parseInt($(this).val(), 10);
      $('#sme_injection_refresh_period_value').text(val);
      extension_settings[MODULE_NAME].injection_refresh_period = val;
      saveSettingsDebounced();
    });
  $('#sme_injection_refresh_period_value').text(refreshPeriod);

  $('#sme_macros_enabled')
    .prop('checked', s.macros_enabled ?? false)
    .on('change', function () {
      const enabled = $(this).prop('checked');
      extension_settings[MODULE_NAME].macros_enabled = enabled;
      saveSettingsDebounced();
      applyInjectionOverrideUI();
    });
  applyInjectionOverrideUI();

  $('#sme_check_continuity').on('click', async function () {
    const characterName = ctrl.getSelectedCharacterName();
    $(this).prop('disabled', true);
    setStatusMessage('Checking continuity...');
    $('#sme_continuity_result').hide().empty();
    try {
      const contradictions = await checkContinuity(characterName);
      if (contradictions.length === 0) {
        $('#sme_continuity_result')
          .addClass('sme_continuity_clean')
          .removeClass('sme_continuity_warn')
          .text('No contradictions found.')
          .show();
        setStatusMessage('Continuity OK.');
      } else {
        const $result = $('#sme_continuity_result')
          .addClass('sme_continuity_warn')
          .removeClass('sme_continuity_clean');
        $result.empty();
        $result.append('<b>Contradictions found:</b>');
        const $ul = $('<ul>');
        contradictions.forEach((c) => $ul.append($('<li>').text(c)));
        $result.append($ul).show();
        setStatusMessage(
          `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found.`,
        );

        // If auto-repair is on, generate a corrective note and inject it for
        // the next AI turn. The note is cleared automatically once that response
        // is rendered by onCharacterMessageRendered.
        if (extension_settings[MODULE_NAME].continuity_auto_repair) {
          setStatusMessage('Generating repair...');
          try {
            const note = await generateRepair(contradictions, characterName);
            injectRepair(note);
            const $repairBlock = $('<div class="sme_repair_queued">');
            $repairBlock.append($('<p>').text('Correction queued for next response:'));
            $repairBlock.append($('<p class="sme_repair_note">').text(note));
            const $cancel = $(
              '<button class="menu_button sme_repair_cancel">Cancel correction</button>',
            );
            $cancel.on('click', () => {
              clearRepair();
              $repairBlock.remove();
              setStatusMessage('Correction cancelled.');
            });
            $repairBlock.append($cancel);
            $result.append($repairBlock);
            setStatusMessage('Correction queued.');
            toastr.info('Correction queued for next response.', 'Smart Memory Enhanced');
          } catch (repairErr) {
            console.error('[Smart Memory Enhanced] Repair generation failed:', repairErr);
            setStatusMessage('Repair failed - see console.');
          }
        }
      }
    } catch (err) {
      showError('Continuity check', err);
      setStatusMessage('');
    } finally {
      $(this).prop('disabled', false);
    }
  });

  $('#sme_about').on('click', async function () {
    // Populate version from manifest.json so it stays in sync automatically.
    try {
      const manifest = await fetch(
        '/scripts/extensions/third-party/Smart-Memory/manifest.json',
      ).then((r) => r.json());
      $('#sme_about_version').text(manifest.version ?? '');
    } catch {
      $('#sme_about_version').text('');
    }
    const $modal = $('#sme_about_modal').clone().show();
    // Remove IDs from the clone so they do not duplicate the hidden template's IDs in the DOM.
    $modal.find('[id]').addBack('[id]').removeAttr('id');
    await callGenericPopup($modal[0], POPUP_TYPE.DISPLAY, '', {
      wide: false,
      large: false,
    });
  });
}

function summarizeArcSummaryVerification(summaries = []) {
  const result = { total: summaries.length, supported: 0, pending_review: 0, rejected: 0, legacy_unverified: 0, preverification: {} };
  for (const summary of summaries) {
    if (summary.validation_status === 'approved' || summary.semantic_support === 'supported' || summary.semantic_support === 'user_approved') result.supported++;
    else if (summary.validation_status === 'rejected' || summary.semantic_support === 'unsupported') result.rejected++;
    else result.pending_review++;
    if (summary.verification_state === 'legacy_unverified') result.legacy_unverified++;
    if (summary.deterministic_rejection_reason) {
      result.preverification[summary.deterministic_rejection_reason] = (result.preverification[summary.deterministic_rejection_reason] ?? 0) + 1;
    }
  }
  return result;
}
