import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/usr/bin/google-chrome';
const HTML_PATH = join(ROOT, 'ui/panel.html');
const CSS_PATH = join(ROOT, 'ui/assets/panel.css');

test('HTML contract: 必需 ID 存在且全局唯一，不存在旧 session-strip 包装，且无多余闭合标签', () => {
  const html = readFileSync(HTML_PATH, 'utf8');

  // 1. 必需 ID 列表（契约覆盖顶栏、发射台、控制岛、展示节点与弹窗）
  const REQUIRED_IDS = [
    'session-status',
    'btn-retry-save',
    'btn-save-copy',
    'btn-empty-new-session',
    'btn-import-doc',
    'btn-bridge-open',
    'btn-bridge-send',
    'btn-artifact-panel',
    'btn-auto-tidy',
    'btn-new-root',
    'global-doc-input',
    'badge-stats',
    'active-agent-display',
    'session-save-indicator',
    'canvas-launchpad',
    'canvas-loading-state',
    'session-empty-state',
    'btn-launchpad-new-root',
    'btn-launchpad-import-doc',
    'btn-launchpad-bridge',
    'btn-reset-view',
    'btn-zoom-out',
    'zoom-text',
    'btn-zoom-in',
    'btn-fullscreen',
    'btn-shortcuts',
    'shortcuts-dialog',
    'btn-shortcuts-close',
  ];

  const idRegex = /\bid=["']([^"']+)["']/g;
  const foundIds = [];
  let match;
  while ((match = idRegex.exec(html)) !== null) {
    foundIds.push(match[1]);
  }

  const counts = new Map();
  for (const id of foundIds) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  for (const id of REQUIRED_IDS) {
    assert.equal(counts.get(id), 1, `元素 ID "${id}" 必须在 HTML 中存在且唯一，当前出现次数: ${counts.get(id) || 0}`);
  }

  // 2. 校验旧的 session-strip 包装已被彻底移除，控件合入顶栏
  assert.equal(html.includes('class="session-strip"'), false, '旧 session-strip 包装容器必须已被删除');

  // 3. 校验 shortcuts-dialog 附近不存在多余的游离闭合 </div>
  const dialogSlice = html.match(/<\/dialog>\s*<\/div>/);
  assert.equal(Boolean(dialogSlice), false, 'dialog 闭合后不得有多余游离的 </div>');
});

test('HTML contract: session-status 与 active-agent-display 保持纯文本叶节点', () => {
  const html = readFileSync(HTML_PATH, 'utf8');

  // 提取 session-status 标签内容
  const statusMatch = html.match(/<[^>]+id=["']session-status["'][^>]*>([\s\S]*?)<\/[^>]+>/);
  assert.ok(statusMatch, '必须找到 session-status 标签');
  assert.equal(/<[^>]+>/.test(statusMatch[1]), false, 'session-status 必须是纯文本叶节点，不能包含子元素标签');

  // 提取 active-agent-display 标签内容
  const agentMatch = html.match(/<[^>]+id=["']active-agent-display["'][^>]*>([\s\S]*?)<\/[^>]+>/);
  assert.ok(agentMatch, '必须找到 active-agent-display 标签');
  assert.equal(/<[^>]+>/.test(agentMatch[1]), false, 'active-agent-display 必须是纯文本叶节点，不能包含子元素标签');
});

test('HTML contract: 顶栏结构化功能分组（资产协同组、整理组、独立主动作）与助手药丸', () => {
  const html = readFileSync(HTML_PATH, 'utf8');

  // 1. 资产与本体协同组：带明确可访问分组
  const assetGroupMatch = html.match(/<[^>]+role=["']group["'][^>]*aria-label=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]+>/);
  assert.ok(assetGroupMatch, '必须包含 role="group" 的功能分组容器');

  // 检查资料/本体协同组内的按钮归属
  assert.match(html, /<div[^>]*role=["']group["'][^>]*aria-label=["'][^"']*协同[^"']*["'][\s\S]*?id=["']btn-import-doc["']/, 'btn-import-doc 应归属于资产与协同组');
  assert.match(html, /<div[^>]*role=["']group["'][^>]*aria-label=["'][^"']*协同[^"']*["'][\s\S]*?id=["']btn-bridge-open["']/, 'btn-bridge-open 应归属于资产与协同组');
  assert.match(html, /<div[^>]*role=["']group["'][^>]*aria-label=["'][^"']*协同[^"']*["'][\s\S]*?id=["']btn-bridge-send["']/, 'btn-bridge-send 应归属于资产与协同组');
  assert.match(html, /<div[^>]*role=["']group["'][^>]*aria-label=["'][^"']*协同[^"']*["'][\s\S]*?id=["']btn-artifact-panel["']/, 'btn-artifact-panel 应归属于资产与协同组');

  // 2. 画布整理组
  assert.match(html, /<div[^>]*role=["']group["'][^>]*aria-label=["'][^"']*整理[^"']*["'][\s\S]*?id=["']btn-auto-tidy["']/, 'btn-auto-tidy 应归属于画布整理组');

  // 3. 独立主动作：btn-new-root 保持独立深色主按钮
  const primaryMatch = html.match(/<button[^>]+class=["'][^"']*btn-primary[^"']*["'][^>]*id=["']btn-new-root["']/)
    || html.match(/<button[^>]+id=["']btn-new-root["'][^>]*class=["'][^"']*btn-primary[^"']*["']/);
  assert.ok(primaryMatch, 'btn-new-root 必须作为独立 primary 主动作按钮呈现');

  // 4. 助手药丸结构化包装
  assert.match(html, /class=["'][^"']*agent-pill[^"']*["'][\s\S]*?id=["']active-agent-display["']/, 'active-agent-display 必须被结构化 agent-pill 药丸容器包裹');
});

test('HTML contract: 引导文案中性、帮助多选快捷键对齐实现 (Shift+点击)、Tab 提示清晰', () => {
  const html = readFileSync(HTML_PATH, 'utf8');

  // 1. 无活动会话中性引导文案
  assert.match(html, /请新建会话，或从侧边栏选择已有会话/, 'session-empty-state 必须使用中性指引文案');
  assert.equal(html.includes('所有会话已清空或尚未激活'), false, '不得使用“所有会话已清空或尚未激活”误导性表述');

  // 2. 快捷键帮助多选分支合并必须为 Shift + 点击卡片
  assert.match(html, /Shift[\s\S]*?点击卡片/, '多选分支合并快捷键必须与实现一致：Shift + 点击卡片');
  assert.equal(html.includes('Ctrl / Cmd') && html.includes('点击卡片'), false, '不得错误宣传 Ctrl/Cmd + 点击卡片');

  // 3. 发射台 Tab 提示注明需选中卡片
  assert.match(html, /Tab[\s\S]*?选中卡片/, '发射台 Tab 快捷键必须注明需选中卡片后衍生分支');
});

test('HTML & CSS contract: loading-state 支持 restore-error 语义展示与动画偏好', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  const css = readFileSync(CSS_PATH, 'utf8');

  // 1. HTML 中应包含 booting 与 error 两套语义 DOM
  assert.match(html, /class=["'][^"']*loading-state-booting[^"']*["']/, 'loading-state 必须包含 booting 阶段语义容器');
  assert.match(html, /class=["'][^"']*loading-state-error[^"']*["']/, 'loading-state 必须包含 restore-error 阶段语义容器');

  // 2. 保存指示灯初始状态应为 booting 而非 saved
  assert.match(html, /id=["']session-save-indicator["'][^>]*data-state=["']booting["']/, 'session-save-indicator 初始 data-state 必须是 booting');

  // 3. CSS 必须支持 restore-error 状态下隐藏/停止 spinner 并展示错误文案
  assert.match(css, /\[data-state=["']restore-error["']\][\s\S]*?\.loading-spinner[\s\S]*?display:\s*none|animation:\s*none/, 'restore-error 状态下 spinner 必须停止转动或隐藏');

  // 4. CSS 必须为 prefers-reduced-motion 提供无动画支持
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?animation:\s*none/, '必须为 prefers-reduced-motion 停用 spinner 持续旋转动画');
});

test('real Chrome: DOM 真实层级关系断言（viewport 内部但 surface 外部）', () => {
  const result = runChromeInspection({
    scenario: 'hierarchy-check',
    width: 1024,
    height: 768,
  });

  assert.equal(result.hierarchyFailures.length, 0, `DOM 真实层级不符合契约: ${JSON.stringify(result.hierarchyFailures)}`);
});

test('real Chrome geometry: 顶栏在 640/1024/1440 宽下自适应、主动作与恢复按钮真正可达 (elementFromPoint/focus)', () => {
  const WIDTHS = [640, 1024, 1440];
  const HEIGHT = 800;

  for (const width of WIDTHS) {
    // 场景 1: 正常紧凑态
    const normal = runChromeInspection({ width, height: HEIGHT, scenario: 'normal' });
    assert.equal(normal.hasHorizontalOverflow, false, `${width}px 正常紧凑态下不得产生横向溢出`);
    assert.ok(normal.primaryActionReachable, `${width}px 正常态下主动作必须 elementFromPoint 命中可达`);
    assert.ok(normal.primaryActionFocused, `${width}px 正常态下主动作必须可通过 focus() 聚焦`);
    assert.ok(normal.viewportRemainingHeight >= 200, `${width}px 视口必须获得稳健剩余高度 (>=200px)`);

    // 场景 2: 错误展开态（验证长错误状态允许换行展开、完整呈现且恢复按钮及主动作可达）
    const errorState = runChromeInspection({ width, height: HEIGHT, scenario: 'error-expanded' });
    assert.equal(errorState.hasHorizontalOverflow, false, `${width}px 错误展开态下不得产生横向溢出`);
    assert.ok(errorState.statusTextExpanded, `${width}px 错误文本必须完整展开（无截断省略）`);
    assert.ok(errorState.statusTextMatchesExact, `${width}px 错误文本必须与注入的长错误原文逐字一致`);
    assert.ok(errorState.statusTextLinesFullyVisible, `${width}px 错误文本各行必须完整可见、无任何祖先裁剪`);
    assert.ok(errorState.retryButtonReachable, `${width}px 重试按钮必须完整可见且可达`);
    assert.ok(errorState.retryButtonFocused, `${width}px 重试按钮必须可通过 focus() 聚焦`);
    assert.ok(errorState.saveCopyButtonReachable, `${width}px 保存副本按钮必须完整可见且可达`);
    assert.ok(errorState.saveCopyButtonFocused, `${width}px 保存副本按钮必须可通过 focus() 聚焦`);
    assert.ok(errorState.primaryActionReachable, `${width}px 错误展开时主动作依然必须完整可见且可达`);
    assert.ok(errorState.viewportRemainingHeight >= 150, `${width}px 错误展开时视口仍应获得合理剩余高度 (>=150px)`);

    // 场景 3: 超长文本态
    const longText = runChromeInspection({ width, height: HEIGHT, scenario: 'long-text' });
    assert.equal(longText.hasHorizontalOverflow, false, `${width}px 超长文本下不得产生横向溢出`);
    assert.ok(longText.primaryActionReachable, `${width}px 超长文本下主动作必须可见可达`);
  }
});

test('real Chrome: restore-error 态下停止 spinner 旋转且展示明确错误与重试指引', () => {
  const result = runChromeInspection({
    width: 1024,
    height: 768,
    scenario: 'restore-error-view',
  });

  assert.equal(result.hasHorizontalOverflow, false, 'restore-error 态无溢出');
  assert.ok(result.loadingStateVisible, 'canvas-loading-state 必须可见');
  assert.ok(result.restoreErrorTextVisible, '恢复失败语义文案必须可见');
  assert.ok(result.spinnerStoppedOrHidden, 'restore-error 态下 spinner 必须停止旋转或隐藏');
});

test('negative control: 负控用例证明可见性与可达性 helper 能够拦截部分出界、祖先裁切与角落覆盖', () => {
  const result = runChromeInspection({
    width: 1024,
    height: 768,
    scenario: 'negative-control',
  });

  // 正控：普通完全暴露按钮应可达
  assert.equal(result.negativeControl.positiveNormalReachable, true, '普通正常按钮必须判定为可达（正控）');

  // 负控前提也要验证：三种缺陷都不能靠“中心点已不可命中”蒙混过关。
  assert.equal(result.negativeControl.allNegativeCentersHit, true, '三个负控按钮的中心点必须仍可命中');

  // 负控 1：部分越过视口边缘（中心在视口内）
  assert.equal(result.negativeControl.overflowViewportReachable, false, '部分越过视口边缘的按钮必须判定为不可达');

  // 负控 2：被 overflow:hidden 祖先裁切（中心仍可命中）
  assert.equal(result.negativeControl.clippedByAncestorReachable, false, '被 overflow:hidden 祖先裁切边界的按钮必须判定为不可达');

  // 负控 3：中心可命中但角落被其他元素遮挡
  assert.equal(result.negativeControl.cornerOccludedReachable, false, '仅角落被遮挡的按钮必须判定为不可达');
});

test('real Chrome: 原生 shortcuts-dialog 快捷键速查在不同视口下均几何居中、四边留白、短视口可滚动且关闭按钮可达', () => {
  const VIEWPORTS = [
    { width: 1024, height: 768, label: '标准桌面 1024x768' },
    { width: 640, height: 800, label: '窄视口 640x800' },
    { width: 800, height: 420, label: '极矮视口 800x420' },
  ];

  for (const vp of VIEWPORTS) {
    const result = runChromeInspection({
      width: vp.width,
      height: vp.height,
      scenario: 'shortcuts-dialog-view',
    });

    assert.ok(result.dialogGeometry, `${vp.label} 下 shortcutsDialog 必须被成功检测`);
    assert.equal(result.dialogGeometry.isOpen, true, `${vp.label} 下弹窗必须为 open`);
    assert.equal(result.dialogGeometry.isCenteredHorizontally, true, `${vp.label} 下弹窗必须水平几何居中（容差 <= 1px）`);
    assert.equal(result.dialogGeometry.isCenteredVertically, true, `${vp.label} 下弹窗必须垂直几何居中（容差 <= 1px）`);
    assert.ok(result.dialogGeometry.hasMarginsAround, `${vp.label} 下弹窗四边必须留有边界余量`);
    assert.ok(result.dialogGeometry.closeButtonReachable, `${vp.label} 下关闭按钮必须完全可见且 elementFromPoint 命中可达`);
    if (vp.height <= 450) {
      assert.ok(result.dialogGeometry.isScrollableOrFits, `${vp.label} 矮视口下弹窗必须可垂直滚动或完整容纳`);
    }
  }
});

function runChromeInspection({ width = 1024, height = 768, scenario }) {
  const htmlContent = readFileSync(HTML_PATH, 'utf8');
  const cssContent = readFileSync(CSS_PATH, 'utf8');

  // 提取原始 body 内的所有 DOM（保留 canvas-app 以及紧随其后的原生 dialog）
  // 仅剥离 <script> 标签，绝不丢弃原生 <dialog>
  const bodyInnerMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const rawBodyInner = bodyInnerMatch ? bodyInnerMatch[1] : htmlContent;
  const cleanBody = rawBodyInner.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  const testPage = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${cssContent}
  </style>
</head>
<body>
  ${cleanBody}
  <script>
    window.__EVAL_SCENARIO__ = ${JSON.stringify(scenario)};
  </script>
</body>
</html>`;

  const tmpDir = mkdtempSync(join(tmpdir(), 'panel-shell-inspect-'));
  const testPagePath = join(tmpDir, 'page.html');
  void testPagePath;
  const runFilePath = join(tmpDir, 'run.html');

  const inspectorScript = `
    const scenario = window.__EVAL_SCENARIO__;
    const viewport = document.getElementById('viewport');
    const surface = document.getElementById('surface');
    const header = document.querySelector('.canvas-header');
    const btnNewRoot = document.getElementById('btn-new-root');
    const btnRetry = document.getElementById('btn-retry-save');
    const btnSaveCopy = document.getElementById('btn-save-copy');
    const statusEl = document.getElementById('session-status');
    const saveIndicator = document.getElementById('session-save-indicator');
    const agentEl = document.getElementById('active-agent-display');
    const loadingState = document.getElementById('canvas-loading-state');
    const launchpad = document.getElementById('canvas-launchpad');
    const emptyState = document.getElementById('session-empty-state');
    const dock = document.querySelector('.floating-dock');

    // 场景注入
    if (scenario === 'error-expanded') {
      if (statusEl) {
        statusEl.textContent = '保存失败：跨窗口并发写入发生冲突，请选择重试保存当前版本或将当前画布保存为副本。这是一段长错误信息用于验证错误文本能够正常展开，不被写死的固定宽度或者单行省略强行隐藏。';
      }
      if (saveIndicator) saveIndicator.setAttribute('data-state', 'error');
      const cluster = document.querySelector('.session-info-cluster');
      if (cluster) cluster.setAttribute('data-status-error', 'true');
      if (btnRetry) btnRetry.removeAttribute('hidden');
      if (btnSaveCopy) btnSaveCopy.removeAttribute('hidden');
    } else if (scenario === 'long-text') {
      if (agentEl) {
        agentEl.textContent = '当前助手: 超长助手模型名称-gpt-5.6-luna-high-effort-parallel-reasoning-agent-2026';
      }
    } else if (scenario === 'restore-error-view') {
      if (loadingState) {
        loadingState.removeAttribute('hidden');
        loadingState.setAttribute('data-state', 'restore-error');
      }
    } else if (scenario === 'shortcuts-dialog-view') {
      const dialog = document.getElementById('shortcuts-dialog');
      if (dialog && typeof dialog.showModal === 'function') {
        try {
          dialog.showModal();
        } catch {}
      }
    } else if (scenario === 'negative-control') {
      const container = document.createElement('div');
      container.id = 'neg-container';
      container.style.position = 'fixed';
      container.style.top = '0';
      container.style.left = '0';
      container.style.width = '100vw';
      container.style.height = '100vh';
      container.style.zIndex = '99999';
      container.style.pointerEvents = 'auto';

      // 1. 正控：普通完全暴露在视口中间的按钮
      const posBtn = document.createElement('button');
      posBtn.id = 'test-pos-btn';
      posBtn.textContent = '正控按钮';
      posBtn.style.position = 'absolute';
      posBtn.style.top = '200px';
      posBtn.style.left = '200px';
      posBtn.style.width = '100px';
      posBtn.style.height = '40px';
      container.appendChild(posBtn);

      // 2. 负控 1：部分越过视口右边缘（中心在视口内）
      // 宽度 100，left=docW-64：中心=docW-14 仍在视口内，right=docW+36 部分越界。
      const overflowBtn = document.createElement('button');
      overflowBtn.id = 'test-overflow-btn';
      overflowBtn.textContent = '出界按钮';
      overflowBtn.style.position = 'absolute';
      overflowBtn.style.top = '300px';
      overflowBtn.style.left = (document.documentElement.clientWidth - 64) + 'px';
      overflowBtn.style.width = '100px';
      overflowBtn.style.height = '40px';
      container.appendChild(overflowBtn);

      // 3. 负控 2：被 overflow:hidden 祖先裁切（中心仍可命中）
      const clipAncestor = document.createElement('div');
      clipAncestor.style.position = 'absolute';
      clipAncestor.style.top = '400px';
      clipAncestor.style.left = '200px';
      clipAncestor.style.width = '80px';
      clipAncestor.style.height = '60px';
      clipAncestor.style.overflow = 'hidden';

      const clippedBtn = document.createElement('button');
      clippedBtn.id = 'test-clipped-btn';
      clippedBtn.textContent = '被裁切按钮';
      clippedBtn.style.position = 'absolute';
      clippedBtn.style.top = '0px';
      clippedBtn.style.left = '0px';
      clippedBtn.style.width = '120px'; // 宽度 120 > 80，右半部分被裁掉，但中心在 60px，仍落在 0..80 内部！
      clippedBtn.style.height = '40px';
      clipAncestor.appendChild(clippedBtn);
      container.appendChild(clipAncestor);

      // 4. 负控 3：仅角落被覆盖，中心可命中
      const cornerBtn = document.createElement('button');
      cornerBtn.id = 'test-corner-btn';
      cornerBtn.textContent = '角落被盖按钮';
      cornerBtn.style.position = 'absolute';
      cornerBtn.style.top = '500px';
      cornerBtn.style.left = '200px';
      cornerBtn.style.width = '100px';
      cornerBtn.style.height = '40px';
      container.appendChild(cornerBtn);

      const occluder = document.createElement('div');
      occluder.style.position = 'absolute';
      occluder.style.top = '500px';
      occluder.style.left = '200px';
      occluder.style.width = '15px'; // 只盖住左上角 15x15
      occluder.style.height = '15px';
      occluder.style.backgroundColor = 'red';
      container.appendChild(occluder);

      document.body.appendChild(container);
    }

    // 1. 真实 DOM 层级断言（必须在 viewport 内部且不在 surface 内部）
    const hierarchyFailures = [];
    const checkElements = [
      { id: 'canvas-launchpad', el: launchpad },
      { id: 'session-empty-state', el: emptyState },
      { id: 'canvas-loading-state', el: loadingState },
      { id: 'floating-dock', el: dock },
    ];
    for (const item of checkElements) {
      if (!item.el) {
        hierarchyFailures.push({ id: item.id, error: '元素未找到' });
        continue;
      }
      const inViewport = viewport && viewport.contains(item.el);
      const inSurface = surface && surface.contains(item.el);
      const closestSurface = item.el.closest('#surface');
      if (!inViewport) hierarchyFailures.push({ id: item.id, error: '不在 viewport 内部' });
      if (inSurface || closestSurface) hierarchyFailures.push({ id: item.id, error: '意外处于 surface 内部' });
    }

    // 2. 几何与可达性辅助
    function isElementReachable(el) {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (el.disabled) return false;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;

      const docW = document.documentElement.clientWidth;
      const docH = document.documentElement.clientHeight;

      // 必须四边均完整落在视口内（允许 1px 舍入误差）
      if (rect.left < -1 || rect.top < -1 || rect.right > docW + 1 || rect.bottom > docH + 1) {
        return false;
      }

      // 沿祖先检查 overflow-x/y 为 hidden/clip/auto/scroll 时，矩形必须位于对应轴的裁剪框内
      let parent = el.parentElement;
      while (parent && parent !== document.documentElement) {
        const pStyle = window.getComputedStyle(parent);
        const overflowX = pStyle.overflowX;
        const overflowY = pStyle.overflowY;
        const pRect = parent.getBoundingClientRect();

        const clipsX = (overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto' || overflowX === 'scroll');
        const clipsY = (overflowY === 'hidden' || overflowY === 'clip' || overflowY === 'auto' || overflowY === 'scroll');

        if (clipsX) {
          if (rect.left < pRect.left - 1 || rect.right > pRect.right + 1) {
            return false;
          }
        }
        if (clipsY) {
          if (rect.top < pRect.top - 1 || rect.bottom > pRect.bottom + 1) {
            return false;
          }
        }
        parent = parent.parentElement;
      }

      // 中心 + 4 个内缩采样点（内缩 min(6px, 1/4 尺寸)）全部命中元素自身或其子元素
      const insetX = Math.min(6, rect.width / 4);
      const insetY = Math.min(6, rect.height / 4);
      const samplePoints = [
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        { x: rect.left + insetX, y: rect.top + insetY },
        { x: rect.right - insetX, y: rect.top + insetY },
        { x: rect.left + insetX, y: rect.bottom - insetY },
        { x: rect.right - insetX, y: rect.bottom - insetY },
      ];

      for (const pt of samplePoints) {
        const hit = document.elementFromPoint(pt.x, pt.y);
        const ok = hit === el || (el.contains && el.contains(hit));
        if (!ok) return false;
      }

      return true;
    }

    // 可聚焦验证
    let primaryActionFocused = false;
    if (btnNewRoot) {
      try {
        btnNewRoot.focus();
        primaryActionFocused = (document.activeElement === btnNewRoot);
      } catch {}
    }

    let retryButtonFocused = false;
    if (btnRetry) {
      try {
        btnRetry.focus();
        retryButtonFocused = (document.activeElement === btnRetry);
      } catch {}
    }

    let saveCopyButtonFocused = false;
    if (btnSaveCopy) {
      try {
        btnSaveCopy.focus();
        saveCopyButtonFocused = (document.activeElement === btnSaveCopy);
      } catch {}
    }

    const docWidth = document.documentElement.clientWidth;
    const bodyScrollWidth = document.body.scrollWidth;
    const headerScrollWidth = header ? header.scrollWidth : 0;
    const viewportRect = viewport ? viewport.getBoundingClientRect() : { height: 0 };

    // 错误展开判定与长错误全文可见性
    let statusTextExpanded = false;
    let statusTextMatchesExact = false;
    let statusTextLinesFullyVisible = false;

    if (statusEl && scenario === 'error-expanded') {
      const isMultiline = statusEl.clientHeight > 18;
      const noVerticalOverflow = statusEl.scrollHeight <= statusEl.clientHeight + 2;
      statusTextExpanded = isMultiline && noVerticalOverflow;

      // 1. 原文逐字严格匹配
      const expectedText = '保存失败：跨窗口并发写入发生冲突，请选择重试保存当前版本或将当前画布保存为副本。这是一段长错误信息用于验证错误文本能够正常展开，不被写死的固定宽度或者单行省略强行隐藏。';
      statusTextMatchesExact = (statusEl.textContent === expectedText);

      // 2. CSS 计算样式断言
      const sStyle = window.getComputedStyle(statusEl);
      const styleNoClipping = (sStyle.whiteSpace !== 'nowrap' && sStyle.textOverflow !== 'ellipsis')
        && (statusEl.scrollWidth <= statusEl.clientWidth + 2)
        && (statusEl.scrollHeight <= statusEl.clientHeight + 2);

      // 3. 用 DOM Range.selectNodeContents 得到各文字行矩形，验证每行在 status 自身边界、viewport 边界及裁剪祖先边界内
      let linesOk = styleNoClipping;
      try {
        const range = document.createRange();
        range.selectNodeContents(statusEl);
        const rects = Array.from(range.getClientRects());
        if (rects.length === 0) {
          linesOk = false;
        }
        const sRect = statusEl.getBoundingClientRect();
        const docW = document.documentElement.clientWidth;
        const docH = document.documentElement.clientHeight;

        for (const lineRect of rects) {
          if (lineRect.width <= 0 || lineRect.height <= 0) continue;
          // 在 status 边界内（允许 2px 舍入）
          if (lineRect.left < sRect.left - 2 || lineRect.right > sRect.right + 2) {
            linesOk = false;
            break;
          }
          if (lineRect.top < sRect.top - 2 || lineRect.bottom > sRect.bottom + 2) {
            linesOk = false;
            break;
          }
          // 在视口边界内
          if (lineRect.left < -1 || lineRect.top < -1 || lineRect.right > docW + 1 || lineRect.bottom > docH + 1) {
            linesOk = false;
            break;
          }
          // 文字行也必须位于所有会裁剪内容的祖先内，不能只检查 status 自身。
          let ancestor = statusEl.parentElement;
          while (ancestor && ancestor !== document.documentElement) {
            const aStyle = window.getComputedStyle(ancestor);
            const aRect = ancestor.getBoundingClientRect();
            const clipsX = /^(hidden|clip|auto|scroll)$/.test(aStyle.overflowX);
            const clipsY = /^(hidden|clip|auto|scroll)$/.test(aStyle.overflowY);
            if ((clipsX && (lineRect.left < aRect.left - 1 || lineRect.right > aRect.right + 1))
              || (clipsY && (lineRect.top < aRect.top - 1 || lineRect.bottom > aRect.bottom + 1))) {
              linesOk = false;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (!linesOk) break;
        }
      } catch {
        linesOk = false;
      }
      statusTextLinesFullyVisible = linesOk;
    }

    // restore-error 判定
    let restoreErrorTextVisible = false;
    let spinnerStoppedOrHidden = false;
    if (scenario === 'restore-error-view' && loadingState) {
      const errBox = loadingState.querySelector('.loading-state-error');
      if (errBox) {
        const style = window.getComputedStyle(errBox);
        restoreErrorTextVisible = style.display !== 'none' && style.visibility !== 'hidden' && errBox.textContent.includes('失败');
      }
      const spinner = loadingState.querySelector('.loading-spinner');
      if (spinner) {
        const spStyle = window.getComputedStyle(spinner);
        spinnerStoppedOrHidden = (spStyle.display === 'none' || spStyle.animationName === 'none');
      } else {
        spinnerStoppedOrHidden = true;
      }
    }

    let negativeControl = null;
    if (scenario === 'negative-control') {
      const posBtn = document.getElementById('test-pos-btn');
      const overflowBtn = document.getElementById('test-overflow-btn');
      const clippedBtn = document.getElementById('test-clipped-btn');
      const cornerBtn = document.getElementById('test-corner-btn');

      negativeControl = {
        allNegativeCentersHit: [overflowBtn, clippedBtn, cornerBtn].every((el) => {
          const rect = el.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit === el || el.contains(hit);
        }),
        positiveNormalReachable: isElementReachable(posBtn),
        overflowViewportReachable: isElementReachable(overflowBtn),
        clippedByAncestorReachable: isElementReachable(clippedBtn),
        cornerOccludedReachable: isElementReachable(cornerBtn),
      };
    }

    let dialogGeometry = null;
    if (scenario === 'shortcuts-dialog-view') {
      const dialog = document.getElementById('shortcuts-dialog');
      const closeBtn = document.getElementById('btn-shortcuts-close');
      if (dialog) {
        const dRect = dialog.getBoundingClientRect();
        const docW = document.documentElement.clientWidth;
        const docH = document.documentElement.clientHeight;

        const centerX = dRect.left + dRect.width / 2;
        const centerY = dRect.top + dRect.height / 2;
        const expectedCenterX = docW / 2;
        const expectedCenterY = docH / 2;

        const isCenteredHorizontally = Math.abs(centerX - expectedCenterX) <= 1.01;
        const isCenteredVertically = Math.abs(centerY - expectedCenterY) <= 1.01;

        // 四边余量
        const hasMarginsAround = (dRect.left >= 8) && (dRect.top >= 8) && (dRect.right <= docW - 8) && (dRect.bottom <= docH - 8);

        // 矮视口下可垂直滚动或完整容纳
        const dStyle = window.getComputedStyle(dialog);
        const hasScrollOverflow = (dStyle.overflowY === 'auto' || dStyle.overflowY === 'scroll');
        const fitsInViewport = dRect.height <= docH;
        const isScrollableOrFits = fitsInViewport && (dialog.scrollHeight <= dialog.clientHeight + 2 || hasScrollOverflow);

        dialogGeometry = {
          isOpen: Boolean(dialog.open),
          rect: { left: dRect.left, top: dRect.top, width: dRect.width, height: dRect.height },
          isCenteredHorizontally,
          isCenteredVertically,
          hasMarginsAround,
          closeButtonReachable: isElementReachable(closeBtn),
          isScrollableOrFits,
        };
      }
    }

    const result = {
      hierarchyFailures,
      hasHorizontalOverflow: (bodyScrollWidth > docWidth + 1) || (headerScrollWidth > docWidth + 1),
      primaryActionReachable: isElementReachable(btnNewRoot),
      primaryActionFocused,
      retryButtonReachable: isElementReachable(btnRetry),
      retryButtonFocused,
      saveCopyButtonReachable: isElementReachable(btnSaveCopy),
      saveCopyButtonFocused,
      viewportRemainingHeight: viewportRect.height,
      statusTextExpanded,
      statusTextMatchesExact,
      statusTextLinesFullyVisible,
      loadingStateVisible: loadingState ? window.getComputedStyle(loadingState).display !== 'none' : false,
      restoreErrorTextVisible,
      spinnerStoppedOrHidden,
      negativeControl,
      dialogGeometry,
    };

    document.body.setAttribute('data-inspect-result', JSON.stringify(result));
  `;

  const pageWithScript = testPage.replace('</body>', `<script>${inspectorScript}</script></body>`);
  writeFileSync(runFilePath, pageWithScript, 'utf8');

  const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-profile-'));

  try {
    const dumpedHtml = execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-background-networking',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--dump-dom',
      runFilePath,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 });

    const resultMatch = dumpedHtml.match(/data-inspect-result=["']([^"']+)["']/);
    if (!resultMatch) {
      throw new Error(`Chrome 未能返回评估结果: ${dumpedHtml.slice(0, 300)}`);
    }
    const unescaped = resultMatch[1].replace(/&quot;/g, '"');
    return JSON.parse(unescaped);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
