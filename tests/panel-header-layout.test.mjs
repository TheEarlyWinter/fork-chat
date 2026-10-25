import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCardHtml } from '../ui/assets/panel-cards.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/usr/bin/google-chrome';
const WIDTHS = [220, 280, 340, 640];
const SCALES = [1, 0.72];
const RESULT_MARKER = '__PANEL_HEADER_LAYOUT_RESULT__';

const LONG_ZH = '这是一条用于验证资料卡标题省略与徽标布局的超长中文文件名句子';
const LONG_EN = 'thisisaverylongbranchfilenamewithoutsanyspacesandmuststayinsideitscard';
const SHORT = '短标题';

const VARIANTS = [
  { id: 'plain-zh', title: LONG_ZH },
  { id: 'plain-en', title: LONG_EN },
  { id: 'plain-short', title: SHORT },
  { id: 'doc-zh', title: LONG_ZH, isDoc: true },
  { id: 'branch-en', title: LONG_EN, parentId: 'parent-1' },
  { id: 'battle-zh', title: `对比 # ${LONG_ZH}`, isBattle: true },
  { id: 'merge-en', title: `合并总结 ${LONG_EN}`, isMerge: true },
  { id: 'stamp-starred', title: LONG_ZH, statusStamp: 'starred' },
  { id: 'stamp-accepted', title: LONG_EN, statusStamp: 'accepted' },
  { id: 'stamp-rejected', title: LONG_ZH, statusStamp: 'rejected' },
  { id: 'collapsed', title: LONG_EN, isCollapsed: true, childCount: 7 },
  {
    id: 'collapsed-stamped-doc',
    title: LONG_ZH,
    isDoc: true,
    statusStamp: 'accepted',
    isCollapsed: true,
    childCount: 12,
  },
];

function cssForTest() {
  if (process.env.FORK_CHAT_HEADER_BASELINE === '1') {
    return execFileSync('git', ['show', 'HEAD:ui/assets/panel.css'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  }
  return readFileSync(join(ROOT, 'ui/assets/panel.css'), 'utf8');
}

function escapeScriptText(value) {
  return value.replace(/<\//g, '<\\/');
}

function buildMatrix() {
  const matrix = [];
  for (const width of WIDTHS) {
    for (const scale of SCALES) {
      for (const variant of VARIANTS) {
        const id = `${width}-${String(scale).replace('.', '_')}-${variant.id}`;
        const card = {
          id,
          title: variant.title,
          parentId: variant.parentId || null,
          isDoc: Boolean(variant.isDoc),
          isBattle: Boolean(variant.isBattle),
          isMerge: Boolean(variant.isMerge),
          statusStamp: variant.statusStamp || null,
          isCollapsed: Boolean(variant.isCollapsed),
          messages: [],
        };
        matrix.push({
          id,
          width,
          scale,
          variant: variant.id,
          sourceTitle: variant.title,
          childCount: variant.childCount || 0,
          html: buildCardHtml({ card, childCount: variant.childCount || 0 }),
        });
      }
    }
  }
  return matrix;
}

function pageFor(css, matrix) {
  const cards = matrix.map(item => `
    <section class="matrix-case" data-case-id="${item.id}" data-width="${item.width}" data-scale="${item.scale}">
      <div class="canvas-surface" style="transform: scale(${item.scale});">
        <div class="chat-card has-custom-height" data-case-id="${item.id}" style="left: 16px; top: 16px; width: ${item.width}px; height: 240px;">
          ${item.html}
        </div>
      </div>
    </section>
  `).join('\n');

  const matrixJson = escapeScriptText(JSON.stringify(matrix.map(({ id, width, scale, variant, sourceTitle }) => ({
    id, width, scale, variant, sourceTitle,
  }))));

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${css}</style>
<style>
  /* Harness only: preserve the production canvas transform and give every card a real layout box. */
  html, body { margin: 0; padding: 0; background: #fff; overflow: visible; }
  body { width: 900px; min-height: 20000px; }
  .matrix-case { position: relative; width: 860px; height: 250px; overflow: visible; }
  .matrix-case .canvas-surface { position: absolute; inset: 0 auto auto 0; width: 860px; height: 240px; transform-origin: 0 0; }
</style>
</head>
<body>
${cards}
<pre id="${RESULT_MARKER}"></pre>
<script>
(() => {
  const cases = ${matrixJson};
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return {
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    };
  };
  const style = (element) => {
    const value = getComputedStyle(element);
    return {
      minWidth: value.minWidth,
      gap: value.gap,
      flexGrow: value.flexGrow,
      flexShrink: value.flexShrink,
      flexWrap: value.flexWrap,
      flexBasis: value.flexBasis,
      alignSelf: value.alignSelf,
      whiteSpace: value.whiteSpace,
      overflow: value.overflow,
      textOverflow: value.textOverflow,
      lineHeight: value.lineHeight,
    };
  };
  const byId = new Map(cases.map(value => [value.id, value]));
  const results = [...document.querySelectorAll('.matrix-case')].map((caseBox) => {
    const id = caseBox.dataset.caseId;
    const card = caseBox.querySelector('.chat-card');
    const header = card.querySelector('.card-header');
    const titleBox = card.querySelector('.card-title-box');
    const title = card.querySelector('.card-title');
    const dot = card.querySelector('.card-dot');
    const actions = card.querySelector('.card-header-actions');
    const badges = [...card.querySelectorAll('.card-origin-tag, .card-stamp-badge')];
    const buttons = [...header.querySelectorAll('button')];
    return {
      ...byId.get(id),
      card: rect(card),
      header: rect(header),
      titleBox: rect(titleBox),
      title: {
        ...rect(title),
        text: title.textContent,
        titleAttr: title.getAttribute('title'),
        offsetHeight: title.offsetHeight,
        clientHeight: title.clientHeight,
        scrollWidth: title.scrollWidth,
        style: style(title),
      },
      dot: { ...rect(dot), style: style(dot) },
      actions: { ...rect(actions), style: style(actions) },
      titleBoxStyle: style(titleBox),
      headerStyle: style(header),
      badges: badges.map(element => ({
        className: element.className,
        text: element.textContent,
        rect: rect(element),
        style: style(element),
      })),
      buttons: buttons.map(element => ({
        className: element.className,
        rect: rect(element),
      })),
    };
  });
  document.getElementById('${RESULT_MARKER}').textContent = '${RESULT_MARKER}' + JSON.stringify({
    matrixCases: results.length,
    results,
  });
})();
</script>
</body>
</html>`;
}

function renderWithChrome(matrix) {
  const profile = mkdtempSync(join(tmpdir(), 'fork-chat-panel-header-profile-'));
  const htmlPath = join(profile, 'panel-header-layout.html');
  writeFileSync(htmlPath, pageFor(cssForTest(), matrix), 'utf8');

  try {
    const result = spawnSync(CHROME, [
      '--headless=new',
      '--dump-dom',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--no-default-browser-check',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
      `--user-data-dir=${profile}`,
      `file://${htmlPath}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    });

    assert.equal(
      result.error,
      undefined,
      `Chrome invocation failed: ${result.error?.message || 'unknown error'}`,
    );
    assert.equal(result.status, 0, `Chrome exited ${result.status}: ${result.stderr}`);

    const resultElement = `<pre id="${RESULT_MARKER}">${RESULT_MARKER}`;
    const start = result.stdout.lastIndexOf(resultElement);
    assert.notEqual(start, -1, `Chrome dump-dom did not include the layout result marker; stderr: ${result.stderr}; tail: ${result.stdout.slice(-2000)}`);
    const jsonStart = start + resultElement.length;
    const end = result.stdout.indexOf('</pre>', jsonStart);
    assert.notEqual(end, -1, `Chrome dump-dom result was not closed; tail: ${result.stdout.slice(-2000)}`);
    return JSON.parse(result.stdout.slice(jsonStart, end));
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

function number(value) {
  return Number.parseFloat(value);
}

function inside(inner, outer, epsilon = 1.25) {
  return inner.left >= outer.left - epsilon
    && inner.top >= outer.top - epsilon
    && inner.right <= outer.right + epsilon
    && inner.bottom <= outer.bottom + epsilon;
}

function validateLayout(payload) {
  const failures = [];
  let wrappedBadgeCount = 0;
  const fail = (item, message) => failures.push(`${item.id}: ${message}`);

  for (const item of payload.results) {
    const scale = item.scale;
    const lineHeight = number(item.title.style.lineHeight);
    const titleLineHeight = Number.isFinite(lineHeight) ? lineHeight * scale : Infinity;
    const narrow = item.width <= 280;

    if (item.title.titleAttr !== item.sourceTitle) fail(item, `title attr lost full name: ${JSON.stringify(item.title.titleAttr)}`);
    if (item.title.text !== item.sourceTitle) fail(item, 'DOM title text differs from source title');
    if (!inside(item.header, item.card)) fail(item, 'header escapes card bounds');
    if (!inside(item.titleBox, item.header)) fail(item, 'title-box escapes header bounds');
    if (!inside(item.actions, item.header) || !inside(item.actions, item.card)) fail(item, 'header actions escape header/card bounds');
    if (item.titleBox.right > item.actions.left + 1.25) fail(item, 'title-box overlaps header actions');
    if (!inside(item.title, item.header) || !inside(item.title, item.card)) fail(item, 'title escapes header/card bounds');
    if (item.title.width <= 0 || item.title.height <= 0) fail(item, 'title has no visible geometry');
    if (item.title.offsetHeight > lineHeight + 1.25) fail(item, `title wraps to multiple unscaled lines: ${item.title.offsetHeight}px`);
    if (item.header.height < item.title.height - 1.25) fail(item, 'fixed-height card vertically compresses the header around the title');
    if (item.title.height > titleLineHeight + 1.5) fail(item, `title wraps after scale: ${item.title.height}px > ${titleLineHeight}px`);
    if (item.title.style.whiteSpace !== 'nowrap') fail(item, `title white-space is ${item.title.style.whiteSpace}`);
    if (item.title.style.overflow !== 'hidden') fail(item, `title overflow is ${item.title.style.overflow}`);
    if (item.title.style.textOverflow !== 'ellipsis') fail(item, `title text-overflow is ${item.title.style.textOverflow}`);

    // Assert visible behavior rather than prescribing flex-basis or a particular layout algorithm.
    if (item.dot.width < 5 * scale || item.dot.height < 5 * scale) fail(item, 'dot was visibly shrunk');
    if (!inside(item.dot, item.titleBox)) fail(item, 'dot escapes title-box');

    for (const badge of item.badges) {
      if (badge.style.whiteSpace !== 'nowrap') fail(item, `${badge.className} white-space is ${badge.style.whiteSpace}`);
      if (badge.rect.width <= 0 || badge.rect.height <= 0) fail(item, `${badge.className} has no visible geometry`);
      if (!inside(badge.rect, item.header) || !inside(badge.rect, item.card)) {
        fail(item, `${badge.className} is clipped/outside card bounds`);
      }
      if (!inside(badge.rect, item.titleBox)) fail(item, `${badge.className} escapes title-box`);
      if (badge.rect.top > item.title.top + 1.25) wrappedBadgeCount += 1;
    }

    for (const button of item.buttons) {
      if (!inside(button.rect, item.header) || !inside(button.rect, item.card)) {
        fail(item, `${button.className} escapes header/card bounds`);
      }
    }

    if (narrow && item.badges.length >= 2 && !item.badges.some(badge => badge.rect.top > item.title.top + 1.25)) {
      fail(item, 'narrow card did not wrap any badge while keeping title one line');
    }
  }

  return { failures, wrappedBadgeCount };
}

test('panel header layout: real Chrome geometry matrix keeps long titles and controls inside cards', () => {
  const matrix = buildMatrix();
  const payload = renderWithChrome(matrix);
  assert.equal(payload.matrixCases, matrix.length, 'Chrome must measure every generated matrix case');

  const { failures, wrappedBadgeCount } = validateLayout(payload);
  const mode = process.env.FORK_CHAT_HEADER_BASELINE === '1' ? 'HEAD baseline' : 'production';
  const geometry = WIDTHS.flatMap(width => SCALES.map(scale => {
    const group = payload.results.filter(item => item.width === width && item.scale === scale);
    const roundedRange = getter => {
      const range = group.map(getter);
      return [Number(Math.min(...range).toFixed(2)), Number(Math.max(...range).toFixed(2))];
    };
    return {
      width,
      scale,
      cases: group.length,
      cardWidth: roundedRange(item => item.card.width),
      headerWidth: roundedRange(item => item.header.width),
      titleWidth: roundedRange(item => item.title.width),
      titleBoxHeight: roundedRange(item => item.titleBox.height),
      headerHeight: roundedRange(item => item.header.height),
      fixedCardHeight: 240,
    };
  }));
  const summary = {
    mode,
    matrixCases: matrix.length,
    widths: WIDTHS,
    scales: SCALES,
    variants: VARIANTS.length,
    wrappedBadgeCount,
    geometryFailures: failures.length,
    geometry,
  };
  console.log(`PANEL_HEADER_LAYOUT_SUMMARY ${JSON.stringify(summary)}`);
  assert.deepEqual(failures, [], `layout violations (${failures.length}):\n${failures.join('\n')}`);
});
