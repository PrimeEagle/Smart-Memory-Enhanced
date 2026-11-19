/**
 * Plain-data boundary for Memorize domain state.
 *
 * Runtime effects (functions, promises, DOM objects, class instances, and
 * cyclic graphs) must never cross this boundary.  The validator reports the
 * first exact property path so a programming defect is diagnosable before a
 * journal, store, outcome, or diagnostic projection is mutated.
 */

const objectTag = (value) => Object.prototype.toString.call(value);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  return value?.constructor?.name ?? objectTag(value).slice(8, -1) ?? 'object';
}

function propertyPath(parent, key, arrayIndex = false) {
  if (arrayIndex) return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function boundaryError(path, value, context, reason) {
  const error = new TypeError(`Non-serializable domain data at ${path}: ${reason}.`);
  error.code = 'SME_NON_SERIALIZABLE_DOMAIN_DATA';
  error.sme_origin = 'programming_error';
  error.sme_reason_code = 'non_serializable_domain_data';
  error.sme_failure_stage = context.stage ?? 'domain_boundary_validation';
  error.sme_serialization_path = path;
  error.sme_serialization_type = typeOf(value);
  error.sme_operation_type = context.operation_type ?? null;
  error.sme_obligation_id = context.obligation_id ?? null;
  error.sme_request_diagnostics = {
    provider_call_required: false,
    retry_eligible: false,
    failure_origin: 'local_programming_defect',
    serialization_path: path,
    serialization_type: typeOf(value),
    operation_type: context.operation_type ?? null,
    obligation_id: context.obligation_id ?? null,
    failure_stage: error.sme_failure_stage,
  };
  return error;
}

export function assertSerializableDomain(value, context = {}) {
  const active = new WeakSet();
  const visit = (current, path) => {
    const primitive = typeof current;
    if (current === null || primitive === 'string' || primitive === 'boolean') return;
    if (primitive === 'number') {
      if (!Number.isFinite(current)) throw boundaryError(path, current, context, 'number is not finite');
      return;
    }
    if (primitive === 'undefined' && context.allow_undefined === true) return;
    if (primitive === 'undefined' || primitive === 'function'
      || primitive === 'symbol' || primitive === 'bigint') {
      throw boundaryError(path, current, context, `${primitive} values are runtime-only`);
    }
    if (typeof current?.then === 'function') {
      throw boundaryError(path, current, context, 'promises and thenables are runtime-only');
    }
    if (Number.isInteger(current?.nodeType)
      && (typeof current?.nodeName === 'string' || current?.ownerDocument)) {
      throw boundaryError(path, current, context, 'DOM-like values are runtime-only');
    }
    if (active.has(current)) throw boundaryError(path, current, context, 'cyclic references are not allowed');
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw boundaryError(path, current, context,
        `${typeOf(current)} is not a plain object`);
    }
    active.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!(index in current)) throw boundaryError(`${path}[${index}]`, undefined, context,
          'sparse array entries are not allowed');
        visit(current[index], propertyPath(path, index, true));
      }
    } else {
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === 'symbol') throw boundaryError(path, current, context,
          'symbol property keys are not allowed');
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor?.get || descriptor?.set) throw boundaryError(
          propertyPath(path, key), current, context, 'accessor properties are runtime-only');
        visit(current[key], propertyPath(path, key));
      }
    }
    active.delete(current);
  };
  visit(value, context.path ?? '$');
  return value;
}

export function freezeDomainTree(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDomainTree(nested);
  return Object.freeze(value);
}

export function cloneSerializableDomain(value, context = {}) {
  if (value == null) return value;
  assertSerializableDomain(value, context);
  return structuredClone(value);
}

export function immutableSerializableDomain(value, context = {}) {
  return freezeDomainTree(cloneSerializableDomain(value, context));
}
