import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeNotificationText, pick, langOf } from '../src/l10n.js';

const files = ['../src/index.js', '../src/cron/debt-reminder.js', '../src/auth/handlers.js', '../src/l10n.js'];
for (const f of files) {
  const src = readFileSync(new URL(f, import.meta.url), 'utf8');
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
assert.equal(sanitizeNotificationText('a — b – c'), 'a : b - c');
assert.equal(pick({ en: 'e', am: 'a' }, 'am'), 'a');
assert.equal(pick({ en: 'e', am: 'a' }, 'en'), 'e');
assert.equal(langOf({ language_code: 'AM' }), 'am');
assert.equal(langOf({}), 'en');
console.log('emdash check passed');
