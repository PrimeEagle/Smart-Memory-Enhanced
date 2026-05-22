# Smart Memory - Ideas & Future Directions

*A holding space for ideas that are interesting but not currently planned.
Sourced from design discussions, user feedback, and external model reviews.
Nothing here is committed to - entries may be promoted to a versioned design
doc, deferred indefinitely, or closed as won't-implement as the project evolves.*

---

## Source-linked memories with edit/hide reconciliation

Every extracted memory would keep provenance: source message range, speaker,
and a short evidence snippet. If a message is later edited or deleted, affected
memories would be flagged as stale and the user offered options: re-extract,
retire, keep anyway, or compare old vs new.

**Why it is interesting:** Long-form RP users revise scenes after the fact.
Memories from an edited or hidden message continue to influence the character
unless the user manually hunts them down.

**Why it is not feasible right now:** SillyTavern provides no stable message
IDs. Positional indices shift whenever a message is deleted, making reliable
provenance tracking impossible without ST-level changes. This limitation is
already documented in CLAUDE.md in the context of read-only mode ghost ranges.

**Status: blocked on ST architecture.**

---

## Branch-aware memory snapshots for alternate timelines

First-class support for alternate routes: memory snapshots tied to
checkpoints/branches, with the ability to fork memory state, name a route,
switch the active memory state, compare branches, and selectively merge memories
back into main canon.

**Why it is interesting:** Users frequently explore "what if" branches - romance
outcomes, alternate deaths, villain routes, failed quests. Read-only mode covers
temporary experimentation but does not support persistent alternate continuities.
Long-term memories are shared across all chats for a character and do not roll
back automatically.

**Why it is complex:** Branch-aware storage, a UI for switching active
timelines, and safe merge behavior are all significant engineering. Merge in
particular is hard - a "merge all" button would be dangerous and selective
cherry-picking is fiddly to design well. Storage grows with every branch.

**Status: parking lot. High value for power users, high implementation cost.**

---

## Dynamic per-message memory briefing

Before each AI response, build a compact situation-specific briefing from the
memory graph: the top memories, scenes, arcs, and entity facts most relevant to
the current user message and responding character - more targeted than static
tier injection.

**Why it is interesting:** Rare-but-relevant details could surface exactly when
needed instead of relying only on always-present memories. Especially useful
when token budgets are tight.

**Why it is not feasible for us:** Adds a model call before every response.
On an RTX 2080 with 8GB VRAM this would make the extension prohibitively
expensive to run. We already have /sm-search for on-demand semantic retrieval,
and Vector Storage covers the dynamic retrieval role alongside Smart Memory's
curated-context role. Keeping model calls minimal is a core design constraint.

**Status: closed for Profile A. Could be reconsidered as an opt-in Profile B
feature if demand warrants it.**

---

## In-story chronology

Every timestamp in the system is wall-clock (`ts = Date.now()`) or
message-index (`valid_from`, `valid_to`). There is no in-story time. A scene
three real-time days ago could be "the next morning" in-story or "two months
later." The model currently infers pacing from context every turn rather than
having it stated.

**Approach:** A `story_time` field on scenes extracted during scene
summarization, even as a relative clause ("morning of day 3 since the trial").
A small "elapsed time since last scene" derivation injected alongside scene
history so the AI can reason about narrative pacing explicitly.

**Why deferred:** Extraction of story time is unreliable on weak local models -
many chats are timeless slice-of-life and would just store nulls. 1.7.0 already
has significant scope. Worth revisiting once the narrative-depth features (witnessed-by,
perspective-scoped, relationship deltas) are in and we can see how they land.

**Status: deferred to post-1.7.0.**

---

## Card-defined secrets and player mode

Character cards (or world info entries) could seed pre-defined entries into the
Perspectives & Secrets system using a structured tag format - for example, a
murder mystery card could define `[hiding] Colonel Mustard from everyone | killed
Lord Blackwood` directly in the card, so the LLM knows the secret from the start
without it needing to be extracted from prose.

The user cannot add these manually - that would spoil the scenario for themselves.
Card-defined injection is the only viable path for gamification scenarios where the
user is a player, not the author. The existing spoiler subsection (collapsed behind
a warning) already handles the UI side: a player who does not want to be spoiled
simply does not open it.

**Why it is interesting:** Makes Smart Memory viable as a game engine layer -
murder mysteries, RPGs with hidden roles, political intrigue with faction secrets.
The card becomes a complete game artifact rather than just a character description.

**Why it is not designed yet:** No cards exist that use this pattern. The right
format (card description tags vs world info entries vs a dedicated secrets field)
should be designed around a real card's needs, not speculatively.

**Status: parking lot. Revisit when a card author needs it.**

---

## Pinned epistemic entries that carry across chats

Some epistemic knowledge is session-specific (what a character learned this scene), but some is durable - deep-seated beliefs, long-standing secrets, core convictions that do not reset between sessions. A pinning mechanism would let users mark individual entries as persistent, storing them alongside long-term memories rather than in chatMetadata.

**Why it is interesting:** A character who believes their dead sister is still alive, or who is hiding a crime from years before the story starts, should carry that epistemic state into every new chat without the user having to re-establish it manually.

**Considerations:** Pinned entries would need their own clear/manage UI, and a decision on whether extraction can update or retire them the same way long-term memories are updated.

**Status: parking lot. Not on the roadmap for any current release.**

---

## State ledger storage scope and clear behaviour

State cards are currently stored in chatMetadata (chat-scoped), but they accumulate knowledge from long-term memories across multiple sessions. A character's injury from three sessions ago is reflected in their state card but never appears in the current chat's messages - wiping the ledger on "Forget This Chat" loses that accumulated state permanently, because extraction on the new chat cannot reconstruct facts it never saw.

As a pragmatic fix, "Forget This Chat" no longer clears the state ledger. But the deeper question remains: the ledger contains a mix of entity types with very different natural scopes - character state (clearly durable, should survive session resets) vs. objects, places, and factions (world-scoped, not owned by any single character, awkward to attach to a character's extension_settings slot especially in group chats).

The right long-term answer may be a split storage model: character-type state cards stored in extension_settings alongside long-term memories, and world-scoped cards (object, place, faction) stored either in a shared world slot or kept in chatMetadata. This needs careful design before touching it.

A further complication with world-scoped entities in group chats: each character may have a different view of an object's state (Kael has the knife; Wilma knows Kael has it; a third character has never seen it and shouldn't have it in their ledger at all). That per-character knowledge of world-entity state is essentially what the epistemic tier already handles. This raises the question of whether object, place, and faction entities belong in the state ledger at all, or whether they should be modelled as epistemic entries - with the state ledger reserved for character-type entities where "objective state" is less ambiguous. Needs a dedicated brainstorm before any implementation decisions are made.

**Why it matters:** State cards are the only tier that tracks physical and situational entity state across sessions. Incorrect scoping means either stale data survives when it shouldn't, or accumulated knowledge is lost when it should persist.

**Status: needs a dedicated brainstorm session. Do not change storage scope or entity type routing without resolving the group chat / world-entity / epistemic overlap question first.**

---

## Improve heuristic scene break detection

The regex heuristic is the fallback when AI detection is disabled and the only detection method used during catch-up for users without AI detection on. It has been expanded to cover common RP transition patterns (sleep/wake, movement verbs, multi-word place names, possessives) but it remains brittle - it misses transitions that don't fit the expected phrasing and can fire on character card intro text that uses similar language.

Possible directions: a larger and more carefully tested pattern set; a lightweight keyword scoring approach instead of any-match; or a middle ground where a small fast model (not the full extraction model) handles yes/no detection at lower cost than the current AI detection path, making decent scene detection viable even on Profile A without opting into full AI detection.

**Status: ongoing. The heuristic is usable but not good enough to be relied on for chats with natural prose transitions.**

---

## Automated token budget allocation

All injection token budgets are currently fixed values set manually by the user (or left at their defaults). In practice, most tiers use far less than their budget on short chats and approach or exceed it on long ones. The total budget is also a single shared number that users must set without knowing how it will be distributed.

A smarter system would observe how much each tier actually uses and reallocate the surplus dynamically. For example: if scenes only uses 80 tokens of its 300-token budget, those 220 tokens could flow to long-term memories where 30 entries are being trimmed. The user sets a single total budget; the system distributes it based on actual demand.

A simpler intermediate step would be preset selectors (Compact / Normal / Detailed) that set all budgets together, replacing the current raw-number sliders. This is already noted in CLAUDE.md under planned UX improvements.

The trim indicator (visual alarm on the token bar when a tier is actively dropping content) is the first step toward this - it gives users visibility into when trimming is happening before any automated reallocation is designed.

**Why deferred:** the distribution algorithm (priority order, minimum floors, what to do when everything is at minimum) needs careful design to avoid surprising behaviour. The wrong allocation can hurt quality worse than a flat budget. Needs a dedicated design session before any implementation.

**Status: parking lot. Trim indicator is the prerequisite - build and observe usage patterns before designing the allocation logic.**

---

## Configuration profiles per character or chat

A saved configuration set - extraction frequency, token budgets, injection positions, hardware profile override - that can be locked to a specific character or chat and loaded automatically when that character or chat is opened. Multiple named profiles could exist, letting the user switch between them without manually adjusting each setting.

**Why it is interesting:** Different roleplay contexts have genuinely different needs. A slice-of-life chat with one character needs lighter extraction and smaller budgets than a complex multi-character epic. Right now all settings are global, so users either tune for their heaviest use case and waste context elsewhere, or re-tune manually when switching between very different chats.

**Considerations:** Profiles would need a save/load UI, a way to lock a profile to a character or chat (stored in extension_settings and chatMetadata respectively), and a fallback "Default" profile for unlocked chats. Settings that are global by nature (Memory LLM source, embedding configuration) probably should not be part of a profile. Deciding which settings are per-profile vs truly global needs careful thought.

Our existing storage split maps naturally onto two profile levels: a character-locked profile (stored in extension_settings alongside long-term memories) sets defaults for any chat with that character, and a chat-locked profile (stored in chatMetadata alongside session data) overrides it for a specific chat. This is cleaner than a flat profile system because the storage slots already exist and already carry the right scope semantics - character-level settings like long-term budget and epistemic toggles belong in the character profile, chat-level settings like arc budget and scene detection belong in the chat profile.

Group chats add a third level. Character-locked profiles from individual group members should not bleed into the group context - the group is its own thing with its own dynamics and constantly switching active characters. A group-locked profile stored against the group ID (the same pattern used for pinned arcs) would sit between character and chat in the hierarchy: Default → Character (solo chats only) → Group (group chats) → Chat (overrides all). The group profile would need its own management UI, likely in the Smart Memory panel when a group chat is active. Adding or removing a character from a group mid-chat should not affect the group's configuration.

**Status: parking lot. Not on the roadmap for any current release.**

---

## Injection threshold freeze for prompt cache stability

An option to freeze the injection point - the boundary in the chat beyond which memory summaries start being injected - and only advance it when a trigger condition is met (e.g. after N new messages, after N new extractions, or when context usage crosses a threshold). Between triggers, the injected content stays stable, which means the prompt cache on cloud APIs is not invalidated on every single turn.

**Why it is interesting:** Every time new content enters the injected block, the prompt changes and the cloud provider's cache is invalidated. On pay-per-token APIs this matters - a stable injection window means more cache hits and lower costs. For users on tight API budgets this could be meaningful.

**Why it needs careful design:** A frozen threshold means newly extracted memories do not appear in context until the next trigger fires. The user needs to understand that memories exist but are not yet injected, otherwise it looks like extraction is broken. The trigger conditions and their defaults need to be tuned so the freeze is useful without making the system feel unresponsive.

**Status: worth considering sooner than expected. User feedback indicates the majority of Smart Memory users are on cloud/hosted APIs rather than local Ollama, making cache stability and token costs a current concern rather than a future one.**

---

## Per-character memory routing in group chats via extraction tagging

Currently, long-term extraction runs once per round using the panel-selected
character as the target. Other group members' participation goes unrecorded in
their own memory slots unless the user manually runs catch-up for each one -
which in practice nobody does. The expectation is that group chats capture
memories for all participants correctly.

**Proposed approach:** Rather than running a separate extraction pass per
character (which multiplies model calls proportionally to group size), run a
single pass and ask the model to tag each extracted item with the target
character: `[fact:Finn] ...` vs `[fact:Alex] ...`. The parser then routes each
item to the correct character's store. Cost is one extra token per item rather
than a full model call per character.

**Reliability concern:** Weaker local models may tag inconsistently, forget tags
entirely, or assign the wrong character. Degrades gracefully - a missed or wrong
tag lands the item in the wrong slot or drops it, same outcome as today. Worth
validating the approach by manually running a sample group chat extraction prompt
through the candidate models via Ollama before building anything. If the
recommended models tag reliably, the implementation risk is low.

**Large group chats:** Still a single extraction pass regardless of group size,
so the cost scales well. The prompt would need to list all active group members
so the model knows what names are valid tags.

**Status: parking lot. Validate model tagging reliability manually before designing the implementation.**

---

Last updated: 2026-05-22
