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
 * Stateful character and world profiles regenerated from graph state.
 *
 * Profiles are compact snapshots injected every turn at low token cost as stable
 * anchors for the AI. They are regenerated from stored memories on a schedule
 * so they stay coherent even after compaction removes older messages. A tightly
 * bounded raw-chat check may additionally validate explicit speaker-relative
 * relationship facts; raw prose is never otherwise used as profile content.
 * Profile generation is a single sequential model call that produces all three
 * sections at once to minimise round-trips on local hardware.
 *
 * Stored in chatMetadata.smartMemoryEnhanced.profiles as a per-character map:
 *   { [characterName]: { character_state, world_state, relationship_matrix, generated_at } }
 *
 * In group chats each member has their own entry so switching the character
 * selector in the settings panel shows the correct character's profile.
 *
 * loadProfiles         - returns stored profiles for a character from chatMetadata (null if none)
 * areProfilesStale     - true if a character's profiles are older than the configured threshold
 * generateProfiles     - calls the model and saves the result; returns the profiles
 * injectProfiles       - pushes the specified character's profiles into the prompt
 * clearProfiles        - removes stored profiles and clears the injection slot
 */

import {
  setExtensionPrompt,
  extension_prompt_types,
  extension_prompt_roles,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { saveChatMetadata } from './catchup-transaction.js';
import { generateMemoryExtract } from './generate.js';
import { applyPromptOverride, PROMPT_TASKS } from './prompt-config.js';
import { estimateTokens, MODULE_NAME, META_KEY, PROMPT_KEY_PROFILES } from './constants.js';
import { CHARACTER_MEMORY_POLICIES, getCharacterMemoryPolicy, loadCharacterMemories, loadRelationshipHistory, formatMemoriesForPrompt } from './longterm.js';
import { loadSessionMemories } from './session.js';
import { loadSceneHistory } from './scenes.js';
import { loadStateLedger } from './state-ledger.js';
import { loadCharacterEntityRegistry } from './graph-migration.js';
import { buildProfileFormatRepairPrompt, buildProfileGenerationPrompt } from './prompts.js';
import { parseProfileOutput } from './parsers.js';
import { smLog } from './logging.js';
import { invalidateUnifiedCache } from './unified-inject.js';
import { buildCanonicalCharacterRoster, canonicalizeNarrativeNames, deduplicateIdentityDecisions, formatCanonicalRosterForPrompt, getCanonicalRosterPeople, resolveCanonicalCharacterName } from './canonical-entities.js';
import { MACRO_NAMES, setMacroContent, isMacroActive } from './macros.js';
import { reportTierTrimStats } from './trim-stats.js';
import { isGeneratedRecordApproved, validateGeneratedRecord } from './record-validation.js';
import { validateCitationSemanticSupport } from './grounding.js';
import {
  CANONICAL_RELATIONSHIP_ROLE_TOKENS,
  extractExplicitNamedFamilyCandidates,
  migrateProfileRoleDescriptorSeparation,
  mergeRelationshipPairEvidence,
  normalizeRelationshipDescriptors,
  relationshipTypeForProfileTarget,
  renderRelationshipMatrixLine,
} from './profile-role-utils.js';

export { CANONICAL_RELATIONSHIP_ROLE_TOKENS, migrateProfileRoleDescriptorSeparation };

// Default staleness threshold: 30 minutes. Profiles generated within this
// window are considered current and will not be regenerated on chat load.
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000;
// ---- Storage ------------------------------------------------------------

/**
 * Returns stored profiles for the given character from chatMetadata, or null if none exist yet.
 * @param {string} characterName
 * @returns {{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}|null}
 */
export function loadProfiles(characterName) {
  if (!characterName) return null;
  const context = getContext();
  const stored = context.chatMetadata?.[META_KEY]?.profiles?.[characterName] ?? null;
  return stored ? migrateProfileRoleDescriptorSeparation(stored).profile : null;
}

/**
 * Persists profiles for the given character to chatMetadata.
 * @param {{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}} profiles
 * @param {string} characterName
 */
async function saveProfiles(profiles, characterName) {
  if (!characterName) return;
  if ([CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return;
  const context = getContext();
  if (!context.chatMetadata) context.chatMetadata = {};
  if (!context.chatMetadata[META_KEY]) context.chatMetadata[META_KEY] = {};
  if (!context.chatMetadata[META_KEY].profiles) context.chatMetadata[META_KEY].profiles = {};
  context.chatMetadata[META_KEY].profiles[characterName] = migrateProfileRoleDescriptorSeparation(profiles).profile;
  await saveChatMetadata(context);
}

export async function reconcileProfileCanonicalNames(characterName) {
  const profiles = loadProfiles(characterName);
  if (!profiles) return false;
  const roster = buildCanonicalCharacterRoster(getContext());
  const next = { ...profiles };
  const replacements = [];
  for (const field of ['character_state', 'world_state', 'relationship_matrix']) {
    const narrative = canonicalizeNarrativeNames(next[field], roster);
    next[field] = narrative.text;
    replacements.push(...narrative.replacements);
  }
  const matrix = String(next.relationship_matrix ?? '').split('\n').map((line) => {
    const match = line.match(/^\s*([^(:]+?)(?:\s*\(([^)]+)\))?\s*:\s*(.+)$/);
    if (!match) return line;
    const result = resolveCanonicalCharacterName(match[1].trim(), roster);
    return result.status === 'ambiguous' || !result.canonicalName ? line : `${result.canonicalName}${match[2] ? ` (${match[2]})` : ''}: ${match[3]}`;
  }).join('\n');
  next.relationship_matrix = matrix;
  const migrated = migrateProfileRoleDescriptorSeparation(next);
  Object.assign(next, migrated.profile);
  if (next.character_state === profiles.character_state
    && next.world_state === profiles.world_state
    && next.relationship_matrix === profiles.relationship_matrix
    && JSON.stringify(next.relationship_matrix_structured ?? []) === JSON.stringify(profiles.relationship_matrix_structured ?? [])) return false;
  next.identity_replacements = deduplicateIdentityDecisions(replacements, 'profile');
  await saveProfiles(next, characterName);
  return true;
}

/** Rewrites references to a duplicate entity after it is merged into another. */
export async function remapProfileEntity(characterName, sourceName, targetName) {
  const profiles = loadProfiles(characterName);
  if (!profiles || !sourceName || sourceName.toLowerCase() === targetName.toLowerCase()) return false;
  const escaped = String(sourceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
  let changed = false;
  const next = { ...profiles };
  for (const key of ['character_state', 'world_state', 'relationship_matrix']) {
    if (typeof next[key] !== 'string') continue;
    const value = next[key].replace(pattern, targetName);
    if (value !== next[key]) { next[key] = value; changed = true; }
  }
  if (changed) await saveProfiles(next, characterName);
  return changed;
}

/**
 * Returns true if stored profiles for the given character are older than the configured
 * threshold or do not exist yet. Used to decide whether to regenerate on chat load.
 * @param {number} [thresholdMs] - Staleness threshold in milliseconds.
 * @param {string} [characterName]
 * @returns {boolean}
 */
export function areProfilesStale(thresholdMs = DEFAULT_STALE_THRESHOLD_MS, characterName) {
  const profiles = loadProfiles(characterName);
  if (!profiles) return true;
  return Date.now() - (profiles.generated_at ?? 0) > thresholdMs;
}

/** Drops only profile fields that have no lexical support in approved current memories. */
export function retainGroundedProfileFields(parsed, sourceMemories = []) {
  const profiles = { ...parsed };
  const sourceMessages = sourceMemories.map((memory) => ({ mes: memory?.content ?? '' }));
  const rejected = [];
  for (const field of ['character_state', 'world_state', 'relationship_matrix']) {
    const content = String(profiles[field] ?? '').trim();
    if (!content) continue;
    const support = validateCitationSemanticSupport({ content }, sourceMessages);
    if (support.checked && !support.supported) {
      profiles[field] = '';
      rejected.push(field);
    }
  }
  return { profiles, rejected };
}

/** Removes immediate-state lines contradicted by the newest scene or State Ledger evidence. */
export function omitStaleCurrentProfileLines(parsed, currentEvidence = '') {
  const profiles = { ...parsed };
  const evidenceWords = new Set((String(currentEvidence).toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => word.length >= 4));
  if (!evidenceWords.size) return { profiles, dropped: [] };
  const currentLabels = /^(?:location|emotional posture|active fears|goals|threats|unresolved)\s*:/i;
  const dropped = [];
  for (const field of ['character_state', 'world_state']) {
    const lines = String(profiles[field] ?? '').split('\n');
    const kept = lines.filter((line) => {
      if (!currentLabels.test(line)) return true;
      const terms = (line.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => word.length >= 4 && !/^(?:location|emotional|posture|active|fears|goals|threats|unresolved|identified)$/.test(word));
      if (!terms.length || terms.some((term) => evidenceWords.has(term))) return true;
      dropped.push({ field, line });
      return false;
    });
    profiles[field] = kept.join('\n').trim();
  }
  return { profiles, dropped };
}

/**
 * Keeps relationship-matrix entries only when the established history supports
 * both the pair and at least one exact current descriptor. A relationship pair
 * is not evidence for a stronger or different status.
 */
function rosterEntries(roster) {
  return getCanonicalRosterPeople(roster);
}

export function extractCardRelationshipFacts(roster = []) {
  const statusPattern = 'husband|wife|ex-husband|ex-wife|partner|sister-in-law|brother-in-law|sibling-in-law|sibling|sister|brother|mother|father|parent|daughter|son|friend|roommate';
  const resolve = (name) => resolveCanonicalCharacterName(name, roster);
  const facts = [];
  const addFact = (entry, subjectName, targetName, relationshipType) => {
    const subject = resolve(subjectName);
    const target = resolve(targetName);
    if (subject.status !== 'resolved' || target.status !== 'resolved' || subject.canonicalName === target.canonicalName) return;
    facts.push({
      subject: subject.canonicalName.toLowerCase(),
      target: target.canonicalName.toLowerCase(),
      relationship_type: relationshipType.toLowerCase(),
      relationship_type_source: 'card_fact',
      relationship_type_confidence_class: 'authoritative',
      relationship_type_source_ids: [`card:${entry?.canonical_id ?? entry?.canonical_card_id ?? entry?.canonicalName ?? 'unknown'}`],
      relationship_type_direction: 'subject_to_target',
      descriptors: [relationshipType.toLowerCase()],
    });
  };
  for (const entry of rosterEntries(roster)) {
    const description = String(entry?.relationshipFactExcerpt ?? entry?.descriptionExcerpt ?? '');
    for (const match of description.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)\\s+(?:is|was)\\s+(?:the\\s+)?(${statusPattern})\\s+of\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)`, 'gi'))) {
      addFact(entry, match[1], match[3], match[2]);
    }
      // Common card phrasing: "Alex Rivera, Morgan Lee's wife" or
      // "Alex Rivera is Morgan Lee's daughter". These are explicit
    // directional facts, not descriptive inference.
    for (const match of description.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)\\s*(?:,|is)\\s*([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)'s\\s+(${statusPattern})\\b`, 'gi'))) {
      addFact(entry, match[1], match[2], match[3]);
    }
    for (const match of description.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)'s\\s+(${statusPattern})\\s+is\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)`, 'gi'))) {
      addFact(entry, match[3], match[1], match[2]);
    }
    // Card descriptions commonly state the owner role without repeating the
    // owner's name, e.g. "Mother of Alex Rivera and Jamie Rivera."
    // The owner is an authoritative participant; the named target remains
    // explicit, so this is safe and does not use surname or pronoun inference.
    for (const match of description.matchAll(new RegExp(`(?:^|[.\\n;])\\s*(?:relationship(?:s)?\\s*:\\s*)?(?:the\\s+)?(${statusPattern})\\s+of\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)(?:\\s+(?:and|,)\\s*([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*))?`, 'gi'))) {
      addFact(entry, entry.canonicalName, match[2], match[1]);
      if (match[3]) addFact(entry, entry.canonicalName, match[3], match[1]);
    }
  }
  return facts;
}

function extractGroundedRelationshipFacts(records = [], roster = []) {
  const statusPattern = 'husband|wife|ex-husband|ex-wife|partner|sister-in-law|brother-in-law|sibling-in-law|sibling|sister|brother|mother|father|parent|daughter|son|friend|roommate';
  const resolve = (name) => resolveCanonicalCharacterName(name, roster);
  const resolveExplicitParticipant = (name) => {
    const resolved = resolve(name);
    if (resolved.status === 'resolved') return resolved;
    const explicit = String(name ?? '').trim();
    return /^[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)+$/.test(explicit)
      ? { status: 'explicit_grounded_participant', canonicalName: explicit }
      : resolved;
  };
  const facts = [];
  const addFact = (record, subjectName, targetName, relationshipType) => {
    const subject = resolveExplicitParticipant(subjectName);
    const target = resolveExplicitParticipant(targetName);
    if (!['resolved', 'explicit_grounded_participant'].includes(subject.status)
      || !['resolved', 'explicit_grounded_participant'].includes(target.status)
      || subject.canonicalName === target.canonicalName) return;
    // A grounded memory record can be traced back to its stored evidence.
    // Do not resolve pronouns here: relationship types are durable facts and
    // must have two explicitly named, unambiguous participants.
    const sourceIds = [
      ...(Array.isArray(record?.source_message_ids) ? record.source_message_ids : []),
      ...(Array.isArray(record?.source_memory_ids) ? record.source_memory_ids : []),
      record?.source_message_id,
      record?.source_memory_id,
      record?.id,
    ].filter(Boolean).map(String);
    facts.push({
      subject: subject.canonicalName.toLowerCase(),
      target: target.canonicalName.toLowerCase(),
      relationship_type: relationshipType.toLowerCase(),
      relationship_type_source: 'grounded_source_evidence',
      relationship_type_confidence_class: 'grounded',
      relationship_type_source_ids: [...new Set(sourceIds)],
      descriptors: [relationshipType.toLowerCase()],
    });
  };
  for (const record of records) {
    const text = String(record?.content ?? record?.summary ?? '');
    for (const match of text.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)\\s+(?:is|was)\\s+(?:the\\s+)?(${statusPattern})\\s+of\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)`, 'gi'))) {
      addFact(record, match[1], match[3], match[2]);
    }
    // Direct possessive forms are equally explicit when both names appear:
    // "Kyler is Taylor's sister" and "Taylor's sister is Kyler". These
    // occur naturally in grounded extraction output from ordinary dialogue.
    for (const match of text.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)\\s+(?:is|was)\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)'s\\s+(${statusPattern})\\b`, 'gi'))) {
      addFact(record, match[1], match[2], match[3]);
    }
    for (const match of text.matchAll(new RegExp(`\\b([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)'s\\s+(${statusPattern})\\s+(?:is|was)\\s+([A-Z][\\w'-]*(?:\\s+[A-Z][\\w'-]*)*)`, 'gi'))) {
      addFact(record, match[3], match[1], match[2]);
    }
  }
  return facts;
}

/**
 * Finds the nearest explicitly named roster people before a contextual
 * reference. This is intentionally lexical and local: no model output or
 * long-range pronoun inference is allowed to create a durable relationship.
 */
function nearestNamedRosterPeople(text, beforeIndex, roster = [], limit = 320) {
  const windowStart = Math.max(0, beforeIndex - limit);
  const window = String(text ?? '').slice(windowStart, beforeIndex);
  const mentions = [];
  for (const entry of rosterEntries(roster)) {
    const references = [...new Set([entry.canonicalName, ...(entry.aliases ?? [])].map((value) => String(value ?? '').trim()).filter(Boolean))];
    let nearest = -1;
    for (const reference of references) {
      const matcher = new RegExp(`(^|[^a-z])${escapeRegExp(reference)}(?=$|[^a-z])`, 'ig');
      let match;
      while ((match = matcher.exec(window))) nearest = Math.max(nearest, match.index + match[1].length);
    }
    if (nearest >= 0) mentions.push({ entry, index: windowStart + nearest });
  }
  return mentions.sort((left, right) => right.index - left.index);
}

/**
 * Extracts a small class of explicit contextual facts from the live chat.
 * "You are her husband" is accepted only when "you" is the active persona
 * and the nearest preceding named roster person supplies an unambiguous
 * antecedent.  This keeps direct source evidence available even if memory
 * extraction rewrites the original dialogue without speaker metadata.
 */
function extractRawChatRelationshipFacts(messages = [], roster = []) {
  // This speaker-relative form has an explicit subject (the active persona),
  // but its possessive target can still be ambiguous in a group transcript.
  // Limit it to spouse/partner roles; family roles require named evidence.
  const speakerRelativeSpousePattern = 'husband|wife|ex-husband|ex-wife|partner';
  const persona = rosterEntries(roster).find((entry) => entry.source === 'user-persona' || entry.source_type === 'user-persona');
  if (!persona) return [];
  const resolve = (name) => resolveCanonicalCharacterName(name, roster);
  const resolveExplicitParticipant = (name) => {
    const resolved = resolve(name);
    if (resolved.status === 'resolved') return resolved;
    // A direct, full proper name in the chat can be relationship evidence even
    // when the person has no active character card. This does not create an
    // alias or merge an identity; it merely preserves the explicitly named
    // relationship target in this profile projection.
    const explicit = String(name ?? '').trim();
    return /^[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)+$/.test(explicit)
      ? { status: 'explicit_named_chat_participant', canonicalName: explicit }
      : resolved;
  };
  const facts = [];
  const addFact = (subjectName, targetName, relationshipType, sourceIndex) => {
    const subject = resolveExplicitParticipant(subjectName);
    const target = resolveExplicitParticipant(targetName);
    if (!['resolved', 'explicit_named_chat_participant'].includes(subject.status)
      || !['resolved', 'explicit_named_chat_participant'].includes(target.status)
      || subject.canonicalName === target.canonicalName) return;
    facts.push({
      subject: subject.canonicalName.toLowerCase(),
      target: target.canonicalName.toLowerCase(),
      relationship_type: relationshipType.toLowerCase(),
      relationship_type_source: 'grounded_raw_chat_evidence',
      relationship_type_confidence_class: 'grounded',
      relationship_type_source_ids: [`chat-message:${sourceIndex}`],
      descriptors: [relationshipType.toLowerCase()],
    });
  };
  for (const candidate of extractExplicitNamedFamilyCandidates(messages)) {
    addFact(candidate.subject, candidate.target, candidate.relationship_type, candidate.source_index);
  }
  for (const [arrayIndex, message] of (messages ?? []).entries()) {
    if (message?.is_system) continue;
    const text = String(message?.mes ?? '');
    if (!text.trim()) continue;
    const sourceIndex = Number.isInteger(message?.__sme_original_index) ? message.__sme_original_index : arrayIndex;
    // Speaker-relative spouse wording: resolve "you" only to the
    // active persona, then resolve her/his to the nearest earlier named card.
    for (const match of text.matchAll(new RegExp(`\\b(?:you\\s+are|you're|you've\\s+been)\\s+(?:her|his)\\s+(${speakerRelativeSpousePattern})\\b`, 'ig'))) {
      const target = nearestNamedRosterPeople(text, match.index, roster)
        .find((candidate) => candidate.entry.canonicalName !== persona.canonicalName)?.entry;
      if (target) addFact(persona.canonicalName, target.canonicalName, match[1], sourceIndex);
    }
    // Named family statements are safe when every participant is named in the
    // same bounded message. Do not generalize this to pronouns, surnames, or
    // scene summaries: those remain intentionally non-authoritative.
    // Explicit fully named statements were parsed above. Contextual forms
    // below remain tightly bounded to this individual message.
    // A tightly bounded dialogue form used by imported group chats: a single
    // message introduces exactly two explicit names as a pair, then explicitly
    // addresses them as Mom and Dad while naming the child speaker. The order
    // is anchored by the named introduction ("Morgan and Casey ..."); no
    // pronoun resolution, surname matching, or cross-message carry-over is
    // allowed. This preserves an explicit raw-chat fact when the parents are
    // not represented by active character cards.
    const parentPair = text.match(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+and\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:were|are|stood|arrived|entered)\b/i);
    const namedMom = text.match(/["\u201C](?:Mom|Mother)[,!]?[\u201D"]\s*,?\s*([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:said|asked|called|replied)/i);
    const namedDad = text.match(/["\u201C](?:Dad|Father)[,.!]?[\u201D"]\s*,?\s*(?:we\s+)?(?:weren't|were|are|said|asked|replied)/i);
    if (parentPair && namedMom && namedDad) {
      // Never complete one parent's name from the other's surname. A unique
      // roster alias may resolve a first name, but married or family names are
      // not evidence of identity or relationship by themselves.
      const namedMother = parentPair[1];
      addFact(namedMother, namedMom[1], 'mother', sourceIndex);
      addFact(parentPair[2], namedMom[1], 'father', sourceIndex);
      // A named subject plus a same-message possessive kinship term has an
      // explicit local antecedent here: the previously introduced parent
      // pair. This is deliberately not a general cross-message pronoun rule.
      for (const match of text.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b[^.!?]{0,180}\b(?:her|his)\s+(mother|father)\b/gi)) {
        const relation = match[2].toLowerCase();
        addFact(relation === 'mother' ? namedMother : parentPair[2], match[1], relation, sourceIndex);
      }
    }
    // Likewise, a named person referring to "her/his sister" or brother is
    // accepted only when another named roster person appears earlier in that
    // same message. The nearest explicit name supplies the antecedent; no
    // global pronoun memory or surname heuristic is involved.
    for (const match of text.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b[^.!?]{0,180}\b(?:her|his)\s+(sister|brother|sibling)\b/gi)) {
      const subject = resolveExplicitParticipant(match[1]);
      if (!['resolved', 'explicit_named_chat_participant'].includes(subject.status)) continue;
      const antecedent = nearestNamedRosterPeople(text, match.index, roster, 240)
        .find((candidate) => candidate.entry.canonicalName !== subject.canonicalName)?.entry;
      if (antecedent) addFact(subject.canonicalName, antecedent.canonicalName, match[2], sourceIndex);
    }
    for (const match of text.matchAll(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\b[^.!?]{0,180}\b(?:her|his)\s+(mother|father)\b/gi)) {
      const subject = resolveExplicitParticipant(match[1]);
      if (!['resolved', 'explicit_named_chat_participant'].includes(subject.status)) continue;
      const antecedent = nearestNamedRosterPeople(text, match.index, roster, 240)
        .find((candidate) => candidate.entry.canonicalName !== subject.canonicalName)?.entry;
      if (antecedent) addFact(antecedent.canonicalName, subject.canonicalName, match[2], sourceIndex);
    }
    // Do not turn *ungrounded* possessive family pronouns (for example "her
    // sister") into durable facts. The two bounded forms above require a
    // named subject and a same-message, explicit named antecedent; anything
    // else can be clear to a reader yet still be ambiguous in a group
    // transcript, especially across differing married surnames. Explicit
    // named family statements are handled separately by the named
    // grounded/card parsers above.
  }
  return facts;
}

export function retainKnownProfileRelationships(parsed, characterName, relationshipHistory = {}, roster = [], groundedRecords = [], rawChatMessages = []) {
  const profiles = { ...parsed };
  const historyPairs = Object.values(relationshipHistory ?? {})
    .map((state) => ({
      subject: String(state?.subject_name ?? '').toLowerCase(),
      target: String(state?.target_name ?? '').toLowerCase(),
      relationship_type: String(state?.relationship_type ?? state?.canonical_relationship_type ?? '').trim().toLowerCase() || null,
      relationship_type_source: state?.relationship_type_source ?? 'approved_relationship_history',
      relationship_type_confidence_class: state?.relationship_type ? 'authoritative' : null,
      descriptors: (state?.descriptors ?? []).map((descriptor) => String(typeof descriptor === 'string' ? descriptor : descriptor?.word ?? '').trim().toLowerCase()).filter(Boolean),
    }))
    .filter((pair) => pair.subject && pair.target && (pair.descriptors.length || pair.relationship_type));
  const cardPairs = extractCardRelationshipFacts(roster);
  const groundedPairs = extractGroundedRelationshipFacts(groundedRecords, roster);
  const rawChatPairs = extractRawChatRelationshipFacts(rawChatMessages, roster);
  // Keep the diagnostic compact and privacy-safe: counts and source classes
  // explain why a role may be accepted without exporting card text, memory
  // text, or raw chat.  This also makes an absence of usable evidence
  // distinguishable from a parser/model omission.
  const relationship_evidence_coverage = {
    card_fact_pairs: cardPairs.length,
    approved_history_pairs: historyPairs.length,
    grounded_memory_pairs: groundedPairs.length,
    bounded_raw_chat_pairs: rawChatPairs.length,
    total_pairs: cardPairs.length + historyPairs.length + groundedPairs.length + rawChatPairs.length,
    source_precedence: ['card_fact', 'approved_relationship_history', 'grounded_source_evidence', 'grounded_raw_chat_evidence'],
  };
  if (!historyPairs.length && !cardPairs.length && !groundedPairs.length && !rawChatPairs.length) {
    const lines = String(profiles.relationship_matrix ?? '').split('\n').filter(Boolean);
    const descriptor_terminal_outcomes = lines.flatMap((line) => String(line).split(':').slice(1).join(':').split(',').map((value) => value.trim()).filter(Boolean).map((descriptor) => ({
      relationship_target: String(line).split(':')[0]?.trim().toLowerCase() || null,
      generated_descriptor: descriptor, normalized_descriptor: null, authoritative_descriptors: [], disposition: 'rejected_unsupported',
      reason_code: 'no_authoritative_relationship_evidence', normalization_rule: null,
    })));
    const field_terminal_outcomes = lines.map((line) => ({
      relationship_target: String(line).split(':')[0]?.trim().toLowerCase() || null,
      canonical_relationship_type: null,
      generated_descriptors: String(line).split(':').slice(1).join(':').split(',').map((value) => value.trim()).filter(Boolean),
      accepted_descriptors: [], rejected_descriptors: [], preserved_authoritative_descriptors: [], final_saved_descriptors: [],
      field_terminal_outcome: 'dropped_no_supported_descriptors',
    }));
    return { profiles: { ...profiles, relationship_matrix: '' }, rejected: lines, rejection_details: [], descriptor_traces: descriptor_terminal_outcomes, descriptor_terminal_outcomes, field_terminal_outcomes, relationship_evidence_coverage };
  }
  const self = String(characterName ?? '').toLowerCase();
  const rejected = [];
  let normalized = 0;
  let invalidLabel = 0;
  const rejectionDetails = [];
  const descriptorTraces = [];
  const descriptorTerminalOutcomes = [];
  const fieldTerminalOutcomes = [];
  let rejectedPlaceholder = 0;
  profiles.relationship_matrix = String(profiles.relationship_matrix ?? '').split('\n').map((line) => {
    const match = line.match(/^\s*([^(:]+?)(?:\s*\([^)]+\))?\s*:\s*(.+)$/);
    if (!match) return line;
    const entity = match[1].trim().toLowerCase();
    // Accept the complete valid confidence range, including 1.0. Leaving a
    // trailing annotation turns an otherwise exact descriptor (for example
    // "open [confidence: 1.0]") into a false mismatch.
    const status = match[2]
      .replace(/\[confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\]/ig, '')
      .replace(/\s*;\s*confidence:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)(?=\s*(?:,|$))/ig, '')
      .trim().toLowerCase();
    const cardPair = cardPairs.find((candidate) => (candidate.subject === self && candidate.target === entity) || (candidate.target === self && candidate.subject === entity));
    const historyPair = historyPairs.find((candidate) => (candidate.subject === self && candidate.target === entity) || (candidate.target === self && candidate.subject === entity));
    const groundedPair = groundedPairs.find((candidate) => (candidate.subject === self && candidate.target === entity) || (candidate.target === self && candidate.subject === entity));
    const rawChatPair = rawChatPairs.find((candidate) => (candidate.subject === self && candidate.target === entity) || (candidate.target === self && candidate.subject === entity));
    // Source precedence is intentional: direct card facts, approved typed
    // history, grounded memory, then bounded raw-chat facts. Descriptor-only
    // values never provide a relationship role.
    const pair = mergeRelationshipPairEvidence(cardPair, historyPair, groundedPair, rawChatPair);
    const profileRelationshipType = relationshipTypeForProfileTarget(pair, self, entity);
    if (/^\s*(?:character|person|npc|user|persona|entity|unknown relationship)\b/i.test(status)) {
      rejected.push(line);
      const outcome = { relationship_target: entity, generated_descriptor: status, normalized_descriptor: null, authoritative_descriptors: pair?.descriptors ?? [], disposition: 'rejected_malformed', reason_code: 'invalid_relationship_label', normalization_rule: null };
      descriptorTraces.push(outcome);
      descriptorTerminalOutcomes.push(outcome);
      fieldTerminalOutcomes.push({ relationship_target: entity, canonical_relationship_type: profileRelationshipType, generated_descriptors: [status], accepted_descriptors: [], rejected_descriptors: [status], preserved_authoritative_descriptors: pair?.descriptors ?? [], final_saved_descriptors: [], field_terminal_outcome: 'dropped_no_supported_descriptors' });
      rejectionDetails.push({ section: 'relationship_matrix', field_path: entity, generated_value: status, authoritative_value: pair?.descriptors ?? [], disposition: 'dropped_conflict', reason_code: 'invalid_relationship_label' });
      invalidLabel++;
      return '';
    }
    // A deliberately small, one-way synonym table handles common local-model
    // wording without permitting fuzzy semantic approval. Every replacement
    // must still be present in the authoritative pair vocabulary.
    const descriptorSynonyms = { appreciative: 'grateful', trusting: 'open', caring: 'affectionate', reassuring: 'supportive' };
    const descriptorTokens = status.split(',').map((value) => value
      // Local models often attach a confidence score to only the final
      // comma-separated descriptor. Normalize per token so the annotation
      // cannot survive a whole-line formatting variation.
      .replace(/\s*;\s*confidence\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*$/ig, '')
      .replace(/\s*\[confidence\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\]\s*$/ig, '')
      .trim()).filter(Boolean);
    const placeholderDescriptors = new Set(['unknown', 'none', 'n/a', 'not specified', 'unsure', 'unclear']);
    // Exact authoritative vocabulary always wins. A synonym is only a fallback
    // for a token that is not already an approved descriptor (for example,
    // authoritative "trusting" must never be rewritten to "open").
    const normalizedTokens = descriptorTokens.map((token) => pair?.descriptors.includes(token) ? token : (descriptorSynonyms[token] ?? token));
    if (pair && descriptorTokens.length) {
      // Validate each generated descriptor independently. A mixed line such as
      // "wary, appreciative" must not discard the grounded "appreciative"
      // part merely because "wary" lacks support; likewise it must never let
      // an unsupported descriptor through simply because one sibling is valid.
      const accepted = [];
      const rejectedDescriptors = [];
      descriptorTokens.forEach((token, index) => {
        const canonical = normalizedTokens[index];
        if (pair.descriptors.includes(canonical)) {
          if (!accepted.includes(canonical)) accepted.push(canonical);
          const outcome = { relationship_target: entity, generated_descriptor: token, normalized_descriptor: canonical !== token ? canonical : null, authoritative_descriptors: pair.descriptors, disposition: canonical === token ? 'accepted_exact' : 'accepted_normalized_synonym', reason_code: canonical === token ? 'authoritative_exact_match' : 'controlled_descriptor_synonym', normalization_rule: canonical === token ? null : 'controlled_descriptor_synonym' };
          descriptorTraces.push(outcome);
          descriptorTerminalOutcomes.push(outcome);
          if (canonical !== token) {
            normalized++;
            rejectionDetails.push({ section: 'relationship_matrix', field_path: entity, generated_value: token, normalized_descriptor: canonical, normalization_rule: 'controlled_descriptor_synonym', authoritative_descriptors: pair.descriptors, disposition: 'accepted_normalized_synonym', reason_code: 'controlled_descriptor_synonym' });
          }
          return;
        }
        const placeholder = placeholderDescriptors.has(token);
        const outcome = { relationship_target: entity, generated_descriptor: token, normalized_descriptor: null, authoritative_descriptors: pair.descriptors, disposition: placeholder ? 'rejected_placeholder' : 'rejected_unsupported', reason_code: placeholder ? 'placeholder_relationship_descriptor' : 'unsupported_relationship_descriptor', normalization_rule: null };
        descriptorTraces.push(outcome);
        descriptorTerminalOutcomes.push(outcome);
        rejectedDescriptors.push(token);
        if (placeholder) rejectedPlaceholder++;
      });
      if (accepted.length) {
        // Profiles are a guarded projection, not a relationship-history
        // editor. Preserve the complete authoritative set and merely record
        // which model-proposed descriptors were accepted or rejected.
        // A descriptor such as "sister" emitted by the relationship model is
        // not a canonical family type by itself. Only a typed card, grounded
        // source, or explicitly typed approved record may establish that role.
        fieldTerminalOutcomes.push({ relationship_target: entity, canonical_relationship_type: profileRelationshipType, generated_descriptors: descriptorTokens, accepted_descriptors: accepted, rejected_descriptors: rejectedDescriptors, preserved_authoritative_descriptors: pair.descriptors, final_saved_descriptors: pair.descriptors, field_terminal_outcome: rejectedDescriptors.length ? 'saved_with_partial_descriptors' : 'saved_with_all_descriptors' });
        return `${match[1].trim()}: ${pair.descriptors.join(', ')}`;
      }
      fieldTerminalOutcomes.push({ relationship_target: entity, canonical_relationship_type: profileRelationshipType, generated_descriptors: descriptorTokens, accepted_descriptors: [], rejected_descriptors: rejectedDescriptors, preserved_authoritative_descriptors: pair.descriptors, final_saved_descriptors: [], field_terminal_outcome: 'dropped_no_supported_descriptors' });
      rejected.push(line);
      return '';
    }
    // “Partner” is weaker than an established spouse status. Normalize the
    // generated synonym only when the canonical relationship evidence gives a
    // precise current descriptor; never infer a stronger relationship.
    const precise = ['husband', 'wife', 'ex-husband', 'ex-wife'].includes(pair?.relationship_type)
      ? pair.relationship_type
      : null;
    if (precise && /\b(?:partner|family|character|person)\b/i.test(status)) {
      normalized++;
      const outcome = { relationship_target: entity, generated_descriptor: status, normalized_descriptor: precise, authoritative_descriptors: pair.descriptors, disposition: 'accepted_normalized_synonym', reason_code: 'controlled_relationship_type_synonym', normalization_rule: 'controlled_relationship_type_synonym' };
      descriptorTraces.push(outcome);
      descriptorTerminalOutcomes.push(outcome);
      fieldTerminalOutcomes.push({ relationship_target: entity, canonical_relationship_type: profileRelationshipType ?? precise, generated_descriptors: [status], accepted_descriptors: [precise], rejected_descriptors: [], preserved_authoritative_descriptors: pair.descriptors, final_saved_descriptors: pair.descriptors, field_terminal_outcome: 'saved_with_all_descriptors' });
      return line.replace(/\b(?:partner|family|character|person)\b/i, precise);
    }
    rejected.push(line);
    for (const token of descriptorTokens) {
      const placeholder = placeholderDescriptors.has(token);
      const outcome = { relationship_target: entity, generated_descriptor: token, normalized_descriptor: null, authoritative_descriptors: pair?.descriptors ?? [], disposition: placeholder ? 'rejected_placeholder' : (pair ? 'rejected_conflict' : 'rejected_unsupported'), reason_code: placeholder ? 'placeholder_relationship_descriptor' : (pair ? 'unsupported_relationship_descriptor' : 'no_authoritative_relationship_pair'), normalization_rule: null };
      descriptorTraces.push(outcome);
      descriptorTerminalOutcomes.push(outcome);
      if (placeholder) rejectedPlaceholder++;
    }
    fieldTerminalOutcomes.push({ relationship_target: entity, canonical_relationship_type: profileRelationshipType, generated_descriptors: descriptorTokens, accepted_descriptors: [], rejected_descriptors: descriptorTokens, preserved_authoritative_descriptors: pair?.descriptors ?? [], final_saved_descriptors: [], field_terminal_outcome: 'dropped_no_supported_descriptors' });
    rejectionDetails.push({ section: 'relationship_matrix', field_path: entity, generated_value: status, authoritative_value: pair?.descriptors ?? [], disposition: 'dropped_conflict', reason_code: 'unsupported_relationship_descriptor' });
    return '';
  }).filter(Boolean).join('\n');
  // A model may put a legally established relationship in the matrix but still
  // call it "unresolved" in the free-form state fields.  Do not preserve that
  // contradiction when the same counterpart has an exact spouse descriptor.
  const establishedPartners = [cardPairs, historyPairs, groundedPairs, rawChatPairs]
    .flat()
    .filter((pair) => pair.subject === self || pair.target === self)
    .filter((pair) => ['husband', 'wife', 'ex-husband', 'ex-wife'].includes(pair.relationship_type))
    .map((pair) => pair.subject === self ? pair.target : pair.subject);
  const contradictory = /\b(?:unresolved|uncertain|pending|unknown)\b/i;
  const relationshipIssue = /\b(?:divorc(?:e|ed|ing)|marri(?:age|ed)|spous(?:e|al)|husband|wife|partner)\b/i;
  let contradictoryStateLines = 0;
  for (const field of ['character_state', 'world_state']) {
    profiles[field] = String(profiles[field] ?? '').split('\n').filter((line) => {
      const namesEstablished = establishedPartners.some((partner) => new RegExp(`(^|[^a-z])${escapeRegExp(partner)}(?=$|[^a-z])`, 'i').test(line));
      if (!namesEstablished || !contradictory.test(line) || !relationshipIssue.test(line)) return true;
      rejected.push(line);
      contradictoryStateLines++;
      return false;
    }).join('\n').trim();
  }
  // Persist a structured, role-separated projection alongside the compatible
 // text matrix. A role is emitted only from independently grounded pair
 // evidence; descriptor words never establish one.
 const evidencePairs = [cardPairs, historyPairs, groundedPairs, rawChatPairs].flat();
 const evidenceForTarget = (target) => mergeRelationshipPairEvidence(...evidencePairs.filter((pair) =>
 (pair.subject === self && pair.target === target) || (pair.target === self && pair.subject === target)));
 const structuredByTarget = new Map();
 for (const outcome of fieldTerminalOutcomes) {
 const target = String(outcome.relationship_target ?? '').trim().toLowerCase();
 if (!target || structuredByTarget.has(target)) continue;
 const evidence = evidenceForTarget(target);
 const relationshipType = outcome.canonical_relationship_type ?? relationshipTypeForProfileTarget(evidence, self, target) ?? null;
 const cleaned = normalizeRelationshipDescriptors(
 outcome.final_saved_descriptors?.length ? outcome.final_saved_descriptors : evidence?.descriptors ?? [],
 relationshipType,
 );
 structuredByTarget.set(target, {
 target,
 canonical_relationship_type: relationshipType,
 relationship_type_source: relationshipType ? (evidence?.relationship_type_source ?? 'unresolved') : 'unresolved',
 relationship_type_source_id: relationshipType ? (evidence?.relationship_type_source_ids?.[0] ?? null) : null,
 relationship_type_direction: relationshipType ? (evidence?.subject === target ? 'target_to_profile' : 'profile_to_target_inverted') : null,
 relationship_type_confidence_class: relationshipType ? (evidence?.relationship_type_confidence_class ?? 'unresolved') : 'unresolved',
 relationship_descriptors: cleaned.descriptors,
 role_tokens_removed_from_descriptors: cleaned.removed,
 });
 }
 const relationship_matrix_structured = [...structuredByTarget.values()];
 if (relationship_matrix_structured.length) {
 profiles.relationship_matrix = relationship_matrix_structured
 .map((entry) => renderRelationshipMatrixLine(entry.target, { relationship_type: entry.canonical_relationship_type }, entry.relationship_descriptors))
 .join('\n');
 }
 const profile_role_tokens_removed = relationship_matrix_structured.reduce((count, entry) => count + entry.role_tokens_removed_from_descriptors.length, 0);
 const profile_fields_migrated_for_role_separation = relationship_matrix_structured.filter((entry) => entry.role_tokens_removed_from_descriptors.length).length;
 return { profiles: { ...profiles, relationship_matrix_structured }, rejected, rejection_details: rejectionDetails, descriptor_traces: descriptorTraces, descriptor_terminal_outcomes: descriptorTerminalOutcomes, field_terminal_outcomes: fieldTerminalOutcomes.map((outcome) => {
 const target = String(outcome.relationship_target ?? '').toLowerCase();
 const entry = structuredByTarget.get(target);
 const evidence = evidenceForTarget(target);
 const terminal = entry?.canonical_relationship_type
   ? 'resolved'
   : evidence ? 'unresolved_ambiguous'
     : outcome.field_terminal_outcome === 'dropped_no_supported_descriptors' ? 'unresolved_no_evidence' : 'rejected_unsafe_inference';
 const candidateEvidence = evidence ? [{
   canonical_relationship_type: relationshipTypeForProfileTarget(evidence, self, target) ?? null,
   relationship_type_source: evidence.relationship_type_source ?? null,
   relationship_type_source_id: evidence.relationship_type_source_ids?.[0] ?? null,
   relationship_type_direction: evidence.subject === target ? 'target_to_profile' : 'profile_to_target_inverted',
   relationship_descriptors: evidence.descriptors ?? [],
 }] : [];
 const rejectedEvidence = (outcome.rejected_descriptors ?? []).map((descriptor) => ({ descriptor, reason_code: terminal === 'unresolved_no_evidence' ? 'no_authoritative_relationship_pair' : 'unsupported_relationship_descriptor' }));
 return {
   ...outcome,
   canonical_relationship_type: entry?.canonical_relationship_type ?? outcome.canonical_relationship_type ?? null,
   relationship_type_source: entry?.relationship_type_source ?? (evidence?.relationship_type_source ?? null),
   relationship_type_source_id: entry?.relationship_type_source_id ?? (evidence?.relationship_type_source_ids?.[0] ?? null),
   relationship_type_direction: entry?.relationship_type_direction ?? (evidence ? (evidence.subject === target ? 'target_to_profile' : 'profile_to_target_inverted') : null),
   relationship_type_confidence_class: entry?.relationship_type_confidence_class ?? (evidence?.relationship_type_confidence_class ?? null),
   candidate_evidence: candidateEvidence,
   rejected_evidence: rejectedEvidence,
   terminal_outcome: terminal,
   relationship_type_candidate_evidence: candidateEvidence,
   relationship_type_rejected_evidence: rejectedEvidence,
   relationship_type_terminal_outcome: terminal,
   role_tokens_removed_from_descriptors: entry?.role_tokens_removed_from_descriptors ?? [],
   final_saved_descriptors: entry?.relationship_descriptors ?? outcome.final_saved_descriptors,
 };
 }), normalized, invalid_label: invalidLabel, rejected_placeholder: rejectedPlaceholder, contradictory_state_lines: contradictoryStateLines, profile_role_tokens_removed, profile_fields_migrated_for_role_separation, relationship_evidence_coverage };
}

/** Drops present-state profile lines framed as speculation rather than evidence. */
export function omitSpeculativeProfileLines(parsed) {
  const profiles = { ...parsed };
  const speculative = /\b(?:perhaps|possibly|probably|likely|apparently|presumably|rumou?red|implied|seems?|appears?|might|may\s+(?:be|have|still|not)|could\s+be)\b/i;
  const dropped = [];
  for (const field of ['character_state', 'world_state']) {
    const lines = String(profiles[field] ?? '').split('\n');
    profiles[field] = lines.filter((line) => {
      if (!speculative.test(line)) return true;
      dropped.push({ field, line });
      return false;
    }).join('\n').trim();
  }
  return { profiles, dropped };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Generation ---------------------------------------------------------

/**
 * Calls the model to regenerate character/world profiles from stored memories
 * and saves the result to chatMetadata.
 *
 * Loads active long-term memories, session memories, and the character entity
 * registry. Passes them all to buildProfileGenerationPrompt in one call.
 * Returns null and logs a warning if the model produces unparseable output.
 *
 * @param {string} characterName - Active character name.
 * @param {Function|null} [abortCheck] - Optional zero-arg function; if it returns true the write is skipped (chat switched).
 * @param {{throwOnFailure?: boolean, onTerminal?: Function}} [options]
 * Lets a transactional caller receive one privacy-safe terminal record for
 * each profile attempt. Raw provider output is never included in that record.
 * @returns {Promise<{character_state: string, world_state: string, relationship_matrix: string, generated_at: number}|null>}
 */
export async function generateProfiles(characterName, abortCheck = null, options = {}) {
  const settings = extension_settings[MODULE_NAME];
  if (!settings.profiles_enabled || !characterName || [CHARACTER_MEMORY_POLICIES.READ_ONLY, CHARACTER_MEMORY_POLICIES.DISABLED].includes(getCharacterMemoryPolicy(characterName))) return null;

  // Only pass active (non-retired) memories to the profile prompt.
  const longtermMemories = loadCharacterMemories(characterName).filter((m) => !m.superseded_by && isGeneratedRecordApproved(m));
  const sessionMemories = loadSessionMemories().filter((m) => !m.superseded_by && isGeneratedRecordApproved(m));

  if (longtermMemories.length === 0 && sessionMemories.length === 0) {
    // Nothing stored yet - skip generation rather than producing empty profiles.
    return null;
  }

  const ltText = formatMemoriesForPrompt(longtermMemories);
  const sessText =
    sessionMemories.length > 0
      ? sessionMemories.map((m) => `[${m.type}] ${m.content}`).join('\n')
      : '';

  // Pass entity registry names for the relationship matrix. Only character and
  // place entities are useful here - concepts and objects clutter the output.
  const entityRegistry = loadCharacterEntityRegistry(characterName);
  const relationshipHistory = loadRelationshipHistory(characterName);
  const entities = entityRegistry
    .filter((e) => e.type === 'character' || e.type === 'place')
    .map((e) => ({ name: e.name, type: e.type }));

  const profileContext = getContext();
  const roster = buildCanonicalCharacterRoster(profileContext);
  // The active group roster deliberately excludes inactive cards, but an
  // already-grounded character entity may still be a named relationship
  // target. Add it only as reference evidence; it never changes group-card
  // injection, policy, or identity ownership.
  const relationshipRoster = {
    ...roster,
    characters: [...(roster.characters ?? []), ...entityRegistry
      .filter((entry) => entry?.type === 'character' && entry?.name)
      .filter((entry) => !(roster.characters ?? []).some((card) => card.canonicalName?.toLowerCase() === String(entry.name).toLowerCase()))
      .map((entry) => ({ canonicalName: String(entry.name), canonical_id: entry.canonical_id ?? entry.canonical_card_id ?? `grounded:${String(entry.name).toLowerCase()}`, aliases: [], source: 'grounded-entity-registry', source_type: 'grounded-entity-registry' }))],
  };
  const rawChatMessages = profileContext.chat ?? [];
  const profileCardId = roster.characters?.find((entry) => entry.canonicalName === characterName)?.id ?? null;
  const emitTerminal = (detail = {}) => options.onTerminal?.({
    profile_identity: characterName,
    profile_card_id: profileCardId,
    request_attempted: false,
    request_completed: false,
    provider_error: null,
    returned_none: false,
    raw_output_length: 0,
    normalized_output_length: 0,
    sections_detected: [],
    character_state_detected: false,
    world_state_detected: false,
    relationship_matrix_detected: false,
    parser_path: [],
    formatting_repair_attempted: false,
    formatting_repair_succeeded: false,
    parse_error_code: null,
    terminal_outcome: 'returned_none',
    saved: false,
    prior_profile_preserved: false,
    ...detail,
  });
  const inspectStructure = (value) => {
    const raw = String(value ?? '');
    const normalized = raw
      .replace(/```(?:xml|markdown|text)?\s*/gi, '')
      .trim();
    const sections = ['character_state', 'world_state', 'relationship_matrix'].filter((key) => {
      const label = key.replace('_', '[ _-]*');
      return new RegExp(`(?:<\\s*${label}|(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*{1,2}\\s*)?${label.replace('[ _-]*', '[ _-]*')})`, 'i').test(normalized);
    });
    return { raw_output_length: raw.length, normalized_output_length: normalized.length, sections_detected: sections };
  };
  const prompt = buildProfileGenerationPrompt(
    characterName,
    ltText,
    sessText,
    entities,
    formatCanonicalRosterForPrompt(roster),
    relationshipHistory,
    extractCardRelationshipFacts(roster),
  );

  try {
    const response = await generateMemoryExtract(applyPromptOverride(prompt, PROMPT_TASKS.PROFILES, characterName), {
      responseLength: settings.profiles_response_length ?? 600,
    });

    smLog('[Smart Memory Enhanced] Profile generation response:', response);

    if (!response) {
      emitTerminal({ request_attempted: true, request_completed: true, returned_none: true, terminal_outcome: 'returned_none' });
      return null;
    }

    const initialStructure = inspectStructure(response);
    let parsed = parseProfileOutput(response, { requireAll: true });
    let parserPath = ['strict'];
    let repaired = null;
    // Local models sometimes retain usable facts but miss the parser contract.
    // A single formatting-only repair preserves that evidence without allowing a
    // second model call to invent a replacement profile.
    if (!parsed) {
      repaired = await generateMemoryExtract(
        applyPromptOverride(buildProfileFormatRepairPrompt(response), PROMPT_TASKS.PROFILES, characterName),
        { responseLength: settings.profiles_response_length ?? 600 },
      );
      parsed = parseProfileOutput(repaired, { requireAll: true });
      parserPath.push('format_repair', 'strict_repair');
      if (parsed) smLog('[Smart Memory Enhanced] Recovered profile output with a format-only repair.');
    }
    // Explicit partial-profile policy: only Character State + World State can
    // be saved partially. Relationship Matrix is retained from an existing
    // approved profile when possible, never silently erased.
    let partialProfile = false;
    if (!parsed) {
      const partialCandidate = parseProfileOutput(repaired || response);
      parserPath.push('partial_recovery');
      if (partialCandidate?.character_state && partialCandidate?.world_state) {
        parsed = partialCandidate;
        partialProfile = true;
      }
    }
    if (!parsed) {
      const prior = loadProfiles(characterName);
      const error = new Error(`${characterName} profile generation produced unparseable output.`);
      error.sme_profile_malformed_output = true;
      console.warn(`[Smart Memory Enhanced] ${error.message} Check format above.`);
      emitTerminal({
        request_attempted: true, request_completed: true,
        ...inspectStructure(repaired || response), parser_path: parserPath,
        formatting_repair_attempted: true, formatting_repair_succeeded: false,
        parse_error_code: 'unparseable_required_sections', terminal_outcome: prior ? 'preserved_prior' : 'rejected_unparseable',
        prior_profile_preserved: Boolean(prior),
      });
      if (options.throwOnFailure) throw error;
      return prior;
    }
    const profileFields = ['character_state', 'world_state', 'relationship_matrix'];
    const hasGroundedField = profileFields.some((field) => {
      const value = String(parsed[field] ?? '').trim();
      return value.length > 0 && !/^(?:unknown|none|none identified)$/i.test(value);
    });
    if (!hasGroundedField) {
      // An empty or placeholder-only response must never erase a useful,
      // previously approved profile.
      smLog('[Smart Memory Enhanced] Profile generation produced no supported fields; preserving the prior profile.');
      return loadProfiles(characterName);
    }

    const identityReplacements = [];
    for (const field of ['character_state', 'world_state', 'relationship_matrix']) {
      const narrative = canonicalizeNarrativeNames(parsed[field], roster);
      parsed[field] = narrative.text;
      identityReplacements.push(...narrative.replacements);
    }
    parsed.relationship_matrix = parsed.relationship_matrix
      .split('\n')
      .map((line) => {
        const match = line.match(/^\s*([^(:]+?)(?:\s*\(([^)]+)\))?\s*:\s*(.+)$/);
        if (!match) return line;
        const resolution = resolveCanonicalCharacterName(match[1].trim(), roster, entityRegistry);
        // A guessed or contradictory card identity must not become durable
        // profile state. Exact/approved aliases are canonicalized; unknown
        // non-card entities remain readable under their supplied name.
        if (resolution.status === 'ambiguous' || resolution.status === 'rejected') return '';
        return `${resolution.canonicalName ?? match[1].trim()}${match[2] ? ` (${match[2]})` : ''}: ${match[3]}`;
      })
      .filter(Boolean)
      .join('\n');

    // The prompt receives only active records (superseded records were
    // excluded above), so the latest supported fact can replace older state.
    // A field that introduces unrelated terms is omitted instead of silently
    // becoming current profile truth.
    const fieldGrounding = retainGroundedProfileFields(parsed, [...longtermMemories, ...sessionMemories]);
    parsed = fieldGrounding.profiles;
    const priorProfiles = loadProfiles(characterName);
    const preservedPriorFields = [];
    if (partialProfile && !String(parsed.relationship_matrix ?? '').trim() && String(priorProfiles?.relationship_matrix ?? '').trim()) {
      parsed.relationship_matrix = priorProfiles.relationship_matrix;
      preservedPriorFields.push('relationship_matrix');
    }
    for (const field of fieldGrounding.rejected) {
      const prior = String(priorProfiles?.[field] ?? '').trim();
      if (!prior) continue;
      parsed[field] = prior;
      preservedPriorFields.push(field);
    }
    const currentEvidence = [
      ...loadSceneHistory().slice(-2).map((scene) => scene.summary),
      ...Object.values(loadStateLedger()).map((card) => JSON.stringify(card ?? {})),
    ].join('\n');
    const temporalCheck = omitStaleCurrentProfileLines(parsed, currentEvidence);
    parsed = temporalCheck.profiles;
    const speculationCheck = omitSpeculativeProfileLines(parsed);
    parsed = speculationCheck.profiles;
    const groundedRelationshipRecords = [
      ...longtermMemories,
      ...sessionMemories,
    ];
    // Scene summaries are generated narrative derivatives. They can preserve
    // source-era wording (including historical aliases), but are never an
    // authority for durable relationship labels such as spouse or ex-spouse.
    // Only directly grounded memory records, card facts, and Relationship
    // History may validate the profile relationship matrix.
    const relationshipCheck = retainKnownProfileRelationships(parsed, characterName, relationshipHistory, relationshipRoster, groundedRelationshipRecords, rawChatMessages);
    parsed = relationshipCheck.profiles;
    if (relationshipCheck.rejected.length) {
      const priorRelationshipCheck = retainKnownProfileRelationships(priorProfiles ?? {}, characterName, relationshipHistory, relationshipRoster, groundedRelationshipRecords, rawChatMessages);
      const priorMatrix = String(priorRelationshipCheck.profiles.relationship_matrix ?? '').trim();
      if (priorMatrix) {
        parsed.relationship_matrix = priorMatrix;
        if (!preservedPriorFields.includes('relationship_matrix')) preservedPriorFields.push('relationship_matrix');
      }
    }
    if (fieldGrounding.rejected.length) {
      smLog(`[Smart Memory Enhanced] Omitted unsupported profile fields: ${fieldGrounding.rejected.join(', ')}.`);
    }
    if (!profileFields.some((field) => String(parsed[field] ?? '').trim())) {
      smLog('[Smart Memory Enhanced] Profile generation had no grounded fields; preserving the prior profile.');
      return loadProfiles(characterName);
    }

    const profileDescriptorTerminalOutcomes = relationshipCheck.descriptor_terminal_outcomes ?? [];
    const profileFieldTerminalOutcomes = relationshipCheck.field_terminal_outcomes ?? [];
    const rejectedRelationshipDescriptors = profileDescriptorTerminalOutcomes.filter((entry) => String(entry.disposition ?? '').startsWith('rejected_'));
    const rejectedRelationshipFields = profileFieldTerminalOutcomes.filter((entry) => entry.field_terminal_outcome === 'dropped_no_supported_descriptors');
    // A descriptor inside a wholly dropped field is represented by the field
    // outcome in user-facing status. Only rejected siblings of a field that
    // was actually saved are a separate descriptor-level warning.
    const rejectedDescriptorsInSavedFields = profileFieldTerminalOutcomes
      .filter((entry) => entry.field_terminal_outcome === 'saved_with_partial_descriptors')
      .flatMap((entry) => entry.rejected_descriptors ?? []);
    const profiles = {
      ...parsed,
      generated_at: Date.now(),
      parent_memory_ids: [...longtermMemories, ...sessionMemories].map((memory) => memory.id).filter(Boolean),
      source_memory_ids: [...longtermMemories, ...sessionMemories].map((memory) => memory.id).filter(Boolean),
      evidence_ids: [...longtermMemories, ...sessionMemories].map((memory) => memory.id).filter(Boolean),
      identity_replacements: deduplicateIdentityDecisions(identityReplacements, 'profile'),
      field_grounding_rejections: fieldGrounding.rejected,
      preserved_prior_fields: preservedPriorFields,
      stale_field_rejections: temporalCheck.dropped.map((entry) => entry.field),
      speculative_field_rejections: speculationCheck.dropped.map((entry) => entry.field),
      // `relationship_field_details` remains a compatibility projection. New
      // consumers must use the terminal arrays below: attempt-level traces
      // are deliberately kept out of status/degradation accounting.
      relationship_field_rejections: rejectedRelationshipFields.length,
      relationship_dropped_field_descriptor_count: rejectedRelationshipFields.reduce((total, entry) => total + (entry.rejected_descriptors?.length ?? entry.generated_descriptors?.length ?? 0), 0),
      relationship_descriptor_rejections: rejectedDescriptorsInSavedFields.length,
      relationship_field_details: profileFieldTerminalOutcomes.map((detail) => ({
        profile_identity: characterName, profile_card_id: roster.characters?.find((entry) => entry.canonicalName === characterName)?.id ?? null,
        preserved_value: preservedPriorFields.includes('relationship_matrix') ? String(priorProfiles?.relationship_matrix ?? '') : null,
        winning_evidence_type: 'relationship_history',
        winning_evidence_id: relationshipHistory ? 'relationship_history' : null,
        profile_terminal_outcome: partialProfile ? 'saved_partial' : 'saved_full',
        ...detail,
      })),
      profile_descriptor_traces: relationshipCheck.descriptor_traces ?? [],
      profile_descriptor_terminal_outcomes: profileDescriptorTerminalOutcomes,
      profile_field_terminal_outcomes: profileFieldTerminalOutcomes.map((detail) => ({
        profile_identity: characterName,
        profile_card_id: roster.characters?.find((entry) => entry.canonicalName === characterName)?.id ?? null,
        ...detail,
      })),
      relationship_field_validation: {
        saved_with_all_descriptors: profileFieldTerminalOutcomes.filter((entry) => entry.field_terminal_outcome === 'saved_with_all_descriptors').length,
        saved_with_partial_descriptors: profileFieldTerminalOutcomes.filter((entry) => entry.field_terminal_outcome === 'saved_with_partial_descriptors').length,
        preserved_authoritative_value: profileFieldTerminalOutcomes.filter((entry) => entry.field_terminal_outcome === 'preserved_authoritative_value').length,
        dropped_no_supported_descriptors: rejectedRelationshipFields.length,
      },
      field_validation: {
        accepted_exact: Math.max(0, profileFields.length - fieldGrounding.rejected.length - temporalCheck.dropped.length - speculationCheck.dropped.length - rejectedRelationshipFields.length),
        accepted_normalized: relationshipCheck.normalized ?? 0,
        preserved_prior: preservedPriorFields.length,
        dropped_conflict: rejectedRelationshipDescriptors.filter((entry) => entry.disposition === 'rejected_conflict').length,
        dropped_speculative: speculationCheck.dropped.length,
        dropped_invalid_label: rejectedRelationshipDescriptors.filter((entry) => entry.reason_code === 'invalid_relationship_label').length,
        dropped_unsupported: fieldGrounding.rejected.length + rejectedRelationshipDescriptors.filter((entry) => entry.disposition === 'rejected_unsupported').length,
        dropped_malformed: rejectedRelationshipDescriptors.filter((entry) => entry.disposition === 'rejected_malformed').length,
      },
    };
    validateGeneratedRecord(profiles, { allowDerived: true, parentStore: [...longtermMemories, ...sessionMemories] });
    if (!isGeneratedRecordApproved(profiles)) {
      smLog('[Smart Memory Enhanced] Profile generation failed grounding validation; preserving the prior profile.');
      emitTerminal({ request_attempted: true, request_completed: true, ...initialStructure, parser_path: parserPath, formatting_repair_attempted: Boolean(repaired), formatting_repair_succeeded: Boolean(repaired && parseProfileOutput(repaired, { requireAll: true })), parse_error_code: 'grounding_rejected', terminal_outcome: priorProfiles ? 'preserved_prior' : 'rejected_unparseable', prior_profile_preserved: Boolean(priorProfiles) });
      return loadProfiles(characterName);
    }
    if (abortCheck?.()) return null;
    await saveProfiles(profiles, characterName);
    const finalStructure = inspectStructure(repaired || response);
    emitTerminal({ request_attempted: true, request_completed: true, ...finalStructure,
      character_state_detected: finalStructure.sections_detected.includes('character_state'),
      world_state_detected: finalStructure.sections_detected.includes('world_state'),
      relationship_matrix_detected: finalStructure.sections_detected.includes('relationship_matrix'),
      parser_path: parserPath, formatting_repair_attempted: Boolean(repaired), formatting_repair_succeeded: Boolean(repaired && parseProfileOutput(repaired, { requireAll: true })), terminal_outcome: partialProfile ? 'saved_partial' : 'saved_full', saved: true, prior_profile_preserved: preservedPriorFields.length > 0 });
    return profiles;
  } catch (err) {
    console.error('[Smart Memory Enhanced] Profile generation failed:', err);
    if (!err?.sme_profile_malformed_output) emitTerminal({ request_attempted: true, provider_error: String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 240), parse_error_code: 'provider_or_persistence_error', terminal_outcome: 'provider_error' });
    if (options.throwOnFailure) throw err;
    return null;
  }
}

// ---- Injection ----------------------------------------------------------

/**
 * Formats profiles into a compact text block for prompt injection.
 * Sections with empty content are omitted so the block stays short when
 * the model only populated some sections.
 * @param {{character_state: string, world_state: string, relationship_matrix: string}} profiles
 * @param {number} budget - Token budget for the profiles block.
 * @returns {string}
 */
function formatProfiles(profiles, budget) {
  // Build sections in priority order: character_state is least important
  // (drop first to preserve relationship context), relationship_matrix last.
  const sections = [
    { key: 'character_state', label: 'Character state:' },
    { key: 'world_state', label: 'World state:' },
    { key: 'relationship_matrix', label: 'Relationships:' },
  ];

  // Start with all non-empty sections as a mutable array of text blocks.
  // Trimming rebuilds from the array rather than text-replacing, so repeated
  // phrasings across sections cannot cause partial removal.
  const activeParts = sections
    .filter(({ key }) => profiles[key])
    .map(({ key, label }) => `${label}\n${profiles[key]}`);

  // Drop sections from the front (least important first) until under budget.
  while (estimateTokens(activeParts.join('\n\n')) > budget && activeParts.length > 1) {
    activeParts.shift();
  }

  return activeParts.join('\n\n');
}

/**
 * Injects the given character's stored profiles into the prompt via setExtensionPrompt.
 * Clears the slot if profiles are disabled, the character is unknown, or nothing is stored.
 * @param {string} [characterName]
 */
export function injectProfiles(characterName) {
  const settings = extension_settings[MODULE_NAME];

  if (!settings.profiles_enabled || getCharacterMemoryPolicy(characterName) === CHARACTER_MEMORY_POLICIES.DISABLED) {
    setMacroContent(MACRO_NAMES.profiles, '');
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_PROFILES);
    return;
  }

  const profiles = loadProfiles(characterName);
  if (!profiles || !isGeneratedRecordApproved(profiles)) {
    setMacroContent(MACRO_NAMES.profiles, '');
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_PROFILES);
    return;
  }

  const budget = settings.profiles_inject_budget ?? 200;
  const sections = [
    profiles.character_state,
    profiles.world_state,
    profiles.relationship_matrix,
  ].filter(Boolean);
  const fullTokens = estimateTokens(sections.join('\n\n'));
  const text = formatProfiles(profiles, budget);

  if (!text) {
    setMacroContent(MACRO_NAMES.profiles, '');
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_PROFILES);
    return;
  }

  const template = settings.profiles_template ?? '{{profiles}}';
  const content = template.replace('{{profiles}}', text);
  reportTierTrimStats(PROMPT_KEY_PROFILES, estimateTokens(content), fullTokens);

  setMacroContent(MACRO_NAMES.profiles, content);
  if (isMacroActive(MACRO_NAMES.profiles)) {
    setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
    invalidateUnifiedCache(PROMPT_KEY_PROFILES);
    return;
  }

  setExtensionPrompt(
    PROMPT_KEY_PROFILES,
    content,
    settings.profiles_position ?? extension_prompt_types.IN_PROMPT,
    settings.profiles_depth ?? 1,
    false,
    settings.profiles_role ?? extension_prompt_roles.SYSTEM,
  );
}

/**
 * Clears stored profiles from chatMetadata and removes the injection slot.
 * If characterName is provided, only that character's entry is removed.
 * If omitted, all profiles for the chat are removed.
 * @param {string} [characterName]
 */
export async function clearProfiles(characterName) {
  const context = getContext();
  if (context.chatMetadata?.[META_KEY]?.profiles) {
    if (characterName) {
      delete context.chatMetadata[META_KEY].profiles[characterName];
    } else {
      delete context.chatMetadata[META_KEY].profiles;
    }
    await saveChatMetadata(context);
  }
  setExtensionPrompt(PROMPT_KEY_PROFILES, '', extension_prompt_types.NONE, 0);
  invalidateUnifiedCache(PROMPT_KEY_PROFILES);
}
