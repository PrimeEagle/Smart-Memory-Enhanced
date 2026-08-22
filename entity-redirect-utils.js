/**
 * Final-registry validation for durable entity redirects.
 *
 * Redirects are graph edges, not identity evidence. A redirect is usable only
 * when it terminates at a materialized record in the exact finalized registry
 * that the reconciliation pass will audit. Invalid edges are removed from the
 * active map; live references are deliberately left intact for the caller to
 * repair through authoritative provenance or retain for review.
 */

function fingerprint(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const idFingerprint = (value) => value == null ? null : fingerprint(String(value));

/**
 * Validates and flattens durable redirects against final materialized records.
 * The return value contains only active, terminal-safe redirects. Diagnostics
 * are intentionally fingerprinted and contain no names or memory text.
 */
export function validateFinalizedEntityRedirects(redirects = {}, finalizedRegistry = [], options = {}) {
  const source = redirects && typeof redirects === 'object' ? redirects : {};
  const records = Array.isArray(finalizedRegistry) ? finalizedRegistry : [];
  const finalIds = new Set(records
    .filter((record) => record?.id && !record?.scheduled_for_removal && !record?.pending_removal)
    .map((record) => String(record.id)));
  const liveReferenceCounts = options.live_reference_counts instanceof Map
    ? options.live_reference_counts
    : new Map(Object.entries(options.live_reference_counts ?? {}).map(([id, count]) => [String(id), Number(count) || 0]));
  const validated_redirects = {};
  const diagnostics = [];
  const diagnostics_by_source = new Map();

  const resolve = (sourceId) => {
    const direct = source[sourceId]?.replacement_canonical_id;
    if (!direct) return { terminal: null, reason: 'missing_target' };
    let current = String(direct);
    const seen = new Set([String(sourceId)]);
    if (current === String(sourceId)) return { terminal: null, reason: 'self_redirect' };
    while (source[current]?.replacement_canonical_id) {
      if (seen.has(current)) return { terminal: null, reason: 'redirect_cycle' };
      seen.add(current);
      const next = String(source[current].replacement_canonical_id);
      if (next === current) return { terminal: null, reason: 'self_redirect' };
      current = next;
    }
    if (!finalIds.has(current)) return { terminal: null, reason: 'missing_finalized_registry_target' };
    return { terminal: current, reason: null };
  };

  for (const sourceId of Object.keys(source).sort()) {
    const redirect = source[sourceId] ?? {};
    const directTarget = redirect.replacement_canonical_id == null ? null : String(redirect.replacement_canonical_id);
    const result = resolve(String(sourceId));
    const liveBefore = Math.max(0, Number(liveReferenceCounts.get(String(sourceId)) ?? 0) || 0);
    const base = {
      redirect_source_id_fingerprint: idFingerprint(sourceId),
      direct_target_id_fingerprint: idFingerprint(directTarget),
      resolved_terminal_target_fingerprint: idFingerprint(result.terminal),
      terminal_target_exists: Boolean(result.terminal),
      finalized_registry_scope: 'finalized_reconciliation_registry',
      finalized_registry_membership: Boolean(result.terminal),
      live_reference_count_before_repair: liveBefore,
      created_stage: redirect.created_stage ?? redirect.originating_stage ?? 'legacy_unknown',
      validation_stage: 'finalized_redirect_validation',
    };
    if (!result.terminal) {
      const diagnostic = {
        ...base,
        validation_result: 'removed_invalid_redirect',
        repair_status: liveBefore ? 'blocked' : 'applied',
        invalid_reason: result.reason,
        self_redirect: result.reason === 'self_redirect',
        cycle: result.reason === 'redirect_cycle',
        missing_target: result.reason === 'missing_target' || result.reason === 'missing_finalized_registry_target',
        removed_target: result.reason === 'missing_finalized_registry_target',
        removed_stage: 'finalized_redirect_validation',
      };
      diagnostics.push(diagnostic);
      diagnostics_by_source.set(String(sourceId), diagnostic);
      continue;
    }
    const flattened = String(result.terminal);
    validated_redirects[String(sourceId)] = {
      ...redirect,
      old_canonical_id: String(redirect.old_canonical_id ?? sourceId),
      replacement_canonical_id: flattened,
      redirect_validation: {
        status: directTarget === flattened ? 'validated_terminal' : 'flattened_terminal_chain',
        stage: 'finalized_redirect_validation',
      },
    };
    const diagnostic = {
      ...base,
      validation_result: directTarget === flattened ? 'validated' : 'flattened',
      repair_status: 'safe',
      rewrite_stage: null,
      invalid_reason: null,
      self_redirect: false,
      cycle: false,
      missing_target: false,
      removed_target: false,
    };
    diagnostics.push(diagnostic);
    diagnostics_by_source.set(String(sourceId), diagnostic);
  }
  return {
    validated_redirects,
    diagnostics,
    diagnostics_by_source,
    changed: JSON.stringify(source) !== JSON.stringify(validated_redirects),
    finalized_registry_record_count: finalIds.size,
  };
}
