import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, MAX_URL_LENGTH } from '../src/validate.js';

const BASE = 'http://localhost:3000';

test('accepts http and https and returns the normalized href', () => {
  assert.deepEqual(validateUrl('https://example.com', BASE), { ok: true, url: 'https://example.com/' });
  assert.deepEqual(validateUrl('  http://example.com/a?b=c  ', BASE), { ok: true, url: 'http://example.com/a?b=c' });
});

test('rejects non-strings and empty input', () => {
  assert.equal(validateUrl(undefined, BASE).ok, false);
  assert.equal(validateUrl(42, BASE).ok, false);
  assert.equal(validateUrl('   ', BASE).ok, false);
});

test('rejects disallowed protocols', () => {
  for (const url of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c']) {
    assert.equal(validateUrl(url, BASE).ok, false, url);
  }
});

test('enforces the maximum length', () => {
  const okUrl = 'https://example.com/' + 'a'.repeat(MAX_URL_LENGTH - 20);
  assert.equal(validateUrl(okUrl, BASE).ok, true);
  assert.equal(validateUrl(okUrl + 'a'.repeat(21), BASE).ok, false);
});

test('rejects the app host regardless of case or port', () => {
  assert.equal(validateUrl('http://localhost:3000/abc', BASE).ok, false);
  assert.equal(validateUrl('http://LOCALHOST/abc', BASE).ok, false);
  assert.equal(validateUrl('https://go.shruthic.me/x', 'https://go.shruthic.me').ok, false);
  assert.equal(validateUrl('https://example.com/x', 'https://go.shruthic.me').ok, true);
});
