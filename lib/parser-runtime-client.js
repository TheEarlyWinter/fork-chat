import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, exclusiveFile, readCheckedFile } from './file-safety.js';

const JOB = /^[a-f0-9]{32}$/;
function port() {
  // 在 Node.js --permission 沙盒中，宿主未向 App 主进程开放 --allow-net，
  // 任何在主进程内调用 net.createServer() 都会抛出 ERR_ACCESS_DENIED 导致进程崩溃。
  // 在私有/动态端口范围 [20000, 60000] 内随机选取端口，由具备 native 权限的子进程负责绑定。
  return Promise.resolve(20000 + Math.floor(Math.random() * 40000));
}
export function createParserRuntimeClient({ sdk, dataDir, pollMs = 1200, startupTimeoutMs = 15000 }) {
  let current = null, starting = null;
  async function control(info, route, init = {}) {
    const response = await sdk.runtime.fetch(info.runtimeId, route, { ...init, headers: { ...init.headers, Authorization: `Bearer ${info.token}` }, timeoutMs: 5000 });
    const value = await response.json();
    if (!response.ok || value.ok !== true) throw Object.assign(new Error(value.error || '解析助手请求失败'), { code: 'PARSER_CONTROL_FAILED' });
    return value;
  }
  async function start() {
    if (typeof sdk.runtime?.start !== 'function') throw Object.assign(new Error('宿主不支持正式运行时'), { code: 'APP_RUNTIME_UNSUPPORTED' });
    const root = await privateDirectory(dataDir, '.parser-control');
    const generation = randomUUID().replaceAll('-', '');
    const name = `${generation}.json`, token = randomBytes(32).toString('hex');
    const handle = await exclusiveFile(root, name);
    try { await handle.writeFile(JSON.stringify({ token })); await handle.sync(); } finally { await handle.close(); }
    let info;
    try {
      const number = await port();
      info = { ...await sdk.runtime.start({ runtime: 'node', entry: 'runtime/parser.mjs', args: [String(number), name], profile: 'native', network: 'external', service: { id: 'document-parser', port: number, readyMarker: 'PARSER_READY' } }), token, generation };
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        const status = await sdk.runtime.get(info.runtimeId);
        if (['failed', 'exited', 'stopped'].includes(status?.state)) throw new Error('解析助手启动失败');
        if (status?.service?.state === 'ready') {
          const health = await control(info, '/health');
          if (health.protocol !== 2 || health.generation !== generation) throw new Error('解析助手协议或实例不匹配');
          current = info;
          return info;
        }
        await delay(100);
      }
      throw new Error('解析助手启动超时');
    } catch (error) {
      if (info) await sdk.runtime.stop(info.runtimeId).catch(() => {});
      throw error;
    } finally { await fs.rm(path.join(root, name), { force: true }).catch(() => {}); }
  }
  async function ready() {
    if (current) {
      const state = await sdk.runtime.get(current.runtimeId);
      if (state?.service?.state === 'ready' && state.state === 'ready') return current;
      current = null;
    }
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }
  async function stop(info) {
    await sdk.runtime.stop(info.runtimeId).catch(() => {});
    if (current === info) current = null;
  }
  async function parse(doc, options, { signal, onProgress } = {}) {
    signal?.throwIfAborted();
    const info = await ready();
    signal?.throwIfAborted();
    let jobId, done = false, submitted = false;
    try {
      submitted = true;
      const started = await control(info, '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: doc.fileId, sha256: doc.sha256, filename: doc.filename, options }) });
      if (!JOB.test(started.jobId)) throw new Error('解析助手任务标识无效');
      jobId = started.jobId;
      const duration = Number(started.timeoutMs);
      const deadline = Date.now() + (Number.isFinite(duration) ? Math.min(15 * 60 * 1000, Math.max(30000, duration)) : 5 * 60 * 1000) + 10000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = await control(info, `/jobs/${jobId}`);
        signal?.throwIfAborted();
        if (state.status === 'done') {
          if (state.resultFile !== `${jobId}.json`) throw new Error('解析结果文件引用无效');
          const root = await privateDirectory(dataDir, 'helper-results');
          const target = path.join(root, state.resultFile);
          const result = JSON.parse((await readCheckedFile(root, target, 16 * 1024 * 1024)).toString('utf8'));
          if (result.ok !== true || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2_000_000) throw new Error('解析结果不完整');
          signal?.throwIfAborted();
          await fs.rm(target, { force: true });
          done = true;
          return result;
        }
        if (['error', 'cancelled'].includes(state.status)) throw Object.assign(new Error(state.error || '解析失败'), { code: state.code || 'PARSE_FAILED' });
        onProgress?.(state.stage || '解析中');
        await delay(pollMs, undefined, { signal });
      }
      throw new Error('解析助手任务超时');
    } finally {
      if (!done && submitted) {
        if (jobId) {
          try {
            const cancelled = await control(info, `/jobs/${jobId}`, { method: 'DELETE' });
            if (!cancelled.settled) await stop(info);
          } catch { await stop(info); }
        } else await stop(info); // Submission may have succeeded before its reply was lost.
      }
    }
  }
  return { ready, parse };
}
