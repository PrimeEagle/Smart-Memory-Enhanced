const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
};

export function buildMultiOwnerLongtermPrompt(basePrompt, allowedOwners = []) {
  const owners = [...new Set(allowedOwners.map((owner) => String(owner ?? '').trim()).filter(Boolean))];
  return `${basePrompt}\n\nALLOWED OWNERS (use exactly one per record):\n${owners
    .map((owner) => `- ${JSON.stringify(owner)}`).join('\n')}\n\nReturn one JSON object only:\n{"records":[{"owner":"<allowed owner>","type":"fact|event|preference|relationship|skill|goal|belief|possession","content":"...","source_indices":[0],"importance":1,"permanence":"permanent|temporary"}],"no_update_owners":["<allowed owner>"]}\nEvery record requires non-empty source_indices. Never assign one record to multiple owners.`;
}

function parsedObject(response) {
  const text = String(response ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Pure owner/provenance validation and local partitioning for one shared response. */
export function partitionMultiOwnerLongtermResponse(response, {
  allowed_owners: allowedOwners = [], source_indices: sourceIndices = [],
} = {}) {
  const owners = [...new Set(allowedOwners.map((owner) => String(owner ?? '').trim()).filter(Boolean))];
  const ownerMatches = new Map();
  for (const owner of owners) {
    const key = normalize(owner);
    ownerMatches.set(key, [...(ownerMatches.get(key) ?? []), owner]);
  }
  const allowedSources = new Set(sourceIndices.filter(Number.isInteger));
  const value = parsedObject(response);
  if (!value || !Array.isArray(value.records)) return freeze({
    status: 'malformed', partitions: {}, no_update_owners: [], rejected: [{
      reason_code: 'invalid_multi_owner_json_contract', record_index: null,
    }], targeted_recovery_owners: owners,
  });
  const accepted = [];
  const rejected = [];
  for (const [recordIndex, source] of value.records.entries()) {
    const matches = ownerMatches.get(normalize(source?.owner)) ?? [];
    const citations = [...new Set((Array.isArray(source?.source_indices)
      ? source.source_indices : []).map(Number).filter(Number.isInteger))];
    const reason = matches.length !== 1 ? matches.length === 0
      ? 'unknown_owner' : 'ambiguous_owner'
      : citations.length === 0 ? 'missing_source_provenance'
        : citations.some((index) => !allowedSources.has(index))
          ? 'source_provenance_outside_window' : null;
    if (reason) {
      rejected.push({ record_index: recordIndex, owner: source?.owner ?? null,
        reason_code: reason });
      continue;
    }
    accepted.push({ ...source, owner: matches[0], source_indices: citations,
      _record_index: recordIndex });
  }
  const fingerprints = new Map();
  for (const record of accepted) {
    const key = JSON.stringify([normalize(record.type), normalize(record.content),
      [...record.source_indices].sort((a, b) => a - b)]);
    fingerprints.set(key, [...(fingerprints.get(key) ?? []), record]);
  }
  const crossOwnerDuplicates = new Set([...fingerprints.values()]
    .filter((records) => new Set(records.map((record) => normalize(record.owner))).size > 1)
    .flatMap((records) => records.map((record) => record._record_index)));
  const partitions = Object.fromEntries(owners.map((owner) => [owner, []]));
  for (const record of accepted) {
    if (crossOwnerDuplicates.has(record._record_index)) {
      rejected.push({ record_index: record._record_index, owner: record.owner,
        reason_code: 'cross_owner_duplicate_assignment' });
      continue;
    }
    const { _record_index, ...durableRecord } = record;
    partitions[record.owner].push(durableRecord);
  }
  const explicitNoUpdate = [...new Set((Array.isArray(value.no_update_owners)
    ? value.no_update_owners : []).map((owner) => ownerMatches.get(normalize(owner)))
    .filter((matches) => matches?.length === 1).map((matches) => matches[0]))]
    .filter((owner) => partitions[owner].length === 0);
  const targetedRecoveryOwners = owners.filter((owner) => partitions[owner].length === 0
    && !explicitNoUpdate.includes(owner));
  return freeze({
    status: rejected.length ? accepted.length ? 'partial' : 'rejected' : 'accepted',
    partitions, no_update_owners: explicitNoUpdate, rejected,
    targeted_recovery_owners: targetedRecoveryOwners,
    accepted_record_count: Object.values(partitions).reduce((sum, records) => sum + records.length, 0),
  });
}
