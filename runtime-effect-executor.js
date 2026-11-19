import { assertSerializableDomain, immutableSerializableDomain }
  from './serializable-domain.js';

/** Runtime-only adapter registry. Handlers never enter plans or receipts. */
export function createRuntimeEffectExecutor(handlersValue = {}) {
  const handlers = new Map(Object.entries(handlersValue));
  for (const [operationType, handler] of handlers) {
    if (!operationType || typeof handler !== 'function') throw new TypeError(
      'Runtime effect handlers require a stable operation type and function.');
  }
  return Object.freeze({
    validate(plan, context = {}) {
      assertSerializableDomain(plan, { ...context,
        operation_type: plan?.operation_type ?? context.operation_type,
        path: context.path ?? '$.plan', stage: context.stage ?? 'effect_plan_validation' });
      if (!handlers.has(plan?.operation_type)) throw Object.assign(
        new Error(`No runtime effect handler is registered for ${plan?.operation_type ?? 'missing'}.`), {
          code: 'SME_EFFECT_HANDLER_NOT_REGISTERED', sme_origin: 'programming_error',
          sme_reason_code: 'effect_handler_not_registered',
          sme_operation_type: plan?.operation_type ?? null,
        });
      return plan;
    },
    async execute(plan, context = {}) {
      this.validate(plan, context);
      const receipt = await handlers.get(plan.operation_type)(plan);
      return immutableSerializableDomain(receipt, { ...context,
        operation_type: plan.operation_type, path: '$.receipt',
        stage: 'effect_receipt_validation' });
    },
  });
}

/** Validate a complete aggregate before the first effect is allowed to run. */
export function validateEffectPlanAggregate(executor, plans = [], context = {}) {
  assertSerializableDomain(plans, { ...context, path: '$.plans',
    stage: 'effect_aggregate_validation' });
  for (const [index, plan] of plans.entries()) executor.validate(plan, {
    ...context, path: `$.plans[${index}]`, operation_type: plan?.operation_type,
    stage: 'effect_aggregate_validation',
  });
  return plans;
}

/**
 * Execute a prevalidated aggregate sequentially and return data-only receipts.
 * Optional hooks are runtime fault-injection/telemetry effects and are never
 * copied into the aggregate result.
 */
export async function executeEffectPlanAggregate({ executor, plans = [], context = {},
  hooks = {} } = {}) {
  validateEffectPlanAggregate(executor, plans, context);
  const completedReceipts = [];
  let stage = 'before_effects';
  let activePlan = null;
  try {
    await hooks.on_boundary?.({ stage, plan: null, completed_receipts: [] });
    for (const plan of plans) {
      activePlan = plan;
      stage = 'before_effect';
      await hooks.on_boundary?.({ stage, plan, completed_receipts: [...completedReceipts] });
      stage = 'effect_execution';
      const receipt = await executor.execute(plan, context);
      completedReceipts.push(receipt);
      stage = 'after_effect';
      await hooks.on_boundary?.({ stage, plan, completed_receipts: [...completedReceipts] });
    }
    activePlan = null;
    stage = 'after_effects';
    await hooks.on_boundary?.({ stage, plan: null,
      completed_receipts: [...completedReceipts] });
    stage = 'aggregate_receipt';
    return immutableSerializableDomain({
      schema_version: 1, status: 'effects_completed',
      operation_count: plans.length, receipts: completedReceipts,
    }, { ...context, path: '$.effect_aggregate_receipt',
      stage: 'effect_aggregate_receipt_validation' });
  } catch (error) {
    error.sme_origin ??= error?.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
      ? 'programming_error' : 'persistence';
    error.sme_failure_stage ??= stage;
    error.sme_reason_code ??= error?.code === 'SME_NON_SERIALIZABLE_DOMAIN_DATA'
      ? 'non_serializable_domain_data' : 'persistence_failure';
    error.sme_request_diagnostics = {
      ...(error.sme_request_diagnostics ?? {}),
      provider_call_required: false, retry_eligible: false,
      failure_stage: stage, failed_plan_id: activePlan?.plan_id ?? null,
      completed_owner_receipts: completedReceipts,
      pending_owner_plan_ids: plans
        .filter((plan) => !completedReceipts.some((receipt) => receipt.plan_id === plan.plan_id))
        .map((plan) => plan.plan_id),
    };
    throw error;
  }
}
