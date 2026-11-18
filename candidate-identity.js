export const CANDIDATE_IDENTITY_SCHEMA_VERSION = 1;

export function candidateIdentityOf(candidate) {
  const id = candidate?.candidate_identity?.candidate_id;
  return id == null ? null : String(id).trim() || null;
}

export function assignCandidateIdentity(candidate, candidateId, detail = {}) {
  const id = String(candidateId ?? '').trim();
  if (!candidate || !id) throw Object.assign(new Error('Candidate identity is required.'), {
    code: 'SME_CANDIDATE_IDENTITY_REQUIRED',
  });
  const existing = candidateIdentityOf(candidate);
  if (existing && existing !== id) throw Object.assign(
    new Error('Candidate identity cannot change during transformation.'), {
      code: 'SME_CANDIDATE_IDENTITY_MUTATION_REJECTED', prior_candidate_id: existing,
      requested_candidate_id: id,
    });
  candidate.candidate_identity = {
    schema_version: CANDIDATE_IDENTITY_SCHEMA_VERSION,
    candidate_id: id,
    parent_candidate_id: detail.parent_candidate_id
      ?? candidate.candidate_identity?.parent_candidate_id ?? null,
    transformation_receipt_id: detail.transformation_receipt_id
      ?? candidate.candidate_identity?.transformation_receipt_id ?? null,
  };
  return candidate;
}

export function copyCandidateIdentity(source, target, detail = {}) {
  const id = candidateIdentityOf(source);
  return id ? assignCandidateIdentity(target, id, detail) : target;
}

export function deriveCandidateIdentity(source, target, derivedCandidateId,
  transformationReceiptId) {
  const parentCandidateId = candidateIdentityOf(source);
  const receiptId = String(transformationReceiptId ?? '').trim();
  if (!parentCandidateId || !receiptId) throw Object.assign(
    new Error('A derived candidate requires its parent identity and transformation receipt.'), {
      code: 'SME_DERIVED_CANDIDATE_RECEIPT_REQUIRED',
    });
  return assignCandidateIdentity(target, derivedCandidateId, {
    parent_candidate_id: parentCandidateId,
    transformation_receipt_id: receiptId,
  });
}
