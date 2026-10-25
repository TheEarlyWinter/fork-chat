import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const ENTRY = '../ui/assets/function-panel.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function loadPanel({ watchReturn, watchReject } = {}) {
  const windowEvents = new Map();
  const channel = {
    closeCalls: 0,
    postMessages: [],
    listeners: new Map(),
    close() { this.closeCalls += 1; },
    postMessage(message) { this.postMessages.push(message); },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
  };
  const storageWatch = {
    callback: null,
    calls: 0,
  };
  const loads = { agents: 0, sessions: 0 };
  const hostCalls = [];
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);

  const document = {
    getElementById() { return null; },
  };
  const window = {
    addEventListener(type, handler) { windowEvents.set(type, handler); },
    removeEventListener(type, handler) {
      if (windowEvents.get(type) === handler) windowEvents.delete(type);
    },
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };

  const hana = { readyCalls: 0, ready() { this.readyCalls += 1; } };
  const requestHost = async (...args) => {
    hostCalls.push(args);
    return { json: async () => ({}) };
  };
  const createForkSessionStore = () => ({
    watch(callback) {
      storageWatch.callback = callback;
      storageWatch.calls += 1;
      if (watchReject) return Promise.reject(watchReject);
      return watchReturn;
    },
  });
  const writeRenameIntent = () => {};
  const createAgentListController = () => ({
    loadAgents() { loads.agents += 1; },
    restoreAgent() {},
  });
  const createSessionListController = () => ({
    loadSessions() { loads.sessions += 1; },
    handleSessionState() {},
    handleSessionResult() {},
  });

  const context = vm.createContext({
    console,
    document,
    window,
    localStorage,
    BroadcastChannel: function BroadcastChannel() { return channel; },
    setTimeout,
    clearTimeout,
    Promise,
    Math,
  });
  const source = await readFile(new URL(ENTRY, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: ENTRY });
  const imports = {
    './sdk.js': { hana },
    './host-api.js': { requestHost },
    './fork-session-store.js': { createForkSessionStore },
    './fork-session-commands.js': { writeRenameIntent },
    './function-agents.js': { createAgentListController },
    './function-sessions.js': { createSessionListController },
  };
  await module.link(async specifier => {
    const exports = imports[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  try {
    await module.evaluate();
    return {
      channel,
      windowEvents,
      storageWatch,
      loads,
      hostCalls,
      unhandled,
      async flushRejections() {
        await Promise.resolve();
        await new Promise(resolve => setImmediate(resolve));
      },
      cleanupUnhandled() { process.removeListener('unhandledRejection', onUnhandled); },
    };
  } catch (error) {
    process.removeListener('unhandledRejection', onUnhandled);
    throw error;
  }
}

async function loadPanelForLifecycle(options = {}) {
  const result = await loadPanel(options);
  // The module evaluates synchronously; callers use this hook only to make the
  // fixture's intent explicit and to avoid hiding promise rejection timing.
  return result;
}

test('function-panel: pagehide synchronously unsubscribes and closes BroadcastChannel exactly once', async () => {
  let unsubscribeCalls = 0;
  const panel = await loadPanelForLifecycle({
    watchReturn: () => { unsubscribeCalls += 1; },
  });
  const release = panel.windowEvents.get('pagehide');
  const beforeunload = panel.windowEvents.get('beforeunload');
  assert.equal(typeof release, 'function');
  assert.equal(typeof beforeunload, 'function');

  release();
  assert.equal(unsubscribeCalls, 1, '同步 unsubscribe 必须在 pagehide 当场执行');
  assert.equal(panel.channel.closeCalls, 1);
  beforeunload();
  release();
  assert.equal(unsubscribeCalls, 1);
  assert.equal(panel.channel.closeCalls, 1);
  panel.cleanupUnhandled();
});

test('function-panel: a captured storage callback is closed by the release gate', async () => {
  let unsubscribeCalls = 0;
  const panel = await loadPanelForLifecycle({
    watchReturn: () => { unsubscribeCalls += 1; },
  });
  const callback = panel.storageWatch.callback;
  assert.equal(panel.loads.sessions, 1, '初始化只加载一次会话');

  callback();
  assert.equal(panel.loads.sessions, 2);
  panel.windowEvents.get('pagehide')();
  callback();
  assert.equal(panel.loads.sessions, 2, '关闭后捕获的 watch 回调不得继续 loadSessions');
  assert.equal(unsubscribeCalls, 1);
  panel.cleanupUnhandled();
});

test('function-panel: Promise unsubscribe releases once before or after close and closes the callback gate while pending', async () => {
  for (const resolveBeforeClose of [true, false]) {
    const pending = deferred();
    let unsubscribeCalls = 0;
    const panel = await loadPanelForLifecycle({ watchReturn: pending.promise });
    const callback = panel.storageWatch.callback;
    const release = panel.windowEvents.get('pagehide');

    if (resolveBeforeClose) {
      pending.resolve(() => { unsubscribeCalls += 1; });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(unsubscribeCalls, 0);
      release();
      assert.equal(unsubscribeCalls, 1);
    } else {
      release();
      assert.equal(panel.channel.closeCalls, 1);
      callback();
      assert.equal(panel.loads.sessions, 1, 'Promise 等待期间关闭门禁必须立即生效');
      pending.resolve(() => { unsubscribeCalls += 1; });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(unsubscribeCalls, 1, '关闭后 resolve 的 unsubscribe 只能释放一次');
    }

    release();
    assert.equal(unsubscribeCalls, 1);
    assert.equal(panel.channel.closeCalls, 1);
    panel.cleanupUnhandled();
  }
});

test('function-panel: registration or unsubscribe failures are contained and never block channel close', async () => {
  const registrationFailure = await loadPanelForLifecycle({
    watchReject: new Error('watch failed'),
  });
  registrationFailure.windowEvents.get('pagehide')();
  await registrationFailure.flushRejections();
  assert.equal(registrationFailure.channel.closeCalls, 1);
  assert.deepEqual(registrationFailure.unhandled, []);
  registrationFailure.cleanupUnhandled();

  for (const unsubscribe of [
    () => { throw new Error('sync unsubscribe failed'); },
    () => Promise.reject(new Error('async unsubscribe failed')),
  ]) {
    const panel = await loadPanelForLifecycle({ watchReturn: unsubscribe });
    panel.windowEvents.get('pagehide')();
    await panel.flushRejections();
    assert.equal(panel.channel.closeCalls, 1);
    assert.deepEqual(panel.unhandled, []);
    panel.cleanupUnhandled();
  }
});
