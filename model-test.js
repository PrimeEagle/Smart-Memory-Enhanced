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
 * Extraction model test: runs a fixed scenario through the full extraction
 * pipeline and returns structured per-tier results for display in the UI.
 *
 * runModelTest - runs the test against the configured memory LLM and returns
 *                per-tier results plus the name of the first tier that failed
 */

import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { generateMemoryExtract } from './generate.js';
import { smLog } from './logging.js';
import {
  buildExtractionPrompt,
  buildSessionExtractionPrompt,
  buildArcExtractionPrompt,
} from './prompts.js';
import { parseExtractionOutput, parseSessionOutput, parseArcOutput } from './parsers.js';

// ---- Test fixture -----------------------------------------------------------

// A fixed roleplay scenario designed to exercise all three extraction tiers.
// Rich enough that a capable model should produce multiple items per tier;
// long enough to surface models that degrade on larger prompts.
export const TEST_CHARACTERS = ['Yara', 'Cael'];

// A post-armistice occupied city. Yara is a former resistance fighter looking
// for her brother Daven, who went into hiding after the war ended and has now
// gone missing. Cael is an intelligence operative officially working for the
// occupation authority, secretly helping Yara.
//
// Designed so that all three story arcs open clearly but NONE resolve within
// the conversation - the brother is not found, the surveillance tail is not
// identified, Cael's handler does not discover him. This prevents the model
// from confusing established facts with open threads.
export const TEST_MESSAGES = [
  {
    name: 'Cael',
    text: 'You got my note. I was not sure you would come after last time.',
  },
  {
    name: 'Yara',
    text: 'You said you had word of Daven. I would walk through the occupation garrison barefoot for that.',
  },
  {
    name: 'Cael',
    text: 'Keep your voice down. The Pact officers have doubled their patrols since the Aldenmoor incident. Half the market has informants on retainer.',
  },
  {
    name: 'Yara',
    text: 'Then tell me quickly. What do you know?',
  },
  {
    name: 'Cael',
    text: 'He was spotted three weeks ago in the Vethara district. A market stall owner recognised him from before the armistice. Daven was asking about passage north - toward the border crossings.',
  },
  {
    name: 'Yara',
    text: 'North means he is trying to get out. Or someone is moving him.',
  },
  {
    name: 'Cael',
    text: 'The stall owner said he did not look like he was choosing where to go. And the same morning he was seen, two Pact intelligence officers checked into the Vethara wayhouse. That is not a coincidence.',
  },
  {
    name: 'Yara',
    text: 'If they have him, I need to reach Vethara before they move him again. How long do we have?',
  },
  {
    name: 'Cael',
    text: 'A day, maybe two. Pact intelligence does not hold people in field wayhouses - they are transit points. Daven will be moved to a processing facility the moment the paperwork clears.',
  },
  {
    name: 'Yara',
    text: 'Then we go tonight. Will you help me?',
  },
  {
    name: 'Cael',
    text: 'Yara. My handler believes I am monitoring resistance contacts - monitoring you. If I travel to Vethara with you, I burn everything I have built in this city. My access, my cover, possibly my life if he decides I have turned.',
  },
  {
    name: 'Yara',
    text: 'Then do not come.',
  },
  {
    name: 'Cael',
    text: 'I did not say I would not. I said what it costs. I will come with you. But you need to understand what you are asking of me.',
  },
  {
    name: 'Yara',
    text: 'I understand. And I will not forget it, Cael. Whatever happens after.',
  },
  {
    name: 'Cael',
    text: 'There is something else. Since I sent you that note two days ago, I have had the feeling we are being watched. Not Pact - they do not follow at a distance, they simply take you. Someone else. Independent.',
  },
  {
    name: 'Yara',
    text: 'The Thornback cells are still operating in the south quarter. Could be former resistance who think I am a liability.',
  },
  {
    name: 'Cael',
    text: 'Possibly. Or someone who picked up that I was asking questions about your brother and decided to follow the thread back to you. I have not been able to identify them yet.',
  },
  {
    name: 'Yara',
    text: 'Can you find out who they are?',
  },
  {
    name: 'Cael',
    text: 'I have a contact who tracks independent operators in this district. She may know who is running surveillance here. I sent word this morning - waiting on a reply.',
  },
  {
    name: 'Yara',
    text: 'How long until she answers?',
  },
  {
    name: 'Cael',
    text: 'A day. Maybe two. The same window we have for Daven.',
  },
  {
    name: 'Yara',
    text: 'So we move on Vethara not knowing who is watching us.',
  },
  {
    name: 'Cael',
    text: 'That is the situation, yes. I would rather wait for the identification but you are right that we cannot. We move tonight and I try to run the tail down in parallel.',
  },
  {
    name: 'Yara',
    text: 'Tell me about the wayhouse. Exits, staff, who is inside.',
  },
  {
    name: 'Cael',
    text: 'Two exits. The front is watched around the clock. The south gate is unmanned after the second bell - garrison budget cuts gutted the overnight posts after the armistice. There is a porter inside named Fen who owes me a considerable debt.',
  },
  {
    name: 'Yara',
    text: 'You trust him?',
  },
  {
    name: 'Cael',
    text: 'I trust that he is more afraid of me than of the two Pact officers staying there. That has been enough before.',
  },
  {
    name: 'Yara',
    text: 'And your handler - when does he expect his next report from you?',
  },
  {
    name: 'Cael',
    text: 'Three days. If I am not back with something credible by then, he will start asking questions I cannot answer. That is our hard deadline on this, Yara.',
  },
  {
    name: 'Yara',
    text: 'Three days to reach Vethara, get Daven out, and get you back in place before your handler notices. I swear I will not waste a single hour of that. Let us go.',
  },
];

// ---- Tier definitions -------------------------------------------------------

// Each tier defines which setting gates it, how to run it, how to parse it,
// and what hint to show the user when reviewing the output.
const TIER_DEFS = [
  {
    key: 'longterm',
    name: 'Long-term Memories',
    enabledKey: 'longterm_enabled',
    hint:
      'Should contain lasting facts about characters, relationships, preferences, and ' +
      'significant events - who these people are, what binds them, what is at stake. ' +
      'A capable model typically finds 5 or more items in this scenario.',
    responseLength: 600,
    buildPrompt: (history) => buildExtractionPrompt(history, '', TEST_CHARACTERS[0]),
    parse: (response) => {
      const items = parseExtractionOutput(response || '');
      return { items: items.map((i) => `[${i.type}] ${i.content}`), count: items.length };
    },
  },
  {
    key: 'session',
    name: 'Session Memories',
    enabledKey: 'session_enabled',
    hint:
      'Should contain scene details, revelations about the situation, and how things ' +
      'developed this session - the wayhouse location, the sighting, the timeline, ' +
      'what Cael committed to. A capable model typically finds 4 or more items in this scenario.',
    responseLength: 400,
    buildPrompt: (history) => buildSessionExtractionPrompt(history, '', ''),
    parse: (response) => {
      const items = parseSessionOutput(response || '');
      return { items: items.map((i) => `[${i.type}] ${i.content}`), count: items.length };
    },
  },
  {
    key: 'arcs',
    name: 'Story Arcs',
    enabledKey: 'arcs_enabled',
    hint:
      'Should identify exactly the three open threads in this scenario: Yara must reach ' +
      'Vethara and get Daven out before the Pact moves him; an unknown party is surveilling ' +
      'them and has not been identified; Cael is deceiving his handler and will face ' +
      'consequences if discovered. None of these resolve in the conversation. ' +
      'A capable model finds all three and nothing else.',
    responseLength: 400,
    buildPrompt: (history) => buildArcExtractionPrompt(history, ''),
    parse: (response) => {
      const { add } = parseArcOutput(response || '', []);
      return { items: add.map((a) => a.content), count: add.length };
    },
  },
];

// ---- Runner -----------------------------------------------------------------

/**
 * Runs the fixed test scenario through every enabled extraction tier.
 * Returns per-tier results and the name of the first tier that produced
 * no output (null if all tiers passed).
 *
 * Tiers are run sequentially to avoid OOM on local models.
 *
 * @returns {Promise<{tiers: Array, failedTier: string|null}>}
 */
export async function runModelTest() {
  const settings = extension_settings[MODULE_NAME];
  const chatHistory = TEST_MESSAGES.map((m) => `${m.name}: ${m.text}`).join('\n\n');

  const tiers = [];

  for (const def of TIER_DEFS) {
    if (!(settings[def.enabledKey] ?? true)) continue;

    const prompt = def.buildPrompt(chatHistory);
    smLog(
      `[ModelTest] Prompt length for "${def.name}": ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`,
    );
    const response = await generateMemoryExtract(prompt, { responseLength: def.responseLength });
    smLog(`[ModelTest] Raw response for tier "${def.name}":`, response);
    const { items, count } = def.parse(response);

    tiers.push({
      key: def.key,
      name: def.name,
      hint: def.hint,
      items,
      empty: count === 0,
    });
  }

  const failedTier = tiers.find((t) => t.empty);
  return { tiers, failedTier: failedTier?.name ?? null };
}
