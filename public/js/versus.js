// The side-by-side page (versus.html): one question, the same request sent to 2–4
// models at once, and their answers drawn on one scale. The question and options are
// shared with the single-model page through the browser's storage.

import {
  DEFAULT_BASE_URL,
  EXAMPLES,
  LIMITS,
  PLACEHOLDER_EXAMPLE,
  REFUSAL_TEXT,
  TYPES,
  buildCurl,
  choiceHint,
  displayItems,
  findModel,
  formatModelPrice,
  formatUsd,
  isAnswerRefusedError,
  isAnswerShapeError,
  modelGroups,
  modelPageUrl,
  normalizeKey,
  parseCatalog,
  parseError,
  readAnswer,
  resolveEndpoint,
  scoreHint,
  validateKey,
} from './core.js';
import { initThemeToggle } from './theme-toggle.js';
import {
  MAX_MODELS,
  MIN_MODELS,
  buildVersusRequests,
  modelNames,
  nextModel,
  restoreModels,
  summarizeComparison,
} from './versus-core.js';
import { createVersusViz, signatureOf } from './versus-viz.js';

// Every key starts with STORE_PREFIX, like the single-model page's (and the theme's).
const STORE_PREFIX = 'simple-jev:';
// The single-model page's form. This page reads and writes its Base URL, question type,
// question, background and options, so both pages always ask the same question; the
// fields only that page has (its model, image detail) are left as they are.
const FORM_STORE = 'simple-jev:form:v2';
const MODELS_STORE = 'simple-jev:versus:v1';
const KEY_STORE = 'simple-jev:key';
const CATALOG_STORE = 'simple-jev:catalog:v1';
const CACHE_CLEARED_HASH = '#cache-cleared';
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
  // Removes every key that starts with `prefix`, leaving other sites' data alone.
  removeAll(prefix) {
    for (const area of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[area];
        const keys = Array.from({ length: store.length }, (_, i) => store.key(i));
        for (const key of keys) if (key?.startsWith(prefix)) store.removeItem(key);
      } catch {
        // Storage unavailable: nothing was saved there.
      }
    }
  },
};

function readJson(key) {
  try {
    return JSON.parse(storage.get(key) ?? 'null');
  } catch {
    return null;
  }
}

function debounce(fn, ms) {
  let t;
  const run = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  run.cancel = () => clearTimeout(t);
  return run;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---- state ---------------------------------------------------------------

let uid = 0;
const newId = (prefix = 'opt') => `${prefix}${++uid}`;

function nextSlot(list) {
  const used = new Set(list.map((o) => o.slot));
  let slot = 1;
  while (used.has(slot) && slot <= LIMITS.choice.max) slot += 1;
  return slot;
}

const toChoice = (list) =>
  list.slice(0, LIMITS.choice.max).map((o, i) => ({ id: newId(), name: String(o.name ?? ''), desc: String(o.desc ?? ''), slot: i + 1 }));
const toScore = (list) => list.slice(0, LIMITS.score.max).map((l) => ({ id: newId(), text: String(l.text ?? '') }));
// `custom`: the row shows the 自定义模型名称 text box instead of the menu.
const toModels = (ids) => ids.map((model) => ({ id: newId('model'), model, custom: false }));

// Blank option rows, as on a first visit: two choices, three score levels.
const blankChoice = () => toChoice(PLACEHOLDER_EXAMPLE.choice.map(() => ({})));
const blankScore = () => toScore([{}, {}, {}]);

// The shared question as saved by either page; the models are this page's own.
function loadState() {
  const str = (v, d) => (typeof v === 'string' ? v : d);
  const saved = readJson(FORM_STORE);
  const s = saved && typeof saved === 'object' ? saved : {};
  const models = toModels(restoreModels(readJson(MODELS_STORE)?.models));
  try {
    return {
      baseUrl: str(s.baseUrl, DEFAULT_BASE_URL),
      type: TYPES.includes(s.type) ? s.type : PLACEHOLDER_EXAMPLE.type,
      question: str(s.question, ''),
      context: str(s.context, ''),
      noul: { trueText: str(s.noul?.trueText, ''), falseText: str(s.noul?.falseText, '') },
      choice: Array.isArray(s.choice) && s.choice.length ? toChoice(s.choice) : blankChoice(),
      score: Array.isArray(s.score) && s.score.length ? toScore(s.score) : blankScore(),
      models,
    };
  } catch {
    // An unreadable save: start from an empty question.
    return {
      baseUrl: DEFAULT_BASE_URL,
      type: PLACEHOLDER_EXAMPLE.type,
      question: '',
      context: '',
      noul: { trueText: '', falseText: '' },
      choice: blankChoice(),
      score: blankScore(),
      models,
    };
  }
}

const state = loadState();

// The question as the single-model page saves it, to write back and to compare with.
const sharedForm = () => ({
  baseUrl: state.baseUrl,
  type: state.type,
  question: state.question,
  context: state.context,
  noul: state.noul,
  choice: state.choice.map(({ name, desc }) => ({ name, desc })),
  score: state.score.map(({ text }) => ({ text })),
});

const saveState = debounce(() => {
  const saved = readJson(FORM_STORE);
  const other = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  storage.set(FORM_STORE, JSON.stringify({ ...other, ...sharedForm() }));
  storage.set(MODELS_STORE, JSON.stringify({ models: state.models.map((m) => m.model) }));
}, 250);

// ---- elements ------------------------------------------------------------

const form = $('versus-form');
const baseUrlInput = $('base-url');
const endpointPreview = $('endpoint-preview');
const keyInput = $('api-key');
const toggleKeyBtn = $('toggle-key');
const rememberKey = $('remember-key');
const modelList = $('model-list');
const addModelBtn = $('add-model');
const modelsNote = $('models-note');
const modelsCount = $('models-count');
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
const meta = $('vs-meta');
const raw = $('raw');

const viz = createVersusViz($('vs-viz'), $('tooltip'));

let busy = false;
let lastSent = null; // { snapshot, status } of the round of calls on screen
let shownQuestion = null; // question of the round in flight or on screen; null = echo the form
let pendingRefresh = false; // options or type changed while calls were in flight

initThemeToggle($('theme-toggle'), $('theme-label'));

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
  // The OpenRouter model list belongs in the menus only while the address is OpenRouter's.
  loadCatalog();
  renderModels();
  markStale();
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

// ---- model list (shared with the single-model page) ----------------------------

// OpenRouter publishes its decision models (no key needed). The list read last is kept
// in the browser, under the same key as the single-model page's, so both menus agree.
const CATALOG_PATH = '/api/v1/models?output_modalities=decisions';
let catalog = null; // parseCatalog() entries, or null
let catalogOrigin = null; // the OpenRouter address `catalog` came from
let catalogStatus = 'idle'; // idle | loading | ready | failed
let catalogTried = null; // address of the last attempt, so a failure is not retried on every keystroke

function openRouterOrigin() {
  const r = resolveEndpoint(state.baseUrl);
  if (!r.ok) return null;
  const url = new URL(r.url);
  return /(^|\.)openrouter\.ai$/i.test(url.hostname) ? url.origin : null;
}

// The list for the menus: only while the Base URL is the address it came from.
function listedCatalog() {
  const origin = openRouterOrigin();
  return origin && origin === catalogOrigin ? catalog : null;
}

// Cached in the API's own shape, so reading it back goes through parseCatalog too.
function cacheCatalog(origin, list) {
  const data = list.map((m) => ({
    id: m.id,
    canonical_slug: m.slug,
    name: m.name,
    context_length: m.context,
    pricing: { prompt: m.price == null ? null : String(m.price) },
    architecture: { input_modalities: m.images ? ['text', 'image'] : ['text'], output_modalities: ['decisions'] },
  }));
  storage.set(CATALOG_STORE, JSON.stringify({ origin, data }));
}

function readCachedCatalog() {
  try {
    const saved = JSON.parse(storage.get(CATALOG_STORE) ?? 'null');
    const list = parseCatalog(saved);
    if (typeof saved?.origin === 'string' && list.length) {
      catalog = list;
      catalogOrigin = saved.origin;
    }
  } catch {
    // Unreadable cache: the fresh list replaces it.
  }
}

// `retry` re-reads after a failure; otherwise a failed address waits for 重试.
async function loadCatalog(retry = false) {
  const origin = openRouterOrigin();
  if (!origin || catalogStatus === 'loading') return;
  if (catalogStatus === 'ready' && catalogOrigin === origin) return;
  if (catalogStatus === 'failed' && catalogTried === origin && !retry) return;
  catalogStatus = 'loading';
  catalogTried = origin;
  renderModels();
  try {
    const res = await fetch(`${origin}${CATALOG_PATH}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = parseCatalog(await res.json());
    if (!list.length) throw new Error('empty list');
    catalog = list;
    catalogOrigin = origin;
    catalogStatus = 'ready';
    cacheCatalog(origin, list);
  } catch {
    catalogStatus = 'failed';
  }
  renderModels();
  // Names in the 0% preview come from the list; answers or errors on screen stay.
  if (!busy && resultStatus.dataset.state === 'idle') refreshPreview();
}

// ---- model rows ------------------------------------------------------------

const rowEls = new Map(); // model row id → its elements
let shownMenu = null; // the menu in the selects, so they are refilled only when it changes

function modelRow() {
  const li = el('li', 'vs-model-row');
  const num = el('span', 'level-num');
  num.setAttribute('aria-hidden', 'true');
  const pick = el('div', 'vs-model-pick');
  const select = el('select');
  const custom = el('input', 'vs-model-custom');
  custom.type = 'text';
  custom.autocomplete = 'off';
  custom.spellcheck = false;
  custom.placeholder = '例如 typesafe/jev-1.13:nitro';
  const info = el('p', 'hint vs-model-info');
  pick.append(select, custom, info);
  const remove = el('button', 'mini-btn remove-btn', '×');
  remove.type = 'button';
  li.append(num, pick, remove);
  return { li, num, select, custom, info, remove };
}

function fillMenu(select, groups, loading) {
  const note = new Option('正在读取 OpenRouter 上的全部决策模型…', '');
  note.disabled = true;
  select.replaceChildren(
    ...groups.map((g) => {
      const group = document.createElement('optgroup');
      group.label = g.label;
      group.append(...g.options.map((o) => new Option(o.label, o.id)));
      return group;
    }),
    ...(loading ? [note] : []),
    new Option('自定义模型名称…', CUSTOM_MODEL),
  );
}

// One line under each row about its model: name, context, price, its page.
function renderModelInfo(m, r) {
  const entry = findModel(m.model, catalog);
  r.info.replaceChildren();
  if (entry) {
    const facts = [entry.name, entry.context ? `上下文 ${entry.context.toLocaleString('en-US')} token` : '', formatModelPrice(entry.price)];
    r.info.append(facts.filter(Boolean).join(' · '));
    const href = modelPageUrl(entry.id);
    if (href) {
      const link = el('a', null, '模型页');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      r.info.append(' · ', link);
    }
  } else if (m.custom && m.model && listedCatalog()) {
    r.info.append('OpenRouter 的决策模型列表里没有这个名称，请检查拼写。');
  }
  r.info.hidden = !r.info.firstChild;
}

// Rows are updated in place, so a name being typed keeps its focus when the list
// arrives or another row is added.
function renderModels() {
  const groups = modelGroups(listedCatalog());
  const listed = new Set(groups.flatMap((g) => g.options.map((o) => o.id)));
  const loading = catalogStatus === 'loading' && !listedCatalog();
  const menu = JSON.stringify([groups, loading]);
  const menuChanged = menu !== shownMenu;
  shownMenu = menu;
  for (const [id, r] of rowEls) {
    if (state.models.some((m) => m.id === id)) continue;
    r.li.remove();
    rowEls.delete(id);
  }
  const n = state.models.length;
  state.models.forEach((m, i) => {
    let r = rowEls.get(m.id);
    if (!r) {
      r = modelRow();
      r.li.dataset.id = m.id;
      rowEls.set(m.id, r);
      fillMenu(r.select, groups, loading);
    } else if (menuChanged) {
      fillMenu(r.select, groups, loading);
    }
    if (modelList.children[i] !== r.li) modelList.insertBefore(r.li, modelList.children[i] ?? null);
    // A name being typed stays in the text box, even when it turns out to be listed.
    if (m.custom && listed.has(m.model) && document.activeElement !== r.custom) m.custom = false;
    if (!listed.has(m.model)) m.custom = true;
    r.num.textContent = String(i + 1);
    r.select.value = m.custom ? CUSTOM_MODEL : m.model;
    r.select.setAttribute('aria-label', `第 ${i + 1} 个模型`);
    r.custom.hidden = !m.custom;
    r.custom.setAttribute('aria-label', `第 ${i + 1} 个模型的名称`);
    if (m.custom && document.activeElement !== r.custom && r.custom.value.trim() !== m.model) r.custom.value = m.model;
    r.remove.disabled = n <= MIN_MODELS;
    r.remove.setAttribute('aria-label', `删除第 ${i + 1} 个模型`);
    r.remove.title = n <= MIN_MODELS ? `至少要对比 ${MIN_MODELS} 个模型` : '删除这个模型';
    renderModelInfo(m, r);
  });
  addModelBtn.disabled = n >= MAX_MODELS;
  addModelBtn.textContent = n >= MAX_MODELS ? `最多 ${MAX_MODELS} 个模型` : '＋ 添加模型';
  modelsCount.textContent = `${n} / ${MAX_MODELS}`;
  renderModelsNote();
}

function renderModelsNote() {
  modelsNote.replaceChildren();
  if (openRouterOrigin() && !listedCatalog()) {
    if (catalogStatus === 'loading') {
      modelsNote.append('正在读取 OpenRouter 的模型列表…');
    } else if (catalogStatus === 'failed') {
      const retry = el('button', 'link-btn', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        rowEls.get(state.models[0]?.id)?.select.focus(); // the button goes away with this line
        loadCatalog(true);
      });
      modelsNote.append('没能读取 OpenRouter 的模型列表，下拉框里只有常用模型。', retry);
    }
  }
  modelsNote.hidden = !modelsNote.firstChild;
}

const rowModel = (node) => state.models.find((m) => m.id === node.closest('li')?.dataset.id);

modelList.addEventListener('change', (e) => {
  const select = e.target.closest('select');
  const m = select && rowModel(select);
  if (!m) return;
  const r = rowEls.get(m.id);
  select.removeAttribute('aria-invalid');
  if (select.value === CUSTOM_MODEL) {
    // Start from the model that was chosen, e.g. to add a variant such as :nitro.
    m.custom = true;
    r.custom.value = m.model;
    r.custom.hidden = false;
    r.custom.focus();
  } else {
    m.custom = false;
    m.model = select.value;
  }
  onModelsEdited();
});

modelList.addEventListener('input', (e) => {
  const input = e.target.closest('input');
  const m = input && rowModel(input);
  if (!m) return;
  input.removeAttribute('aria-invalid');
  m.model = input.value.trim();
  onModelsEdited();
});

modelList.addEventListener('click', (e) => {
  const btn = e.target.closest('button.remove-btn');
  const m = btn && !btn.disabled && rowModel(btn);
  if (!m) return;
  const i = state.models.indexOf(m);
  state.models.splice(i, 1);
  onModelsEdited();
  // Keep keyboard focus nearby after the row goes.
  const next = state.models[Math.min(i, state.models.length - 1)];
  const r = next && rowEls.get(next.id);
  (r ? (r.custom.hidden ? r.select : r.custom) : addModelBtn).focus();
});

addModelBtn.addEventListener('click', () => {
  if (state.models.length >= MAX_MODELS) return;
  const menu = modelGroups(listedCatalog()).flatMap((g) => g.options.map((o) => o.id));
  const model = nextModel(state.models.map((m) => m.model), menu);
  state.models.push({ id: newId('model'), model, custom: false });
  onModelsEdited();
  rowEls.get(state.models.at(-1).id)?.select.focus();
});

// The models changed: the preview shows the new rows; answers on screen are marked stale.
function onModelsEdited() {
  hideFormErrors();
  renderModels();
  if (!busy) {
    if (lastSent) markStale();
    else refreshPreview();
  }
  saveState();
}

// ---- question fields -----------------------------------------------------

// Echoes the question above the result; an empty form echoes the grey placeholder.
function renderQuestionEcho() {
  const q = (shownQuestion ?? state.question).trim();
  resultQuestion.textContent = `问：${q || PLACEHOLDER_EXAMPLE.question}`;
  resultQuestion.classList.toggle('is-hint', !q);
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

// The example chips, then the clear button and its undo notice. The notice sits
// right before the question input, so Shift+Tab from there reaches 撤销.
const clearBtn = el('button', 'chip chip-clear', '清空');
clearBtn.type = 'button';
clearBtn.title = '清空问题、背景内容和所有选项';
clearBtn.setAttribute('aria-label', '清空问题、背景内容和所有选项');
clearBtn.addEventListener('click', () => clearInputs());
const clearNotice = el('span', 'inline-notice');
clearNotice.setAttribute('role', 'status');

function renderExamples() {
  $('examples').replaceChildren(
    ...EXAMPLES.map((ex) => {
      const btn = el('button', 'chip', ex.title);
      btn.type = 'button';
      btn.addEventListener('click', () => loadExample(ex));
      return btn;
    }),
    clearBtn,
    clearNotice,
  );
}

let undoTimer = null;

function dismissUndo() {
  clearTimeout(undoTimer);
  if (!clearNotice.firstChild) return;
  const hadFocus = clearNotice.contains(document.activeElement);
  clearNotice.replaceChildren();
  if (hadFocus) clearBtn.focus();
}

// Empties the question, background and the options of every question type, back to
// blank rows as on a first visit. Connection settings, the models and the chosen type
// stay. 撤销 is offered until the next edit or 8 seconds.
function clearInputs() {
  const blank = { question: '', context: '', noul: { trueText: '', falseText: '' }, choice: blankChoice(), score: blankScore() };
  const content = (s) =>
    JSON.stringify([s.question, s.context, s.noul, s.choice.map((o) => [o.name, o.desc]), s.score.map((l) => l.text)]);
  // Already blank (e.g. a double click): keep any pending undo of the real content.
  if (content(state) === content(blank)) {
    questionInput.focus();
    return;
  }
  const before = {
    question: state.question,
    context: state.context,
    noul: { ...state.noul },
    choice: state.choice.map((o) => ({ ...o })),
    score: state.score.map((l) => ({ ...l })),
  };
  Object.assign(state, blank);
  renderAll();
  saveState();
  questionInput.focus();

  const undo = el('button', 'link-btn', '撤销');
  undo.type = 'button';
  undo.addEventListener('click', () => {
    Object.assign(state, before);
    renderAll();
    saveState();
    dismissUndo();
    questionInput.focus();
  });
  clearNotice.replaceChildren('已清空', undo);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(dismissUndo, 8000);
}

// Any edit after clearing retires the undo, so it can never overwrite new input.
form.addEventListener('input', dismissUndo);

function loadExample(ex) {
  dismissUndo();
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
      const hint = choiceHint(i);
      name.placeholder = hint.name;
      name.setAttribute('aria-label', `选项 ${i + 1} 名称`);
      const desc = el('input', 'opt-desc');
      desc.type = 'text';
      desc.autocomplete = 'off';
      desc.value = opt.desc;
      desc.dataset.field = 'desc';
      desc.placeholder = hint.desc || '说明（选填）：什么情况选它';
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
      text.placeholder = scoreHint(i, n);
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
  // During a call, record the edit right away: a debounced refresh landing just
  // after the answers would otherwise wipe them instead of marking them stale.
  if (busy) pendingRefresh = true;
  else refreshPreviewSoon();
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
  partial: '部分模型出错',
  error: '出错了',
  stale: '内容已修改，可重新调用',
};

function setStatus(name) {
  resultStatus.dataset.state = name;
  resultStatus.textContent = STATUS[name];
}

function resetResultExtras() {
  resultCard.classList.remove('is-stale');
  meta.hidden = true;
  raw.hidden = true;
}

// The models as the preview names them; a blank row says so.
function previewModels() {
  const ids = state.models.map((m) => m.model);
  const names = modelNames(ids, catalog);
  return ids.map((id, i) => ({ id, name: names[i] || `第 ${i + 1} 个模型（未填写）` }));
}

// Options, type or models changed: show them at 0%. While calls are in flight the
// charts belong to them, so the refresh waits until they finish.
function refreshPreview() {
  if (busy) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  viz.build(state.type, displayItems(state.type, state), previewModels());
  lastSent = null;
  shownQuestion = null;
  renderQuestionEcho();
  resetResultExtras();
  setStatus('idle');
}

// The requests the form would send now, to compare with the round on screen.
const requestsFromForm = () => buildVersusRequests(state, state.models.map((m) => m.model));
const snapshotOf = (built) => JSON.stringify([built.bodies, built.items]);

function markStale() {
  if (busy || !lastSent) return;
  const built = requestsFromForm();
  const same = built.ok && snapshotOf(built) === lastSent.snapshot;
  resultCard.classList.toggle('is-stale', !same);
  setStatus(same ? lastSent.status : 'stale');
}

// On narrow layouts the result sits below the form: bring its top into view.
function revealResult() {
  const top = resultCard.getBoundingClientRect().top;
  if (top >= 0 && top < window.innerHeight * 0.5) return;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  window.scrollBy({ top: top - 12, behavior });
}

const STATE_SOURCE = { question: '问题本身（背景内容为空）', text: '背景内容（文本）', json: '背景内容（JSON）' };

// Speed, cost and the ids of every call, one column per model.
function showMeta(outcomes, names, stateSource) {
  const table = $('meta-table');
  const headRow = el('tr');
  const corner = el('th', null, '');
  corner.scope = 'col';
  headRow.append(corner);
  for (const name of names) {
    const th = el('th', null, name);
    th.scope = 'col';
    headRow.append(th);
  }
  const rows = [
    ['结果', (o) => (o.result ? '成功' : o.error.title)],
    ['耗时', (o) => (o.ms == null ? '—' : `${o.ms} ms`)],
    ['费用', (o) => formatUsd(o.json?.usage?.cost)],
    ['输入 tokens', (o) => o.json?.usage?.input_tokens ?? '—'],
    ['输出 tokens（免费）', (o) => o.json?.usage?.output_tokens ?? '—'],
    ['服务商', (o) => o.json?.provider ?? '—'],
    ['返回的模型', (o) => o.json?.model ?? '—', 'mono'],
    ['生成 ID', (o) => o.json?.id ?? '—', 'mono'],
  ];
  const body = el('tbody');
  for (const [label, get, cls] of rows) {
    const tr = el('tr');
    const th = el('th', null, label);
    th.scope = 'row';
    tr.append(th);
    for (const o of outcomes) {
      const text = String(get(o));
      tr.append(el('td', label === '结果' && !o.result ? 'is-error' : text === '—' ? null : cls, text));
    }
    body.append(tr);
  }
  const head = el('thead');
  head.append(headRow);
  table.replaceChildren(head, body);
  // Sets the table's minimum width (versus.css): two models fit a phone, more scroll sideways.
  table.style.setProperty('--vs-cols', String(names.length));
  const costs = outcomes.map((o) => o.json?.usage?.cost).filter((c) => c != null && Number.isFinite(Number(c)));
  const total = costs.reduce((sum, c) => sum + Number(c), 0);
  $('meta-note').textContent = [costs.length ? `合计费用 ${formatUsd(total)}` : '', `判断材料：${STATE_SOURCE[stateSource] ?? '—'}`]
    .filter(Boolean)
    .join(' · ');
  meta.hidden = false;
  syncMetaScroll();
}

// A table wider than the card scrolls sideways: then it can be scrolled from the
// keyboard too, and a line under it says so.
const metaScroll = $('meta-scroll');
function syncMetaScroll() {
  const overflow = !meta.hidden && metaScroll.scrollWidth - metaScroll.clientWidth > 1;
  if (overflow) {
    metaScroll.tabIndex = 0;
    metaScroll.setAttribute('role', 'region');
    metaScroll.setAttribute('aria-label', '调用详情表');
  } else {
    metaScroll.removeAttribute('tabindex');
    metaScroll.removeAttribute('role');
    metaScroll.removeAttribute('aria-label');
  }
  $('meta-scroll-hint').hidden = !overflow;
}
if ('ResizeObserver' in window) new ResizeObserver(syncMetaScroll).observe(metaScroll);
else window.addEventListener('resize', syncMetaScroll);

async function copyText(text, btn) {
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
}

function rawBlock(title, name, text) {
  const block = el('div', 'raw-block');
  const head = el('div', 'raw-head');
  const copy = el('button', 'copy-btn', '复制');
  copy.type = 'button';
  copy.setAttribute('aria-label', `复制${title}（${name}）`);
  const pre = el('pre', null, text);
  copy.addEventListener('click', () => copyText(pre.textContent, copy));
  head.append(el('span', null, title), copy);
  block.append(head, pre);
  return block;
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// The request, an equivalent curl command and the response of every call.
function showRaw(outcomes, names, endpoint) {
  $('raw-models').replaceChildren(
    ...outcomes.map((o, i) => {
      const box = el('details', 'vs-raw-model');
      box.open = i === 0;
      box.append(
        el('summary', null, names[i]),
        rawBlock('请求 JSON', names[i], JSON.stringify(o.body, null, 2)),
        rawBlock('等价的 curl 命令', names[i], buildCurl(endpoint, o.body)),
        rawBlock('响应 JSON', names[i], prettyJson(o.text) || '（没有响应内容）'),
      );
      return box;
    }),
  );
  raw.hidden = false;
}

// ---- validation display --------------------------------------------------

// The input a model row shows: its text box in custom mode, else its menu.
const rowInput = (m) => {
  const r = rowEls.get(m.id);
  return r && (r.custom.hidden ? r.select : r.custom);
};

const FIELD_INPUT = {
  baseUrl: () => baseUrlInput,
  apiKey: () => keyInput,
  // Marks the rows the error names (blank, repeated); a count problem points at 添加模型.
  models: (err) => {
    const flagged = (err.rows ?? []).map((i) => state.models[i] && rowInput(state.models[i])).filter(Boolean);
    for (const input of flagged) input.setAttribute('aria-invalid', 'true');
    return flagged[0] ?? addModelBtn;
  },
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

// Rows are flagged as a group (e.g. both duplicates), so they are cleared as a group too.
function hideFormErrors() {
  formErrors.hidden = true;
  formErrors.replaceChildren();
  for (const input of document.querySelectorAll('.option-list input[aria-invalid], .vs-model-list [aria-invalid]')) {
    input.removeAttribute('aria-invalid');
  }
}

// True when a field the errors mention is blank and showing grey example text,
// which is easy to mistake for a filled-in value.
function blankFieldShowsHint(errors) {
  const blank = (v) => !String(v ?? '').trim();
  return errors.some(
    (err) =>
      (err.field === 'question' && blank(state.question)) ||
      (err.field === 'options' && state.type === 'choice' && state.choice.some((o) => blank(o.name))) ||
      (err.field === 'options' && state.type === 'score' && state.score.some((l) => blank(l.text))),
  );
}

function showFormErrors(errors) {
  const list = el('ul');
  for (const err of errors) list.append(el('li', null, err.message));
  formErrors.replaceChildren(list);
  if (blankFieldShowsHint(errors)) {
    formErrors.append(
      el('p', 'form-errors-note', '输入框里的灰色文字只是示例，需要自己填写；想直接试用，可以点上面「试试示例」里的按钮。'),
    );
  }
  formErrors.hidden = false;
  let first = null;
  for (const err of errors) {
    const input = FIELD_INPUT[err.field]?.(err);
    if (!input) continue;
    if (err.field !== 'options' && err.field !== 'models') input.setAttribute('aria-invalid', 'true');
    first ??= input;
  }
  first?.focus();
}

// ---- the calls -----------------------------------------------------------

function setBusy(on) {
  busy = on;
  submitBtn.setAttribute('aria-busy', String(on));
  submitText.textContent = on ? '调用中…' : '发起对比';
  if (on) setStatus('busy');
}

const UNREADABLE = {
  title: '无法识别返回内容',
  hint: '服务返回了成功状态，但内容不是预期的决策结果格式。请检查 Base URL 是否指向 Decisions 接口。',
};

// One model's call, never throwing: { body, ms, status, text, json, result | error }.
async function callModel(endpoint, key, body, type, items) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  let response;
  let text = '';
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    text = await response.text();
  } catch (err) {
    const error =
      err?.name === 'AbortError'
        ? { title: '请求超时', hint: `${REQUEST_TIMEOUT_MS / 1000} 秒内没有收到回应，请稍后再试。`, detail: '' }
        : {
            title: '无法连接到这个地址',
            hint: '可能是网络问题、Base URL 填写有误，或者该服务不允许浏览器直接调用（CORS）。',
            detail: err?.message ?? '',
          };
    return { body, ms: null, text: '', error };
  } finally {
    clearTimeout(timer);
  }
  const outcome = { body, ms: Math.round(performance.now() - t0), status: response.status, text };
  if (!response.ok) return { ...outcome, error: parseError(response.status, text) };
  try {
    outcome.json = JSON.parse(text);
  } catch {
    return { ...outcome, error: { ...UNREADABLE, detail: '返回的内容不是有效的 JSON' } };
  }
  try {
    return { ...outcome, result: readAnswer(type, outcome.json, items) };
  } catch (err) {
    const error = isAnswerRefusedError(err)
      ? { ...REFUSAL_TEXT, detail: err.message }
      : { ...UNREADABLE, detail: isAnswerShapeError(err) ? err.message : String(err?.message ?? '') };
    return { ...outcome, error };
  }
}

async function submit() {
  if (busy) return;
  hideFormErrors();

  const endpoint = resolveEndpoint(state.baseUrl);
  const key = normalizeKey(keyInput.value);
  const built = requestsFromForm();
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
  const ids = built.bodies.map((b) => b.model);
  const names = modelNames(ids, catalog);
  const models = ids.map((id, i) => ({ id, name: names[i] }));
  const snapshot = snapshotOf(built);
  // The requests already include every edit, so a preview refresh still waiting on
  // its debounce must not fire later and wipe these answers.
  refreshPreviewSoon.cancel();
  resetResultExtras();
  lastSent = null;
  pendingRefresh = false;
  shownQuestion = state.question.trim();
  renderQuestionEcho();
  setBusy(true);
  // Same options and models as on screen: shrink the old answers; otherwise start over.
  if (signatureOf(type, items, models) !== viz.signature()) viz.build(type, items, models);
  const drained = viz.drain();
  revealResult();

  // All calls go out at once; each row grows in as soon as its own answer arrives.
  let arrived = 0;
  const outcomes = await Promise.all(
    built.bodies.map(async (body, i) => {
      const outcome = await callModel(endpoint.url, key, body, type, items);
      await drained;
      arrived += 1;
      if (outcome.result) viz.play(i, outcome.result);
      else viz.fail(i, outcome.error);
      viz.progress(arrived, built.bodies.length);
      return outcome;
    }),
  );
  setBusy(false);

  const answered = outcomes.filter((o) => o.result).length;
  const status = answered === outcomes.length ? 'done' : answered ? 'partial' : 'error';
  if (!answered) {
    // Nothing to keep on screen: echo the form again and, if the options were edited
    // meanwhile, show those at 0%. The summary still says what went wrong.
    shownQuestion = null;
    renderQuestionEcho();
    if (pendingRefresh) viz.build(state.type, displayItems(state.type, state), previewModels());
  }
  // Edits made during the calls show up as a stale marker on these answers.
  pendingRefresh = false;
  viz.summarize(summarizeComparison(type, outcomes.map((o, i) => ({ name: names[i], result: o.result, error: o.error }))));
  showMeta(outcomes, names, built.stateSource);
  showRaw(outcomes, names, endpoint.url);
  lastSent = answered ? { snapshot, status } : null;
  setStatus(status);
  markStale();
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

// ---- clear cache ----------------------------------------------------------

// Forgets everything the site saved in this browser (both pages' forms, the models
// compared here, the remembered key, the theme) and reloads, as on a first visit.
function clearCache() {
  const ok = window.confirm(
    '确定要清除缓存吗？\n\n这会删除本站保存在浏览器里的所有内容：两个页面共用的问题和选项、Base URL、要对比的模型、主题设置，以及记住的 API Key。清除后页面会刷新，和第一次打开时一样。',
  );
  if (!ok) return;
  // A save still waiting on its debounce would write the data straight back.
  saveState.cancel();
  saveKey.cancel();
  storage.removeAll(STORE_PREFIX);
  history.replaceState(null, '', `${location.pathname}${location.search}${CACHE_CLEARED_HASH}`);
  location.reload();
}

$('clear-cache').addEventListener('click', clearCache);

// ---- boot ----------------------------------------------------------------

function renderAll() {
  baseUrlInput.value = state.baseUrl;
  renderEndpoint();
  renderModels();
  for (const radio of form.elements.type) radio.checked = radio.value === state.type;
  questionInput.placeholder = PLACEHOLDER_EXAMPLE.question;
  questionInput.value = state.question;
  contextInput.value = state.context;
  renderQuestionEcho();
  renderOptions();
  hideFormErrors();
  refreshPreview();
}

// Back from the single-model page with the browser's back button: this page comes back
// as it was left, so pick up a question edited there in the meantime.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || busy) return;
  const fresh = loadState();
  const shared = (s) => JSON.stringify([s.baseUrl, s.type, s.question, s.context, s.noul, s.choice.map((o) => [o.name, o.desc]), s.score.map((l) => l.text)]);
  if (shared(fresh) === shared(state)) return;
  Object.assign(state, { ...fresh, models: state.models });
  renderAll();
});

// Set both explicitly: some browsers restore typed values and checkboxes on reload,
// which would bring a key (or the remember box) back after clearing the cache.
const savedKey = storage.get(KEY_STORE);
keyInput.value = savedKey ?? '';
rememberKey.checked = Boolean(savedKey);
readCachedCatalog();
renderExamples();
renderAll();
loadCatalog();

if (location.hash === CACHE_CLEARED_HASH) {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const notice = $('cache-notice');
  notice.textContent = '✓ 缓存已清除';
  setTimeout(() => (notice.textContent = ''), 6000);
}
