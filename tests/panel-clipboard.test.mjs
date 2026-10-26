import test from 'node:test';
import assert from 'node:assert/strict';

import { createClipboardWriter } from '../ui/assets/panel-clipboard.js';
import { bindCardExportHandlers } from '../ui/assets/panel-card-export.js';

// 这一层只用可控的假 DOM 验证 writer 自身的成功判据与清理。
// 它不证明真实浏览器或宿主 iframe 里的行为，也不接触系统剪贴板。

function makeDoc({ execResult = true, execThrows = null, selectThrows = null } = {}) {
  const state = { appended: [], removed: [], commands: [], selected: 0 };
  const body = {
    appendChild(el) {
      state.appended.push(el);
      el.parentNode = body;
    },
    removeChild(el) {
      state.removed.push(el);
      el.parentNode = null;
    },
  };
  const doc = {
    body,
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        value: '',
        style: {},
        parentNode: null,
        select() {
          state.selected += 1;
          if (selectThrows) throw selectThrows;
        },
      };
    },
    execCommand(command) {
      state.commands.push(command);
      if (execThrows) throw execThrows;
      return execResult;
    },
  };
  return { doc, state };
}

function makeNavigator({ writeText } = {}) {
  if (writeText === undefined) return { nav: {}, calls: [] };
  const calls = [];
  const nav = {
    clipboard: {
      writeText(text) {
        calls.push(text);
        return writeText(text);
      },
    },
  };
  return { nav, calls };
}

test('异步剪贴板成功：直接完成，不碰 textarea 兜底', async () => {
  const { nav, calls } = makeNavigator({ writeText: async () => undefined });
  const { doc, state } = makeDoc();
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => nav });

  await copyText('结构大纲');

  assert.deepEqual(calls, ['结构大纲'], '必须把原文交给异步剪贴板');
  assert.equal(state.appended.length, 0, '成功路径不该创建兜底 textarea');
  assert.equal(state.commands.length, 0, '成功路径不该调用 execCommand');
});

test('没有异步剪贴板时走兜底，execCommand 返回 true 才算成功', async () => {
  const { nav } = makeNavigator();
  const { doc, state } = makeDoc({ execResult: true });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => nav });

  await copyText('整链 Markdown');

  assert.deepEqual(state.commands, ['copy']);
  assert.equal(state.appended.length, 1, '兜底必须真的插入一个临时 textarea');
  assert.equal(state.appended[0].value, '整链 Markdown');
  assert.equal(state.removed.length, 1, '成功路径同样要移除临时节点');
  assert.equal(state.appended[0].parentNode, null);
});

test('异步剪贴板被拒后转兜底，兜底成功则整体成功', async () => {
  const { nav, calls } = makeNavigator({ writeText: async () => { throw new Error('权限受限'); } });
  const { doc, state } = makeDoc({ execResult: true });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => nav });

  await copyText('回退内容');

  assert.equal(calls.length, 1, '异步接口只该被尝试一次');
  assert.deepEqual(state.commands, ['copy']);
  assert.equal(state.removed.length, 1);
});

test('execCommand 返回 false 必须失败，不能当作已复制', async () => {
  const { nav } = makeNavigator();
  const { doc, state } = makeDoc({ execResult: false });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => nav });

  await assert.rejects(
    () => copyText('未确认内容'),
    /复制/,
    'execCommand 返回 false 表示本次复制没有被确认，writer 必须拒绝',
  );

  assert.deepEqual(state.commands, ['copy'], '仍然应该真的尝试过一次');
  assert.equal(state.removed.length, 1, '失败路径也必须移除临时节点');
});

test('execCommand 返回值不是 true 的其它形式同样失败', async () => {
  // 注意：默认参数只对 undefined 生效，所以这里用一个明确的非 true 真值（1），
  // 验证判据是严格 equality，不是“看起来成功就算成功”。
  const { doc } = makeDoc({ execResult: 1 });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => ({}) });

  await assert.rejects(() => copyText('内容'), /复制/);
});

test('execCommand 抛错时失败并清理临时节点', async () => {
  const { doc, state } = makeDoc({ execThrows: new Error('命令被拒绝') });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => ({}) });

  await assert.rejects(() => copyText('内容'), /命令被拒绝/);
  assert.equal(state.removed.length, 1, '抛错时也必须移除临时节点');
  assert.equal(state.appended[0].parentNode, null);
});

test('select 抛错时失败并清理临时节点', async () => {
  const { doc, state } = makeDoc({ selectThrows: new Error('无法选中') });
  const copyText = createClipboardWriter({ doc: () => doc, getNavigator: () => ({}) });

  await assert.rejects(() => copyText('内容'), /无法选中/);
  assert.equal(state.removed.length, 1, 'select 失败时也必须移除临时节点');
  assert.equal(state.commands.length, 0, 'select 失败不应继续执行 copy');
});

test('文档不可用时直接失败，不伪造成功', async () => {
  const copyText = createClipboardWriter({ doc: () => null, getNavigator: () => ({}) });
  await assert.rejects(() => copyText('内容'), /剪贴板不可用/);
});

test('writer 不读取也不清空用户剪贴板', async () => {
  const touched = [];
  const nav = {
    clipboard: {
      writeText(text) { touched.push(['writeText', text]); return Promise.resolve(); },
      readText() { touched.push(['readText']); return Promise.resolve(''); },
    },
  };
  const copyText = createClipboardWriter({ doc: () => null, getNavigator: () => nav });

  await copyText('正文');

  assert.deepEqual(touched, [['writeText', '正文']], '除写入本次内容外不得触碰剪贴板');
});

// —— 接真实调用方：失败必须走失败提示，不能显示成功文案 ——

function makeButton() {
  return { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
}

function makeCardEl() {
  const topology = makeButton();
  const chain = makeButton();
  return {
    topology,
    chain,
    querySelector(selector) {
      if (selector === '[data-action="export-topology"]') return topology;
      if (selector === '[data-action="export-chain"]') return chain;
      return null;
    },
  };
}

function bindExport({ cardEl, copyText }) {
  const messages = [];
  bindCardExportHandlers({
    cardEl,
    card: { id: 'card-1', title: '测试卡' },
    on: (el, type, fn) => el.addEventListener(type, fn),
    getIsDisposed: () => false,
    cardsNow: () => [{ id: 'card-1', title: '测试卡' }],
    cardParentIds: new Map(),
    buildTopologyOutline: () => '大纲文本',
    findCardAncestorChain: () => [{ id: 'card-1', title: '测试卡' }],
    formatCardChainMarkdown: () => '# 链路',
    copyText,
    flashMessage: msg => messages.push(msg),
    safeDetail: value => String(value),
  });
  return messages;
}

for (const [label, selector] of [['结构大纲', 'topology'], ['整链', 'chain']]) {
  test(`${label}导出：复制未被确认时必须报失败，不得显示已复制`, async () => {
    const cardEl = makeCardEl();
    const messages = bindExport({
      cardEl,
      copyText: createClipboardWriter({
        doc: () => makeDoc({ execResult: false }).doc,
        getNavigator: () => ({}),
      }),
    });

    await cardEl[selector].listeners.click({ stopPropagation() {} });

    assert.equal(messages.length, 1, '必须给出一条提示');
    assert.match(messages[0], /失败/, '提示必须说明失败');
    assert.equal(messages[0].includes('已复制'), false, '不得出现已复制的成功文案');
    assert.equal(messages[0].includes('复制到剪贴板'), false, '不得声称已复制到剪贴板');
  });

  test(`${label}导出：复制确认成功后才显示成功文案`, async () => {
    const cardEl = makeCardEl();
    const messages = bindExport({
      cardEl,
      copyText: async () => undefined,
    });

    await cardEl[selector].listeners.click({ stopPropagation() {} });

    assert.equal(messages.length, 1);
    assert.match(messages[0], /复制/);
    assert.equal(messages[0].includes('失败'), false);
  });
}
