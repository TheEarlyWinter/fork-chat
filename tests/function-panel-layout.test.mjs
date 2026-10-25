import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../ui/function-panel.html', import.meta.url), 'utf8');

test('function panel contains exactly three first-level collapsible groups (agent, session, parser)', () => {
  const groups = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  assert.equal(groups.length, 3, 'Expected exactly 3 first-level groups');

  // 第 1 组：助手列表
  const [, agentAttrs, agentContent] = groups[0];
  assert.match(agentAttrs, /id="agent-group"/);
  assert.doesNotMatch(agentAttrs, /\bopen\b/, '助手列表默认收起，不再每次开侧边栏都死展开');
  const agentSummary = agentContent.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  assert.ok(agentSummary);
  assert.match(agentSummary, /助手列表/);
  assert.match(agentSummary, /id="agent-count"/);
  assert.match(agentContent, /class="agent-group-content"/);
  assert.match(agentContent, /id="agent-list"/);
  assert.match(agentContent, /id="search-input"/);
  assert.match(agentContent, /id="btn-refresh"/);

  // 第 2 组：会话列表（与助手分组并列，放下方）
  const [, sessionAttrs, sessionContent] = groups[1];
  assert.match(sessionAttrs, /id="session-group"/);
  assert.match(sessionAttrs, /\bopen\b/);
  const sessionSummary = sessionContent.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  assert.ok(sessionSummary);
  assert.match(sessionSummary, /会话列表/);
  assert.match(sessionSummary, /id="session-count"/);
  assert.match(sessionContent, /class="session-group-content"/);
  assert.match(sessionContent, /id="btn-new-session"/);
  assert.match(sessionContent, /id="btn-refresh-sessions"/);
  assert.match(sessionContent, /id="session-status"/);
  assert.match(sessionContent, /id="session-list"/);

  // 第 3 组：云端解析设置（App 自管，默认收起）
  const [, parserAttrs, parserContent] = groups[2];
  assert.match(parserAttrs, /id="parser-group"/);
  assert.doesNotMatch(parserAttrs, /\bopen\b/, '解析设置默认收起，避免每次开侧边栏都发请求');
  const parserSummary = parserContent.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  assert.ok(parserSummary);
  assert.match(parserSummary, /解析设置/);
  assert.match(parserSummary, /id="parser-state"/);
  assert.match(parserContent, /id="parser-enabled"/);
  assert.match(parserContent, /id="parser-token"/);
  assert.match(parserContent, /id="btn-parser-save"/);
});

test('all groups keep buttons and inputs inside content and outside summary toggle', () => {
  const groups = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  assert.equal(groups.length, 3);

  for (const [, , content] of groups) {
    const summary = content.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    assert.ok(summary);
    // 确保可折叠 summary 内不放置可聚焦 button 或 input（保持原生无障碍折叠行为）
    assert.doesNotMatch(summary, /<(button|input)\b/);
  }
});

test('group contents are strictly isolated without cross-leaking', () => {
  const groups = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  const [, , agentContent] = groups[0];
  const [, , sessionContent] = groups[1];

  // 助手分组内绝不泄露会话控件
  assert.doesNotMatch(agentContent, /id="btn-new-session"/);
  assert.doesNotMatch(agentContent, /id="btn-refresh-sessions"/);
  assert.doesNotMatch(agentContent, /id="session-status"/);
  assert.doesNotMatch(agentContent, /id="session-list"/);

  // 会话分组内绝不泄露助手控件
  assert.doesNotMatch(sessionContent, /id="search-input"/);
  assert.doesNotMatch(sessionContent, /id="agent-list"/);
});
