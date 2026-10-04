// Page wiring: form state, option editors, the API call and result display.

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  EXAMPLES,
  LIMITS,
  MODELS,
  TYPES,
  buildCurl,
  buildRequest,
  displayItems,
  formatUsd,
  isAnswerShapeError,
  normalizeKey,
  parseError,
  readAnswer,
  resolveEndpoint,
  validateKey,
} from './core.js';
import { createViz, signatureOf } from './viz.js';

const FORM_STORE = 'simple-jev:form';
const KEY_STORE = 'simple-jev:key';
const THEME_STORE = 'simple-jev:theme';
const CUSTOM_MODEL = '__custom';
const REQUEST_TIMEOUT_MS = 60_000;

const $ = (id) => document.getElementById(id);

// localStorage can be missing or throw (private windows, blocked site data); the page works without it.
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Ignore: remembering is a convenience only.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore.
    }
  },
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---- state ---------------------------------------------------------------

let uid = 0;
const newId = () => `opt${++uid}`;

const DEFAULT_SCORE = [{ text: '低' }, { text: '中' }, { text: '高' }];

function nextSlot(list) {
  const used = new Set(list.map((o) => o.slot));
  let slot = 1;
  while (used.has(slot) && slot <= LIMITS.choice.max) slot += 1;
  return slot;
}

const toChoice = (list) =>
  list.slice(0, LIMITS.choice.max).map((o, i) => ({ id: newId(), name: String(o.name ?? ''), desc: String(o.desc ?? ''), slot: i + 1 }));
const toScore = (list) => list.slice(0, LIMITS.score.max).map((l) => ({ id: newId(), text: String(l.text ?? '') }));

function initialState() {
  const ex = EXAMPLES[0];
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    type: ex.type,
    question: ex.question,
    context: ex.context,
    noul: { trueText: '', falseText: '' },
    choice: toChoice(ex.choice),
    score: toScore(DEFAULT_SCORE),
  };
}

function loadState() {
  const base = initialState();
  const raw = storage.get(FORM_STORE);
  if (!raw) return base;
  try {
    const s = JSON.parse(raw);
    const str = (v, d) => (typeof v === 'string' ? v : d);
    return {
      baseUrl: str(s.baseUrl, base.baseUrl),
      model: str(s.model, base.model) || base.model,
      type: TYPES.includes(s.type) ? s.type : base.type,
      question: str(s.question, base.question),
      context: str(s.context, base.context),
      noul: { trueText: str(s.noul?.trueText, ''), falseText: str(s.noul?.falseText, '') },
      choice: Array.isArray(s.choice) && s.choice.length ? toChoice(s.choice) : base.choice,
      score: Array.isArray(s.score) && s.score.length ? toScore(s.score) : base.score,
    };
  } catch {
    return base;
  }
}

const state = loadState();

const saveState = debounce(() => {
  storage.set(
    FORM_STORE,
    JSON.stringify({
      baseUrl: state.baseUrl,
      model: state.model,
      type: state.type,
      question: state.question,
      context: state.context,
      noul: state.noul,
      choice: state.choice.map(({ name, desc }) => ({ name, desc })),
      score: state.score.map(({ text }) => ({ text })),
    }),
  );
}, 250);

// ---- elements ------------------------------------------------------------

const form = $('jev-form');
const baseUrlInput = $('base-url');
const endpointPreview = $('endpoint-preview');
const keyInput = $('api-key');
const toggleKeyBtn = $('toggle-key');
const rememberKey = $('remember-key');
const modelSelect = $('model-select');
const modelCustom = $('model-custom');
const questionInput = $('question');
const contextInput = $('context');
const noulTrue = $('noul-true');
const noulFalse = $('noul-false');
const choiceList = $('choice-list');
const scoreList = $('score-list');
const addChoiceBtn = $('add-choice');
const addScoreBtn = $('add-score');
const formErrors = $('form-errors');
const submitBtn = $('submit');
const submitText = submitBtn.querySelector('.submit-text');
const resultCard = $('result-card');
const resultStatus = $('result-status');
const resultQuestion = $('result-question');
const resultError = $('result-error');
const resultMeta = $('result-meta');
const raw = $('raw');

const viz = createViz($('viz'), $('tooltip'));

let busy = false;
let lastSent = null; // { snapshot, question } of the successful request on screen
let shownQuestion = null; // question of the request in flight or on screen; null = echo the form
let pendingRefresh = false; // options or type changed while a call was in flight

// ---- theme ---------------------------------------------------------------

const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
const themeBtn = $('theme-toggle');

const THEME_COLOR = { light: '#f6f5f1', dark: '#0d0d0d' };

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  // Keep the browser chrome in step with a manual override.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = THEME_COLOR[mode === 'auto' ? own : mode];
  }
  themeBtn.dataset.mode = mode;
  $('theme-label').textContent = THEME_LABEL[mode];
  themeBtn.setAttribute('aria-label', `切换主题：当前为${THEME_LABEL[mode]}`);
}

themeBtn.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(themeBtn.dataset.mode) + 1) % order.length];
  if (next === 'auto') storage.remove(THEME_STORE);
  else storage.set(THEME_STORE, next);
  applyTheme(next);
});

// ---- connection fields ---------------------------------------------------

function renderEndpoint() {
  const r = resolveEndpoint(state.baseUrl);
  endpointPreview.replaceChildren();
  endpointPreview.classList.toggle('is-error', !r.ok);
  if (!r.ok) {
    endpointPreview.textContent = r.error;
    return;
  }
  endpointPreview.append('将发送到：POST ', el('code', null, r.url));
  if (r.note) endpointPreview.append(el('br'), el('span', 'note', r.note));
}

baseUrlInput.addEventListener('input', () => {
  state.baseUrl = baseUrlInput.value;
  baseUrlInput.removeAttribute('aria-invalid');
  renderEndpoint();
  saveState();
});

toggleKeyBtn.addEventListener('click', () => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  toggleKeyBtn.textContent = show ? '隐藏' : '显示';
  toggleKeyBtn.setAttribute('aria-label', show ? '隐藏 Key' : '显示 Key');
});

const saveKey = debounce(() => {
  if (!rememberKey.checked) return;
  // An emptied field means "forget it", not "keep the old one".
  const key = keyInput.value.trim();
  if (key) storage.set(KEY_STORE, key);
  else storage.remove(KEY_STORE);
}, 300);

keyInput.addEventListener('input', () => {
  keyInput.removeAttribute('aria-invalid');
  saveKey();
});

rememberKey.addEventListener('change', () => {
  if (rememberKey.checked) saveKey();
  else storage.remove(KEY_STORE);
});

function renderModel() {
  modelSelect.replaceChildren(
    ...MODELS.map((m) => new Option(m.label, m.id)),
    new Option('自定义模型名称…', CUSTOM_MODEL),
  );
  const known = MODELS.some((m) => m.id === state.model);
  modelSelect.value = known ? state.model : CUSTOM_MODEL;
  modelCustom.hidden = known;
  modelCustom.value = known ? '' : state.model;
}

function currentModel() {
  return modelSelect.value === CUSTOM_MODEL ? modelCustom.value.trim() : modelSelect.value;
}

modelSelect.addEventListener('change', () => {
  const custom = modelSelect.value === CUSTOM_MODEL;
  modelCustom.hidden = !custom;
  if (custom) modelCustom.focus();
  state.model = currentModel();
  markStale();
  saveState();
});

modelCustom.addEventListener('input', () => {
  modelCustom.removeAttribute('aria-invalid');
  state.model = currentModel();
  markStale();
  saveState();
});

// ---- question fields -----------------------------------------------------

function renderQuestionEcho() {
  const q = (shownQuestion ?? state.question).trim();
  resultQuestion.textContent = q ? `问：${q}` : '';
}

questionInput.addEventListener('input', () => {
  state.question = questionInput.value;
  questionInput.removeAttribute('aria-invalid');
  renderQuestionEcho();
  markStale();
  saveState();
});

contextInput.addEventListener('input', () => {
  state.context = contextInput.value;
  markStale();
  saveState();
});

for (const radio of form.elements.type) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.type = radio.value;
    renderOptions();
    refreshPreview();
    saveState();
  });
}

function renderExamples() {
  const box = $('examples');
  box.replaceChildren(
    ...EXAMPLES.map((ex) => {
      const btn = el('button', 'chip', ex.title);
      btn.type = 'button';
      btn.addEventListener('click', () => loadExample(ex));
      return btn;
    }),
  );
}

function loadExample(ex) {
  state.type = ex.type;
  state.question = ex.question;
  state.context = ex.context ?? '';
  if (ex.noul) state.noul = { ...ex.noul };
  else if (ex.type === 'noul') state.noul = { trueText: '', falseText: '' };
  if (ex.choice) state.choice = toChoice(ex.choice);
  if (ex.score) state.score = toScore(ex.score);
  renderAll();
  saveState();
}

// ---- option editors ------------------------------------------------------

function iconButton(label, text, action) {
  const btn = el('button', 'mini-btn', text);
  btn.type = 'button';
  btn.dataset.action = action;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  return btn;
}

function renderChoiceList() {
  const n = state.choice.length;
  choiceList.replaceChildren(
    ...state.choice.map((opt, i) => {
      const row = el('li', 'option-row is-choice');
      row.dataset.id = opt.id;
      const sw = el('span', `swatch s${opt.slot}`);
      sw.setAttribute('aria-hidden', 'true');
      const name = el('input', 'opt-name');
      name.type = 'text';
      name.autocomplete = 'off';
      name.value = opt.name;
      name.dataset.field = 'name';
      name.placeholder = i === 0 ? '选项名，如：活' : i === 1 ? '选项名，如：死' : '选项名';
      name.setAttribute('aria-label', `选项 ${i + 1} 名称`);
      const desc = el('input', 'opt-desc');
      desc.type = 'text';
      desc.autocomplete = 'off';
      desc.value = opt.desc;
      desc.dataset.field = 'desc';
      desc.placeholder = '说明（选填）：什么情况选它';
      desc.setAttribute('aria-label', `选项 ${i + 1} 说明`);
      const remove = iconButton(`删除选项 ${i + 1}`, '×', 'remove');
      remove.classList.add('remove-btn');
      remove.disabled = n <= LIMITS.choice.min;
      row.append(sw, name, desc, remove);
      return row;
    }),
  );
  addChoiceBtn.disabled = n >= LIMITS.choice.max;
  addChoiceBtn.textContent = n >= LIMITS.choice.max ? `最多 ${LIMITS.choice.max} 个选项` : '＋ 添加选项';
}

function renderScoreList() {
  const n = state.score.length;
  scoreList.replaceChildren(
    ...state.score.map((lvl, i) => {
      const row = el('li', 'option-row is-score');
      row.dataset.id = lvl.id;
      const num = el('span', 'level-num', String(i + 1));
      num.setAttribute('aria-hidden', 'true');
      const text = el('input', 'opt-text');
      text.type = 'text';
      text.autocomplete = 'off';
      text.value = lvl.text;
      text.dataset.field = 'text';
      text.placeholder = i === 0 ? '最低一档' : i === n - 1 ? '最高一档' : `第 ${i + 1} 档`;
      text.setAttribute('aria-label', `第 ${i + 1} 档内容`);
      const up = iconButton(`把第 ${i + 1} 档上移`, '↑', 'up');
      up.disabled = i === 0;
      const down = iconButton(`把第 ${i + 1} 档下移`, '↓', 'down');
      down.disabled = i === n - 1;
      const remove = iconButton(`删除第 ${i + 1} 档`, '×', 'remove');
      remove.disabled = n <= LIMITS.score.min;
      row.append(num, text, up, down, remove);
      return row;
    }),
  );
  addScoreBtn.disabled = n >= LIMITS.score.max;
  addScoreBtn.textContent = n >= LIMITS.score.max ? `最多 ${LIMITS.score.max} 档` : '＋ 添加档位';
}

function renderOptions() {
  for (const t of TYPES) $(`options-${t}`).hidden = t !== state.type;
  $('opt-title-text').textContent = { noul: '“是”和“否”的含义', choice: '可选答案', score: '打分等级' }[state.type];
  noulTrue.value = state.noul.trueText;
  noulFalse.value = state.noul.falseText;
  renderChoiceList();
  renderScoreList();
}

const refreshPreviewSoon = debounce(() => refreshPreview(), 120);

function onOptionsEdited() {
  hideFormErrors();
  refreshPreviewSoon();
  saveState();
}

for (const [input, key] of [
  [noulTrue, 'trueText'],
  [noulFalse, 'falseText'],
]) {
  input.addEventListener('input', () => {
    state.noul[key] = input.value;
    onOptionsEdited();
  });
}

function listFor(listEl) {
  return listEl === choiceList ? state.choice : state.score;
}

function bindListEditor(listEl, render, addBtn, makeItem, max) {
  listEl.addEventListener('input', (e) => {
    const input = e.target.closest('input');
    const row = e.target.closest('li');
    if (!input || !row) return;
    const item = listFor(listEl).find((o) => o.id === row.dataset.id);
    if (!item) return;
    item[input.dataset.field] = input.value;
    input.removeAttribute('aria-invalid');
    onOptionsEdited();
  });

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    const row = e.target.closest('li');
    if (!btn || !row || btn.disabled) return;
    const list = listFor(listEl);
    const i = list.findIndex((o) => o.id === row.dataset.id);
    if (i < 0) return;
    const action = btn.dataset.action;
    if (action === 'remove') list.splice(i, 1);
    if (action === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (action === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    render();
    onOptionsEdited();
    // Keep keyboard focus somewhere sensible after the list re-renders.
    if (action === 'remove') {
      const next = listEl.children[Math.min(i, list.length - 1)];
      (next?.querySelector('input') ?? addBtn).focus();
    } else {
      const moved = listEl.querySelector(`li[data-id="${row.dataset.id}"] button[data-action="${action}"]`);
      (moved && !moved.disabled ? moved : listEl.querySelector(`li[data-id="${row.dataset.id}"] input`))?.focus();
    }
  });

  // Enter moves to the next row, or adds one at the end, instead of submitting.
  listEl.addEventListener('keydown', (e) => {
    // keyCode 229: Safari reports the Enter that commits IME text this way, without isComposing.
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey) return;
    const input = e.target.closest('input');
    const row = e.target.closest('li');
    if (!input || !row) return;
    e.preventDefault();
    const nextRow = row.nextElementSibling;
    if (nextRow) nextRow.querySelector('input')?.focus();
    else if (listFor(listEl).length < max) addBtn.click();
  });

  addBtn.addEventListener('click', () => {
    const list = listFor(listEl);
    if (list.length >= max) return;
    list.push(makeItem(list));
    render();
    onOptionsEdited();
    listEl.lastElementChild?.querySelector('input')?.focus();
  });
}

bindListEditor(
  choiceList,
  renderChoiceList,
  addChoiceBtn,
  (list) => ({ id: newId(), name: '', desc: '', slot: nextSlot(list) }),
  LIMITS.choice.max,
);
bindListEditor(scoreList, renderScoreList, addScoreBtn, () => ({ id: newId(), text: '' }), LIMITS.score.max);

// ---- result panel --------------------------------------------------------

const STATUS = {
  idle: '等待调用',
  busy: '调用中…',
  done: '完成',
  error: '出错了',
  stale: '内容已修改，可重新调用',
};

function setStatus(stateName) {
  resultStatus.dataset.state = stateName;
  resultStatus.textContent = STATUS[stateName];
}

function resetResultExtras() {
  resultCard.classList.remove('is-stale');
  resultError.hidden = true;
  resultMeta.hidden = true;
  raw.hidden = true;
}

// Options or type changed: show the new options at 0%. While a call is in flight
// the bars belong to that call, so the refresh waits until it finishes.
function refreshPreview() {
  if (busy) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  viz.build(state.type, displayItems(state.type, state));
  lastSent = null;
  shownQuestion = null;
  renderQuestionEcho();
  resetResultExtras();
  setStatus('idle');
}

// What the form would send right now, to compare with the request on screen.
function formSnapshot() {
  const built = buildRequest({ ...state, model: currentModel() });
  return built.ok ? JSON.stringify([built.body, built.items]) : 'invalid';
}

function markStale() {
  if (busy || !lastSent) return;
  const same = formSnapshot() === lastSent.snapshot;
  resultCard.classList.toggle('is-stale', !same);
  setStatus(same ? 'done' : 'stale');
}

// Scrolls the result into view when it is off screen, or always on narrow
// layouts where the result sits below the form.
function revealResult(target) {
  const r = target.getBoundingClientRect();
  const narrow = window.matchMedia('(max-width: 960px)').matches;
  if (!narrow && r.top >= 0 && r.top <= window.innerHeight - 160) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  resultCard.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

function showMeta(json, ms, stateSource) {
  const rows = [
    ['耗时', `${ms} ms`],
    ['费用', formatUsd(json?.usage?.cost)],
    ['输入 tokens', json?.usage?.input_tokens ?? '—'],
    ['服务商', json?.provider ?? '—'],
    ['输出 tokens（免费）', json?.usage?.output_tokens ?? '—'],
    ['判断材料', { question: '问题本身（背景内容为空）', text: '背景内容（文本）', json: '背景内容（JSON）' }[stateSource] ?? '—'],
    ['模型', json?.model ?? '—', 'wide mono'],
    ['生成 ID', json?.id ?? '—', 'wide mono'],
  ];
  resultMeta.replaceChildren(
    ...rows.map(([k, v, cls]) => {
      const wrap = el('div', cls?.includes('wide') ? 'wide' : null);
      const dd = el('dd', cls?.includes('mono') ? 'mono' : null, String(v));
      wrap.append(el('dt', null, k), dd);
      return wrap;
    }),
  );
  resultMeta.hidden = false;
}

function showRaw(body, endpoint, responseText) {
  $('raw-request').textContent = JSON.stringify(body, null, 2);
  $('raw-curl').textContent = buildCurl(endpoint, body);
  let pretty = responseText ?? '';
  try {
    pretty = JSON.stringify(JSON.parse(responseText), null, 2);
  } catch {
    // Not JSON: show as-is.
  }
  $('raw-response').textContent = pretty || '（没有响应内容）';
  raw.hidden = false;
}

function showResultError({ title, hint, detail }) {
  resultError.querySelector('.error-title').textContent = title;
  resultError.querySelector('.error-hint').textContent = hint ?? '';
  resultError.querySelector('.error-detail').textContent = detail ?? '';
  resultError.hidden = false;
  setStatus('error');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const text = $(btn.dataset.copy)?.textContent ?? '';
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Clipboard API blocked: fall back to a temporary selection.
    const area = el('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => (btn.textContent = '复制'), 1500);
});

// ---- validation display --------------------------------------------------

const FIELD_INPUT = {
  baseUrl: () => baseUrlInput,
  apiKey: () => keyInput,
  model: () => (modelSelect.value === CUSTOM_MODEL ? modelCustom : modelSelect),
  question: () => questionInput,
  // Marks the rows the error names (duplicates, unnamed or blank rows) and returns the first.
  options: (err) => {
    const list = state.type === 'choice' ? choiceList : scoreList;
    const inputs = [...list.children].map((row) => row.querySelector('input'));
    const flagged = (err.rows ?? []).map((i) => inputs[i]).filter(Boolean);
    for (const input of flagged) input.setAttribute('aria-invalid', 'true');
    return flagged[0] ?? inputs[0];
  },
};

function hideFormErrors() {
  formErrors.hidden = true;
  formErrors.replaceChildren();
}

function showFormErrors(errors) {
  const list = el('ul');
  for (const err of errors) list.append(el('li', null, err.message));
  formErrors.replaceChildren(list);
  formErrors.hidden = false;
  let first = null;
  for (const err of errors) {
    const input = FIELD_INPUT[err.field]?.(err);
    if (!input) continue;
    if (err.field !== 'options') input.setAttribute('aria-invalid', 'true');
    first ??= input;
  }
  first?.focus();
}

// ---- the call ------------------------------------------------------------

function setBusy(on) {
  busy = on;
  submitBtn.setAttribute('aria-busy', String(on));
  submitText.textContent = on ? '调用中…' : '发起调用';
  $('viz').classList.toggle('is-busy', on);
  if (on) setStatus('busy');
}

async function submit() {
  if (busy) return;
  hideFormErrors();

  const endpoint = resolveEndpoint(state.baseUrl);
  const key = normalizeKey(keyInput.value);
  const built = buildRequest({ ...state, model: currentModel() });
  const errors = [];
  if (!endpoint.ok) errors.push({ field: 'baseUrl', message: endpoint.error });
  const keyError = validateKey(key);
  if (keyError) errors.push({ field: 'apiKey', message: keyError });
  if (!built.ok) errors.push(...built.errors);
  if (errors.length) {
    showFormErrors(errors);
    return;
  }

  const type = state.type;
  const items = built.items;
  const sent = { snapshot: JSON.stringify([built.body, built.items]), question: state.question.trim() };
  resetResultExtras();
  lastSent = null;
  pendingRefresh = false;
  shownQuestion = sent.question;
  renderQuestionEcho();
  setBusy(true);
  // Blank rows are not sent, so rebuild the bars if they differ from what is sent;
  // otherwise shrink the previous result back to 0 while waiting.
  if (signatureOf(type, items) !== viz.signature()) viz.build(type, items);
  const drained = viz.drain();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  let response = null;
  let text = '';
  let failure = null;
  try {
    response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(built.body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    text = await response.text();
  } catch (err) {
    failure =
      err?.name === 'AbortError'
        ? { title: '请求超时', hint: `${REQUEST_TIMEOUT_MS / 1000} 秒内没有收到回应，请稍后再试。`, detail: '' }
        : {
            title: '无法连接到这个地址',
            hint: '可能是网络问题、Base URL 填写有误，或者该服务不允许浏览器直接调用（CORS）。',
            detail: err?.message ?? '',
          };
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - t0);
  await drained;
  setBusy(false);

  const fail = (error, responseText) => {
    // Options or type edited mid-call: show the form's current options at 0%.
    if (pendingRefresh) viz.build(state.type, displayItems(state.type, state));
    pendingRefresh = false;
    shownQuestion = null;
    renderQuestionEcho();
    viz.clear(['调用失败', '原因见下方说明。']);
    showResultError(error);
    showRaw(built.body, endpoint.url, responseText);
    revealResult(resultError);
  };

  if (failure) return fail(failure, '');
  if (!response.ok) return fail(parseError(response.status, text), text);

  let result;
  let json;
  try {
    json = JSON.parse(text);
    result = readAnswer(type, json, items);
  } catch (err) {
    return fail(
      {
        title: '无法识别返回内容',
        hint: '服务返回了成功状态，但内容不是预期的 Jev 格式。请检查 Base URL 是否指向 Jev 的 Decisions 接口。',
        detail: isAnswerShapeError(err) ? err.message : '返回的内容不是有效的 JSON',
      },
      text,
    );
  }

  // Edits made while the call was in flight show up as a stale marker on this result.
  pendingRefresh = false;
  lastSent = sent;
  setStatus('done');
  showMeta(json, ms, built.stateSource);
  showRaw(built.body, endpoint.url, text);
  markStale();
  revealResult($('viz'));
  await viz.play(result);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submit();
  }
});

// ---- boot ----------------------------------------------------------------

function renderAll() {
  baseUrlInput.value = state.baseUrl;
  renderEndpoint();
  renderModel();
  for (const radio of form.elements.type) radio.checked = radio.value === state.type;
  questionInput.value = state.question;
  contextInput.value = state.context;
  renderQuestionEcho();
  renderOptions();
  hideFormErrors();
  refreshPreview();
}

applyTheme(['light', 'dark'].includes(storage.get(THEME_STORE)) ? storage.get(THEME_STORE) : 'auto');
const savedKey = storage.get(KEY_STORE);
if (savedKey) {
  keyInput.value = savedKey;
  rememberKey.checked = true;
}
renderExamples();
renderAll();
