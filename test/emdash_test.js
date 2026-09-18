// Guards notification payloads against emdash (U+2014) regressions.
// Run with: node test/emdash_test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = ['../src/index.js', '../src/cron/debt-reminder.js', '../src/auth/handlers.js'];
for (const f of files) {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8');
  // Strip console.* lines and // comments: only payload strings matter.
  const payload = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('console.'))
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
  assert.ok(!payload.includes('—'), `${f} contains emdash in non-log code`);
}
console.log('emdash check passed');
