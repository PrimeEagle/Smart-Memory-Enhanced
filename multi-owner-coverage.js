const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value ?? '').trim()).filter(Boolean))];

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

/** Pure structural coverage for one multi-owner Long-Term obligation. */
export function projectMultiOwnerCoverage({ required_owners: requiredOwners = [],
  partitions = {}, no_update_owners: noUpdateOwners = [], rejected = [],
  owner_results: ownerResults = {}, prior = null } = {}) {
  const required = unique(prior?.required_owners?.length
    ? prior.required_owners : requiredOwners);
  const requiredByKey = new Map(required.map((owner) => [owner.toLocaleLowerCase(), owner]));
  const canonical = (owner) => requiredByKey.get(String(owner ?? '').trim().toLocaleLowerCase()) ?? null;
  const priorAccepted = unique(prior?.owners_with_accepted_records).map(canonical).filter(Boolean);
  const accepted = unique([...priorAccepted, ...Object.entries(partitions)
    .filter(([, records]) => Array.isArray(records) && records.length > 0)
    .map(([owner]) => canonical(owner)).filter(Boolean)]);
  const priorNoUpdate = unique(prior?.owners_with_explicit_no_update).map(canonical).filter(Boolean);
  const explicitNoUpdate = unique([...priorNoUpdate,
    ...unique(noUpdateOwners).map(canonical).filter(Boolean)]);
  const covered = new Set([...accepted, ...explicitNoUpdate]);
  const rejectedOwners = unique(rejected.map((item) => canonical(item?.owner)).filter(Boolean));
  const missing = required.filter((owner) => !covered.has(owner));
  const persisted = unique([
    ...unique(prior?.owners_durably_persisted).map(canonical).filter(Boolean),
    ...Object.entries(ownerResults).filter(([, result]) =>
      result?.status === 'committed' || result?.status === 'verified_no_update')
      .map(([owner]) => canonical(owner)).filter(Boolean),
  ]);
  const requiringRecovery = unique([...missing, ...rejectedOwners])
    .filter((owner) => !covered.has(owner));
  return freeze({
    schema_version: 1,
    required_owners: required,
    owners_with_accepted_records: accepted,
    owners_with_explicit_no_update: explicitNoUpdate,
    owners_with_rejected_output: rejectedOwners,
    missing_owners: missing,
    owners_durably_persisted: persisted,
    owners_requiring_recovery: requiringRecovery,
    complete: required.length > 0 && requiringRecovery.length === 0
      && required.every((owner) => covered.has(owner)),
  });
}

export function selectMultiOwnerRecoverySubset(coverage = null) {
  return freeze(unique(coverage?.owners_requiring_recovery));
}
