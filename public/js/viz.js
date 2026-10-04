// Renders a question's options as animated probability bars.
// build() draws the 0% preview for the current options; play() animates a result in.

import { describeConfidence, describeNoul } from './core.js';

const GROW_MS = 1500;
const SHRINK_MS = 380;

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Slow start and finish so the numbers visibly count up from 0.
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInCubic = (t) => t * t * t;

function tween(ms, ease, frame) {
  let cancelled = false;
  const promise = new Promise((resolve) => {
    if (ms <= 0 || reduceMotion()) {
      frame(1);
      resolve(true);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      if (cancelled) return resolve(false);
      const t = Math.min(1, (now - t0) / ms);
      frame(ease(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
  return { promise, cancel: () => (cancelled = true) };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const pctText = (n) => `${n}%`;

// Identifies a set of options, to tell whether the bars on screen need rebuilding.
export const signatureOf = (type, items) =>
  JSON.stringify([type, items.map((it) => [it.key, it.label, it.desc, it.slot])]);

export function createViz(root, tooltip) {
  let type = null;
  let items = [];
  let result = null; // the result currently on screen (null = 0% preview)
  let level = 0; // 0..1, how far the current result has grown in
  let anim = null;
  let refs = {};

  // ---- tooltip ------------------------------------------------------------
  // Pointer tooltips sit above the pointer. Keyboard-focus tooltips sit below the
  // mark (so they do not cover the big percentages above the bar), or above it
  // when there is no room below.
  let tipTarget = null;
  let tipFocus = false;

  function placeTip(left, top) {
    const { width, height } = tooltip.getBoundingClientRect();
    const x = Math.max(8, Math.min(window.innerWidth - width - 8, left - width / 2));
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(top(height))}px)`;
  }
  function fillTip(target) {
    const value = target.dataset.tipValue;
    if (!value) return false;
    tooltip.replaceChildren(el('strong', null, value), el('span', null, target.dataset.tipLabel));
    tooltip.hidden = false;
    tipTarget = target;
    return true;
  }
  function showPointerTip(target, x, y) {
    tipFocus = false;
    if (!fillTip(target)) return;
    const pad = 12;
    placeTip(x, (h) => (y - h - pad < 8 ? y + pad + 8 : y - h - pad));
  }
  function showFocusTip(target) {
    tipFocus = true;
    if (!fillTip(target)) return;
    const pad = 10;
    const r = target.getBoundingClientRect();
    placeTip(r.left + r.width / 2, (h) => (r.bottom + pad + h > window.innerHeight - 8 ? r.top - h - pad : r.bottom + pad));
  }
  function hideTip() {
    tooltip.hidden = true;
    tipTarget = null;
  }
  function bindTip(node) {
    node.addEventListener('pointermove', (e) => showPointerTip(node, e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => showFocusTip(node));
    node.addEventListener('blur', hideTip);
  }
  // The tooltip is position: fixed. On scroll a pointer tooltip is dropped; a
  // keyboard one follows its mark (focusing a mark can itself scroll the page).
  function onViewportChange() {
    if (tooltip.hidden) return;
    if (tipFocus && tipTarget && document.activeElement === tipTarget) {
      const target = tipTarget;
      requestAnimationFrame(() => document.activeElement === target && showFocusTip(target));
    } else {
      hideTip();
    }
  }
  window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  });

  // ---- DOM ----------------------------------------------------------------
  function headline() {
    const box = el('div', 'headline');
    const main = el('p', 'headline-main', '还没有结果');
    const sub = el('p', 'headline-sub', '填好问题和选项，点「发起调用」后，概率会从 0 开始长出来。');
    box.append(main, sub);
    box.setAttribute('aria-live', 'polite');
    refs.headMain = main;
    refs.headSub = sub;
    return box;
  }

  function confidenceBlock() {
    const box = el('div', 'confidence');
    const top = el('div', 'confidence-top');
    const label = el('span', 'confidence-label', '置信度');
    const help = el('span', 'confidence-help', '概率越集中在一个答案上，置信度越高');
    const value = el('span', 'confidence-value', '—');
    top.append(label, help, value);
    const meter = el('div', 'meter');
    const fill = el('div', 'meter-fill');
    meter.append(fill);
    box.append(top, meter);
    refs.confValue = value;
    refs.confFill = fill;
    return box;
  }

  function rowsBlock(withSwatch) {
    const list = el('ul', 'rows');
    refs.rows = items.map((it, i) => {
      const row = el('li', 'row');
      row.dataset.key = it.key;
      if (withSwatch) {
        const sw = el('span', `swatch s${it.slot || 0}`);
        sw.setAttribute('aria-hidden', 'true');
        row.append(sw);
      } else {
        row.append(el('span', 'level-num', String(i + 1)));
      }
      const text = el('div', 'row-text');
      const labelLine = el('div', 'row-label-line');
      labelLine.append(el('span', 'row-label', it.label));
      const badge = el('span', 'row-badge');
      badge.hidden = true;
      labelLine.append(badge);
      text.append(labelLine);
      if (it.desc) text.append(el('span', 'row-desc', it.desc));
      const meter = el('div', 'row-meter');
      const fill = el('div', `row-fill s${withSwatch ? it.slot || 0 : 1}`);
      meter.append(fill);
      const value = el('span', 'row-value', '0%');
      row.append(text, meter, value);
      list.append(row);
      return { row, fill, value, badge };
    });
    return list;
  }

  function buildSplit(frag) {
    if (items.length === 2) {
      const duel = el('div', 'duel');
      refs.duel = items.map((it, i) => {
        const side = el('div', `duel-side ${i === 0 ? 'duel-left' : 'duel-right'}`);
        const head = el('div', 'duel-head');
        const sw = el('span', `swatch s${it.slot}`);
        sw.setAttribute('aria-hidden', 'true');
        head.append(sw, el('span', 'duel-label', it.label));
        const value = el('span', 'duel-value', '0%');
        side.append(head, value);
        duel.append(side);
        return value;
      });
      frag.append(duel);
    } else {
      refs.duel = null;
    }

    const bar = el('div', `bar${items.length === 2 ? ' bar-duel' : ''}`);
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '概率分布');
    refs.bar = bar;
    refs.segs = items.map((it) => {
      const seg = el('div', `seg s${it.slot || 0}`);
      seg.tabIndex = -1;
      seg.setAttribute('role', 'img');
      seg.dataset.tipLabel = it.label;
      seg.hidden = true;
      bindTip(seg);
      bar.append(seg);
      return seg;
    });
    frag.append(bar);
    frag.append(rowsBlock(true));
  }

  function buildScore(frag) {
    const ruler = el('div', 'ruler');
    const track = el('div', 'ruler-track');
    const fill = el('div', 'ruler-fill');
    track.append(fill);
    const ticks = el('div', 'ruler-ticks');
    const n = items.length;
    items.forEach((it, i) => {
      const tick = el('span', 'tick', String(i + 1));
      tick.style.left = `${n > 1 ? (i / (n - 1)) * 100 : 0}%`;
      tick.dataset.tipLabel = it.label;
      tick.dataset.tipValue = `第 ${i + 1} 档`;
      bindTip(tick);
      ticks.append(tick);
    });
    const marker = el('div', 'ruler-marker');
    const bubble = el('span', 'marker-bubble', '—');
    const dot = el('span', 'marker-dot');
    marker.append(bubble, dot);
    marker.hidden = true;
    track.append(marker);
    const caption = el('p', 'ruler-caption', `等级：1 最低 → ${n} 最高`);
    ruler.append(track, ticks, caption);
    refs.rulerFill = fill;
    refs.marker = marker;
    refs.bubble = bubble;
    frag.append(ruler);
    frag.append(rowsBlock(false));
  }

  function build(nextType, nextItems) {
    anim?.cancel();
    hideTip();
    type = nextType;
    items = nextItems;
    result = null;
    level = 0;
    refs = {};
    const frag = document.createDocumentFragment();
    frag.append(headline());
    if (type === 'score') buildScore(frag);
    else buildSplit(frag);
    const conf = confidenceBlock();
    conf.hidden = type === 'noul';
    frag.append(conf);
    root.replaceChildren(frag);
    root.dataset.type = type;
    root.classList.remove('has-result');
    paint(0);
  }

  // ---- painting -----------------------------------------------------------
  // Draws the current result scaled by k (0 = empty bars, 1 = full result).
  function paint(k) {
    level = k;
    const res = result;
    if (type === 'score') paintScore(res, k);
    else paintSplit(res, k);

    const conf = res?.confidence;
    if (refs.confFill) {
      refs.confFill.style.width = `${conf == null ? 0 : conf * k * 100}%`;
      refs.confValue.textContent =
        conf == null || !res ? '—' : `${Math.round(conf * 100 * k)}%` + (k === 1 ? ` · ${describeConfidence(conf)}` : '');
    }
  }

  // Percentages are only shown when the API returned real probabilities.
  const valueText = (res, pct, k) => (res?.estimated ? '—' : pctText(Math.round(pct * k)));

  function paintSplit(res, k) {
    const its = res ? res.items : items.map((it) => ({ ...it, share: 0, pct: 0 }));
    // Duel: the two sides grow toward each other from opposite ends.
    if (refs.duel && its.length === 2) {
      const [a, b] = its;
      const gap = a.share > 0 && b.share > 0 ? 1 : 0;
      setSeg(refs.segs[0], a, { left: '0', width: `calc(${a.share * k * 100}% - ${gap}px)` });
      setSeg(refs.segs[1], b, { right: '0', width: `calc(${b.share * k * 100}% - ${gap}px)` });
      refs.duel[0].textContent = valueText(res, a.pct, k);
      refs.duel[1].textContent = valueText(res, b.pct, k);
    } else {
      // Stacked: the whole stack grows from the left, with a 2px surface gap between segments.
      const visible = its.map((it, i) => (it.share > 0 ? i : -1)).filter((i) => i >= 0);
      let cum = 0;
      its.forEach((it, i) => {
        const seg = refs.segs[i];
        if (!seg) return;
        const j = visible.indexOf(i);
        if (j < 0) {
          setSeg(seg, it, null);
          return;
        }
        const lb = j > 0 ? 1 : 0;
        const rb = j < visible.length - 1 ? 1 : 0;
        setSeg(seg, it, {
          left: `calc(${cum * k * 100}% + ${lb}px)`,
          width: `calc(${it.share * k * 100}% - ${lb + rb}px)`,
        });
        cum += it.share;
      });
    }
    paintRows(res, its, k);
  }

  function setSeg(seg, it, geo) {
    if (!geo || !(it.share > 0)) {
      seg.hidden = true;
      seg.tabIndex = -1;
      return;
    }
    const text = result?.estimated ? 'Jev 的选择' : pctText(it.pct);
    seg.hidden = false;
    seg.style.left = geo.left ?? 'auto';
    seg.style.right = geo.right ?? 'auto';
    seg.style.width = geo.width;
    seg.dataset.tipValue = text;
    seg.setAttribute('aria-label', `${it.label}：${text}`);
  }

  // Only segments wide enough to show a focus ring are tab stops, and only once the
  // result has fully grown in. Every value is also listed in the rows below.
  const MIN_FOCUS_WIDTH = 6;
  function updateSegFocus() {
    refs.segs?.forEach((seg) => {
      const wide = !seg.hidden && seg.getBoundingClientRect().width >= MIN_FOCUS_WIDTH;
      seg.tabIndex = result && level === 1 && wide ? 0 : -1;
    });
  }
  window.addEventListener('resize', () => updateSegFocus(), { passive: true });

  function paintRows(res, its, k) {
    its.forEach((it, i) => {
      const r = refs.rows?.[i];
      if (!r) return;
      r.fill.style.width = `${(it.share ?? 0) * k * 100}%`;
      r.value.textContent = valueText(res, it.pct ?? 0, k);
    });
  }

  function paintScore(res, k) {
    const its = res ? res.items : items.map((it) => ({ ...it, share: 0, pct: 0 }));
    paintRows(res, its, k);
    // At k = 0 (preview, or shrunk while a new call runs) there is no score to mark.
    if (!res || k === 0) {
      refs.marker.hidden = true;
      refs.rulerFill.style.width = '0%';
      return;
    }
    const frac = res.max > 0 ? res.score / res.max : 0;
    refs.marker.hidden = false;
    refs.marker.style.left = `${frac * k * 100}%`;
    refs.rulerFill.style.width = `${frac * k * 100}%`;
    refs.bubble.textContent = (1 + res.score * k).toFixed(2);
  }

  // ---- result text --------------------------------------------------------
  const IDLE_HEADLINE = ['还没有结果', '填好问题和选项，点「发起调用」后，概率会从 0 开始长出来。'];

  function setHeadline(res) {
    if (!res) {
      [refs.headMain.textContent, refs.headSub.textContent] = IDLE_HEADLINE;
      return;
    }
    const confText =
      res.confidence == null ? '' : `置信度 ${Math.round(res.confidence * 100)}%（${describeConfidence(res.confidence)}）`;
    if (res.type === 'noul') {
      const d = describeNoul(res.probability);
      refs.headMain.textContent = `Jev 判断：${d.text}`;
      refs.headSub.textContent = `“是”的概率为 ${res.items[0].pct}%`;
    } else if (res.type === 'choice') {
      const win = res.items.find((it) => it.key === res.winner);
      refs.headMain.textContent = `Jev 的选择：${win ? win.label : res.winner}`;
      const parts = res.estimated ? ['接口没有返回各选项的概率，条形图只标出 Jev 的选择'] : [`概率 ${win?.pct ?? 0}%`];
      if (confText) parts.push(confText);
      refs.headSub.textContent = parts.join(' · ');
    } else {
      const near = res.items[Math.round(res.score)];
      refs.headMain.textContent = `得分 ${(res.score + 1).toFixed(2)} / ${res.max + 1}`;
      const parts = [`最接近第 ${Math.round(res.score) + 1} 档：${near?.label ?? ''}`];
      if (res.estimated) parts.push('接口没有返回各档的概率');
      refs.headSub.textContent = parts.join(' · ');
    }
  }

  function setBadges(res) {
    refs.rows?.forEach((r, i) => {
      const it = res?.items[i];
      let text = '';
      if (it && res.type === 'choice' && it.key === res.winner) text = '✓ Jev 的选择';
      if (it && res.type === 'noul' && it.key === res.winner) text = '✓ 更可能';
      if (it && res.type === 'score' && it.key === res.peak) text = '最可能';
      r.badge.textContent = text;
      r.badge.hidden = !text;
      r.row.classList.toggle('is-winner', Boolean(text));
    });
  }

  // ---- public API ---------------------------------------------------------
  async function play(res) {
    anim?.cancel();
    result = res;
    // Results can mention options we did not send; rebuild rows so every value is listed.
    if (res.items.length !== items.length) {
      const keep = res;
      build(type, res.items.map(({ key, label, desc, slot }) => ({ key, label, desc, slot })));
      result = keep;
    }
    setBadges(null);
    setHeadline(res);
    root.classList.add('has-result');
    anim = tween(GROW_MS, easeInOutCubic, paint);
    const done = await anim.promise;
    if (done) {
      setBadges(res);
      updateSegFocus();
    }
  }

  // Shrinks whatever is on screen back to 0 while a new call is in flight.
  async function drain() {
    anim?.cancel();
    setBadges(null);
    refs.segs?.forEach((seg) => (seg.tabIndex = -1));
    refs.headMain.textContent = '正在等待 Jev 回答…';
    refs.headSub.textContent = '通常一秒内就会返回。';
    if (!result || level === 0) {
      root.classList.remove('has-result');
      return;
    }
    const from = level;
    anim = tween(SHRINK_MS, easeInCubic, (t) => paint(from * (1 - t)));
    await anim.promise;
    root.classList.remove('has-result');
  }

  const signature = () => signatureOf(type, items);

  // Back to the 0% preview. An optional [main, sub] headline replaces the idle
  // instructions, e.g. to point at an error shown below.
  function clear(message) {
    anim?.cancel();
    result = null;
    setBadges(null);
    setHeadline(null);
    if (message) [refs.headMain.textContent, refs.headSub.textContent] = message;
    root.classList.remove('has-result');
    paint(0);
  }

  return { build, play, drain, clear, signature, hasResult: () => result != null };
}
