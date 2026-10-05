/** Pure relationship-pair safety rules shared by reconciliation and tests. */
export function normalizeRelationshipIdentityLabel(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(?:card|persona):/i, '')
    .replace(/\.(?:png|jpe?g|webp|gif)$/i, '')
    .trim()
    .toLowerCase();
}

export function classifyRelationshipPairIdentity({
  subjectLabel, targetLabel, resolutionAttempted = false,
  subjectCanonicalId = null, targetCanonicalId = null,
} = {}) {
  const subject = normalizeRelationshipIdentityLabel(subjectLabel);
  const target = normalizeRelationshipIdentityLabel(targetLabel);
  if (!subject || !target) return { safe: false, reason: 'missing_participant_label' };
  if (subject === target) return { safe: false, reason: 'apparent_self_pair' };
  if (!resolutionAttempted) return { safe: null, reason: 'canonical_resolution_required' };
  if (!subjectCanonicalId || !targetCanonicalId) return { safe: false, reason: 'participant_not_safely_resolved' };
  if (String(subjectCanonicalId) === String(targetCanonicalId)) {
    return { safe: false, reason: 'participants_collapse_to_same_canonical_identity' };
  }
  return { safe: true, reason: null };
}

export function summarizeRelationshipQuality({ profileUnresolved = 0, unresolvedPairs = [], deterministicDebt = 0, integrityErrors = 0 } = {}) {
  const ambiguousPairs = unresolvedPairs.length;
  const quarantinedPairs = unresolvedPairs.filter((entry) => entry?.excluded_from_injection === true).length;
  return {
    unresolved_but_safe_records: {
      count: Number(profileUnresolved) + ambiguousPairs,
      profile_field_records: Number(profileUnresolved),
      ambiguous_noncanonical_pair_keys: ambiguousPairs,
      quarantined_from_injection: quarantinedPairs,
      disposition: 'retained_without_identity_guessing',
    },
    ambiguous_noncanonical_pair_keys: {
      count: ambiguousPairs,
      quarantined_from_injection: quarantinedPairs,
      disposition: ambiguousPairs ? 'retained_for_review_and_excluded_from_propagation' : 'none',
    },
    legacy_pair_key_normalization_debt: {
      count: Number(deterministicDebt),
      disposition: deterministicDebt ? 'review_or_safe_rekey_if_deterministic' : 'none',
    },
    actual_integrity_errors: { count: Number(integrityErrors), disposition: integrityErrors ? 'attention_required' : 'none' },
    accounting_invariant: {
      final_audit_unresolved_pair_keys: ambiguousPairs,
      summary_unresolved_pair_keys: ambiguousPairs,
      reconciled: true,
    },
  };
}
