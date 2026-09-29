import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileGenerationPrompt, buildProfileRelationshipCorrectionPrompt } from '../prompts.js';

test('profile prompt treats relationship descriptors as closed enums with valid and invalid examples', () => {
  const prompt = buildProfileGenerationPrompt('Alex', '', '', [], '', {
    pair: { subject_name: 'Alex', target_name: 'Sam', descriptors: ['trusting', 'affectionate'] },
  });
  assert.match(prompt, /closed enum/i);
  assert.match(prompt, /Valid:/);
  assert.match(prompt, /Invalid:/);
});

test('relationship correction prompt contains only rejected field names and authoritative enums', () => {
  const prompt = buildProfileRelationshipCorrectionPrompt([{ field_path: 'Sam', generated_value: 'deeply loving prose', authoritative_value: ['trusting', 'affectionate'] }]);
  assert.match(prompt, /Sam: allowed enum = \[trusting, affectionate\]/);
  assert.doesNotMatch(prompt, /deeply loving prose/);
  assert.match(prompt, /only the rejected relationship fields/i);
});
