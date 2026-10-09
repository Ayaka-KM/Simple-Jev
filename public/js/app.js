// Page wiring: form state, option editors, the API call and result display.

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  EXAMPLES,
  IMAGE_DETAILS,
  LIMITS,
  MODELS,
  PLACEHOLDER_EXAMPLE,
  REFUSAL_TEXT,
  TYPES,
  buildCurl,
  buildRequest,
  choiceHint,
  dataUrlBytes,
  displayItems,
  formatUsd,
  imageSupport,
  isAnswerRefusedError,
  isAnswerShapeError,
  migrateLegacyForm,
  modelShortName,
  normalizeKey,
  parseError,
  readAnswer,
  redactImages,
  resolveEndpoint,
  scoreHint,
  validateKey,
} from './core.js';
import { initThemeToggle } from './theme-toggle.js';
import { createViz, signatureOf } from './viz.js';

// Every key this page stores starts with STORE_PREFIX (the theme key too: see theme-toggle.js).
const STORE_PREFIX = 'simple-jev:';
const FORM_STORE = 'simple-jev:form:v2';
const LEGACY_FORM_STORE = 'simple-jev:form';
const KEY_STORE = 'simple-jev:key';
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
const newId = () => `opt${++uid}`;

function nextSlot(list) {
  const used = new Set(list.map((o) => o.slot));
  let slot = 1;
  while (used.has(slot) && slot <= LIMITS.choice.max) slot += 1;
  return slot;
}

const toChoice = (list) =>
  list.slice(0, LIMITS.choice.max).map((o, i) => ({ id: newId(), name: String(o.name ?? ''), desc: String(o.desc ?? ''), slot: i + 1 }));
const toScore = (list) => list.slice(0, LIMITS.score.max).map((l) => ({ id: newId(), text: String(l.text ?? '') }));

// Blank option rows, as on a first visit: two choices, three score levels.
const blankChoice = () => toChoice(PLACEHOLDER_EXAMPLE.choice.map(() => ({})));
const blankScore = () => toScore([{}, {}, {}]);

// An empty form: the example question and options appear only as grey
// placeholders, so typing replaces them rather than editing them.
function initialState() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    type: PLACEHOLDER_EXAMPLE.type,
    question: '',
    context: '',
    noul: { trueText: '', falseText: '' },
    choice: blankChoice(),
    score: blankScore(),
    // Images stay in memory only: never saved to the browser.
    images: [],
    imageDetail: 'auto',
  };
}

// The saved form, moving a first-version save (which stored the placeholder
// example as real values) to the current key on the way.
function readSavedForm() {
  const raw = storage.get(FORM_STORE);
  if (raw) return JSON.parse(raw);
  const legacy = storage.get(LEGACY_FORM_STORE);
  if (!legacy) return null;
  let migrated = null;
  try {
    migrated = migrateLegacyForm(JSON.parse(legacy));
  } catch {
    // Unreadable old save: drop it.
  }
  if (migrated) storage.set(FORM_STORE, JSON.stringify(migrated));
  storage.remove(LEGACY_FORM_STORE);
  return migrated;
}

function loadState() {
  const base = initialState();
  try {
    const s = readSavedForm();
    if (!s || typeof s !== 'object') return base;
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
      images: [],
      imageDetail: IMAGE_DETAILS.includes(s.imageDetail) ? s.imageDetail : 'auto',
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
      imageDetail: state.imageDetail,
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
const imageField = $('image-field');
const imageList = $('image-list');
const imageAdd = $('image-add');
const imageInput = $('image-input');
const imageHint = $('image-hint');
const imageCount = $('image-count');
const imageDetailRow = $('image-detail-row');
const imageDetail = $('image-detail');
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
  onModelChanged();
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
  onModelChanged();
  markStale();
  saveState();
});

modelCustom.addEventListener('input', () => {
  modelCustom.removeAttribute('aria-invalid');
  state.model = currentModel();
  onModelChanged();
  markStale();
  saveState();
});

// Whether images can be sent depends on the model; names we don't know are looked up.
function onModelChanged() {
  if (currentModel() && !MODELS.some((m) => m.id === currentModel())) loadCatalog();
  renderImageField();
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
  const box = $('examples');
  box.replaceChildren(
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

// Empties the question, background and the options of every question type, back
// to blank rows as on a first visit. Connection settings (Base URL, key, model)
// and the chosen type stay. 撤销 is offered until the next edit or 8 seconds.
function clearInputs() {
  const blank = {
    question: '',
    context: '',
    noul: { trueText: '', falseText: '' },
    choice: blankChoice(),
    score: blankScore(),
    images: [],
  };
  const content = (s) =>
    JSON.stringify([
      s.question,
      s.context,
      s.noul,
      s.choice.map((o) => [o.name, o.desc]),
      s.score.map((l) => l.text),
      s.images.map((img) => img.id),
    ]);
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
    images: state.images.slice(),
  };
  imageMessage = '';
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
  // Examples are text only; images belong to the question they were added for.
  state.images = [];
  imageMessage = '';
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

// ---- images ----------------------------------------------------------------

// OpenRouter's model list, fetched once, to tell whether a custom model name takes images.
let catalog = null;
let catalogStatus = 'idle'; // idle | loading | ready | failed

function openRouterOrigin() {
  const r = resolveEndpoint(state.baseUrl);
  if (!r.ok) return null;
  const url = new URL(r.url);
  return /(^|\.)openrouter\.ai$/i.test(url.hostname) ? url.origin : null;
}

async function loadCatalog() {
  const origin = openRouterOrigin();
  if (catalogStatus !== 'idle' || !origin) return;
  catalogStatus = 'loading';
  renderImageField();
  try {
    const res = await fetch(`${origin}/api/v1/models?output_modalities=decisions`, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json())?.data;
    catalog = Array.isArray(list) ? list : [];
    catalogStatus = 'ready';
  } catch {
    catalogStatus = 'failed';
  }
  renderImageField();
}

// { supported: true | false | null (unknown), max, checking }
function currentImageSupport() {
  const support = imageSupport(currentModel(), catalog);
  if (support.source === 'unknown' && catalogStatus === 'loading' && openRouterOrigin()) return { ...support, checking: true };
  return support;
}

let imageUid = 0;
let imageMessage = ''; // problems from the last add, shown under the field until the next change
const MAX_SIDE = 1024; // longest side sent; about 770 tokens per image with GPT-6 Luna
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const KEEP_ORIGINAL_BYTES = 400 * 1024;
const SENDABLE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const formatKB = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Small PNG/JPEG/WebP files are sent as they are; anything larger or in another format
// (HEIC, GIF, BMP… whatever the browser can decode) becomes a JPEG at most MAX_SIDE wide.
async function prepareImage(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 20 MB');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取这张图片，请换成 PNG、JPEG 或 WebP');
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  let dataUrl;
  let w = width;
  let h = height;
  if (scale === 1 && SENDABLE_TYPES.includes(file.type) && file.size <= KEEP_ORIGINAL_BYTES) {
    dataUrl = await readAsDataUrl(file);
  } else {
    w = Math.max(1, Math.round(width * scale));
    h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  }
  bitmap.close?.();
  return { id: `img${++imageUid}`, name: file.name || '粘贴的图片', dataUrl, width: w, height: h, bytes: dataUrlBytes(dataUrl) };
}

async function addImages(fileList) {
  const files = [...(fileList ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const support = currentImageSupport();
  if (support.supported === false) {
    imageMessage = `${currentModel()} 只支持文字，不能添加图片。`;
    renderImageField();
    return;
  }
  const room = support.max - state.images.length;
  const problems = [];
  if (files.length > room) problems.push(`每次最多 ${support.max} 张，多出的 ${files.length - Math.max(0, room)} 张没有添加`);
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      state.images.push(await prepareImage(file));
    } catch (err) {
      problems.push(`${file.name || '图片'}：${err.message}`);
    }
  }
  imageMessage = problems.join('；');
  onImagesEdited();
}

function removeImage(id) {
  const i = state.images.findIndex((img) => img.id === id);
  if (i < 0) return;
  state.images.splice(i, 1);
  imageMessage = '';
  onImagesEdited();
  // Keep keyboard focus nearby after the list re-renders.
  const next = imageList.children[Math.min(i, state.images.length - 1)];
  (next?.querySelector('button') ?? imageAdd).focus();
}

function onImagesEdited() {
  dismissUndo();
  hideFormErrors();
  renderImageField();
  markStale();
}

function renderImageField() {
  const support = currentImageSupport();
  const n = state.images.length;
  const blocked = support.supported === false;
  imageField.classList.toggle('is-disabled', blocked);
  imageList.classList.toggle('is-unsent', blocked && n > 0);
  imageAdd.disabled = blocked || n >= support.max;
  imageAdd.textContent = !blocked && n >= support.max ? `最多 ${support.max} 张` : '＋ 添加图片';
  imageCount.textContent = n ? `${n} / ${blocked ? 0 : support.max} 张` : '';
  imageDetailRow.hidden = n === 0 || blocked;

  imageList.replaceChildren(
    ...state.images.map((img, i) => {
      const li = el('li', 'image-item');
      const pic = el('img');
      pic.src = img.dataUrl;
      pic.alt = `图片 ${i + 1}：${img.name}`;
      const meta = el('span', 'image-meta', `${img.width}×${img.height} · ${formatKB(img.bytes)}`);
      const remove = el('button', 'mini-btn image-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `删除图片 ${i + 1}`);
      remove.title = '删除这张图片';
      remove.addEventListener('click', () => removeImage(img.id));
      li.append(pic, meta, remove);
      return li;
    }),
  );

  const model = currentModel() || '这个模型';
  let text;
  if (blocked) {
    text = `${model} 只支持文字，看不到图片。要判断图片，请在上方「模型」里选择 GPT-6 Luna Decisions。`;
    if (n) text += `已添加的 ${n} 张图片不会发送，请删除，或换用支持图片的模型。`;
  } else if (support.checking) {
    text = '正在查询这个模型是否支持图片…';
  } else if (support.supported === null) {
    text = `无法确认「${model}」是否支持图片。不支持图片的模型通常不会报错，而是给出没有根据的结果。`;
  } else {
    text = `点「添加图片」、把图片拖到这里，或直接粘贴（Ctrl+V）。图片会在浏览器里压缩后发送，最多 ${support.max} 张；不会保存，刷新页面后需要重新添加。`;
  }
  imageHint.textContent = imageMessage ? `${imageMessage}。${text}` : text;
  imageHint.classList.toggle('is-error', Boolean(imageMessage));
}

imageAdd.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
  await addImages(imageInput.files);
  imageInput.value = ''; // allow picking the same file again
});

imageDetail.addEventListener('change', () => {
  state.imageDetail = IMAGE_DETAILS.includes(imageDetail.value) ? imageDetail.value : 'auto';
  markStale();
  saveState();
});

// Dropping files anywhere on the page must not navigate away from the form; only the
// question card accepts them.
const dropZone = imageField.closest('.card');
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (hasFiles(e) && !dropZone.contains(e.target)) e.preventDefault();
  });
}
dropZone.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropZone.classList.add('is-dragover');
});
dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('is-dragover');
});
dropZone.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropZone.classList.remove('is-dragover');
  addImages(e.dataTransfer.files);
});

// Pasting an image anywhere adds it (text pastes are left alone).
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});

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
  // after the response would otherwise wipe the result instead of marking it stale.
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
// The request the form would send now (images and their support come from page state).
function requestFromForm() {
  return buildRequest({ ...state, model: currentModel(), imageSupport: currentImageSupport() });
}

// Images are fingerprinted (length + tail) so comparing snapshots stays cheap.
const fingerprint = (url) => `${url.length}:${url.slice(-24)}`;
const snapshotOf = (built) => JSON.stringify([redactImages(built.body, fingerprint), built.items]);

function formSnapshot() {
  const built = requestFromForm();
  return built.ok ? snapshotOf(built) : 'invalid';
}

function markStale() {
  if (busy || !lastSent) return;
  const same = formSnapshot() === lastSent.snapshot;
  resultCard.classList.toggle('is-stale', !same);
  setStatus(same ? 'done' : 'stale');
}

// Brings `target` (the bar, or the error box) fully into view. On narrow layouts
// the result sits below the form, so the card's top is brought up as well.
function revealResult(target) {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const narrow = window.matchMedia('(max-width: 960px)').matches;
  if (narrow) {
    const card = resultCard.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    // Align the card's top unless that would push the target below the fold.
    const delta = r.bottom - card.top + 16 <= window.innerHeight ? card.top - 12 : r.bottom - window.innerHeight + 16;
    window.scrollBy({ top: delta, behavior });
    return;
  }
  const r = target.getBoundingClientRect();
  if (r.top >= 8 && r.bottom <= window.innerHeight - 8) return;
  // The result column is sticky: scrolling up moves it down until it sticks, so
  // scroll by the target's own offset rather than scrolling the card.
  const delta = r.top < 8 ? r.top - 16 : r.bottom - window.innerHeight + 16;
  window.scrollBy({ top: delta, behavior });
}

function showMeta(json, ms, stateSource, imageCount = 0, detail = 'auto') {
  const rows = [
    ['耗时', `${ms} ms`],
    ['费用', formatUsd(json?.usage?.cost)],
    ['输入 tokens', json?.usage?.input_tokens ?? '—'],
    ['服务商', json?.provider ?? '—'],
    ['输出 tokens（免费）', json?.usage?.output_tokens ?? '—'],
    [
      '判断材料',
      ({ question: '问题本身（背景内容为空）', text: '背景内容（文本）', json: '背景内容（JSON）' }[stateSource] ?? '—') +
        (imageCount ? ` + ${imageCount} 张图片（精度：${{ auto: '自动', low: '低', high: '高' }[detail] ?? '自动'}）` : ''),
    ],
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

function showRaw(body, endpoint, responseText, imageCount = 0) {
  const shown = imageCount ? redactImages(body) : body;
  $('raw-request').textContent = JSON.stringify(shown, null, 2);
  $('raw-curl').textContent = buildCurl(endpoint, shown, imageCount > 0);
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
  images: () => imageAdd.disabled ? imageList.querySelector('button') ?? imageAdd : imageAdd,
  // Marks the rows the error names (duplicates, unnamed or blank rows) and returns the first.
  options: (err) => {
    const list = state.type === 'choice' ? choiceList : scoreList;
    const inputs = [...list.children].map((row) => row.querySelector('input'));
    const flagged = (err.rows ?? []).map((i) => inputs[i]).filter(Boolean);
    for (const input of flagged) input.setAttribute('aria-invalid', 'true');
    return flagged[0] ?? inputs[0];
  },
};

// Option rows are flagged as a group (e.g. both duplicates), so they are cleared
// as a group too: fixing either duplicate un-flags both.
function hideFormErrors() {
  formErrors.hidden = true;
  formErrors.replaceChildren();
  for (const input of document.querySelectorAll('.option-list input[aria-invalid]')) input.removeAttribute('aria-invalid');
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
    if (err.field !== 'options' && err.field !== 'images') input.setAttribute('aria-invalid', 'true');
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
  const built = requestFromForm();
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
  const sent = { snapshot: snapshotOf(built), question: state.question.trim() };
  const imageCount = built.imageCount ?? 0;
  const detail = state.imageDetail;
  const modelName = modelShortName(built.body.model);
  // The request already includes every edit, so a preview refresh still waiting
  // on its debounce must not fire later and wipe this call's result.
  refreshPreviewSoon.cancel();
  resetResultExtras();
  lastSent = null;
  pendingRefresh = false;
  shownQuestion = sent.question;
  renderQuestionEcho();
  setBusy(true);
  // Blank rows are not sent, so rebuild the bars if they differ from what is sent;
  // otherwise shrink the previous result back to 0 while waiting.
  if (signatureOf(type, items) !== viz.signature()) viz.build(type, items);
  const drained = viz.drain(modelName);

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
    viz.clear(['还没有结果', '这次调用没有成功，原因见上方。修改后可以再试一次。']);
    showResultError(error);
    showRaw(built.body, endpoint.url, responseText, imageCount);
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
        ...(isAnswerRefusedError(err)
          ? { ...REFUSAL_TEXT, detail: err.message }
          : {
              title: '无法识别返回内容',
              hint: '服务返回了成功状态，但内容不是预期的决策结果格式。请检查 Base URL 是否指向 Decisions 接口。',
              detail: isAnswerShapeError(err) ? err.message : '返回的内容不是有效的 JSON',
            }),
      },
      text,
    );
  }
  result.by = modelShortName(json?.model ?? built.body.model);

  // Edits made while the call was in flight show up as a stale marker on this result.
  pendingRefresh = false;
  lastSent = sent;
  setStatus('done');
  showMeta(json, ms, built.stateSource, imageCount, detail);
  showRaw(built.body, endpoint.url, text, imageCount);
  markStale();
  // Aim at the bar (or score ruler), not the whole viz, which can be taller than the screen.
  revealResult($('viz').querySelector('.bar, .ruler') ?? $('viz'));
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

// ---- clear cache ----------------------------------------------------------

// Forgets everything this page saved in the browser (form, remembered key, theme)
// and reloads, so the page is exactly as on a first visit. It sits next to the
// main button and drops the saved key, so it asks first.
function clearCache() {
  const ok = window.confirm(
    '确定要清除缓存吗？\n\n这会删除本页保存在浏览器里的所有内容：输入的问题和选项、Base URL、模型、主题设置，以及记住的 API Key。清除后页面会刷新，和第一次打开时一样。',
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
  renderModel();
  for (const radio of form.elements.type) radio.checked = radio.value === state.type;
  questionInput.placeholder = PLACEHOLDER_EXAMPLE.question;
  questionInput.value = state.question;
  contextInput.value = state.context;
  renderQuestionEcho();
  renderOptions();
  imageDetail.value = state.imageDetail;
  onModelChanged();
  hideFormErrors();
  refreshPreview();
}

// Set both explicitly: some browsers restore typed values and checkboxes on reload,
// which would bring a key (or the remember box) back after clearing the cache.
const savedKey = storage.get(KEY_STORE);
keyInput.value = savedKey ?? '';
rememberKey.checked = Boolean(savedKey);
renderExamples();
renderAll();

if (location.hash === CACHE_CLEARED_HASH) {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const notice = $('cache-notice');
  notice.textContent = '✓ 缓存已清除';
  setTimeout(() => (notice.textContent = ''), 6000);
}
