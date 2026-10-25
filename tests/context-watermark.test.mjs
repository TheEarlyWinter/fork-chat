import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContextWatermark, jsonEscapedBytes, resolveContextLimits, CONTEXT_WATERMARK_DEFAULTS } from '../ui/assets/context-watermark.js';

const entry = (role, text) => ({ role, parts: () => [text] });
const turn = text => [entry('user', `${text}?`), entry('assistant', `${text}!`)];
const bytes = messages => Buffer.byteLength(JSON.stringify(messages));

test('watermark: defaults are finite, invalid overrides cannot enlarge hard ceilings', () => {
  assert.equal(CONTEXT_WATERMARK_DEFAULTS.maxMessages, 256);
  assert.equal(CONTEXT_WATERMARK_DEFAULTS.maxBytes, 512 * 1024);
  for (const value of [Infinity, NaN, -1, 0, 1e9, '10']) {
    const limits = resolveContextLimits({ maxMessages: value, maxBytes: value });
    assert.ok(limits.maxMessages > 0 && limits.maxMessages <= 256);
    assert.ok(limits.maxBytes > 0 && limits.maxBytes <= 512 * 1024);
  }
  assert.ok(resolveContextLimits({ maxMessages: 4 }).targetMessages <= 4);
});

test('watermark: JSON byte counter handles Chinese, escaping, emoji and split/lone surrogates', () => {
  for (const parts of [['汉😀\\\"\n\u0000'], ['\ud83d', '\ude00'], ['\ud83d', 'x', '\udc00'], [''], ['\b\t\f\r']]) {
    const expected = Buffer.byteLength(JSON.stringify(parts.join(''))) - 2;
    assert.equal(jsonEscapedBytes(parts), expected);
    if (expected > 2) assert.equal(jsonEscapedBytes(parts, 2), 3, 'saturated count, not a fabricated exact total');
  }
});

test('watermark: small history unchanged, inputs untouched and exact wire bytes', () => {
  const out = applyContextWatermark({ groups: [turn('old')], pending: entry('user', 'new') });
  assert.deepEqual(out.messages, [{ role: 'user', content: 'old?' }, { role: 'assistant', content: 'old!' }, { role: 'user', content: 'new' }]);
  assert.equal(out.stats.wireBytes, bytes(out.messages));
  assert.equal(out.stats.omittedMessageCount, 0);
  assert.deepEqual(out.errors, []);
});

test('watermark: count OR byte high line trims oldest whole turns toward low line', () => {
  const out = applyContextWatermark({ groups: [turn('a'), turn('b'), turn('c')], pending: entry('user', 'pending'), limits: { maxMessages: 6, targetMessages: 4 } });
  assert.deepEqual(out.messages.map(m => m.content), ['c?', 'c!', 'pending']);
  assert.equal(out.stats.omittedMessageCount, 4);
  assert.equal(out.stats.watermarked, true);
});

test('watermark: byte overflow alone triggers and never cuts strings/turns', () => {
  const out = applyContextWatermark({ groups: [turn('汉'.repeat(80)), turn('new')], pending: entry('user', '问'), limits: { maxBytes: 250, targetBytes: 180 } });
  assert.deepEqual(out.messages.map(m => m.content), ['new?', 'new!', '问']);
  assert.equal(out.stats.wireBytes, bytes(out.messages));
  assert.ok(bytes(out.messages) <= 250);
});

test('watermark: exact high line is accepted, one byte less omits the whole group', () => {
  const expected = [{ role: 'user', content: 'x?' }, { role: 'assistant', content: 'x!' }, { role: 'user', content: 'p' }];
  const exact = bytes(expected);
  assert.equal(applyContextWatermark({ groups: [turn('x')], pending: entry('user', 'p'), limits: { maxBytes: exact } }).messages.length, 3);
  assert.equal(applyContextWatermark({ groups: [turn('x')], pending: entry('user', 'p'), limits: { maxBytes: exact - 1 } }).messages.length, 1);
});

test('watermark: protected pending over high line fails closed before any history projection', () => {
  const explosive = { role: 'user', parts: () => { throw new Error('old history must stay lazy'); } };
  const out = applyContextWatermark({ groups: [[explosive]], pending: entry('user', '大'.repeat(100)), limits: { maxBytes: 100 } });
  assert.equal(out.errors[0].code, 'CONTEXT_PENDING_TOO_LARGE');
  assert.deepEqual(out.messages, []);
});

test('watermark: pending between low/high remains complete with no invented summary', () => {
  const pending = 'p'.repeat(130);
  const out = applyContextWatermark({ groups: [turn('x'.repeat(100))], pending: entry('user', pending), limits: { maxBytes: 240, targetBytes: 100 } });
  assert.deepEqual(out.messages, [{ role: 'user', content: pending }]);
  assert.ok(bytes(out.messages) <= 240);
});

test('watermark: latest oversized turn stops suffix; never reintroduces older small turns', () => {
  const out = applyContextWatermark({ groups: [turn('small'), turn('x'.repeat(1000))], pending: entry('user', 'new'), limits: { maxBytes: 150 } });
  assert.deepEqual(out.messages.map(m => m.content), ['new']);
  assert.equal(out.stats.omittedMessageCount, 4);
});

test('watermark: no pending gives bounded historical preview and empty input has two wire bytes', () => {
  assert.deepEqual(applyContextWatermark().messages, []);
  assert.equal(applyContextWatermark().stats.wireBytes, 2);
  const out = applyContextWatermark({ groups: [turn('a'), turn('b')], limits: { maxMessages: 2 } });
  assert.deepEqual(out.messages.map(m => m.content), ['b?', 'b!']);
});

test('watermark: old bodies stay lazy at 10000 messages and deterministic repeated compiles', () => {
  let visited = 0;
  const groups = Array.from({ length: 5000 }, (_, i) => ['user', 'assistant'].map(role => ({ role, parts: () => { visited++; return [`${i}:${role}`]; } })));
  const first = applyContextWatermark({ groups, pending: entry('user', 'p') });
  assert.ok(visited <= 256, 'do not render/concatenate every old body before pruning');
  assert.ok(first.messages.length <= 192);
  assert.equal(first.stats.omittedMessageCount + first.messages.length, 10001);
  assert.deepEqual(applyContextWatermark({ groups, pending: entry('user', 'p') }).messages, first.messages);
});

test('watermark: deterministic arbitrary UTF-16 counter agrees with actual JSON encoding', () => {
  let seed = 19;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let n = 0; n < 500; n++) {
    const parts = Array.from({ length: 3 }, () => Array.from({ length: next() % 25 }, () => String.fromCharCode(next() & 0xffff)).join(''));
    assert.equal(jsonEscapedBytes(parts), Buffer.byteLength(JSON.stringify(parts.join(''))) - 2);
  }
});
