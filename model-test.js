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
const TEST_CHARACTERS = ['Sable', 'Riven'];

const TEST_MESSAGES = [
  {
    name: 'Riven',
    text: 'Keep your hood up. The watch patrols have doubled since Tarren went missing.',
  },
  { name: 'Sable', text: 'Missing or dead?' },
  {
    name: 'Riven',
    text: 'Both, probably. He was supposed to meet me at the Broken Tine three nights ago. Never showed.',
  },
  {
    name: 'Sable',
    text: "Tarren was your best contact inside the watch. If she got to him, she knows we're looking into her.",
  },
  {
    name: 'Riven',
    text: "Lady Voss doesn't leave loose ends. That's why I was dismissed - I refused to file a false report on one of her arrests. Should have known that wasn't the end of it.",
  },
  {
    name: 'Sable',
    text: "I still need to find Mira. Three weeks since she disappeared and the watch won't even acknowledge she existed.",
  },
  {
    name: 'Riven',
    text: 'Your sister was asking questions she should not have been asking. Same as Tarren. Same as the six names on that list I showed you.',
  },
  {
    name: 'Sable',
    text: 'So Voss is behind all of it. The disappearances, the false arrests, everything.',
  },
  {
    name: 'Riven',
    text: "I cannot prove it yet. That's why we're here. The mill foreman told Tarren there was a tunnel - runs under the old quarter, comes up somewhere near the estate grounds.",
  },
  { name: 'Sable', text: "You trust a dead man's rumour?" },
  {
    name: 'Riven',
    text: 'I trust that Tarren died for it. Come on, this way.',
  },
  {
    name: 'Sable',
    text: "This place smells like it hasn't been used in decades.",
  },
  {
    name: 'Riven',
    text: "The mill itself hasn't. But someone has been through here recently - look at the floor. Fresh scuff marks.",
  },
  { name: 'Sable', text: "There's a door at the back. Lock's been cut." },
  {
    name: 'Riven',
    text: "Someone didn't want it to look forced. They had a key and cut the lock afterward to make it look abandoned.",
  },
  {
    name: 'Sable',
    text: 'Found something. A letter, tucked behind the millstone. It is written in cipher.',
  },
  {
    name: 'Riven',
    text: 'Let me see. I know this cipher - it is the old watch administrative code. Voss used it before she switched to couriers. If I am reading this right it is a delivery schedule. Names, dates, destinations.',
  },
  { name: 'Sable', text: 'Destinations where?' },
  {
    name: 'Riven',
    text: "The Greyveil labor camps. She has been selling people into indenture. The disappearances aren't murders - they're trafficking. Your sister might still be alive.",
  },
  {
    name: 'Sable',
    text: 'Then we need to move fast. If she finds out we have this letter, Mira gets moved or worse.',
  },
  {
    name: 'Riven',
    text: 'The tunnel is real. I can see the entrance behind the grain chute. It is going to be a tight fit but it goes north toward the estate.',
  },
  { name: 'Sable', text: 'We go in tonight. I am not waiting.' },
  {
    name: 'Riven',
    text: 'Sable. I owe you for pulling me out of the investigation last year. I will follow you in. But if we are caught inside those grounds, no one is coming for us.',
  },
  { name: 'Sable', text: 'I know. Let us go.' },
  {
    name: 'Riven',
    text: 'The tunnel opens into a storage cellar. Barred from the outside but the bar is up. Someone left it open.',
  },
  { name: 'Sable', text: 'Intentionally?' },
  {
    name: 'Riven',
    text: 'Could be a trap. Could be that whoever left that letter wanted us to get through.',
  },
  { name: 'Sable', text: "An informant inside Voss's estate?" },
  {
    name: 'Riven',
    text: 'It would explain how Tarren got the delivery schedule in the first place. Someone on the inside has been feeding information out. We need to find them before Voss does.',
  },
  {
    name: 'Sable',
    text: 'One thing at a time. Mira first, then we figure out who our unexpected ally is.',
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
      'significant events. A capable model typically finds 5 or more items in this scenario.',
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
      'Should contain current-session developments, revelations, and scene details. ' +
      'A capable model typically finds 4 or more items in this scenario.',
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
      'Should identify open narrative threads - promises made, goals set, mysteries introduced, ' +
      'unresolved tensions. A capable model typically finds 3 items in this scenario.',
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
    const response = await generateMemoryExtract(prompt, { responseLength: def.responseLength });
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
