// The charts of the side-by-side page (versus.html). Every model gets its own row on
// one shared scale, so the answers line up: a stacked bar per model for 是/否 and 单选,
// a ruler per model for 打分, then the confidence and each option's probability, model
// by model. build() draws the 0% preview; play(i, result) grows model i's answer in.

import { describeConfidence } from './core.js';

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

function swatch(slot) {
  const sw = el('span', `swatch s${slot || 0}`);
  sw.setAttribute('aria-hidden', 'true');
  return sw;
}

const TITLES = {
  noul: ['“是”的概率', ''],
  choice: ['概率分布', '每个选项的概率'],
  score: ['得分', '每一档的概率'],
};
const IDLE = ['还没有结果', '选好模型、填好问题和选项，点「发起对比」后，每个模型的回答会在下面一行一行地并排显示。'];
const VERDICT = { agree: '✓ 结论一致', differ: '≠ 结论不同', none: '无法对比' };

// Identifies what is drawn, to tell whether the charts on screen need rebuilding.
export const signatureOf = (type, items, models) =>
  JSON.stringify([type, items.map((it) => [it.key, it.label, it.desc, it.slot]), models.map((m) => [m.id, m.name])]);

export function createVersusViz(root, tooltip) {
  let type = null;
  let items = []; // the options, plus any an answer mentions that was not sent
  let models = []; // [{ id, name }]
  let slots = []; // per model: { result, error, level, anim, waiting }
  let refs = {};

  // ---- tooltip (pointer only: every value is also written out below the charts) ----

  function hideTip() {
    tooltip.hidden = true;
  }
  function bindTip(node) {
    node.addEventListener('pointermove', (e) => {
      const value = node.dataset.tipValue;
      if (!value) return hideTip();
      tooltip.replaceChildren(el('strong', null, value), el('span', null, node.dataset.tipLabel ?? ''));
      tooltip.hidden = false;
      const { width, height } = tooltip.getBoundingClientRect();
      const x = Math.max(8, Math.min(window.innerWidth - width - 8, e.clientX - width / 2));
      const y = e.clientY - height - 12 < 8 ? e.clientY + 20 : e.clientY - height - 12;
      tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    });
    node.addEventListener('pointerleave', hideTip);
  }
  window.addEventListener('scroll', hideTip, { passive: true, capture: true });

  // ---- DOM ----------------------------------------------------------------

  function summaryBlock() {
    const box = el('div', 'vs-summary');
    box.setAttribute('aria-live', 'polite');
    refs.summary = box;
    refs.verdict = el('p', 'vs-verdict');
    refs.main = el('p', 'vs-summary-main');
    refs.sub = el('p', 'vs-summary-sub');
    refs.points = el('ul', 'vs-points');
    box.append(refs.verdict, refs.main, refs.sub, refs.points);
    return box;
  }

  function legend() {
    const list = el('ul', 'vs-legend');
    list.setAttribute('aria-label', '图例');
    refs.legend = list;
    fillLegend();
    return list;
  }

  function fillLegend() {
    refs.legend.replaceChildren(
      ...items.map((it) => {
        const li = el('li', 'vs-legend-item');
        li.append(swatch(it.slot), el('span', it.isHint ? 'is-hint' : null, it.label));
        return li;
      }),
    );
  }

  // Level numbers above the rulers, at the same positions as the ticks on every rail.
  const levelLeft = (i) => `${items.length > 1 ? (i / (items.length - 1)) * 100 : 0}%`;

  function axis() {
    const box = el('div', 'vs-axis');
    box.setAttribute('aria-hidden', 'true');
    items.forEach((it, i) => {
      const tick = el('span', 'vs-axis-tick', String(i + 1));
      tick.style.left = levelLeft(i);
      tick.dataset.tipValue = `第 ${i + 1} 档`;
      tick.dataset.tipLabel = it.label;
      bindTip(tick);
      box.append(tick);
    });
    return box;
  }

  function trackRow(model) {
    const row = el('li', 'vs-track');
    row.dataset.state = 'idle';
    const head = el('div', 'vs-track-head');
    const name = el('span', 'vs-track-name', model.name);
    const value = el('span', 'vs-track-value');
    const valueSwatch = swatch(0);
    valueSwatch.hidden = true;
    const valueText = el('span', 'vs-value-text', '—');
    value.append(valueSwatch, valueText);
    head.append(name, value);
    const plot = el('div', 'vs-plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', `${model.name}：还没有结果`);
    const t = { row, value, valueSwatch, valueText, plot, segs: [] };
    if (type === 'score') {
      const scale = el('div', 'vs-scale');
      const rail = el('div', 'vs-rail');
      t.fill = el('div', 'vs-rail-fill');
      rail.append(t.fill);
      items.forEach((_, i) => {
        const tick = el('span', 'vs-rail-tick');
        tick.style.left = levelLeft(i);
        rail.append(tick);
      });
      t.dot = el('span', 'vs-dot');
      t.dot.hidden = true;
      bindTip(t.dot);
      rail.append(t.dot);
      scale.append(rail);
      plot.append(scale);
    } else {
      t.bar = el('div', 'vs-bar');
      plot.append(t.bar);
    }
    t.error = el('div', 'vs-track-error');
    t.error.hidden = true;
    row.append(head, plot, t.error);
    return t;
  }

  function answersBlock() {
    const section = el('section', 'vs-block');
    const head = el('div', 'vs-block-head');
    head.append(el('h3', 'vs-block-title', TITLES[type][0]));
    if (type !== 'score') head.append(legend());
    section.append(head);
    if (type === 'score') section.append(axis());
    const list = el('ul', 'vs-tracks');
    refs.tracks = models.map((m) => trackRow(m));
    list.append(...refs.tracks.map((t) => t.row));
    section.append(list);
    if (type === 'score') {
      const levels = el('ol', 'vs-levels');
      levels.setAttribute('aria-label', '各档含义');
      levels.append(
        ...items.map((it, i) => {
          const li = el('li');
          li.append(el('span', 'level-num', String(i + 1)), el('span', it.isHint ? 'is-hint' : null, it.label));
          return li;
        }),
      );
      section.append(levels);
    }
    return section;
  }

  function confidenceBlock() {
    const section = el('section', 'vs-block');
    const head = el('div', 'vs-block-head');
    head.append(el('h3', 'vs-block-title', '置信度'), el('p', 'vs-block-note', '概率越集中在一个答案上，置信度越高'));
    const list = el('ul', 'vs-meters');
    refs.conf = models.map((m) => {
      const li = el('li', 'vs-row');
      const meter = el('div', 'meter');
      const fill = el('div', 'meter-fill');
      meter.append(fill);
      const value = el('span', 'vs-row-value', '—');
      li.append(el('span', 'vs-row-name', m.name), meter, value);
      list.append(li);
      return { fill, value };
    });
    section.append(head, list);
    return section;
  }

  function detailBlock() {
    const section = el('section', 'vs-block');
    const head = el('div', 'vs-block-head');
    head.append(el('h3', 'vs-block-title', TITLES[type][1]));
    refs.detail = el('ul', 'vs-options');
    section.append(head, refs.detail);
    fillDetail();
    return section;
  }

  // One group per option, one bar per model inside it: the models' bars for an option
  // sit right under each other on the same baseline.
  function fillDetail() {
    refs.options = items.map((it, j) => {
      const li = el('li', 'vs-option');
      const head = el('div', 'vs-option-head');
      head.append(type === 'score' ? el('span', 'level-num', String(j + 1)) : swatch(it.slot));
      const text = el('div', 'vs-option-text');
      text.append(el('span', `vs-option-label${it.isHint ? ' is-hint' : ''}`, it.label));
      if (it.desc) text.append(el('span', 'vs-option-desc', it.desc));
      const gap = el('span', 'vs-option-gap');
      head.append(text, gap);
      const rows = el('ul', 'vs-option-rows');
      const cells = models.map((m) => {
        const row = el('li', 'vs-row');
        const meter = el('div', 'row-meter');
        const fill = el('div', `row-fill s${type === 'score' ? 1 : it.slot || 0}`);
        meter.append(fill);
        const value = el('span', 'vs-row-value', '0%');
        const mark = el('span', 'vs-row-mark');
        row.append(el('span', 'vs-row-name', m.name), meter, value, mark);
        rows.append(row);
        return { row, fill, value, mark };
      });
      li.append(head, rows);
      return { li, key: it.key, gap, cells };
    });
    refs.detail.replaceChildren(...refs.options.map((o) => o.li));
  }

  function build(nextType, nextItems, nextModels) {
    for (const slot of slots) slot.anim?.cancel();
    hideTip();
    type = nextType;
    items = nextItems.map((it) => ({ ...it }));
    models = nextModels.map((m) => ({ ...m }));
    slots = models.map(() => ({ result: null, error: null, level: 0, anim: null, waiting: false }));
    refs = {};
    const frag = document.createDocumentFragment();
    frag.append(summaryBlock(), answersBlock());
    // Confidence and the per-option breakdown; 是/否 has neither (its bars say it all).
    refs.extras = type === 'noul' ? [] : [confidenceBlock(), detailBlock()];
    frag.append(...refs.extras);
    root.replaceChildren(frag);
    root.classList.remove('has-result');
    setSummary(null);
    models.forEach((_, i) => paint(i, 0));
  }

  // An answer can name an option that was not sent; it joins the legend and the
  // breakdown in grey, so nothing the model said is dropped.
  function mergeItems(resultItems) {
    const extra = resultItems.filter((it) => !items.some((own) => own.key === it.key));
    if (!extra.length) return;
    items.push(...extra.map(({ key, label, desc }) => ({ key, label, desc, slot: 0 })));
    if (refs.legend) fillLegend();
    if (refs.detail) {
      fillDetail();
      slots.forEach((slot, i) => {
        paintDetail(i, slot.level);
        setMarks(i, slot.level === 1 ? slot.result : null);
      });
    }
  }

  // ---- painting -------------------------------------------------------------

  const pctText = (pct, k) => `${Math.round(pct * k)}%`;

  // Draws model i's answer scaled by k (0 = empty, 1 = the full answer).
  function paint(i, k) {
    slots[i].level = k;
    const res = slots[i].result;
    const t = refs.tracks[i];
    if (type === 'score') paintRail(t, res, k);
    else paintBar(t, res, k);
    paintValue(i, res, k);
    if (refs.conf) {
      const c = res?.confidence;
      refs.conf[i].fill.style.width = `${c == null ? 0 : c * k * 100}%`;
      refs.conf[i].value.textContent =
        c == null || !res ? '—' : `${Math.round(c * 100 * k)}%` + (k === 1 ? ` · ${describeConfidence(c)}` : '');
    }
    paintDetail(i, k);
  }

  function makeSegments(i, res) {
    const t = refs.tracks[i];
    t.segs = res.items.map((it) => {
      const seg = el('div', `vs-seg s${it.slot || 0}`);
      seg.hidden = true;
      seg.dataset.tipLabel = `${models[i].name} · ${it.label}`;
      seg.dataset.tipValue = res.estimated ? '它的选择' : `${it.pct}%`;
      bindTip(seg);
      return seg;
    });
    t.bar.replaceChildren(...t.segs);
  }

  function place(seg, left, right, width) {
    seg.hidden = false;
    seg.style.left = left;
    seg.style.right = right;
    seg.style.width = width;
  }

  // Yes/no: 是 grows from the left and 否 from the right, meeting at the probability of
  // yes. Choice: the whole stack grows from the left. 2px surface gaps between segments.
  function paintBar(t, res, k) {
    if (!res) {
      for (const seg of t.segs) seg.hidden = true;
      return;
    }
    const its = res.items;
    if (type === 'noul') {
      const [a, b] = its;
      const gap = a.share > 0 && b.share > 0 ? 1 : 0;
      place(t.segs[0], '0', 'auto', `calc(${a.share * k * 100}% - ${gap}px)`);
      place(t.segs[1], 'auto', '0', `calc(${b.share * k * 100}% - ${gap}px)`);
      t.segs[0].hidden = !(a.share > 0);
      t.segs[1].hidden = !(b.share > 0);
      return;
    }
    const visible = its.map((it, j) => (it.share > 0 ? j : -1)).filter((j) => j >= 0);
    let cum = 0;
    its.forEach((it, j) => {
      const seg = t.segs[j];
      const at = visible.indexOf(j);
      if (at < 0) {
        seg.hidden = true;
        return;
      }
      const lb = at > 0 ? 1 : 0;
      const rb = at < visible.length - 1 ? 1 : 0;
      place(seg, `calc(${cum * k * 100}% + ${lb}px)`, 'auto', `calc(${it.share * k * 100}% - ${lb + rb}px)`);
      cum += it.share;
    });
  }

  function paintRail(t, res, k) {
    if (!res || k === 0) {
      t.dot.hidden = true;
      t.fill.style.width = '0%';
      return;
    }
    const frac = res.max > 0 ? res.score / res.max : 0;
    t.fill.style.width = `${frac * k * 100}%`;
    t.dot.style.left = `${frac * k * 100}%`;
    t.dot.hidden = false;
  }

  function paintValue(i, res, k) {
    const t = refs.tracks[i];
    const slot = slots[i];
    t.valueSwatch.hidden = true;
    if (slot.waiting) {
      t.valueText.textContent = '等待回答…';
      return;
    }
    if (slot.error) {
      t.valueText.textContent = '调用失败';
      return;
    }
    if (!res) {
      t.valueText.textContent = '—';
      return;
    }
    if (type === 'noul') {
      t.valueText.textContent = `是 ${pctText(res.items[0].pct, k)}`;
    } else if (type === 'choice') {
      const win = res.items.find((it) => it.key === res.winner);
      t.valueSwatch.className = `swatch s${win?.slot || 0}`;
      t.valueSwatch.hidden = !win;
      const label = win?.label ?? String(res.winner);
      t.valueText.textContent = res.estimated ? `${label}（没有返回概率）` : `${label} ${pctText(win?.pct ?? 0, k)}`;
    } else {
      t.valueText.textContent = `${(1 + res.score * k).toFixed(2)} / ${res.max + 1}`;
    }
  }

  // A model without probabilities (or without an answer) shows a dash, not a made-up 0%.
  function paintDetail(i, k) {
    if (!refs.options) return;
    const { result: res, error } = slots[i];
    const measured = res && !res.estimated;
    for (const opt of refs.options) {
      const cell = opt.cells[i];
      const it = measured ? res.items.find((x) => x.key === opt.key) : null;
      cell.fill.style.width = `${(it?.share ?? 0) * k * 100}%`;
      cell.value.textContent = measured ? pctText(it?.pct ?? 0, k) : res || error ? '—' : '0%';
    }
  }

  // ✓ beside the option each model picked, once its answer has fully grown in.
  function setMarks(i, res) {
    if (!refs.options) return;
    for (const opt of refs.options) {
      const picked = Boolean(res) && type === 'choice' && opt.key === res.winner;
      const cell = opt.cells[i];
      cell.mark.textContent = picked ? '✓' : '';
      cell.mark.title = picked ? `${models[i].name} 选了这个` : '';
      cell.row.classList.toggle('is-pick', picked);
    }
  }

  // The words a screen reader gets for model i's row.
  function describe(i, res) {
    const name = models[i].name;
    if (type === 'score') {
      const near = Math.round(res.score);
      return `${name}：得分 ${(res.score + 1).toFixed(2)} / ${res.max + 1}，最接近第 ${near + 1} 档「${res.items[near]?.label ?? ''}」`;
    }
    if (res.estimated) {
      const win = res.items.find((it) => it.key === res.winner);
      return `${name}：选了「${win?.label ?? res.winner}」，没有返回各选项的概率`;
    }
    return `${name}：${res.items.map((it) => `${it.label} ${it.pct}%`).join('，')}`;
  }

  // ---- summary ------------------------------------------------------------

  function setSummary(summary, message) {
    refs.summary.classList.toggle('is-final', Boolean(summary));
    // When no model answered there is nothing to break down, only the errors above.
    const empty = Boolean(summary) && !slots.some((s) => s.result);
    for (const block of refs.extras) block.hidden = empty;
    refs.verdict.hidden = !summary;
    refs.points.replaceChildren();
    refs.points.hidden = true;
    if (!summary) {
      [refs.main.textContent, refs.sub.textContent] = message ?? IDLE;
      refs.sub.hidden = false;
      return;
    }
    refs.verdict.dataset.state = summary.state;
    refs.verdict.textContent = VERDICT[summary.state];
    refs.main.textContent = summary.main;
    refs.sub.textContent = '';
    refs.sub.hidden = true;
    refs.points.append(...summary.points.map((p) => el('li', null, p)));
    refs.points.hidden = !summary.points.length;
  }

  // "相差 31 个百分点" beside each option, between the models that returned probabilities.
  // Without `show` (a new round is starting) the labels go.
  function setGaps(show = true) {
    if (!refs.options) return;
    const measured = slots.filter((s) => s.result && !s.result.estimated).map((s) => s.result);
    for (const opt of refs.options) {
      if (!show || measured.length < 2) {
        opt.gap.textContent = '';
        continue;
      }
      const pcts = measured.map((r) => r.items.find((it) => it.key === opt.key)?.pct ?? 0);
      const gap = Math.max(...pcts) - Math.min(...pcts);
      opt.gap.textContent = gap ? `相差 ${gap} 个百分点` : '没有差别';
    }
  }

  // ---- public API ---------------------------------------------------------

  // Shrinks every answer on screen back to 0 while a new round of calls is in flight.
  async function drain() {
    hideTip();
    setSummary(null, [`正在等待 ${models.length} 个模型回答…`, '每个模型的回答一到，它那一行就会长出来。']);
    setGaps(false);
    root.classList.remove('has-result');
    const runs = slots.map((slot, i) => {
      slot.anim?.cancel();
      slot.waiting = true;
      slot.error = null;
      setMarks(i, null);
      const t = refs.tracks[i];
      t.row.dataset.state = 'busy';
      t.error.hidden = true;
      t.plot.hidden = false;
      t.plot.setAttribute('aria-label', `${models[i].name}：等待回答`);
      const from = slot.level;
      if (!slot.result || from === 0) {
        slot.result = null;
        paint(i, 0);
        return Promise.resolve();
      }
      slot.anim = tween(SHRINK_MS, easeInCubic, (x) => paint(i, from * (1 - x)));
      // Cancelled means a new answer already took the row over.
      return slot.anim.promise.then((done) => {
        if (done) slot.result = null;
      });
    });
    await Promise.all(runs);
  }

  // How many answers are in, while the rest are still on their way.
  function progress(done, total) {
    if (done < total) refs.sub.textContent = `已收到 ${done} / ${total} 个回答…`;
  }

  async function play(i, res) {
    const slot = slots[i];
    slot.anim?.cancel();
    slot.result = res;
    slot.error = null;
    slot.waiting = false;
    if (type === 'choice') mergeItems(res.items);
    const t = refs.tracks[i];
    t.row.dataset.state = 'done';
    t.error.hidden = true;
    t.plot.hidden = false;
    t.plot.setAttribute('aria-label', describe(i, res));
    if (type === 'score') {
      t.dot.dataset.tipValue = (res.score + 1).toFixed(2);
      const near = Math.round(res.score);
      t.dot.dataset.tipLabel = `${models[i].name} · 最接近第 ${near + 1} 档：${res.items[near]?.label ?? ''}`;
    } else {
      makeSegments(i, res);
    }
    setMarks(i, null);
    root.classList.add('has-result');
    slot.anim = tween(GROW_MS, easeInOutCubic, (k) => paint(i, k));
    const done = await slot.anim.promise;
    if (done) setMarks(i, res);
    return done;
  }

  // Model i's call failed: its row says why instead of drawing a chart.
  function fail(i, error) {
    const slot = slots[i];
    slot.anim?.cancel();
    slot.result = null;
    slot.error = error;
    slot.waiting = false;
    setMarks(i, null);
    paint(i, 0);
    const t = refs.tracks[i];
    t.row.dataset.state = 'error';
    t.plot.hidden = true;
    t.error.replaceChildren(el('strong', null, error.title));
    if (error.hint) t.error.append(el('span', null, error.hint));
    t.error.hidden = false;
  }

  // Every call has finished: the comparison in words, and the gaps per option.
  function summarize(summary) {
    setSummary(summary);
    setGaps();
  }

  const signature = () => signatureOf(type, items, models);

  return { build, drain, progress, play, fail, summarize, signature };
}
