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
 * All prompt strings for Smart Memory. No logic lives here.
 *
 * Static exports are ready-to-use prompt strings. Builder functions accept
 * runtime values and return the assembled prompt string.
 *
 * buildSummaryPrompt           - assembles the full compaction prompt (first-time summary)
 * buildUpdateSummaryPrompt     - assembles the progressive update prompt (extends existing summary)
 * RECAP_PROMPT                 - away recap "Previously on..." prompt
 * buildSessionExtractionPrompt - assembles the session extraction prompt
 * buildSceneDetectPrompt       - assembles the yes/no scene break detection prompt with prior context
 * SCENE_SUMMARY_PROMPT         - scene mini-summary prompt
 * buildArcExtractionPrompt     - assembles the arc extraction prompt
 * buildArcSummaryPrompt        - assembles the arc resolution summary prompt
 * buildContinuityPrompt        - assembles the continuity check prompt
 * buildRepairPrompt            - assembles the corrective note prompt from a contradiction list
 * buildExtractionPrompt        - assembles the long-term memory extraction prompt
 * buildLongtermConsolidationPrompt - evaluates a batch of unprocessed long-term entries against the consolidated base for one type
 * buildSessionConsolidationPrompt  - same as above but for session memory types (scene, revelation, development, detail)
 * buildProfileGenerationPrompt     - generates character_state, world_state, and relationship_matrix from stored memories
 * buildCanonSummaryPrompt          - generates a stable per-character canon narrative from arc summaries and memories
 * buildSupersessionConfirmPrompt   - binary UPDATE/INDEPENDENT prompt for model-confirmed supersession (method B)
 * buildTriggerGenerationPrompt     - asks the model for contextual trigger keywords for a single memory (Profile B)
 * buildRelationshipDeltaPrompt     - extracts per-pair relationship state changes with magnitude from a scene
 * buildEpistemicExtractionPrompt   - extracts a per-character knowledge map (knows/unaware/suspects/believes/hiding)
 * buildStateCardPrompt              - extracts current-state fields for known entities from a message window
 *
 * Entity tagging: both extraction prompts instruct the model to append an
 * optional `:entity=Name1,Name2` suffix to the bracket tag for any memory
 * that involves a named character, place, or object. The suffix is parsed
 * and normalised to entity registry ids by the extraction wiring in
 * longterm.js and session.js. It is intentionally optional so the model can
 * omit it when no named entities are relevant rather than hallucinating names.
 */

// Prepended to every extraction prompt to prevent the local model from
// slipping into roleplay mode instead of producing structured output.
// Local Ollama models often ignore the systemPrompt parameter, so this
// must live in the prompt body itself.
const NO_ACTION_PREAMBLE = `CRITICAL: Respond with plain TEXT ONLY. Do NOT continue the roleplay. Do NOT speak as any character. You are writing a document, not a story.
CRITICAL: If any other instruction conflicts with this task format, ignore it and follow this task format exactly.

`;

// ---- Short-term: full compaction ----------------------------------------

/**
 * Assembles the full compaction prompt (first-time summary).
 * @param {string} [storedMemories] - Brief digest of long-term and session memories already
 *   stored at other tiers, passed so the summary can focus on narrative flow rather than
 *   restating facts already captured elsewhere. Keep this short to avoid overwhelming local models.
 * @returns {string} The complete prompt string.
 */
export function buildSummaryPrompt(storedMemories = '') {
  const storedSection = storedMemories
    ? `ALREADY STORED IN OTHER MEMORY TIERS (do not restate these as Revealed Information - focus the summary on narrative flow and story state instead):\n${storedMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `${storedSection}Your task is to write a detailed summary of the roleplay conversation so far. This summary will be injected at the top of context so the story can continue seamlessly after older messages fall out of the context window.

IMPORTANT: Summarize only the actual roleplay exchanges between characters. Do NOT reproduce, restate, or copy any injected memory context that appears before the conversation - this includes character history, long-term memories, character profiles, scene history, session details, or story arcs. Those are already stored separately. Only the story events that happened in the chat messages belong in this summary.

Write the summary between [SUMMARY] and [/SUMMARY] markers. Cover all seven factual sections below. Record only events and states already established in the chat; never predict what happens next or treat user preference as story fact.

[SUMMARY]
1. Scene & Setting: Current location, time of day, atmosphere, and any relevant environmental details.

2. Characters Present: Who is involved, their current emotional state, disposition, and demeanor.

3. Key Events: What happened during this conversation, in chronological order. Be specific.

4. Relationship Dynamics: The current state of the relationship(s) between characters - trust, tension, affection, history.

5. Revealed Information: New facts that came to light THIS session that are NOT already stored elsewhere.

6. Story Threads: Unresolved tensions, promises made, questions raised, or ongoing conflicts.

7. Current Moment: Precisely where the story was at the moment this summary was triggered - what was just said or done.
[/SUMMARY]`
  );
}

// ---- Short-term: progressive update -------------------------------------

/**
 * Assembles the progressive update prompt (extends existing summary).
 * @param {string} [storedMemories] - Brief digest of long-term and session memories already
 *   stored at other tiers. Same purpose as in buildSummaryPrompt.
 * @returns {string} The complete prompt string.
 */
export function buildUpdateSummaryPrompt(storedMemories = '') {
  const storedSection = storedMemories
    ? `ALREADY STORED IN OTHER MEMORY TIERS (do not restate these as Revealed Information):\n${storedMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `${storedSection}An existing story summary is provided below, followed by new events that occurred after it. Your task is to update the summary by incorporating the new events.

IMPORTANT: Summarize only the actual roleplay exchanges between characters. Do NOT reproduce, restate, or copy any injected memory context - this includes character history, long-term memories, character profiles, scene history, session details, or story arcs. Those are already stored separately. Only story events from the chat messages belong in this summary.

CRITICAL: You must reproduce every factual section in full. Do NOT write "Same as before", "Unchanged", "As previously noted", or any similar shorthand. The existing summary will not be available after this update - any section you omit or abbreviate is permanently lost. Do not predict future events or place suggestions, likely actions, or user direction in this factual summary.

Section update rules - follow these exactly:
- Section 1 (Scene & Setting): REWRITE to describe the current location, time, and atmosphere only. Do not accumulate past locations.
- Section 2 (Characters Present): REWRITE to describe each character's current state, mood, and disposition only. Do not append "now X, now Y" chains - replace the previous description entirely with where they are NOW.
- Section 3 (Key Events): APPEND new events to the existing list. Keep all prior events.
- Section 4 (Relationship Dynamics): REWRITE to reflect the current state of relationships.
- Section 5 (Revealed Information): APPEND any newly revealed facts. Keep all prior entries.
- Section 6 (Story Threads): UPDATE - add new threads, mark resolved ones as resolved.
- Section 7 (Current Moment): REWRITE to describe precisely where the story is right now.

EXISTING SUMMARY:
{{existing_summary}}

NEW EVENTS TO INCORPORATE:
{{new_events}}

Write the complete updated summary between [SUMMARY] and [/SUMMARY] markers using the same 7-section factual format. Reproduce all seven sections in full.

[SUMMARY]
1. Scene & Setting:
2. Characters Present:
3. Key Events:
4. Relationship Dynamics:
5. Revealed Information:
6. Story Threads:
7. Current Moment:
[/SUMMARY]`
  );
}

// ---- Away recap ---------------------------------------------------------

export const RECAP_PROMPT =
  NO_ACTION_PREAMBLE +
  `You are writing a brief "Previously on..." recap for someone returning to this story after being away. Based on the conversation so far, write a short engaging recap (3-5 sentences) in a warm narrative voice, past tense, as if summarizing a story episode. Focus on the most recent developments and where things were left off. Do not list facts - tell it briefly as a story. Output only the recap text. No notes, no commentary, no disclaimers.`;

// ---- Session memory -----------------------------------------------------

/**
 * Assembles the session memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingSession - Already-recorded session items (may be empty).
 * @param {string} [longtermMemories] - Already-stored long-term memories (may be empty).
 *   Passed so the model can skip facts already captured at the long-term tier.
 * @returns {string} The complete prompt string.
 */
export function buildSessionExtractionPrompt(chatHistory, existingSession, longtermMemories = '', canonicalRoster = '') {
  const existingSection = existingSession
    ? `ALREADY RECORDED THIS SESSION (do not duplicate):\n${existingSession}\n\nIf something from this list has CHANGED, extract the updated version using explicit state-change language ("now", "no longer", "became", "stopped", etc.) so it can supersede the outdated entry rather than accumulating alongside it.\n\n`
    : '';

  const longtermSection = longtermMemories
    ? `ALREADY IN LONG-TERM MEMORY (do not re-extract these - they are already stored):\n${longtermMemories}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY EXTRACTION - Do NOT roleplay. Output structured data only.]

${canonicalRoster}${longtermSection}${existingSection}RECENT EXCHANGES:\n${chatHistory}

---
Extract NEW details worth remembering within this session. Focus on session-specific context: scene details, emotional beats, specific objects/names/places, and how things developed THIS session. Do not re-extract facts already in long-term memory.

SKIP these - they do not belong in session memory:
- Transient physical state that won't outlast this moment (stained clothes, spilled food, current body positions)
- Generic atmosphere descriptions without story significance
- Anything already captured in long-term memory above

DO capture persistent physical anchors even if they feel minor - wounds sustained, physical features described for the first time, notable features of a named location, significant objects referenced by name. These ground the continuity checker.

Types:
- scene       - current or recently completed scene details (location, atmosphere, time, spatial layout)
- revelation  - something revealed or discovered in this exchange
- development - how the relationship or situation changed
- detail      - specific facts, names, objects, or physical details mentioned (e.g. "The whiskey is Dragon's Fire brand", "The inn has a locked cellar door", "She has green eyes")

SCORING CRITERIA:
- 1: Atmospheric or minor flavor detail
- 2: Useful context or meaningful update
- 3: Critical change, pivotal revelation, or defining moment

EXPIRATION CLASS (choose one):
- scene      - likely irrelevant after this scene transition
- session    - useful for this current chat/session
- permanent  - should persist as a durable memory

ENTITY TAGGING (optional but encouraged):
If the memory involves specific NAMED entities, append :entity=Name/type pairs inside the bracket. Use exact names from the conversation only. Classify each as: character, place, object, faction, or concept. Do not tag generic nouns unless they have a specific name in the conversation. Omit this field if no named entities are relevant.

GROUNDING RULES: Never copy names, facts, objects, relationships, or events from these instructions or examples. Use only details supported by the supplied conversation or grounded memories. Every entity name must appear in the supplied conversation or existing-entity list.

The supplied conversation messages are numbered from 0 upward. Every output item MUST include one or more source message indices from that numbered excerpt. Do not emit an item without supporting source indices. Use only indices shown in the source excerpt. The source field is mandatory: write :sources=1,2 inside every bracket. If no message supports a claim, omit it.

One item per line, exact format:
[scene:2:scene:sources=0] <ENTITY_A> is at <LOCATION> during the current scene.
[detail:3:permanent:entity=<ENTITY_A>/character:sources=0] <ENTITY_A> has the explicitly described <EXPLICIT_OBJECT>.
[revelation:3:permanent:entity=<ENTITY_A>/character,<ENTITY_B>/character:sources=0,2] <ENTITY_A> revealed the stated relationship to <ENTITY_B>.
[revelation:1:session:sources=0] A minor event explicitly mentioned in the conversation occurred.

FINAL RULE: Output ONLY [type:score:expiration:sources=0] or [type:score:expiration:entity=Name/type:sources=0,2] lines. No headers. No intros. No explanations.
If nothing new, output exactly: NONE`
  );
}

// ---- Scene break detection ----------------------------------------------

/**
 * Assembles the scene break detection prompt.
 * Providing the previous message as context lets the model distinguish a
 * transition from a continuation of the same scene.
 * @param {string} currentMessage - The latest AI message to evaluate.
 * @param {string} [previousMessage] - The preceding AI message, if available.
 * @returns {string} The complete yes/no detection prompt.
 */
export function buildSceneDetectPrompt(currentMessage, previousMessage) {
  const prevSection = previousMessage
    ? `PREVIOUS MESSAGE (for context - the scene that just ended or is continuing):\n${previousMessage.slice(0, 1000)}\n\n`
    : '';

  return `${prevSection}CURRENT MESSAGE:
${currentMessage.slice(0, 1200)}

---
Did the CURRENT MESSAGE mark the start of a new scene?

A NEW SCENE starts when:
- Time has passed - sleep, waking up, dawn breaking, or any gap between the previous and current message
- The characters have moved to a different location (a new room, building, outdoor area, or setting)
- A hard narrative break occurs (transition, loss of consciousness then recovery, etc.)
- The person the main character is alone with or intimate with has changed (a previous partner has left and a new one has arrived)

NOT a new scene:
- Action, combat, or drama continuing in the same location and moment
- Emotional beats or dialogue within the same continuous encounter
- The story picking up seconds or minutes after the previous message with no location change

Answer YES or NO only. Nothing else.`;
}

export const SCENE_SUMMARY_PROMPT =
  NO_ACTION_PREAMBLE +
  `Write a 2-3 sentence summary of the following scene for use as scene history. Write in past tense, narrative style. Capture what happened, where, and the emotional tone. Then list only the named CHARACTERS who actively participated. Do not list places, objects, organizations, or concepts. Use participant names exactly as supplied in the scene. Do not use old persona names, inferred surnames, collective labels, or parenthetical identity labels.

Output exactly:
[SCENE]
<summary>
[/SCENE]
[CHARACTERS]
Name One, Name Two
[/CHARACTERS]

SCENE:
{{scene_text}}`;

/** Adds the authoritative participant roster to a scene-summary request. */
export function buildSceneSummaryPrompt(sceneText, canonicalRoster = '') {
  return `${canonicalRoster}${SCENE_SUMMARY_PROMPT.replace('{{scene_text}}', String(sceneText ?? ''))}`;
}

// ---- Story arcs ---------------------------------------------------------

/**
 * Assembles the story arc extraction prompt.
 * @param {string} chatHistory - Formatted conversation messages.
 * @param {string} existingArcs - Already-tracked arcs as [arc] lines (may be empty).
 * @returns {string} The complete prompt string.
 */
export function buildArcExtractionPrompt(chatHistory, existingArcs, canonicalRoster = '') {
  const existingSection = existingArcs
    ? `EXISTING OPEN ARCS (read-only context - do not copy, annotate, or re-output these):\n${existingArcs}\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[STORY ARC EXTRACTION - Do NOT roleplay. Output structured data only.]

${canonicalRoster}${existingSection}CONVERSATION:\n${chatHistory}

---
Extract the most significant open story threads from the conversation: unresolved conflicts, unfulfilled promises, active character goals, open mysteries, and tensions that have not yet played out. Aim for the 3-5 threads that matter most to the story - do not list every detail that has not resolved.

An arc is something still in motion across the story - a question not yet answered, a goal not yet reached, a conflict still active. Do NOT output facts about things that already happened and are over.
An arc must state what remains unresolved, pending, unknown, promised, required, or undecided. Use canonical participant names only; never use synthetic parenthetical identity labels.

Before outputting [arc], apply this gate: could this entry still change what happens next? If the answer is no, it is a completed event or established fact, not an arc. A past event is allowed only when it directly leaves a named question, goal, promise, conflict, threat, or mystery still open.

These are NOT arcs - do not output them:
- Tactical details or logistical information ("the south gate is unguarded after midnight")
- Single-scene contingencies that may or may not become relevant
- Consequences or sub-threads of the same arc - group them into one entry
- Facts about events that already occurred, even dramatic ones

Output format - one entry per line, two tags allowed:
  [arc:characters=Name One,Name Two] <new unresolved thread from this conversation, not already listed above>
  [resolved] <title or brief description of an existing arc that was explicitly closed>

Examples (abstract only; never copy these details):
  [arc:characters=<ENTITY_A>,<ENTITY_B>] <ENTITY_A> made an unresolved threat against <ENTITY_B>.
  [arc] The identity of whoever burned the granary is still unknown.
  [resolved] The missing heir was found alive in the northern keep.
  NOT an arc: "Kira was captured by the guards." - this is a fact, not an open thread.
  NOT an arc: "Kira escaped the guards and returned home." - this is a completed event, not an open thread.
  NOT an arc: "The back door is unlocked." - this is a tactical detail, not a story thread.

Only output [arc] for threads that are NEW in this conversation - do not re-output existing arcs.
Only mark [resolved] if the conversation directly closes the arc - a promise kept, a mystery answered, a conflict ended. A related revelation is NOT a resolution. If new information makes an existing arc more urgent or complicated, it stays open.

Discussion, delay, partial progress, emotional reaction, or new information alone never resolves an arc. Use canonical participant names exactly and do not use obsolete persona aliases.

If nothing new and nothing resolved, output: NONE`
  );
}

// ---- Continuity check ---------------------------------------------------

/**
 * Assembles the arc summary prompt for a resolved story arc.
 * The summary covers the full thread from opening through resolution.
 *
 * @param {string} arcContent - The resolved arc's content string.
 * @param {string} sceneSummaries - Joined scene summaries that occurred during the arc.
 * @param {string} memories - Key memories from the arc (formatted as [type] content lines).
 * @returns {string} The complete prompt string.
 */
export function buildArcSummaryPrompt(arcContent, sceneSummaries, memories, canonicalRoster = '') {
  const memSection = memories ? `\nKEY MEMORIES FROM THIS ARC:\n${memories}\n` : '';
  const sceneSection = sceneSummaries ? `\nSCENE SUMMARIES:\n${sceneSummaries}\n` : '';

  return (
    NO_ACTION_PREAMBLE +
    `[RESOLVED ARC SUMMARY - Do NOT roleplay. Output factual data only.]

Write one concise factual paragraph explaining how this specific arc was resolved. Use only the supplied evidence and canonical participant names. Do not introduce new people, old aliases, renamed participants, relationships, motives, backstory, time spans, locations, occupations, family history, abuse, death, injury, marriage, romance, ownership, or betrayal facts. Do not generalize from story patterns, explain what the arc symbolizes, or continue the story. Do not infer a failure or negation from missing evidence.

If the supplied evidence does not clearly show a resolution, output exactly: NONE

Output one concise factual paragraph and nothing else.

[CANONICAL PARTICIPANTS]
${canonicalRoster || '(none supplied)'}

[ARC]
${arcContent}${sceneSection}${memSection}`
  );
}

/** Protected classifier used before any arc can enter the resolved-summary path. */
export function buildArcResolutionClassifierPrompt({ canonicalParticipants = '', arc = '', history = '', evidence = '', scenes = '' }) {
  return NO_ACTION_PREAMBLE + `[ARC RESOLUTION CLASSIFIER]

Determine the current status of one story arc using only the supplied evidence.
Output exactly one label:
RESOLVED
STILL_OPEN
ABANDONED
SUPERSEDED
INSUFFICIENT_EVIDENCE

RESOLVED requires an explicit outcome for the central question, conflict,
promise, obligation, or goal. STILL_OPEN means it remains active despite
discussion, delay, partial progress, emotion, or new information. ABANDONED
requires explicit evidence that it was not pursued or became irrelevant.
SUPERSEDED requires a clearly replacing arc. Do not infer, summarize, or
explain. Silence is not resolution, abandonment, or failure.

[CANONICAL PARTICIPANTS]
${canonicalParticipants || '(none supplied)'}

[ARC]
${arc}

[ARC HISTORY]
${history || '(none supplied)'}

[RECENT RESOLUTION EVIDENCE]
${evidence || '(none supplied)'}

[LINKED SCENES]
${scenes || '(none supplied)'}`;
}

/** Builds the protected one-label verifier prompt for a derived arc summary. */
export function buildArcSummaryVerificationPrompt({ canonicalParticipants = '', arc = '', scenes = '', memories = '', candidate = '' }) {
  return (
    NO_ACTION_PREAMBLE +
    `[ARC SUMMARY VERIFICATION]

You are validating a resolved story-arc summary against evidence. Use only the supplied evidence.

Classify the candidate summary as exactly one label:
SUPPORTED - every material claim and named participant is supported.
AMBIGUOUS - a material claim may be plausible but is not clearly established.
UNSUPPORTED - it introduces, changes, or misattributes people, relationships, events, motives, time spans, or outcomes.

Do not infer, repair, explain, or output anything except SUPPORTED, AMBIGUOUS, or UNSUPPORTED.

[CANONICAL PARTICIPANTS]
${canonicalParticipants}

[ARC]
${arc}

[LINKED SCENES]
${scenes}

[LINKED MEMORIES]
${memories}

[CANDIDATE SUMMARY]
${candidate}`
  );
}

/**
 * Assembles the continuity check prompt.
 * @param {string} establishedFacts - Combined summary + memories as a text block.
 * @param {string} latestResponse - The last AI message to check against the facts.
 * @returns {string} The complete prompt string.
 */
export function buildContinuityPrompt(establishedFacts, latestResponse) {
  return (
    NO_ACTION_PREAMBLE +
    `[CONTINUITY CHECK - Do NOT roleplay. Identify contradictions only.]

ESTABLISHED FACTS (from memories and summary):
${establishedFacts}

LATEST STORY RESPONSE:
${latestResponse}

---
Does the latest response contradict or conflict with any established fact? List each contradiction precisely and briefly. If there are none, output: NONE`
  );
}

// ---- Continuity repair --------------------------------------------------

/**
 * Assembles the prompt that turns a list of detected contradictions into a
 * short corrective context note, ready to inject before the next AI turn.
 * @param {string[]} contradictions - Array of contradiction descriptions from parseContradictions.
 * @param {string} establishedFacts - Combined summary + memories as a text block.
 * @returns {string} The complete prompt string.
 */
export function buildRepairPrompt(contradictions, establishedFacts) {
  const numbered = contradictions.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return (
    NO_ACTION_PREAMBLE +
    `[CONTINUITY REPAIR TASK - Do NOT roleplay. Write a corrective context note only.]

The following contradictions were found in the last AI response:
${numbered}

Established facts for reference:
${establishedFacts}

---
Write a brief, direct correction note (2-4 sentences) to be injected as a system reminder before the next response. Use second person ("Note:" or "Correction:"). State only the facts that were wrong and what the correct information is. Do not narrate or continue the story.`
  );
}

// ---- Long-term memory consolidation -------------------------------------

/**
 * Assembles the long-term memory consolidation prompt.
 *
 * Shows the stable consolidated base for a single type as read-only context,
 * then a small batch of unprocessed entries. The model classifies each
 * unprocessed entry as: duplicate (drop it), new detail (fold into an existing
 * base entry), or genuinely new (keep as-is). Output is only the entries to
 * ADD to the base - never the base itself.
 *
 * @param {string} type - Memory type being consolidated ('fact', 'relationship', 'preference', 'event').
 * @param {string} baseText - Existing consolidated base for this type as [type] content lines (may be empty).
 * @param {string} batchText - Unprocessed entries to evaluate as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildLongtermConsolidationPrompt(type, baseText, batchText) {
  const baseSection = baseText
    ? `EXISTING BASE ENTRIES (context only - do not output these unless updating one):\n${baseText}\n\n`
    : `EXISTING BASE ENTRIES: (none yet for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry, work through these steps in order:

Step 1 - Find the base entry whose subject most closely matches the new entry.
Step 2 - If a match exists and the new entry adds no information not already in that base entry: DROP IT. Output nothing for this entry.
Step 3 - If a match exists and the new entry adds genuinely new detail about the same subject: output ONE merged line that folds all unique details from both into a single concise statement. Do NOT output the original base entry - only the merged replacement.
Step 4 - If no base entry covers the same subject at all: output the new entry as-is.

Rules:
- SAME SUBJECT = same person, physical feature, relationship, or fact, even if worded differently. "Roderick is a ranger" and "Roderick is a seasoned ranger who prefers solitude" are the same subject.
- When merging, rewrite as one unified statement - do not append details with "also" or "additionally".
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- Never copy names, facts, objects, relationships, or events from these instructions or examples.
- One line per distinct subject.

Scoring for output entries:
- importance 1: minor flavor detail, 2: useful context, 3: critical trait or major event
- expiration: scene (fades after scene), session (fades after chat), permanent (durable fact)

Output ONLY the entries to ADD or UPDATE in the base, one per line.

Example output (abstract only; never copy these details):
[fact:3:permanent] <ENTITY_A> has an explicitly stated past loss.
[relationship:2:permanent] <ENTITY_A> has the stated relationship with <ENTITY_B>.

FINAL RULE: Output ONLY [${type}:score:expiration] lines. No headers. No intros. No explanations.
If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Session memory consolidation ---------------------------------------

/**
 * Assembles the session memory consolidation prompt.
 *
 * Same approach as long-term consolidation but uses session memory types
 * (scene, revelation, development, detail). Operates per-type on a small
 * batch of unprocessed entries evaluated against the stable consolidated base.
 *
 * @param {string} type - Session memory type ('scene', 'revelation', 'development', 'detail').
 * @param {string} baseText - Existing consolidated base for this type as [type] content lines (may be empty).
 * @param {string} batchText - Unprocessed entries to evaluate as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildSessionConsolidationPrompt(type, baseText, batchText) {
  const baseSection = baseText
    ? `EXISTING BASE ENTRIES (context only - do not output these unless updating one):\n${baseText}\n\n`
    : `EXISTING BASE ENTRIES: (none yet for this type)\n\n`;

  return (
    NO_ACTION_PREAMBLE +
    `[SESSION MEMORY CONSOLIDATION TASK - Do NOT roleplay. Output structured data only.]

${baseSection}NEW ENTRIES TO EVALUATE (type: ${type}):
${batchText}

---
For each new entry, work through these steps in order:

Step 1 - Find the base entry whose subject most closely matches the new entry.
Step 2 - If a match exists and the new entry adds no information not already in that base entry: DROP IT. Output nothing for this entry.
Step 3 - If a match exists and the new entry adds genuinely new detail about the same subject: output ONE merged line that folds all unique details from both into a single concise statement. Do NOT output the original base entry - only the merged replacement.
Step 4 - If no base entry covers the same subject at all: output the new entry as-is.

Rules:
- SAME SUBJECT = same scene, event, or detail, even if worded differently.
- When merging, rewrite as one unified statement - do not append details with "also" or "additionally".
- NEW information OVERRIDES outdated or conflicting base information.
- Never invent information not present in the base or new entries.
- Never copy names, facts, objects, relationships, or events from these instructions or examples.
- One line per distinct subject.

Scoring for output entries:
- importance 1: passing detail, 2: useful session context, 3: pivotal moment or key revelation
- expiration: scene (fades after scene transition), session (relevant for this chat only), permanent (durable across sessions)

Output ONLY the entries to ADD or UPDATE in the base, one per line.

Example output (abstract only; never copy these details):
[scene:2:session] The explicitly described scene context.
[detail:1:session] <ENTITY_A> left <EXPLICIT_OBJECT> at <LOCATION>.

FINAL RULE: Output ONLY [${type}:score:expiration] lines. No headers. No intros. No explanations.
If all new entries are duplicates and nothing needs to be added, output exactly: NONE`
  );
}

// ---- Profile generation -------------------------------------------------

/**
 * Assembles the profile generation prompt.
 *
 * Asks the model to produce three sections from stored memories:
 *   character_state  - current goals, emotional posture, fears, loyalties
 *   world_state      - current location, threats, unresolved events, time context
 *   relationship_matrix - one line per named entity with directional state + confidence
 *
 * All three sections are requested in one call to avoid extra model round-trips
 * on local hardware. Output uses XML-style tags so the parser can locate each
 * section independently even if the model adds surrounding text.
 *
 * @param {string} characterName - Active character name.
 * @param {string} longtermMemories - Active long-term memories as [type] content lines.
 * @param {string} sessionMemories  - Active session memories as [type] content lines (may be empty).
 * @param {Array<{name: string, type: string}>} [entities] - Known entities for the relationship matrix.
 * @returns {string} The complete prompt string.
 */
export function buildProfileGenerationPrompt(
  characterName,
  longtermMemories,
  sessionMemories,
  entities = [],
  canonicalRoster = '',
  relationshipHistory = {},
) {
  const ltSection = longtermMemories
    ? `LONG-TERM MEMORIES:\n${longtermMemories}\n\n`
    : 'LONG-TERM MEMORIES: (none yet)\n\n';

  const sessSection = sessionMemories
    ? `SESSION MEMORIES:\n${sessionMemories}\n\n`
    : 'SESSION MEMORIES: (none yet)\n\n';

  const entitySection =
    entities.length > 0
      ? `KNOWN ENTITIES: ${entities.map((e) => `${e.name} (${e.type})`).join(', ')}\n\n`
      : '';

  const charLabel = characterName || 'the character';
  const relationshipEvidence = Object.values(relationshipHistory ?? {})
    .map((state) => {
      const subject = String(state?.subject_name ?? '').trim();
      const target = String(state?.target_name ?? '').trim();
      const descriptors = (state?.descriptors ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.word).filter(Boolean);
      return subject && target && descriptors.length ? `${subject} -> ${target}: ${descriptors.join(', ')}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const relationshipSection = relationshipEvidence ? `RELATIONSHIP HISTORY (authoritative current descriptors):\n${relationshipEvidence}\n\n` : '';

  return (
    NO_ACTION_PREAMBLE +
    `[PROFILE GENERATION TASK - Do NOT roleplay. Output structured data only.]

${canonicalRoster}${ltSection}${sessSection}${entitySection}${relationshipSection}Generate a compact current state snapshot for the active roleplay character "${charLabel}". Base everything strictly on the approved evidence above. The evidence is chronological: when two facts conflict, use the later active fact and do not revive retired or superseded circumstances. Do not infer new goals, relationships, personality traits, or world developments. Omit unsupported fields rather than guessing. Never phrase a current-state claim as speculation (for example, "likely", "perhaps", "seems", "might", or "could be"); omit it instead.

Output exactly three sections using these tags. Keep every field to one line. Write factually:

<character_state>
Goals: [current goals and motivations]
Emotional posture: [current emotional state - e.g. stable, anxious, in love, grieving]
Active fears: [active fears or unresolved tensions, or "none identified"]
Loyalties: [current loyalties and commitments]
</character_state>

<world_state>
Location: [current location and atmosphere]
Threats: [active threats or pressures, or "none identified"]
Unresolved: [unresolved events or open situations, or "none identified"]
Time: [time context - time of day, season, elapsed time since a key event, or "unknown"]
</world_state>

<relationship_matrix>
[EntityName] ([type]): [directional one-line state] [confidence: 0.X]
(one line per entity from the KNOWN ENTITIES list; omit this section entirely if no entities are known)
For each relationship line, use at least one exact descriptor from RELATIONSHIP HISTORY for that same pair. Do not upgrade, reinterpret, or substitute a status (for example, do not turn "trust" into "romantic" or "family"). If that pair has no listed descriptor, omit the line.
</relationship_matrix>`
  );
}

/** Repairs formatting only; it must never add or reinterpret profile evidence. */
export function buildProfileFormatRepairPrompt(rawOutput) {
  return (
    NO_ACTION_PREAMBLE +
    `[PROFILE FORMAT REPAIR]

Reformat the supplied profile output into these exact sections only:
<character_state>...</character_state>
<world_state>...</world_state>
<relationship_matrix>...</relationship_matrix>

Copy only claims already present in the supplied output. Do not infer, complete,
correct, merge, or add any facts. Leave a section empty if it has no content.
Output only the three tags.

[UNFORMATTED PROFILE OUTPUT]
${rawOutput}`
  );
}

// ---- Long-term memory extraction ----------------------------------------

/**
 * Assembles the long-term memory extraction prompt.
 * @param {string} chatHistory - Formatted recent messages (name: text pairs).
 * @param {string} existingMemories - Already-stored memories as [type] content lines (may be empty).
 * @param {string} [characterName] - Active roleplay character for this memory store.
 * @returns {string} The complete prompt string.
 */
export function buildExtractionPrompt(chatHistory, existingMemories, characterName = '', canonicalRoster = '') {
  const activeCharacterSection = characterName
    ? `ACTIVE CHARACTER FOR THIS MEMORY STORE: ${characterName}\n\n`
    : '';
  const existingSection = existingMemories
    ? `EXISTING MEMORIES (do NOT duplicate or rephrase these - only add genuinely new information):\n${existingMemories}\n\nIf a fact has CHANGED since an existing memory was written, extract the updated version using explicit state-change language so it can supersede the old entry. Use phrases like "now", "no longer", "formerly", "became", "used to", "moved to", "stopped" - e.g. "Alex no longer distrusts Finn" or "Alex and Finn are now lovers". Without this phrasing, both the old and new fact will be stored redundantly.\n\n`
    : '';

  return (
    NO_ACTION_PREAMBLE +
    `[MEMORY EXTRACTION TASK - Do NOT continue the roleplay. Do NOT speak as a character. Output structured data only.]

${activeCharacterSection}${canonicalRoster}${existingSection}RECENT CONVERSATION TO ANALYZE:\n${chatHistory}

---
Your task: Extract NEW facts worth remembering in future sessions with this character. Ignore filler and small talk. Focus on information that would meaningfully change how future conversations begin or flow.

Prioritization rules (strict):
- Prioritize durable memories about the ACTIVE CHARACTER and their bond with the user.
- Physical traits are durable facts - appearance, scars, injuries, distinctive features, notable possessions. Capture these at importance 2-3. They are the anchors a continuity checker depends on.
- If temporary side characters appear, store only major lasting impact (e.g. a new ally/rival), not blow-by-blow dialogue.
- Avoid over-capturing a single short-lived topic; keep long-term memory diverse and stable across many sessions.

Use one of these memory types:
- fact        - established truths about the character, world, or other characters
- relationship - the current state and history of the relationship between participants
- preference  - what the user demonstrably enjoys (themes, tone, pacing, specific content)
- event       - significant events that occurred and should be recalled

For each memory, also rate its importance on a scale of 1-3:
- 1: Atmospheric or minor flavor detail
- 2: Useful context or meaningful update
- 3: Critical trait, major event, or relationship-defining shift

Also classify expiration:
- scene      - likely irrelevant after this scene transition
- session    - useful for this current chat/session, but may fade
- permanent  - durable fact that should persist long-term

ENTITY TAGGING (optional but encouraged):
If the memory involves specific NAMED entities, append :entity=Name/type pairs inside the bracket. Use exact names from the conversation only. Classify each as: character, place, object, faction, or concept. Do not tag generic nouns unless they have a specific name in the conversation. Omit this field if no named entities are relevant.

GROUNDING RULES: Never copy names, facts, objects, relationships, or events from these instructions or examples. Use only details supported by the supplied conversation or grounded memories. Every entity name must appear in the supplied conversation or existing-entity list.

The supplied conversation messages are numbered from 0 upward. Every line MUST include :sources= followed by one or more supporting message indices from that supplied conversation. If no message supports a claim, omit it.

Output ONLY one memory per line using this exact format (nothing else):
[fact:2:permanent:sources=0] <ENTITY_A> has the explicitly stated role or attribute.
[fact:2:permanent:entity=<ENTITY_A>/character:sources=0] <ENTITY_A> has the explicitly described characteristic.
[relationship:3:permanent:entity=<ENTITY_A>/character,<ENTITY_B>/character:sources=0,2] The conversation states the relationship between <ENTITY_A> and <ENTITY_B>.
[event:2:permanent:entity=<ENTITY_A>/character,<ENTITY_B>/character:sources=0,2] <ENTITY_A> and <ENTITY_B> took the explicitly described action.
[preference:2:session:sources=0] The user explicitly expressed a preference.
[event:1:scene:sources=0] The conversation explicitly mentions a minor scene event.

FINAL RULE: Output ONLY [type:score:expiration:sources=0] or [type:score:expiration:entity=Name/type:sources=0,2] lines. No headers. No intros. No explanations.
If there is nothing new worth preserving, output exactly: NONE`
  );
}

// ---- Supersession confirmation (method B) --------------------------------

/**
 * Builds the narrow binary prompt used to confirm whether a new memory
 * updates/replaces an existing one (UPDATE) or is independently true (INDEPENDENT).
 * Called only for pairs that scored above the same-topic similarity threshold
 * but had no state-change pattern - i.e. the cheap checks were inconclusive.
 *
 * Intentionally minimal: two sentences in, one word out. Short context means
 * even weak local models answer reliably.
 *
 * @param {string} newMemory      - Content of the newly extracted memory.
 * @param {string} existingMemory - Content of the existing stored memory.
 * @returns {string} The complete prompt string.
 */
export function buildSupersessionConfirmPrompt(newMemory, existingMemory) {
  return (
    `[MEMORY CLASSIFICATION - Output one word only: UPDATE or INDEPENDENT]\n\n` +
    `Existing memory: ${existingMemory}\n` +
    `New memory:      ${newMemory}\n\n` +
    `Does the new memory UPDATE or REPLACE the existing memory, making it ` +
    `outdated or no longer fully accurate?\n` +
    `Or are both memories INDEPENDENTLY TRUE at the same time?\n\n` +
    `Output exactly one word: UPDATE or INDEPENDENT`
  );
}

// ---- Canon summary ------------------------------------------------------

/**
 * Assembles the canon summary prompt for a character.
 * Canon is a stable multi-paragraph narrative document covering who the
 * character is, what has happened, and the current state of key relationships.
 * It is sourced from arc summaries and high-importance long-term memories.
 *
 * @param {string} characterName - Active character name.
 * @param {string[]} arcSummaries - Resolved arc summary paragraphs.
 * @param {string} longtermMemories - High-importance long-term memories as [type] content lines.
 * @returns {string} The complete prompt string.
 */
export function buildCanonSummaryPrompt(characterName, arcSummaries, longtermMemories) {
  const charLabel = characterName || 'the character';
  const arcSection =
    arcSummaries.length > 0
      ? `RESOLVED ARC SUMMARIES:\n${arcSummaries.map((s, i) => `Arc ${i + 1}: ${s}`).join('\n\n')}\n\n`
      : 'RESOLVED ARC SUMMARIES: (none)\n\n';
  const memSection = longtermMemories
    ? `KEY MEMORIES:\n${longtermMemories}\n\n`
    : 'KEY MEMORIES: (none)\n\n';

  return (
    NO_ACTION_PREAMBLE +
    `[CANON SUMMARY TASK - Do NOT roleplay. Write a narrative document only.]

${arcSection}${memSection}Write a canon summary for "${charLabel}". This is a stable narrative document that captures the essential truth of what has happened in the story so far and who the character is now. Base everything strictly on the source material above - do not invent facts. Write in past tense, narrative style.

Structure the output as three paragraphs with these headings:

WHO THEY ARE:
[A paragraph on the character's identity, core traits, relationships, and current emotional state based on what has happened]

WHAT HAS HAPPENED:
[A paragraph summarising the key events and arcs in the story so far]

CURRENT STATE:
[A paragraph on where things stand now - unresolved tensions, active goals, and where the story is heading]

Output only the three labelled paragraphs. No preamble, no disclaimers.`
  );
}

// ---- Activation trigger generation (Profile B) ------------------------------

/**
 * Asks the model to suggest contextual trigger keywords for a single memory.
 * Used on Profile B (hosted models) at write time so that memories can be
 * surfaced by synonyms and situational cues that do not literally appear in
 * the memory text.
 *
 * The model is instructed to avoid repeating words already in the memory and
 * to focus on what someone would say or describe when the memory is relevant,
 * not just what the memory itself says.
 *
 * @param {string} content - The memory content string.
 * @returns {string} The assembled prompt.
 */
export function buildTriggerGenerationPrompt(content) {
  return (
    NO_ACTION_PREAMBLE +
    `[KEYWORD TASK - Output a comma-separated list only. Do NOT continue any story or explain your choices.]\n\n` +
    `Memory: "${content}"\n\n` +
    `List 4 to 6 keywords that would signal this memory is relevant to a conversation. Think broadly:\n` +
    `- Synonyms for key concepts in the memory\n` +
    `- Broader categories that contain the specific thing (e.g. "insects" for a bee allergy)\n` +
    `- Situational cues - things someone would encounter or describe when this memory matters\n` +
    `- Emotional or physical reactions associated with this memory\n\n` +
    `Do NOT repeat words already in the memory text. Output short single words or two-word phrases only.\n\n` +
    `Output format: keyword1, keyword2, keyword3\n` +
    `Output:`
  );
}

/**
 * Builds the prompt for relationship delta extraction.
 *
 * Given a scene and the current baseline relationship state for known pairs,
 * the model outputs one line per pair that changed, in the format:
 *   subject -> target: descriptor(magnitude), descriptor(magnitude)
 *
 * For new character pairs with no prior state, the caller may include a
 * character card excerpt so the model can seed the initial state from it.
 * If the pair is introduced mid-scene the model seeds from the prose instead.
 *
 * Magnitude guidelines:
 *   low    - minor shift: a kind gesture, a small disagreement
 *   medium - notable event: a confession, a betrayal discovered, a reconciliation
 *   high   - life-changing or traumatic: murder, profound loss, years of bonding
 *
 * @param {string} sceneText - The scene messages to analyze.
 * @param {string} currentState - Current baselines, one "A->B: descriptors" line per known pair. Empty string if none.
 * @param {string} characterCardExcerpt - Relevant character card text for seeding new pairs. Empty string if not available.
 * @returns {string} The assembled prompt.
 */
export function buildRelationshipDeltaPrompt(sceneText, currentState, characterCardExcerpt = '', canonicalRoster = '') {
  const cardSection = characterCardExcerpt.trim()
    ? `Character background (use only to seed new pairs with no prior state):\n${characterCardExcerpt.trim()}\n\n`
    : '';
  const stateSection = currentState.trim()
    ? `Current relationship state (carry ALL of these forward unless explicitly resolved):\n${currentState.trim()}\n\n`
    : '';

  return (
    `[RELATIONSHIP HISTORY TASK - Output structured data only. Do NOT continue the roleplay.]\n\n` +
    `You maintain a relationship history record for ALL named characters in the scene - not only the character whose card is provided below. The card is background context only.\n\n` +
    `The existing state lists what is already known and TRUE.\n` +
    `Your job is to output the updated state by:\n` +
    `1. Keeping ALL existing descriptors (they remain true unless the scene proves otherwise)\n` +
    `2. Adding new descriptors observed in the scene - maximum 6 per pair total\n` +
    `3. Prefixing a descriptor with ! only if the scene explicitly resolves it\n\n` +
    `Descriptors must describe how subject FEELS TOWARD or RELATES TO target.\n` +
    `Good examples: affectionate, trusting, jealous, protective, hostile, admiring, wary, grateful, resentful.\n` +
    `NOT physical states (sleepy, wet, blushing), NOT character traits (impulsive, naive), NOT scene atmosphere.\n` +
    `Test: would this word still apply if the target left the room? If yes, it is not a relationship descriptor.\n\n` +
    `Example:\n` +
    `Existing: Alice -> Bob: fond(high), nervous(medium)\n` +
    `Scene: Alice confesses her feelings. Bob smiles and takes her hand. Meanwhile Carol watches them, clearly envious.\n` +
    `Output:\n` +
    `Alice -> Bob: fond(high), nervous(medium), open(high)\n` +
    `Carol -> Alice: envious(medium)\n` +
    `(Alice/Bob: fond and nervous kept, open added. Carol included even though she has no card - she is named and her feeling is clear.)\n\n` +
    `Rules:\n` +
    `- subject -> target and target -> subject are separate lines - feelings are not always mutual\n` +
    `- Each descriptor gets its own magnitude: (low), (medium), or (high)\n` +
    `- high = deep or persistent; medium = notable; low = mild or fleeting\n` +
    `- Use magnitude to express intensity, not hedge words: nervous(low) not slightly nervous(medium)\n` +
    `- Capture ALL named characters with observable relationships - NPCs and characters without cards count\n` +
    `- Use the supplied full canonical name for a participant. Never output a short-name and full-name variant as separate people.\n` +
    `- Include named animals and non-human characters if they have a meaningful relationship with someone\n` +
    `- Both sides must be named characters. Never use rooms, homes, places, objects, activities, organizations, or concepts.\n` +
    `- Do not include unnamed extras or background crowd members\n` +
    `- Output descriptor(low), descriptor(medium), descriptor(high), or !descriptor only. Do not write new, added, updated, resolved, Markdown, numbering, or explanations.\n` +
    `- Valid: Alice -> Bob: trusting(high). Invalid: Alice -> Bob's apartment: closer new.\n` +
    `- Output NONE if no relevant pairs appear in the scene\n\n` +
    `Format: Subject -> Target: descriptor(magnitude), descriptor(magnitude)\n\n` +
    canonicalRoster + cardSection +
    stateSection +
    `Scene:\n${sceneText}\n\n` +
    `Output:`
  );
}

// ---- Epistemic extraction -----------------------------------------------

/**
 * Builds the epistemic extraction prompt for a scene.
 *
 * Produces a per-character knowledge map using five tags: knows, unaware,
 * suspects, believes, hiding. The prompt body was validated over five rounds
 * of iterative testing - every rule exists because a specific failure mode was
 * observed without it. Do not simplify.
 *
 * When existingEntries is non-empty, the prompt also asks the model to flag
 * superseded entries via `[retire] <number>` lines (1-based index into the
 * list). No extra model call - retire lines are mixed into the same output.
 *
 * @param {string} sceneText - The scene messages formatted as a chat excerpt.
 * @param {string[]} participants - Character names present in the scene (hint only).
 * @param {Array<{type: string, subject: string, target: string|null, content: string}>} [existingEntries] - Current stored entries for context.
 * @returns {string} The complete prompt string.
 */
export function buildEpistemicExtractionPrompt(sceneText, participants, existingEntries = [], canonicalRoster = '') {
  const participantHint =
    participants.length > 0
      ? `Characters present in this scene: ${participants.join(', ')}.\n\n`
      : '';

  let existingBlock = '';
  if (existingEntries.length > 0) {
    const lines = existingEntries.map((e, i) => {
      const label =
        e.type === 'hiding'
          ? `[hiding] ${e.subject} from ${e.target} | ${e.content}`
          : `[${e.type}] ${e.subject} | ${e.content}`;
      return `[${i + 1}] ${label}`;
    });
    existingBlock =
      `Existing knowledge entries (do not repeat these as new entries):\n` +
      lines.join('\n') +
      `\n\nAfter your new entries, output [retire] <number> for each existing entry` +
      ` that is now superseded, contradicted, or resolved by what happened in this` +
      ` scene. Only retire an entry when the scene explicitly establishes the change` +
      ` - do not retire based on inference. If nothing is superseded, output nothing extra.\n\n`;
  }

  return (
    NO_ACTION_PREAMBLE +
    `[EPISTEMIC EXTRACTION TASK - Output structured data only. Do NOT continue the roleplay.]\n\n` + canonicalRoster +
    `You are building a selective knowledge map: preserve only knowledge states that\n` +
    `matter for future behavior, secrecy, misunderstanding, dramatic irony, or perspective accuracy.\n\n` +
    `Output one entry per character per fact, using these tags:\n\n` +
    `[knows]    Character | fact they have direct knowledge of\n` +
    `[unaware]  Character | fact they do not know (but others do)\n` +
    `[suspects] Character | incomplete belief - they sense something but lack proof\n` +
    `[believes] Character | something they hold as true that is actually false\n` +
    `[hiding]   Concealer from Target | what they are actively concealing\n\n` +
    `Rules:\n` +
    `- Only record what is established by the scene - do not infer beyond what is shown\n` +
    `- Do NOT turn ordinary, universally witnessed actions into [knows] entries\n` +
    `- Prefer fewer high-value entries: normally 3-6 total per character per scene\n` +
    `- Prioritize hiding, believes, suspects, unaware, and meaningful changes in knowledge over routine knows\n` +
    `- Use the supplied canonical character name when available. Do not create parenthetical disambiguated names such as "Sophie (Alissa Kawaguchi)"; put context in the entry content instead.\n` +
    `- Each line covers one character and one fact\n` +
    `- Do not output the same fact twice for the same character\n\n` +
    `- WITNESS RULE: use [knows] for witnessing only when it creates an asymmetric\n` +
    `  perspective, reveals a secret, or will materially affect later choices\n\n` +
    `- UNAWARE COMPLEMENT: when you write [knows] X | fact, ask whether another named\n` +
    `  character does not know that fact. If the scene establishes they do not, write\n` +
    `  the corresponding [unaware] line for them\n\n` +
    `- HIDING RULE: [hiding] means the concealer possesses a fact and is actively\n` +
    `  keeping it from a specific target. Do NOT write [hiding] for a character the\n` +
    `  concealer has already told. An explicit oath or promise of secrecy establishes\n` +
    `  [hiding] for the oath-taker toward the person the secret is being kept from\n\n` +
    `- KNOWS vs SUSPECTS: if a character is explicitly told a fact, use [knows].\n` +
    `  Reserve [suspects] only for characters who have a feeling without being\n` +
    `  directly informed\n\n` +
    `- DECEPTION RULE: when a character makes a false statement, write [hiding] for\n` +
    `  the liar. Then check whether the character who heard it accepted it without\n` +
    `  challenge - if so, also write [believes] for them with the false content.\n` +
    `  Always write both lines together\n\n` +
    `- CONTRADICTION RULE: if a character states their location or actions, check\n` +
    `  whether the scene already established where they actually were. If the\n` +
    `  statement contradicts that established fact, treat it as a lie and apply the\n` +
    `  DECEPTION RULE\n\n` +
    `- BELIEVES RULE: [believes] is ONLY for false beliefs - content that is\n` +
    `  demonstrably untrue based on the scene. Do not use it for things a character\n` +
    `  is merely thinking, feeling, or correctly concluding\n\n` +
    `Example:\n` +
    `Scene: <ENTITY_A> took <EXPLICIT_OBJECT> while <ENTITY_B> watched. Later <ENTITY_A> told\n` +
    `<ENTITY_C> about it but swore <ENTITY_C> to silence. When <ENTITY_B> asked <ENTITY_A> if anything\n` +
    `was missing, he shrugged and said he hadn't noticed.\n\n` +
    `Output:\n` +
    `[knows] <ENTITY_A> | <ENTITY_A> took <EXPLICIT_OBJECT>\n` +
    `[knows] <ENTITY_B> | <ENTITY_A> took <EXPLICIT_OBJECT>\n` +
    `[knows] <ENTITY_C> | <ENTITY_A> took <EXPLICIT_OBJECT>\n` +
    `[unaware] <ENTITY_A> | <ENTITY_B> saw the action\n` +
    `[hiding] <ENTITY_A> from <ENTITY_B> | the action\n` +
    `[hiding] <ENTITY_C> from <ENTITY_B> | <ENTITY_A> told <ENTITY_C> about the action\n` +
    `[believes] <ENTITY_B> | <ENTITY_A> did not notice anything was missing\n\n` +
    `Notes:\n` +
    `- <ENTITY_C> was told directly so [knows] not [suspects]\n` +
    `- A secret applies only toward people who were not told\n` +
    `- A false belief may differ from the established fact\n\n` +
    `---\n\n` +
    existingBlock +
    participantHint +
    `Scene:\n${sceneText}\n\n` +
    `Output:`
  );
}

/**
 * Builds the state card extraction prompt for the current message window.
 *
 * Asks the model to output current-state fields for each known entity whose
 * state is visible in the excerpt. Output is sparse: only fields that are
 * explicitly established or directly shown appear; unknown fields are omitted.
 *
 * Validated against Gemma (Profile B) and Qwen (Profile A). Gemma handles
 * all cases correctly. Qwen over-infers on some fields despite strict rules -
 * the parser filters noise values, but state ledger extraction is Profile-gated
 * for this reason.
 *
 * @param {string} excerpt - Recent messages formatted as "Name: message" lines.
 * @param {Array<{name: string, type: string}>} entityList - Entities in scope.
 * @returns {string} The full prompt string.
 */
export function buildStateCardPrompt(excerpt, entityList, canonicalRoster = '') {
  const entityLines = entityList.map((e) => `- ${e.name} (${e.type})`).join('\n');

  return (
    NO_ACTION_PREAMBLE +
    `[STATE EXTRACTION TASK - Do NOT continue the roleplay. Output structured data only.]\n\n` +
    canonicalRoster + `You are tracking the current physical and operational state of known entities in a story.\n\n` +
    `Known entities:\n${entityLines}\n\n` +
    `Available fields by type:\n` +
    `- character: location, injuries, outfit_disguise, mood, active_goal, carried_items\n` +
    `- object: owner, location, condition, status\n` +
    `- place: occupants, hazards, political_control, damage, accessibility\n` +
    `- faction: leadership, objective, alliances, hostility_level\n\n` +
    `Output one line per entity. One tag at the start of the line containing the entity\n` +
    `name and type, then all known fields after it separated by |:\n\n` +
    `[state:<ENTITY_A>:character] location=<LOCATION> | injuries=<EXPLICIT_INJURY> | carried_items=<EXPLICIT_OBJECT>\n` +
    `[state:<EXPLICIT_OBJECT>:object] owner=<ENTITY_A> | location=with <ENTITY_A>\n` +
    `NONE\n\n` +
    `STRICT RULES - violations produce unusable output:\n` +
    `- ONLY include fields that are EXPLICITLY stated or DIRECTLY shown in the text.\n` +
    `  Do not infer, deduce, or reason about what is probably true.\n` +
    `- A field you are not certain about MUST be omitted entirely. NEVER write\n` +
    `  fieldname=unknown, fieldname=none, fieldname=not mentioned, or any similar\n` +
    `  placeholder. Either you know the value from the text or the field is absent.\n` +
    `- If an entity is not mentioned in the excerpt, do not output a line for it at all.\n` +
    `  An entity with no known fields produces no output - not a line of unknowns.\n` +
    `- If nothing is known about any entity, output: NONE\n\n` +
    `Excerpt:\n${excerpt}\n\n` +
    `Output:`
  );
}
