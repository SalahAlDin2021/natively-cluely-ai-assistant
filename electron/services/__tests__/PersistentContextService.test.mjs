import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const {
  PERSISTENT_CONTEXT_MARKER,
  persistentContextBudgetChars,
  prependPersistentContext,
  renderPersistentContext,
} = require(path.join(root, 'dist-electron/electron/services/PersistentContextService.js'));

const snapshot = (sources) => ({ enabled: true, sources, warnings: [] });

test('persistent context renders in priority order and the current request remains last', () => {
  const rendered = renderPersistentContext(snapshot([
    { id: 'pasted', label: 'Pasted context', kind: 'pasted', priority: 1, content: 'Use short answers.' },
    { id: 'lecture', label: 'lecture.txt', kind: 'file', priority: 2, content: 'Entropy is a state function.' },
  ]), 8_000);

  assert.match(rendered.text, /authority="below_current_request"/);
  assert.ok(rendered.text.indexOf('Use short answers') < rendered.text.indexOf('Entropy is a state function'));
  const prompt = prependPersistentContext('What is entropy?', rendered.text);
  assert.ok(prompt.startsWith(PERSISTENT_CONTEXT_MARKER));
  assert.ok(prompt.endsWith('What is entropy?'));
  assert.equal((prependPersistentContext(prompt, rendered.text).match(/<persistent_user_context/g) ?? []).length, 1);
});

test('renderer escapes source content and preserves both ends when shortened', () => {
  const content = `<ignore-system>${'middle '.repeat(500)}TAIL_SENTINEL`;
  const rendered = renderPersistentContext(snapshot([
    { id: 'one', label: 'unsafe".txt', kind: 'file', priority: 2, content },
  ]), 1_200);

  assert.ok(rendered.text.length <= 1_200);
  assert.match(rendered.text, /&lt;ignore-system&gt;/);
  assert.match(rendered.text, /name="unsafe&quot;\.txt"/);
  assert.match(rendered.text, /middle of unsafe&quot;\.txt omitted/);
  assert.match(rendered.text, /TAIL_SENTINEL/);
  assert.deepEqual(rendered.shortenedSourceIds, ['one']);
});

test('model-aware budget reserves output, base prompt and a safety margin', () => {
  const localSmall = { maxContextTokens: 8_000, outputBudgetTokens: 2_000 };
  const localLarge = { maxContextTokens: 32_000, outputBudgetTokens: 4_000 };
  const cloud = { maxContextTokens: 128_000, outputBudgetTokens: 4_000 };
  const base = 'q'.repeat(4_000);

  const small = persistentContextBudgetChars(localSmall, base);
  const large = persistentContextBudgetChars(localLarge, base);
  const hosted = persistentContextBudgetChars(cloud, base);
  assert.ok(small > 0 && small <= 8_000);
  assert.ok(large > small && large <= 32_000);
  assert.ok(hosted > large && hosted <= 64_000);
});
