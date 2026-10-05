import { test } from 'node:test';
import assert from 'node:assert';
import { looksLikeSession, parseSessionString, isValidCreds } from '../src/session-utils';

const fakeCreds = {
  noiseKey: { private: { type: 'Buffer', data: [1, 2, 3] }, public: { type: 'Buffer', data: [4, 5, 6] } },
  advSecretKey: 'x'.repeat(32),
  me: { id: '93700000000:5@s.whatsapp.net' }
};

test('JSON خام به‌عنوان سشن شناخته می‌شود', () => {
  const j = JSON.stringify(fakeCreds);
  assert.ok(looksLikeSession(j));
  const parsed = parseSessionString(j);
  assert.ok(parsed && isValidCreds(parsed));
});

test('base64 کار می‌کند', () => {
  const b64 = Buffer.from(JSON.stringify(fakeCreds)).toString('base64');
  assert.ok(looksLikeSession(b64));
  const parsed = parseSessionString(b64);
  assert.ok(parsed && isValidCreds(parsed));
});

test('پیشوند برچسب مثل VeroBot!xxx پشتیبانی می‌شود', () => {
  const b64 = 'VeroBot!' + Buffer.from(JSON.stringify(fakeCreds)).toString('base64');
  const parsed = parseSessionString(b64);
  assert.ok(parsed && isValidCreds(parsed));
});

test('چت عادی سشن تلقی نمی‌شود', () => {
  assert.equal(looksLikeSession('سلام چطوری'), false);
  assert.equal(looksLikeSession('ارسال +93712345678 سلام'), false);
  assert.equal(looksLikeSession('A'.repeat(50)), false);
});

test('سشن خراب null برمی‌گرداند', () => {
  assert.equal(parseSessionString('garbage-not-a-session'), null);
  const partial = JSON.stringify({ me: fakeCreds.me }); /* بدون noiseKey */
  assert.equal(isValidCreds(parseSessionString(partial)), false);
});
