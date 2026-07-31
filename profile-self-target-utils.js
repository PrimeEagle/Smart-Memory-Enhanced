/** Pure, conservative self-target classifier for generated profile fields. */
export function isCanonicalProfileSelfTarget({ ownerCanonicalId, ownerCanonicalName, targetLabel, targetResolution } = {}) {
  const ownerName = String(ownerCanonicalName ?? '').trim().toLowerCase();
  const targetName = String(targetLabel ?? '').trim().toLowerCase();
  if (!ownerName || !targetName) return false;
  // A resolved canonical identity is authoritative. An ambiguous short name
  // must never be treated as the owner merely because it shares a first name.
  if (targetResolution?.status === 'resolved') {
    return (ownerCanonicalId && targetResolution.canonicalId === ownerCanonicalId)
      || String(targetResolution.canonicalName ?? '').trim().toLowerCase() === ownerName;
  }
  return targetResolution?.status !== 'ambiguous' && targetResolution?.status !== 'rejected' && targetName === ownerName;
}
