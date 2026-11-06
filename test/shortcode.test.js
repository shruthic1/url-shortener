import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, CODE_PATTERN } from '../src/shortcode.js';

test('generates 7-character alphanumeric codes', () => {
  for (let i = 0; i < 500; i++) {
    assert.match(generateCode(), CODE_PATTERN);
  }
});

test('codes are not all the same', () => {
  const codes = new Set(Array.from({ length: 100 }, generateCode));
  assert.ok(codes.size > 90);
});

test('pattern rejects wrong lengths and characters', () => {
  for (const bad of ['abc', 'abcdefgh', 'abc-123', 'abc_123', 'abc 123', '']) {
    assert.equal(CODE_PATTERN.test(bad), false, bad);
  }
});
