import { completedMemorizeOutcome, isMemorizeOutcome, memorizeOutcomeFromException } from './memorize-outcome.js';

/** One execution boundary shared by initial and resumed Memorize Chat runs. */
export function createMemorizeRunEngine() {
  let activeInvocation = null;
  return Object.freeze({
    get active_invocation() { return activeInvocation; },
    async execute(invocation, operation, thisArg = null, args = []) {
      if (activeInvocation) {
        return memorizeOutcomeFromException(Object.assign(new Error('Memorize Chat is already running.'), {
          code: 'already_running',
        }), { kind: 'blocked', resumable: false });
      }
      activeInvocation = Object.freeze({
        invocation_id: invocation?.invocation_id ?? `memorize-engine-${Date.now()}`,
        mode: invocation?.mode === 'resume' ? 'resume' : 'initial',
        started_at: Date.now(),
      });
      try {
        const value = await operation.apply(thisArg, args);
        return isMemorizeOutcome(value) ? value : completedMemorizeOutcome(value);
      } catch (error) {
        const outcome = memorizeOutcomeFromException(error);
        if (outcome.kind === 'paused' || outcome.kind === 'blocked') return outcome;
        throw error;
      } finally {
        activeInvocation = null;
      }
    },
  });
}

/** DOM adapter kept separate so the engine remains deterministic in tests. */
export function bindMemorizeRunEngine(button, engine, handler, describeInvocation = () => ({})) {
  const bound = async function (...args) {
    return engine.execute(describeInvocation.call(this, ...args), handler, this, args);
  };
  button.on('click', bound);
  return bound;
}

