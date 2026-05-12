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
 * Pure parsing and formatting functions with no SillyTavern runtime dependencies.
 *
 * All functions here operate on plain strings and return plain data - no
 * getContext(), setExtensionPrompt(), or module-level mutable state. Isolating
 * them here means they can be unit-tested without a SillyTavern runtime context.
 * The consuming modules (arcs.js, compaction.js, continuity.js, longterm.js,
 * scenes.js, session.js) import from here rather than defining their own copies.
 *
 * parseExtractionOutput     - parses [type:score:expiration:entity=...] tagged lines from long-term extraction
 * parseSessionOutput        - parses [type:score:expiration:entity=...] tagged lines from session extraction
 * parseArcOutput            - parses [arc] / [resolved] tagged lines from arc extraction
 * parseContradictions       - parses contradiction lines from a continuity check response
 * formatSummary             - strips model analysis scaffolding and extracts the summary text
 * detectSceneBreakHeuristic - pattern-based scene break check, no model call required
 * parseProfileOutput        - extracts character_state, world_state, and relationship_matrix from profile generation output
 * parseTriggerResponse           - parses the comma-separated keyword list from a trigger generation response
 * parseRelationshipDeltaResponse - parses per-pair relationship state changes with magnitude from a delta response
 * parseEpistemicResponse         - parses the five-tag knowledge map output from an epistemic extraction pass
 *
 * All new memory objects produced by the parse functions carry the full graph
 * field set (id, source_messages, entities, time_scope, valid_from, valid_to,
 * supersedes, superseded_by, contradicts) so callers never need to add them
 * separately. IDs are generated fresh here; supersession links are populated
 * later by the verifier pass in graph-migration.js.
 */

import { MEMORY_TYPES, SESSION_TYPES, generateMemoryId } from './constants.js';

// ---- Long-term extraction -----------------------------------------------

/**
 * Parses "[type:importance:expiration] content" tagged lines from the model's
 * long-term extraction output. Lines with unrecognised types, very short content,
 * or that don't match the format are silently skipped.
 *
 * Accepted format (spaces around ':' are optional):
 *   [fact] The character's name is Elara.
 *   [relationship:3] She trusts the innkeeper completely.
 *   [event:2:session] They sealed the pact at dawn.
 *
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, importance: number, expiration: string, ts: number, consolidated: boolean}>}
 */
export function parseExtractionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  const results = [];
  // Capture type and all modifier fields as a single string, then parse them
  // separately. This is resilient to local models reordering optional fields
  // (score, expiration, entity=) or omitting some of them.
  const linePattern = /^\[(fact|relationship|preference|event)([^\]]*)\]\s*(.+)$/gim;
  let match;

  while ((match = linePattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const modifiers = match[2]; // e.g. ":2:permanent" or ":2:permanent:entity=Senjin,Alex"
    const content = match[3].trim();

    if (!MEMORY_TYPES.includes(type) || content.length <= 5) continue;

    // Extract optional score (first standalone 1/2/3 preceded by colon).
    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : 2;

    // Extract optional expiration keyword.
    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch ? expirationMatch[1].toLowerCase() : 'permanent';

    // Extract optional entity names list. Stops at the next colon so reordering
    // does not bleed into other fields.
    const entityMatch = modifiers.match(/entity=([^:[\]]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
      : [];

    // New entries start as unprocessed - they will be evaluated against the
    // consolidated base before being promoted.
    // _raw_entity_names is a transient pipeline field: resolved to entity ids
    // and stripped before the memory reaches storage.
    results.push({
      type,
      content,
      importance,
      expiration,
      ts: Date.now(),
      consolidated: false,
      _raw_entity_names: rawEntityNames,
      // Graph fields - supersession links are added by the verifier pass.
      id: generateMemoryId(),
      source_messages: [],
      entities: [],
      time_scope: 'global',
      valid_from: null,
      valid_to: null,
      supersedes: [],
      superseded_by: null,
      contradicts: [],
    });
  }

  return results;
}

// ---- Session extraction -------------------------------------------------

/**
 * Parses "[type:importance:expiration] content" tagged lines from the model's
 * session extraction output. Lines with unrecognised types or very short content
 * are skipped. The minimum content length (> 3) is intentionally lower than
 * long-term extraction (> 5) since session details tend to be specific and short.
 *
 * Accepted format (spaces around ':' are optional):
 *   [scene] Candlelit tavern, late evening, rain outside.
 *   [revelation:3] She admits the letter was forged.
 *
 * @param {string} text - Raw model response.
 * @returns {Array<{type: string, content: string, importance: number, expiration: string, ts: number, consolidated: boolean}>}
 */
export function parseSessionOutput(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];
  const results = [];
  // Same flexible bracket-content approach as parseExtractionOutput.
  const pattern = /^\[(scene|revelation|development|detail)([^\]]*)\]\s*(.+)$/gim;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const modifiers = match[2];
    const content = match[3].trim();

    if (!SESSION_TYPES.includes(type) || content.length <= 3) continue;

    const importanceMatch = modifiers.match(/:\s*([123])\b/);
    const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : 2;

    const expirationMatch = modifiers.match(/:\s*(scene|session|permanent)\b/i);
    const expiration = expirationMatch ? expirationMatch[1].toLowerCase() : 'session';

    const entityMatch = modifiers.match(/entity=([^:[\]]*)/i);
    const rawEntityNames = entityMatch
      ? entityMatch[1]
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
      : [];

    // New entries start as unprocessed - they will be evaluated against the
    // consolidated base before being promoted.
    // _raw_entity_names is a transient pipeline field: resolved to entity ids
    // and stripped before the memory reaches storage.
    results.push({
      type,
      content,
      importance,
      expiration,
      ts: Date.now(),
      consolidated: false,
      _raw_entity_names: rawEntityNames,
      // Graph fields - session memories use 'session' scope by default.
      id: generateMemoryId(),
      source_messages: [],
      entities: [],
      time_scope: 'session',
      valid_from: null,
      valid_to: null,
      supersedes: [],
      superseded_by: null,
      contradicts: [],
    });
  }
  return results;
}

// ---- Arc extraction -----------------------------------------------------

/**
 * Parses the model's arc extraction response into lists of arcs to add and
 * indices of existing arcs to resolve.
 *
 * New arcs are tagged [arc]. Resolved arcs are tagged [resolved] - the text
 * after the tag is matched against existing arcs by Jaccard word-overlap
 * similarity: arcs with >= 25% overlap are marked for removal. This is
 * intentionally loose to handle the paraphrasing that local models often do.
 *
 * @param {string} text - Raw model response.
 * @param {Array} existingArcs - The current arc list (used for resolution matching).
 * @returns {{add: Array, resolve: number[]}} Arcs to add and indices to remove.
 */
export function parseArcOutput(text, existingArcs) {
  if (!text || text.trim().toUpperCase() === 'NONE') return { add: [], resolve: [] };

  const toAdd = [];
  const toResolve = [];

  const addPattern = /^\[arc\]\s+(.+)$/gim;
  const resolvedPattern = /^\[resolved\]\s+(.+)$/gim;

  // Patterns that indicate a genuine open narrative thread - goal/obligation
  // language, incompleteness markers, unknown-actor framing, open questions.
  // Candidates that match none of these are almost always declarative facts or
  // scene details that the model misfiled as arcs, and are filtered out.
  const ARC_SIGNALS = [
    /\b(unknown|unclear|unresolved|uncertain|unanswered)\b/i,
    /\bremains?\s+(unknown|unclear|open|unresolved)\b/i,
    /\bhas\s+yet\s+to\b/i,
    /\byet\s+to\b/i,
    /\bneeds?\s+to\b/i,
    /\bmust\b/i,
    /\b(promised|swore|vowed|pledged)\b/i,
    /\bplans?\s+to\b/i,
    /\b(wants?\s+to|seeks?\s+to|trying\s+to)\b/i,
    /\b(someone|whoever)\b/i,
    /\bthe\s+identity\s+of\b/i,
    /\bwhether\b/i,
    /\bwhere\s+(is|are|was|were)\b/i,
    /\bwho\s+(is|are|was|were|killed|took|has)\b/i,
  ];

  let match;
  while ((match = addPattern.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.length > 5 && ARC_SIGNALS.some((p) => p.test(content)))
      toAdd.push({ content, ts: Date.now() });
  }

  while ((match = resolvedPattern.exec(text)) !== null) {
    const resolvedText = match[1].trim().toLowerCase();
    // Match against existing arcs using Jaccard word-overlap similarity.
    // A flat "overlap >= 2" count was brittle: short arcs with two shared
    // non-stop words would falsely co-resolve unrelated arcs, while word-form
    // differences (meet/met, promise/promised) caused genuine resolutions to
    // miss. A proportional similarity threshold handles both problems better.
    existingArcs.forEach((arc, idx) => {
      const arcWords = new Set(arc.content.toLowerCase().split(/\s+/).filter(Boolean));
      const resolvedWords = new Set(resolvedText.split(/\s+/).filter(Boolean));
      if (arcWords.size === 0 || resolvedWords.size === 0) return;
      const intersection = [...arcWords].filter((w) => resolvedWords.has(w)).length;
      const union = new Set([...arcWords, ...resolvedWords]).size;
      const similarity = intersection / union;
      // Threshold: require at least 25% Jaccard overlap. This is intentionally
      // permissive - the model already paraphrases the arc in the [resolved]
      // line so exact word matches are rare, but 25% rules out coincidental
      // two-word matches between completely unrelated arcs.
      if (similarity >= 0.25) toResolve.push(idx);
    });
  }

  // Deduplicate resolved indices in case multiple [resolved] lines matched the same arc.
  return { add: toAdd, resolve: [...new Set(toResolve)] };
}

// ---- Continuity check ---------------------------------------------------

// Phrases that indicate the model is saying "all clear" rather than listing
// contradictions. Local models often write verbose explanations instead of
// the single word "NONE" the prompt asks for.
const ALL_CLEAR_PATTERNS = [
  /\bno contradictions?\b/i,
  /\bno conflicts?\b/i,
  /\bdoes not contradict\b/i,
  /\bdoes not conflict\b/i,
  /\bconsistent with\b/i,
  /\baligns? with\b/i,
  /\bno issues? found\b/i,
];

/**
 * Parses the model's continuity check response into an array of contradiction strings.
 * Strips leading bullet/numbering characters. Returns an empty array if the
 * model responded with NONE or produced nothing usable.
 *
 * Only the first non-empty line is checked against all-clear phrases. This
 * prevents local models that write "No conflicts\n\nHere is my reasoning..."
 * from being treated as having found contradictions, while still allowing
 * responses whose first line is a real contradiction to be returned in full.
 *
 * @param {string} text - Raw model response.
 * @returns {string[]}
 */
export function parseContradictions(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  // Local models often write a verdict on the first line ("NO CONFLICTS",
  // "No contradictions found") followed by a verbose explanation, rather than
  // outputting NONE. Check only the first non-empty line so we don't
  // accidentally swallow a real contradiction response that happens to contain
  // an all-clear phrase mid-text.
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine && ALL_CLEAR_PATTERNS.some((p) => p.test(firstLine))) return [];

  return (
    text
      .split('\n')
      .map((line) => line.replace(/^[-•*\d.]+\s*/, '').trim())
      // Lines ending with ':' are section headers ("Here are the issues I found:"),
      // not contradictions. Filtering them prevents inflating the badge count.
      .filter((line) => line.length > 0 && !line.endsWith(':'))
  );
}

// ---- Summary formatting -------------------------------------------------

/**
 * Strips the <analysis> scratchpad block and unwraps the <summary> block
 * from the model's raw output. Falls back to the trimmed raw string if
 * no <summary> tags are present.
 *
 * Handles two truncation cases:
 * - Unclosed <analysis>: strips everything from <analysis> up to the first
 *   <summary> tag so analysis content does not bleed into the summary.
 * - Unclosed <summary>: extracts whatever content appeared after the opening
 *   tag rather than returning the entire raw string including the opening tag.
 *
 * @param {string} raw - Raw model output.
 * @returns {string} Cleaned summary text.
 */
export function formatSummary(raw) {
  // Strip analysis block - handle both closed and unclosed tags.
  // If the model didn't write </analysis>, strip everything from <analysis>
  // up to the first <summary> tag so it doesn't bleed into the summary content.
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  // Fallback: unclosed <analysis> - strip from tag to start of <summary>
  result = result.replace(/<analysis>[\s\S]*?(?=<summary>)/i, '').trim();
  // Try a complete <summary>...</summary> block first.
  const fullMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (fullMatch) {
    return fullMatch[1].trim();
  }
  // If the closing tag is missing the model was cut off mid-response.
  // Extract whatever content appeared after the opening tag rather than
  // falling back to the raw string which still contains the opening tag.
  const partialMatch = result.match(/<summary>([\s\S]*)/i);
  if (partialMatch) {
    return partialMatch[1].trim();
  }
  // Last resort: if the model omitted tags entirely, strip any preamble before
  // the first numbered section ("1." at the start of a line).
  const numberedStart = result.search(/^1\./m);
  if (numberedStart > 0) {
    return result.slice(numberedStart).trim();
  }

  return result;
}

// ---- Profile output parsing ---------------------------------------------

/**
 * Extracts character_state, world_state, and relationship_matrix from the
 * model's profile generation output. Looks for XML-style section tags:
 *
 *   <character_state>...</character_state>
 *   <world_state>...</world_state>
 *   <relationship_matrix>...</relationship_matrix>
 *
 * Returns null if none of the three sections are present (bad output).
 * Partial output (one or two sections found) is returned with the missing
 * sections as empty strings - a partial profile is better than no profile.
 *
 * @param {string} response - Raw model output from buildProfileGenerationPrompt.
 * @returns {{character_state: string, world_state: string, relationship_matrix: string}|null}
 */
export function parseProfileOutput(response) {
  if (!response) return null;

  /**
   * Extracts the content between a pair of XML-style tags.
   * @param {string} tag
   * @returns {string|null}
   */
  function extractSection(tag) {
    const m = response.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  }

  const character_state = extractSection('character_state');
  const world_state = extractSection('world_state');
  const relationship_matrix = extractSection('relationship_matrix');

  // All three missing = unusable response.
  if (!character_state && !world_state && !relationship_matrix) return null;

  return {
    character_state: character_state ?? '',
    world_state: world_state ?? '',
    relationship_matrix: relationship_matrix ?? '',
  };
}

// ---- Trigger keyword parser ---------------------------------------------

/**
 * Parses the comma-separated keyword list returned by buildTriggerGenerationPrompt.
 *
 * Filters out any token that is already a word in the memory content - the
 * model sometimes repeats content words despite the instruction. Also drops
 * tokens that are too short, too long, or contain no alphabetic characters.
 * Caps output at 6 entries in case the model over-generates.
 *
 * @param {string} response - Raw model response to the trigger generation prompt.
 * @param {string} memoryContent - The memory content the triggers are for.
 * @returns {string[]} Filtered, lowercased trigger tokens.
 */
export function parseTriggerResponse(response, memoryContent) {
  const contentWords = new Set(
    String(memoryContent || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  return String(response || '')
    .split(/[,\n]/)
    .flatMap((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/),
    )
    .filter((t) => t.length >= 3 && t.length <= 40 && /[a-z]/.test(t) && !contentWords.has(t))
    .slice(0, 8);
}

// ---- Relationship delta parser ------------------------------------------

// Matches lines like "Senjin -> Asher: warm(high), cautious(low)"
// The arrow can be -> or the unicode → character.
const RELATIONSHIP_LINE_RE = /^([^→-]+?)\s*(?:->|→)\s*([^:]+?)\s*:\s*(.+)$/;
// Matches the inline magnitude suffix: word(low|medium|high)
const INLINE_MAGNITUDE_RE = /\((\s*low|medium|high\s*)\)/i;
const MAGNITUDE_KEYWORDS = new Set(['low', 'medium', 'high']);
// Numeric order for magnitude comparison - used to resolve duplicate root words.
const MAGNITUDE_ORDER = { low: 0, medium: 1, high: 2 };
// Transitional phrases the model sometimes uses to describe change - strip them.
const TRANSITION_RE =
  /\b(?:then\s+(?:more\s+)?|increasingly\s+|still\s+|even\s+more\s+|becoming\s+(?:more\s+)?)/gi;
// Hedge words that should be stripped from descriptor words. Downgrading hedges
// ("slightly", "somewhat") force magnitude to low; upgrading hedges ("very",
// "deeply") force magnitude to high. The magnitude override only applies when
// no explicit inline magnitude was present in the token.
const DOWNGRADE_HEDGE_RE = /^(?:slightly|somewhat|a\s+bit|a\s+little|mildly)\s+/i;
const UPGRADE_HEDGE_RE = /^(?:very|extremely|deeply|intensely|profoundly)\s+/i;

/**
 * Parses the model's relationship delta response into an array of update objects.
 *
 * Each output object has the shape:
 *   { subject: string, target: string, updates: Array<{word, magnitude}>, removals: string[] }
 *
 * updates  - descriptors to add or update (with per-word magnitudes)
 * removals - descriptor words prefixed with ! that should be removed from the stored state
 *
 * Lines that do not match the expected format are silently skipped.
 * Output NONE from the model produces an empty array.
 *
 * @param {string} response - Raw model output from buildRelationshipDeltaPrompt.
 * @returns {Array<{subject: string, target: string, updates: Array<{word: string, magnitude: string}>, removals: string[]}>}
 */
export function parseRelationshipDeltaResponse(response) {
  const lines = String(response || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.toUpperCase() !== 'NONE');

  const results = [];
  for (const line of lines) {
    const match = RELATIONSHIP_LINE_RE.exec(line);
    if (!match) continue;

    const subject = match[1].trim();
    const target = match[2].trim();
    const rest = match[3].trim();

    const updates = [];
    const removals = [];

    for (const token of rest.split(',')) {
      const raw = token.trim();
      if (!raw) continue;

      // Removal marker: !descriptor
      if (raw.startsWith('!')) {
        const word = raw
          .slice(1)
          .replace(INLINE_MAGNITUDE_RE, '')
          .replace(TRANSITION_RE, '')
          .replace(/[^a-z\s-]/g, '')
          .trim()
          .toLowerCase();
        if (word) removals.push(word);
        continue;
      }

      // Parse inline magnitude: word(medium) or word (medium)
      const magMatch = INLINE_MAGNITUDE_RE.exec(raw);
      let magnitude = magMatch ? magMatch[1].trim().toLowerCase() : 'medium';
      let word = raw
        .replace(INLINE_MAGNITUDE_RE, '')
        .replace(TRANSITION_RE, '')
        .replace(/[^a-z\s-]/g, '')
        .trim()
        .toLowerCase();

      // Strip hedge words and adjust magnitude when no explicit magnitude was given.
      // "slightly nervous" → nervous(low); "very nervous" → nervous(high).
      if (!magMatch) {
        if (DOWNGRADE_HEDGE_RE.test(word)) {
          word = word.replace(DOWNGRADE_HEDGE_RE, '').trim();
          magnitude = 'low';
        } else if (UPGRADE_HEDGE_RE.test(word)) {
          word = word.replace(UPGRADE_HEDGE_RE, '').trim();
          magnitude = 'high';
        }
      } else {
        // Even with an explicit magnitude, strip the hedge from the word itself.
        word = word.replace(DOWNGRADE_HEDGE_RE, '').replace(UPGRADE_HEDGE_RE, '').trim();
      }

      if (word && !MAGNITUDE_KEYWORDS.has(word)) {
        updates.push({ word, magnitude });
      }
    }

    // Deduplicate updates by root word: hedge normalization can produce the same
    // word twice with different magnitudes (e.g. "slightly nervous(medium)" and
    // "nervous(medium)" both survive the token loop). Keep only the highest magnitude.
    const deduped = new Map();
    for (const { word, magnitude } of updates) {
      const existing = deduped.get(word);
      if (!existing || MAGNITUDE_ORDER[magnitude] > MAGNITUDE_ORDER[existing.magnitude]) {
        deduped.set(word, { word, magnitude });
      }
    }
    const dedupedUpdates = [...deduped.values()];

    if (subject && target && (dedupedUpdates.length > 0 || removals.length > 0)) {
      results.push({ subject, target, updates: dedupedUpdates, removals });
    }
  }
  return results;
}

// ---- Scene break heuristics ---------------------------------------------

// Patterns that reliably signal a scene transition in roleplay prose.
// Grouped by category for easier tuning: time skips, location transitions,
// and explicit separator markers authors use between scenes.
const SCENE_BREAK_PATTERNS = [
  // Time skips - relative (hours/days/weeks/months/years later)
  // "that evening/night/morning" removed - too broad, fires on incidental
  // references like "that morning he made breakfast" within the same scene.
  /\b(later that (day|night|evening|morning)|the next (day|morning|evening|night)|hours later|days later|weeks later|months later|years? later|a (few )?(hours?|days?|weeks?|months?|years?) (later|passed|had passed)|the following (day|morning|week|month|year)|some time later|meanwhile|after (a while|some time))\b/i,
  // Time skips - absolute jumps ("a year passed", "three months went by")
  /\b(a (year|month|week|decade)|several (years?|months?|weeks?|days?)|[a-z]+ (years?|months?|weeks?|days?) (passed|went by|had passed|had gone by))\b/i,
  // Location transitions - arriving at a named or distinct new place.
  // Deliberately narrow: "entered the room" is not a scene break, but
  // "arrived at the castle" or "found herself in a foreign city" is.
  /\b(arrived at (the|a|an)\s+\w+|found (himself|herself|themselves|myself|yourself) (in|at) (a|an|the)\s+\w+|made (his|her|their|my|your) way (to|into) (the|a|an)\s+\w+|fled (to|into) (the|a|an)\s+\w+|escaped (to|into) (the|a|an)\s+\w+)\b/i,
  // Location transitions - establishing a new base or camp.
  /\b(settled (in|into|down in)|made (a|his|her|their|my) (home|camp|base) (in|at)|took (shelter|refuge) (in|at|among))\b/i,
  // Dawn/dusk transitions implying time passage through sleep or rest.
  /\b(as (dawn|morning|daylight|the sun) (broke|crept|arrived|filtered through|rose|spread)|when (dawn|morning) (came|broke|arrived))\b/i,
  /\b(as (night|darkness|dusk|evening) (fell|settled|crept|arrived|descended)|when (night|darkness|dusk) (came|fell|settled))\b/i,
  // Sleep/wake transitions - only fire when waking implies overnight passage
  // (dawn/morning/light/sun variants). "Woke from sleep" and "woke to find"
  // are too broad and fire on brief naps mid-scene.
  /\b((woke|stirred|roused) (as (dawn|morning|light)|with the (sun|light|dawn)))\b/i,
  // Explicit separator markers (---, ***, * * *)
  /^[-*~]{3,}$/m,
  /\*\s*\*\s*\*/,
];

/**
 * Checks the message text against known scene-break patterns.
 * Fast and free - no model call required.
 * @param {string} messageText - The last AI message to inspect.
 * @returns {boolean} True if a scene break pattern is detected.
 */
export function detectSceneBreakHeuristic(messageText) {
  return SCENE_BREAK_PATTERNS.some((pattern) => pattern.test(messageText));
}

// ---- Epistemic extraction parser ----------------------------------------

// Matches: [hiding] Concealer from Target | content
const EPISTEMIC_HIDING_RE = /^\[hiding\]\s+(.+?)\s+from\s+(.+?)\s*\|\s*(.+)$/i;
// Matches: [tag] Subject | content  (for knows/unaware/suspects/believes)
const EPISTEMIC_STANDARD_RE = /^\[(\w+)\]\s+(.+?)\s*\|\s*(.+)$/i;
const EPISTEMIC_VALID_TYPES = new Set(['knows', 'unaware', 'suspects', 'believes', 'hiding']);

/**
 * Parses the output of an epistemic extraction prompt into structured entries.
 *
 * Handles two line shapes:
 * - Standard: `[tag] Character | content`
 * - Hiding:   `[hiding] Concealer from Target | content`
 *
 * Lines that do not match either pattern, start with '#' or '-' (model notes),
 * or carry an unrecognised tag are silently skipped. Output 'NONE' returns an
 * empty array.
 *
 * @param {string} text - Raw model output.
 * @returns {Array<{type: string, subject: string, target: string|null, content: string}>}
 */
export function parseEpistemicResponse(text) {
  if (!text || text.trim().toUpperCase() === 'NONE') return [];

  const entries = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;

    // Try hiding pattern first - it has a more specific structure.
    let match = EPISTEMIC_HIDING_RE.exec(line);
    if (match) {
      entries.push({
        type: 'hiding',
        subject: match[1].trim(),
        target: match[2].trim(),
        content: match[3].trim(),
      });
      continue;
    }

    match = EPISTEMIC_STANDARD_RE.exec(line);
    if (match) {
      const type = match[1].toLowerCase();
      if (!EPISTEMIC_VALID_TYPES.has(type)) continue;
      entries.push({
        type,
        subject: match[2].trim(),
        target: null,
        content: match[3].trim(),
      });
    }
  }

  return entries;
}
