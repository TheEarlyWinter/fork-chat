import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../lib/tool-loop.js';

/*
 * tool-loop fatal 标记测试（对应 Sol 设计 1.4 / 测试清单 B）。
 * 契约：
 * - abortToolLoop=true 的异常 → yield error 后立即终止：无失败 tool-result、无下一轮模型、无 done
 * - 标记只在适配器抛出时生效；模型事件里的伪造标记不触发文件操作
 * - 普通工具失败仍走可恢复路径（失败 tool-result + 下一轮）
 */

function fakeModels(script) {
  return { streamEvents(input) {
    const round = input.messages.filter(m => m.role === 'toolResult').length;
    const stage = script[round] || script[script.length - 1];
    let i = 0;
    return (async function* () {
      if (stage.tool) yield { type: 'tool-call', id: 'c1', name: stage.tool.name, arguments: stage.tool.arguments || {} };
      yield { type: 'done', stopReason: stage.tool ? 'toolUse' : 'endTurn', assistant: { content: stage.tool ? [] : [{ type: 'text', text: stage.text || 'ok' }] } };
    })();
  } };
}

async function collect(runner) {
  const events = [];
  for await (const event of runner()) events.push(event);
  return events;
}

test('fatal：身份拒绝产生唯一 error 终态，无失败 tool-result、无第二轮、无 done', async () => {
  const boom = Object.assign(new Error('当前宿主未提供文档所需的稳定身份，本次文件操作未执行；已有文件未删除。'), { code: 'ARTIFACT_STABLE_ID_REQUIRED', abortToolLoop: true });
  const events = await collect(() => runToolLoop({
    models: fakeModels([{ tool: { name: 'create_document', arguments: {} } }, { text: '不该被调用的第二轮' }]),
    input: { requestId: 'r', messages: [{ role: 'user', content: '生成文档' }] },
    tools: [{ name: 'create_document' }],
    executeTool: async () => { throw boom; },
  }));
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.equal(events[events.length - 1].type, 'error');
  assert.equal(events.find(e => e.type === 'error').code, 'ARTIFACT_STABLE_ID_REQUIRED');
  assert.equal(events.filter(e => e.type === 'tool-result').length, 0, 'fatal 不发失败 tool-result');
  assert.equal(events.filter(e => e.type === 'done').length, 0, 'fatal 不发 done');
});

test('对照：普通工具失败仍可恢复（失败 tool-result + 第二轮 + done）', async () => {
  const events = await collect(() => runToolLoop({
    models: fakeModels([{ tool: { name: 'create_document', arguments: {} } }, { text: '换种方式重试' }]),
    input: { requestId: 'r', messages: [{ role: 'user', content: '生成文档' }] },
    tools: [{ name: 'create_document' }],
    executeTool: async () => { throw Object.assign(new Error('渲染失败'), { code: 'DOCUMENT_TOO_LARGE' }); },
  }));
  const failed = events.find(e => e.type === 'tool-result');
  assert.equal(failed.ok, false, '普通失败回灌失败 tool-result');
  assert.equal(events.filter(e => e.type === 'done').length, 1, '普通失败后有第二轮并正常收尾');
});

test('fatal 标记必须来自适配器异常；模型 arguments 里伪造的不生效', async () => {
  const events = await collect(() => runToolLoop({
    models: fakeModels([{ tool: { name: 'create_document', arguments: { abortToolLoop: true } } }, { text: '正文' }]),
    input: { requestId: 'r', messages: [{ role: 'user', content: '生成文档' }] },
    tools: [{ name: 'create_document' }],
    executeTool: async () => ({ artifactId: 'a'.repeat(32) }),
  }));
  assert.equal(events.filter(e => e.type === 'error').length, 0, '伪造标记不得触发终止');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
});
