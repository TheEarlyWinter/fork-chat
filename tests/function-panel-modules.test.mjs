import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeThinkingLevel,
  matchAgentModel,
  filterAgents,
  createAgentListController,
} from '../ui/assets/function-agents.js';
import {
  validateSessionTitle,
  computeMenuPosition,
  createSessionListController,
} from '../ui/assets/function-sessions.js';

test('function-agents: normalizeThinkingLevel maps aliases and trims whitespace correctly', () => {
  assert.equal(normalizeThinkingLevel('default'), 'default');
  assert.equal(normalizeThinkingLevel('none'), 'off');
  assert.equal(normalizeThinkingLevel('off'), 'off');
  assert.equal(normalizeThinkingLevel('minimal'), 'minimal');
  assert.equal(normalizeThinkingLevel('low'), 'low');
  assert.equal(normalizeThinkingLevel('medium'), 'medium');
  assert.equal(normalizeThinkingLevel('high'), 'high');
  assert.equal(normalizeThinkingLevel('xhigh'), 'xhigh');
  assert.equal(normalizeThinkingLevel('max'), 'max');
  assert.equal(normalizeThinkingLevel(' HIGH '), 'high');
  assert.equal(normalizeThinkingLevel('unknown'), '');
  assert.equal(normalizeThinkingLevel(null), '');
});

test('function-agents: matchAgentModel prioritizes provider+model exact match then fallback to ref or single id', () => {
  const models = [
    { provider: 'openai', model: 'gpt-4o', id: 'gpt-4o', ref: 'openai/gpt-4o', reasoning: true, thinkingLevels: ['low', 'high'] },
    { provider: 'azure', model: 'gpt-4o', id: 'azure-gpt-4o', ref: 'azure/gpt-4o', reasoning: false },
    { provider: 'anthropic', model: 'claude-3-7-sonnet', id: 'sonnet-37', ref: 'anthropic/claude-3-7-sonnet', reasoning: true },
  ];

  const exactAgent = { provider: 'openai', model: 'gpt-4o' };
  assert.equal(matchAgentModel(exactAgent, models)?.provider, 'openai');

  const refAgent = { provider: 'azure', model: 'gpt-4o' };
  assert.equal(matchAgentModel(refAgent, models)?.provider, 'azure');

  const idAgent = { model: 'sonnet-37' };
  assert.equal(matchAgentModel(idAgent, models)?.ref, 'anthropic/claude-3-7-sonnet');
});

test('function-agents: filterAgents filters by name, id, yuan, model, description case-insensitively', () => {
  const agents = [
    { id: 'cat', name: '猫娘 Hakimi', yuan: 'hanako', model: 'qwen-max', description: '专属工程猫娘' },
    { id: 'dog', name: '柴犬助手', yuan: 'butter', model: 'gpt-4o', description: '日常陪伴' },
  ];

  assert.equal(filterAgents(agents, '').length, 2);
  assert.equal(filterAgents(agents, 'hakimi')[0]?.id, 'cat');
  assert.equal(filterAgents(agents, 'QWEN')[0]?.id, 'cat');
  assert.equal(filterAgents(agents, 'butter')[0]?.id, 'dog');
  assert.equal(filterAgents(agents, '工程')[0]?.id, 'cat');
  assert.equal(filterAgents(agents, 'notfound').length, 0);
});

test('function-sessions: validateSessionTitle checks empty, length, control chars and normalizes whitespace', () => {
  assert.equal(validateSessionTitle(123).ok, false);
  assert.equal(validateSessionTitle('   ').ok, false);
  assert.equal(validateSessionTitle('a'.repeat(81)).ok, false);
  assert.equal(validateSessionTitle('title\u0000with null').ok, false);
  assert.equal(validateSessionTitle('title\u001Fcontrol').ok, false);

  const valid = validateSessionTitle('  hello   world  ');
  assert.equal(valid.ok, true);
  assert.equal(valid.title, 'hello world');
});

test('function-sessions: computeMenuPosition prevents overflow beyond viewport bounds', () => {
  const rect = { width: 100, height: 100 };
  const pos1 = computeMenuPosition(50, 50, rect, 800, 600);
  assert.equal(pos1.posX, 50);
  assert.equal(pos1.posY, 50);

  // X 溢出
  const pos2 = computeMenuPosition(750, 50, rect, 800, 600);
  assert.equal(pos2.posX, 800 - 100 - 4);

  // Y 溢出
  const pos3 = computeMenuPosition(50, 550, rect, 800, 600);
  assert.equal(pos3.posY, 600 - 100 - 4);

  // 负坐标或过小
  const pos4 = computeMenuPosition(-10, -20, rect, 800, 600);
  assert.equal(pos4.posX, 4);
  assert.equal(pos4.posY, 4);
});
