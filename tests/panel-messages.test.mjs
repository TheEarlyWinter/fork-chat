import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodyHtml } from '../ui/assets/panel-messages.js';

// 公式渲染的三条底线：该渲染的渲染，不该渲染的别碰，渲染炸了别吞正文。

test('renderBodyHtml: inline math becomes katex markup', () => {
  const html = renderBodyHtml('玻璃化转变温度 $T_g$ 会上升');
  assert.match(html, /class="katex"/);
  assert.match(html, /玻璃化转变温度/);
  assert.ok(!html.includes('$T_g$'), '原样的 $T_g$ 标记不应残留');
});

test('renderBodyHtml: display math uses the display wrapper', () => {
  const html = renderBodyHtml('推导如下 $$a^2+b^2=c^2$$ 完毕');
  assert.match(html, /katex-display/, '块级公式要带 display 容器');
});

test('renderBodyHtml: prices are not mistaken for formulas', () => {
  const html = renderBodyHtml('价格 $100 和 $200 都没变');
  assert.equal(html, '价格 $100 和 $200 都没变');
});

test('renderBodyHtml: plain text is still escaped', () => {
  const html = renderBodyHtml('<script>alert(1)</script>');
  assert.equal(html, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('renderBodyHtml: broken formula falls back to the original text instead of dropping it', () => {
  // \frac 少了第二个参数，KaTeX 会报错；这时正文不能整段消失
  const html = renderBodyHtml('前文 $\\frac{1}{$ 后文');
  assert.match(html, /前文/);
  assert.match(html, /后文/);
});

test('renderBodyHtml: empty input stays empty', () => {
  assert.equal(renderBodyHtml(''), '');
  assert.equal(renderBodyHtml(null), '');
});
