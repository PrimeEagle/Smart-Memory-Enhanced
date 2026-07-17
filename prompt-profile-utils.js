/** Pure helpers for portable Prompt Preset profiles. No SillyTavern runtime dependency. */

export function createTaskMap(taskIds, values = {}) {
  return Object.fromEntries(taskIds.map((task) => [task, typeof values[task] === 'string' ? values[task] : '']));
}

export function resolveProfileAssignment({ chat = '', character = '', global = '' }, knownIds, fallback = 'builtin:default') {
  return [chat, character, global, fallback].find((id) => id && knownIds.has(id)) ?? fallback;
}

export function makePromptPresetExport(name, tasks) {
  return {
    format: 'smart-memory-enhanced-prompt-preset',
    version: 2,
    name,
    tasks: { ...tasks },
  };
}

export function validatePromptPresetImport(payload, taskIds) {
  if (!payload || payload.format !== 'smart-memory-enhanced-prompt-preset' || payload.version !== 2) {
    throw new Error('This is not a full Smart Memory Enhanced prompt preset.');
  }
  if (typeof payload.name !== 'string' || !payload.name.trim() || !payload.tasks || typeof payload.tasks !== 'object') {
    throw new Error('The prompt preset file is missing a name or task configuration.');
  }
  return { name: payload.name.trim(), tasks: createTaskMap(taskIds, payload.tasks) };
}
