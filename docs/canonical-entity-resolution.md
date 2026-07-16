# Canonical Entity Resolution - Phase 1 Architecture

## Current identity flow

- `longterm.js` and `session.js` parse `:entity=` values into `_raw_entity_names`; `graph-migration.js#resolveEntityNames` then creates or aliases registry entities.
- Relationship History is maintained in `longterm.js`. It is the sole identity-sensitive path that reads the active character-card description directly before building its prompt.
- State Ledger builds its candidate list only from the long-term and session entity registries, then stores parsed results under lower-cased `name|type` keys.
- Profiles consume entity-registry names; Epistemic, Arcs, and relationship parsing retain model-emitted names independently.
- Character cards are exposed through `getContext().characters`; group membership is available through `getContext().groupId` and the active group data. The current extension commonly uses display names, avatars, and group IDs; it does not have one stable card-ID abstraction.

## Independent name-creation paths

1. Long-term and session `_raw_entity_names` create registry records through `resolveEntityNames`.
2. Relationship pairs use parsed subject/target text as storage keys.
3. State Ledger parser output is used directly as a `name|type` key.
4. Profile relationship matrices and Epistemic subjects/targets preserve model text.
5. Existing entity aliases are currently accumulated automatically whenever a registry name matches.

## Phase 1 insertion point

`canonical-entities.js` is the authority for roster construction and deterministic resolution. It is applied before entity upsert and before State Ledger/relationship persistence. Prompt builders receive only its compact formatted roster, never full card descriptions.

Resolution priority: exact canonical name, approved alias, unique first name, existing registry alias, then unresolved. A full-name candidate sharing a unique canonical first name but carrying an unsupported surname is rejected as an alias and resolved to the canonical card identity; unknown names remain eligible to create NPC entities.

## Compatibility and migration risks

- Existing memory records and registry arrays remain readable; canonical metadata is additive.
- Display names remain the portable fallback where a card ID is unavailable.
- Automatic reconciliation is limited to safe unique-first-name variants. Ambiguous names remain untouched and are logged for review.
- Legacy State Ledger keys remain readable; migration merges only safe variants into the canonical `name|type` key.

## Planned files

- New `canonical-entities.js` and unit tests.
- `graph-migration.js`, `longterm.js`, `session.js`, `state-ledger.js`, and prompt builders.
- Relationship, profile, and epistemic persistence paths in their respective modules.
