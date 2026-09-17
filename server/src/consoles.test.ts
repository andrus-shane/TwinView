import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, resolveConsole } from './consoles.js';

test('resolveConsole: override beats the model default; string form takes the link LCD; unknown -> undefined', () => {
  assert.deepEqual(resolveConsole('u04', 'NTL17624'), { link: 'if20', lcd: 'http://127.0.0.1:8892' });
  assert.deepEqual(resolveConsole('u03', 'NTL17915', { u03: 'dfab' }), { link: 'dfab', lcd: undefined });
  assert.deepEqual(resolveConsole('u07', 'NTL99925', { u07: { link: 'pm210', lcd: 'http://10.0.0.5:8889' } }), {
    link: 'pm210',
    lcd: 'http://10.0.0.5:8889',
  });
  assert.equal(resolveConsole('u09', 'FMRW0826-1D30'), undefined);
});

test('nameKey: idle, exact hit, chord, unmapped byte', () => {
  const keys = [
    { index: 2, mask: 246, label: 'Start' },
    { index: 2, mask: 238, label: 'Stop' },
    { index: 0, mask: 237, label: 'Speed Mph 10' },
  ];
  assert.equal(nameKey(keys, 2, 255), null);
  assert.equal(nameKey(keys, 2, 246), 'Start');
  assert.equal(nameKey(keys, 2, 246 & 238), 'Start+Stop');
  assert.equal(nameKey(keys, 1, 190), 'KEY_ARRAY2=190');
});
