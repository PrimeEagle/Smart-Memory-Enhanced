import { immutableSerializableDomain } from './serializable-domain.js';

const PROVENANCE = new Set(['fresh_prompt_slot', 'cached_prompt_slot', 'empty']);

const fingerprint = (value) => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const invalid = (message, path) => {
  const error = new TypeError(message);
  error.code = 'SME_INVALID_INJECTION_READ_MODEL';
  error.sme_failure_stage = 'injection_read_model_construction';
  error.sme_serialization_path = path;
  return error;
};

/** Read-only canonical token accounting exposed by unified injection. */
export function createInjectionTierBreakdown(items = []) {
  const rows = items.map((item, index) => {
    const key = typeof item?.key === 'string' ? item.key.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const tokens = Number(item?.tokens);
    if (!key || !label || !Number.isFinite(tokens) || tokens < 0) {
      throw invalid(`Invalid injection breakdown row at index ${index}.`,
        `$.injection_breakdown[${index}]`);
    }
    return {
      key, label,
      color: typeof item.color === 'string' ? item.color : null,
      tokens: Math.floor(tokens),
    };
  });
  return immutableSerializableDomain(rows, {
    path: '$.injection_breakdown',
    stage: 'injection_read_model_construction',
    operation_type: 'memory_injection',
  });
}

/**
 * Builds the complete read-only unified-injection decision before prompt
 * mutation. Tier-specific injectors own their individual budgets; this plan
 * owns ordering, exact-content deduplication, placement, and provenance.
 */
export function createUnifiedInjectionPlan({ candidates = [], placement = {},
  macro_active: macroActive = false } = {}) {
  if (!Array.isArray(candidates)) {
    throw invalid('Unified injection candidates must be an array.', '$.unified_injection.candidates');
  }
  const validated = candidates.map((item, index) => {
    const key = typeof item?.key === 'string' ? item.key.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const color = typeof item?.color === 'string' ? item.color : null;
    const content = typeof item?.content === 'string' ? item.content : null;
    const provenance = item?.provenance;
    const rank = Number(item?.rank);
    const tokens = Number(item?.tokens);
    const path = `$.unified_injection.candidates[${index}]`;
    if (!key || !label || content === null || !PROVENANCE.has(provenance)
      || !Number.isInteger(rank) || rank < 0 || !Number.isFinite(tokens) || tokens < 0) {
      throw invalid(`Invalid unified injection candidate at index ${index}.`, path);
    }
    const contentFingerprint = content ? fingerprint(content) : null;
    return {
      key, label, color, rank, tokens: Math.floor(tokens), provenance,
      content_fingerprint: contentFingerprint, content,
    };
  }).sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  const seenContent = new Set();
  const normalized = validated.map((item) => {
    let status = 'selected';
    let rejectionReason = null;
    if (!item.content) {
      status = 'rejected';
      rejectionReason = 'empty_content';
    } else if (seenContent.has(item.content_fingerprint)) {
      status = 'rejected';
      rejectionReason = 'duplicate_content';
    } else {
      seenContent.add(item.content_fingerprint);
    }
    return { ...item, status, rejection_reason: rejectionReason };
  });

  const position = Number(placement.position);
  const depth = Number(placement.depth);
  const role = Number(placement.role);
  if (![position, depth, role].every(Number.isFinite)) {
    throw invalid('Unified injection placement must use finite numeric values.',
      '$.unified_injection.placement');
  }
  const selected = normalized.filter((item) => item.status === 'selected');
  const target = selected.length === 0 ? 'cleared' : macroActive ? 'macro' : 'extension_prompt';
  const diagnostics = {
    schema_version: 1,
    target,
    placement: {
      position: Math.floor(position), depth: Math.floor(depth), role: Math.floor(role),
    },
    budget: {
      mode: 'upstream_tier_limits', limit_tokens: null,
      selected_tokens: selected.reduce((total, item) => total + item.tokens, 0),
    },
    selected_tier_keys: selected.map((item) => item.key),
    candidates: normalized.map(({ content: _content, ...item }) => item),
  };
  return immutableSerializableDomain({
    schema_version: 1,
    target,
    placement: diagnostics.placement,
    selected,
    diagnostics,
  }, {
    path: '$.unified_injection',
    stage: 'injection_plan_construction',
    operation_type: 'memory_injection',
  });
}

/** Returns a content-free, privacy-safe projection of a canonical plan. */
export function projectUnifiedInjectionDiagnostics(plan) {
  return immutableSerializableDomain(plan?.diagnostics ?? {
    schema_version: 1, target: 'cleared',
    placement: { position: 0, depth: 0, role: 0 },
    budget: { mode: 'upstream_tier_limits', limit_tokens: null, selected_tokens: 0 },
    selected_tier_keys: [], candidates: [],
  }, {
    path: '$.unified_injection_diagnostics',
    stage: 'injection_diagnostics_projection',
    operation_type: 'memory_injection',
  });
}
