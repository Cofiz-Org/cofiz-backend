import assert from 'node:assert/strict';

const { formatReleaseNotes } = await import('../../src/release/notes.js');

console.log('Testing headline stays one continuous line...');
{
  const { headline, body } = formatReleaseNotes('v1.0.5', '- faster sync\n- bug fixes');
  assert.equal(headline, 'v1.0.5 is ready to install');
  assert.ok(!headline.includes('\n'));
  assert.ok(body.startsWith('v1.0.5 is ready to install\n\n'));
}
console.log('✓ headline');

console.log('Testing markdown bullets become ticked items...');
{
  const { body } = formatReleaseNotes('v1.0.5', '### What changed\n- faster sync\n* bug fixes\n1. Amharic strings\n\nplain line');
  const lines = body.split('\n');
  assert.equal(lines[0], 'v1.0.5 is ready to install');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '✓ What changed');
  assert.equal(lines[3], '✓ faster sync');
  assert.equal(lines[4], '✓ bug fixes');
  assert.equal(lines[5], '✓ Amharic strings');
  assert.equal(lines[6], '✓ plain line');
}
console.log('✓ ticks');

console.log('Testing blank lines and inline markdown are stripped...');
{
  const { body } = formatReleaseNotes('v1.0.5', '\n\n**bold** item\r\n`code` fix\n\n');
  assert.equal(body, 'v1.0.5 is ready to install\n\n✓ bold item\n✓ code fix');
}
console.log('✓ stripped');

console.log('Testing empty notes keep headline only...');
{
  const { body } = formatReleaseNotes('v1.0.5', '   \n ');
  assert.equal(body, 'v1.0.5 is ready to install');
}
console.log('✓ empty');

console.log('Testing long notes cap at a line boundary with overflow count...');
{
  const many = Array.from({ length: 20 }, (_, i) => `- change number ${i + 1}`).join('\n');
  const { body } = formatReleaseNotes('v1.0.5', many);
  assert.ok(body.length <= 501, `length ${body.length}`);
  assert.ok(body.includes('• …and 8 more'));
  assert.ok(!body.includes('change number 13'));
  for (const line of body.split('\n').slice(2)) {
    assert.ok(line.startsWith('✓ ') || line.startsWith('• '), line);
  }
}
console.log('✓ capped');

console.log('All release-notes format tests passed.');
