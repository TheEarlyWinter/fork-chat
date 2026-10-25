import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferToBase64, formatFileSize, rootSlotPosition } from '../ui/assets/panel-format.js';

test('panel-format: bufferToBase64 matches Buffer base64 across chunk boundaries', () => {
  for (const length of [0, 8190, 8191, 16381]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 73 + 19) & 0xff;

    assert.equal(
      bufferToBase64(bytes.buffer),
      Buffer.from(bytes).toString('base64'),
      `length ${length} must encode identically`,
    );
  }
});

test('panel-format: formatFileSize handles invalid, byte, KB, and MB boundaries', () => {
  const cases = [
    [Number.NaN, '0 B'],
    [Number.POSITIVE_INFINITY, '0 B'],
    [-1, '0 B'],
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1048575, '1024.0 KB'],
    [1048576, '1.0 MB'],
    [1572864, '1.5 MB'],
  ];

  for (const [bytes, expected] of cases) assert.equal(formatFileSize(bytes), expected, `${bytes} bytes`);
});

test('panel-format: rootSlotPosition advances three columns then starts the next row', () => {
  const expected = [
    { x: 80, y: 100 },
    { x: 480, y: 100 },
    { x: 880, y: 100 },
    { x: 80, y: 540 },
    { x: 480, y: 540 },
    { x: 880, y: 540 },
    { x: 80, y: 980 },
  ];

  for (let index = 1; index <= expected.length; index += 1) {
    assert.deepEqual(rootSlotPosition(index), expected[index - 1], `root slot ${index}`);
  }

  for (let index = 1; index < 10; index += 1) {
    const current = rootSlotPosition(index);
    const next = rootSlotPosition(index + 1);
    if (index % 3 === 0) {
      assert.deepEqual(next, { x: 80, y: current.y + 440 }, `slot ${index + 1} starts a new row`);
    } else {
      assert.deepEqual(next, { x: current.x + 400, y: current.y }, `slot ${index + 1} advances one column`);
    }
  }
});

test('panel-format: rootSlotPosition exposes current arithmetic for invalid indices', () => {
  assert.deepEqual(rootSlotPosition(0), { x: -320, y: -340 });
  assert.deepEqual(rootSlotPosition(-1), { x: -720, y: -340 });
  assert.deepEqual(rootSlotPosition(1.5), { x: 280, y: 100 });
});
