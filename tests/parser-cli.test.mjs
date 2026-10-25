import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createParserRuntimeClient } from '../lib/parser-runtime-client.js';

test('real Node entry consumes private capability file and authenticates startup health; startup is single-flight', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-cli-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let child, input, state = 'starting', base, starts = 0, stderr = '';
  const sdk = { runtime: {
    async start(value) {
      starts++; input = value;
      assert.equal(value.profile, 'native'); assert.equal(value.network, 'external');
      const authPath = path.join(dataDir, '.parser-control', value.args[1]);
      assert.equal((await fs.stat(authPath)).mode & 0o777, 0o600);
      const config = JSON.parse(await fs.readFile(authPath, 'utf8'));
      assert(!value.args.some(arg => arg.includes(config.token)));
      child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/parser.mjs', import.meta.url)), ...value.args], { cwd: dataDir, env: { PATH: process.env.PATH, HOME: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
      base = `http://127.0.0.1:${value.service.port}`;
      child.stdout.on('data', bytes => { if (bytes.toString().includes('PARSER_READY')) state = 'ready'; });
      child.stderr.on('data', bytes => { stderr += bytes.toString(); });
      child.on('exit', () => { state = 'stopped'; });
      return { runtimeId: 'synthetic-runtime', state: 'starting' };
    },
    async get() { if (state === 'stopped') throw new Error('entry failed: ' + stderr); return { state: state === 'ready' ? 'ready' : 'starting', service: { state: state === 'ready' ? 'ready' : 'pending' } }; },
    async fetch(_id, route, init) { return fetch(base + route, init); },
    async stop() {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
      state = 'stopped';
    },
  } };
  t.after(() => sdk.runtime.stop());
  const client = createParserRuntimeClient({ sdk, dataDir, startupTimeoutMs: 5000 });
  const [a, b] = await Promise.all([client.ready(), client.ready()]);
  assert.equal(a.runtimeId, b.runtimeId); assert.equal(starts, 1);
  assert.equal(input.service.id, 'document-parser');
  assert.equal((await fetch(base + '/health')).status, 401);
  assert.equal((await fetch(base + '/jobs', { method: 'POST', body: '{}' })).status, 401);
  assert.deepEqual(await fs.readdir(path.join(dataDir, '.parser-control')), []);
  assert.equal(stderr, '');
  await sdk.runtime.stop();
});
