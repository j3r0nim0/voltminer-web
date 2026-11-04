import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed, parseAllowlist, DEFAULT_ORIGINS } from './origin.mjs';

const allow = new Set(DEFAULT_ORIGINS);

test('allows production and github.io site', () => {
  assert.equal(originAllowed('https://j3r0nim0.github.io', allow), true);
  assert.equal(originAllowed('https://voltminer.net', allow), true);
  assert.equal(originAllowed('https://www.voltminer.net', allow), true);
});

test('supports wildcard allowlist (*)', () => {
  const wildcard = new Set(['*']);
  assert.equal(originAllowed('https://custom-domain.org', wildcard), true);
  assert.equal(originAllowed('https://anywhere.io', wildcard), true);
  assert.equal(originAllowed('', wildcard), false);
});

test('rejects missing / foreign origins', () => {
  assert.equal(originAllowed('', allow), false);
  assert.equal(originAllowed(null, allow), false);
  assert.equal(originAllowed('https://evil.example', allow), false);
  assert.equal(originAllowed('https://workers.dev', allow), false);
});

test('allows loopback http for local preview', () => {
  assert.equal(originAllowed('http://localhost:8080', allow), true);
  assert.equal(originAllowed('http://127.0.0.1:8080', allow), true);
  assert.equal(originAllowed('https://localhost:8080', allow), false);
});

test('parseAllowlist', () => {
  const s = parseAllowlist(' https://a.example,https://b.example , ');
  assert.equal(s.has('https://a.example'), true);
  assert.equal(s.has('https://b.example'), true);
  assert.equal(s.size, 2);
});
