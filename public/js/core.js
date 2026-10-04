// Pure helpers for building Jev Decisions requests and reading the responses.
// No DOM access here, so the same module runs in the browser and under `node --test`.

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api';
export const DECISIONS_PATH = '/alpha/decisions';
export const QUESTION_KEY = 'decision';
export const DEFAULT_MODEL = 'typesafe/jev-1.13';

export const MODELS = [
  { id: 'typesafe/jev-1.13', label: 'Jev 1.13（当前版本）' },
  { id: '~typesafe/jev-latest', label: 'Jev Latest（自动跟随最新版）' },
];

export const TYPES = ['noul', 'choice', 'score'];

export const LIMITS = {
  choice: { min: 2, max: 8 },
  score: { min: 2, max: 10 },
};

export const NOUL_LABELS = { true: '是', false: '否' };

// Plain http is allowed only for these hosts; keep in sync with connect-src in public/_headers.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// Turns whatever the user typed as Base URL into the full Decisions endpoint.
// Accepts the API root (https://openrouter.ai/api), the OpenAI-style root with
// /v1, the bare site, or the full endpoint pasted as-is.
export function resolveEndpoint(input) {
  const raw = String(input ?? '').trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: '地址格式不正确，应类似 https://openrouter.ai/api' };
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    return { ok: false, error: '请使用 https:// 开头的地址' };
  }
  if (url.username || url.password) {
    return { ok: false, error: '地址里不要包含用户名或密码' };
  }

  let path = url.pathname.replace(/\/+$/, '');
  const notes = [];
  if (!path.endsWith(DECISIONS_PATH)) {
    if (/\/v1$/i.test(path)) {
      path = path.slice(0, -3);
      notes.push('已自动去掉末尾的 /v1（Decisions 接口不在 /v1 下）');
    }
    if (path === '' && /(^|\.)openrouter\.ai$/i.test(url.hostname)) {
      path = '/api';
      notes.push('已自动补上 /api');
    }
    path += DECISIONS_PATH;
  }
  return { ok: true, url: url.origin + path, note: notes.join('；') };
}

// Normalises a pasted key: trims it and drops a leading "Bearer ".
export function normalizeKey(input) {
  return String(input ?? '').trim().replace(/^bearer\s+/i, '').trim();
}

export function validateKey(key) {
  if (!key) return '请填写 API Key';
  // fetch() rejects header values outside visible ASCII, so catch it here with a clearer message.
  if (!/^[\x21-\x7e]+$/.test(key)) return 'API Key 里有空格或非英文字符，请检查是否复制完整';
  return '';
}

// Jev requires `state`. Empty context falls back to the question itself; text that
// parses as a JSON object or array is sent as structured data.
export function buildState(context, question) {
  const text = String(context ?? '').trim();
  if (!text) return { state: question, source: 'question' };
  if (/^[[{]/.test(text)) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') return { state: value, source: 'json' };
    } catch {
      // Not JSON after all; send it as plain text.
    }
  }
  return { state: text, source: 'text' };
}

const clean = (s) => String(s ?? '').trim();

// Options as the user sees them, before any validation. Used for the 0% preview
// and to label results, so blank names get a readable placeholder.
export function displayItems(type, form) {
  if (type === 'noul') {
    return [
      { key: 'true', label: NOUL_LABELS.true, desc: clean(form.noul?.trueText), slot: 1 },
      { key: 'false', label: NOUL_LABELS.false, desc: clean(form.noul?.falseText), slot: 2 },
    ];
  }
  if (type === 'choice') {
    return (form.choice ?? []).map((opt, i) => ({
      key: clean(opt.name),
      label: clean(opt.name) || `选项 ${i + 1}`,
      desc: clean(opt.desc),
      slot: opt.slot ?? i + 1,
    }));
  }
  return (form.score ?? []).map((level, i) => ({
    key: String(i),
    label: clean(level.text) || `第 ${i + 1} 档`,
    desc: '',
    slot: 1,
  }));
}

// Builds the POST body. Returns { ok, body, items, errors, stateSource }: `items`
// are the options actually sent, in the user's order. Each error carries the form
// field it belongs to, and option errors list the offending row indexes in `rows`.
export function buildRequest(form) {
  const errors = [];
  const type = form.type;
  const model = clean(form.model);
  const question = clean(form.question);

  if (!TYPES.includes(type)) errors.push({ field: 'type', message: '请选择题型' });
  if (!model) errors.push({ field: 'model', message: '请填写模型名称' });
  else if (/\s/.test(model)) errors.push({ field: 'model', message: '模型名称里不能有空格' });
  if (!question) errors.push({ field: 'question', message: '请填写问题' });

  let q = null;
  let items = [];
  if (type === 'noul') {
    const t = clean(form.noul?.trueText);
    const f = clean(form.noul?.falseText);
    q = { type: 'noul', instructions: question };
    if (t || f) q.criteria = { true: t || NOUL_LABELS.true, false: f || NOUL_LABELS.false };
    items = displayItems('noul', form);
  } else if (type === 'choice') {
    // Fully blank rows are skipped; their order carries no meaning.
    const rows = (form.choice ?? []).map((o, i) => ({ name: clean(o.name), desc: clean(o.desc), slot: o.slot ?? i + 1, i }));
    const used = rows.filter((r) => r.name || r.desc);
    const { min, max } = LIMITS.choice;
    const unnamed = used.filter((r) => !r.name).map((r) => r.i);
    if (unnamed.length) errors.push({ field: 'options', message: '每个选项都需要填写名称', rows: unnamed });
    const names = used.map((r) => r.name).filter(Boolean);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dupes.length) {
      const dupeRows = used.filter((r) => dupes.includes(r.name)).map((r) => r.i);
      errors.push({ field: 'options', message: `选项名称重复：${dupes.join('、')}`, rows: dupeRows });
    }
    const blankRows = rows.filter((r) => !r.name).map((r) => r.i);
    if (names.length < min) errors.push({ field: 'options', message: `单选题至少需要 ${min} 个选项`, rows: blankRows });
    if (names.length > max) errors.push({ field: 'options', message: `单选题最多 ${max} 个选项` });
    // Object.fromEntries defines own properties, so a name like "__proto__" stays a plain key.
    q = {
      type: 'choice',
      instructions: question,
      criteria: Object.fromEntries(used.filter((r) => r.name).map((r) => [r.name, r.desc || r.name])),
    };
    items = used.map((r) => ({ key: r.name, label: r.name, desc: r.desc, slot: r.slot }));
  } else if (type === 'score') {
    // Levels are ordered, so a blank one is an error rather than silently renumbering the rest.
    const levels = (form.score ?? []).map((l) => clean(l.text));
    const { min, max } = LIMITS.score;
    const blank = levels.map((l, i) => (l ? -1 : i)).filter((i) => i >= 0);
    if (blank.length) {
      errors.push({
        field: 'options',
        message: `第 ${blank.map((i) => i + 1).join('、')} 档是空的，请填写或删除`,
        rows: blank,
      });
    }
    if (levels.length < min) errors.push({ field: 'options', message: `打分题至少需要 ${min} 档` });
    if (levels.length > max) errors.push({ field: 'options', message: `打分题最多 ${max} 档` });
    q = { type: 'score', instructions: question, criteria: levels };
    items = levels.map((label, i) => ({ key: String(i), label, desc: '', slot: 1 }));
  }

  if (errors.length) return { ok: false, errors };
  const { state, source } = buildState(form.context, question);
  return {
    ok: true,
    errors: [],
    items,
    stateSource: source,
    body: { model, state, questions: { [QUESTION_KEY]: q } },
  };
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// A finite number, or null. Unlike Number(), null/''/false/[] do not become 0.
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const prob = (v) => clamp01(num(v) ?? 0);
const conf = (v) => (num(v) == null ? null : clamp01(num(v)));

// Integer percentages that always add up to 100 (largest-remainder rounding),
// so the labels never read "74% + 27%".
export function toPercents(values) {
  const vals = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) return vals.map(() => 0);
  const exact = vals.map((v) => (v / total) * 100);
  const out = exact.map(Math.floor);
  const rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < rest; k++) out[order[k][1]] += 1;
  return out;
}

// Shares that add up to exactly 1, for bar widths.
function toShares(values) {
  const vals = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  return total > 0 ? vals.map((v) => v / total) : vals.map(() => 0);
}

class AnswerShapeError extends Error {}

// Reads the answer for our single question and lines it up with the options the
// user entered (the API does not keep option order). `items` comes from
// displayItems() for the request that was sent.
export function readAnswer(type, json, items) {
  const answer = json?.answers?.[QUESTION_KEY];
  if (!answer || typeof answer !== 'object') throw new AnswerShapeError('返回内容里没有找到答案');
  if (answer.type && answer.type !== type) {
    throw new AnswerShapeError(`返回的题型（${answer.type}）和请求的题型（${type}）不一致`);
  }

  if (type === 'noul') {
    const p = num(answer.noul);
    if (p == null) throw new AnswerShapeError('返回内容里缺少 noul 概率');
    const yes = clamp01(p);
    const raw = [yes, 1 - yes];
    const pct = toPercents(raw);
    return {
      type,
      probability: yes,
      items: items.map((it, i) => ({ ...it, p: raw[i], share: raw[i], pct: pct[i] })),
      winner: yes > 0.5 ? 'true' : yes < 0.5 ? 'false' : null,
      confidence: null,
      estimated: false,
    };
  }

  // Probabilities count only if at least one value is a real number; an empty or
  // all-null object is treated like a missing one.
  const rawProbs =
    answer.probabilities && typeof answer.probabilities === 'object' && !Array.isArray(answer.probabilities)
      ? answer.probabilities
      : null;
  const probs = rawProbs && Object.values(rawProbs).some((v) => num(v) != null) ? rawProbs : null;

  if (type === 'choice') {
    const choice = typeof answer.choice === 'string' ? answer.choice : null;
    if (!probs && choice == null) throw new AnswerShapeError('返回内容里缺少选项概率');
    const list = items.map((it) => ({ ...it }));
    if (probs) {
      // Keep any option the API mentions that we did not send, so nothing is silently dropped.
      for (const k of Object.keys(probs)) {
        if (!list.some((it) => it.key === k)) list.push({ key: k, label: k, desc: '', slot: 0 });
      }
    }
    // Without probabilities only the chosen option is known: it fills the bar, and
    // `estimated` tells the UI not to present that as a measured 100%.
    const raw = list.map((it) => (probs ? prob(probs[it.key]) : it.key === choice ? 1 : 0));
    const shares = toShares(raw);
    const pct = toPercents(raw);
    let winner = choice;
    if (winner == null || !list.some((it) => it.key === winner)) {
      winner = list[raw.indexOf(Math.max(...raw))]?.key ?? null;
    }
    return {
      type,
      items: list.map((it, i) => ({ ...it, p: raw[i], share: shares[i], pct: pct[i] })),
      winner,
      confidence: conf(answer.confidence),
      estimated: !probs,
    };
  }

  // score
  const n = items.length;
  const score = num(answer.score);
  if (score == null) throw new AnswerShapeError('返回内容里缺少 score 分数');
  const max = Math.max(0, n - 1);
  const position = Math.min(max, Math.max(0, score));
  const raw = items.map((_, i) => (probs ? prob(probs[String(i)]) : i === Math.round(position) ? 1 : 0));
  const shares = toShares(raw);
  const pct = toPercents(raw);
  const peak = raw.indexOf(Math.max(...raw));
  return {
    type,
    score: position,
    max,
    items: items.map((it, i) => ({ ...it, p: raw[i], share: shares[i], pct: pct[i] })),
    winner: String(Math.round(position)),
    peak: probs ? String(peak) : null,
    confidence: conf(answer.confidence),
    estimated: !probs,
  };
}

export function isAnswerShapeError(err) {
  return err instanceof AnswerShapeError;
}

// Plain-language reading of a yes/no probability.
export function describeNoul(p) {
  if (p >= 0.9) return { text: '几乎可以肯定：是', lean: 'true' };
  if (p >= 0.7) return { text: '倾向于：是', lean: 'true' };
  if (p > 0.3) return { text: '拿不准', lean: 'none' };
  if (p > 0.1) return { text: '倾向于：否', lean: 'false' };
  return { text: '几乎可以肯定：否', lean: 'false' };
}

export function describeConfidence(c) {
  if (c == null) return '';
  if (c >= 0.8) return '高';
  if (c >= 0.5) return '中';
  return '低';
}

const STATUS_TEXT = {
  400: ['请求参数有误', '检查问题、选项和模型名称是否填写正确。'],
  401: ['API Key 无效或缺失', '检查 Key 是否复制完整、是否已被删除或停用。'],
  402: ['账户余额不足', '到 OpenRouter 充值后再试。'],
  403: ['没有权限', '这个 Key 可能无权使用该模型，或内容触发了审核。'],
  404: ['找不到接口或模型', '检查 Base URL 和模型名称。'],
  408: ['请求超时', '稍后再试。'],
  413: ['内容太长', '缩短背景内容或减少选项后再试。'],
  429: ['请求太频繁', '稍等片刻再试。'],
  500: ['服务器内部错误', '稍后再试。'],
  502: ['上游服务出错', '模型服务商暂时出错，稍后再试。'],
  503: ['服务暂时不可用', '稍后再试。'],
  524: ['上游响应超时', '稍后再试。'],
  529: ['服务商过载', '稍后再试。'],
};

// Validation errors arrive as a JSON-encoded list of issues inside `message`.
function formatIssues(message) {
  if (typeof message !== 'string' || !/^\s*\[/.test(message)) return message;
  try {
    const issues = JSON.parse(message);
    if (!Array.isArray(issues)) return message;
    return issues
      .map((it) => {
        const path = Array.isArray(it?.path) && it.path.length ? it.path.join('.') : '(请求)';
        return `${path}：${it?.message ?? '无效'}`;
      })
      .join('\n');
  } catch {
    return message;
  }
}

export function parseError(status, bodyText) {
  const [title, hint] = STATUS_TEXT[status] ?? [`请求失败（HTTP ${status}）`, '稍后再试，或检查 Base URL 是否正确。'];
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    if (typeof j === 'string') detail = j;
    else if (typeof j?.error === 'string') detail = j.error;
    else detail = j?.error?.message ?? j?.message ?? '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = String(bodyText ?? '').trim();
  }
  detail = formatIssues(detail);
  if (detail.length > 800) detail = `${detail.slice(0, 800)}…`;
  return { status, title, hint, detail };
}

export function formatUsd(cost) {
  const n = Number(cost);
  if (cost == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const digits = Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(n)))));
  return `$${n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`;
}

// Single-quotes a value for POSIX shells.
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// A copy-pasteable curl command. The key stays an environment variable so it
// never ends up in the clipboard.
export function buildCurl(endpoint, body) {
  return [
    `curl ${shellQuote(endpoint)} \\`,
    '  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d ${shellQuote(JSON.stringify(body, null, 2))}`,
  ].join('\n');
}

export const EXAMPLES = [
  {
    id: 'cat',
    title: '薛定谔的猫',
    type: 'choice',
    question: '薛定谔的猫是活的还是死的？',
    context: '',
    choice: [
      { name: '活', desc: '猫是活的' },
      { name: '死', desc: '猫是死的' },
    ],
  },
  {
    id: 'cat3',
    title: '猫 + 叠加态',
    type: 'choice',
    question: '薛定谔的猫是活的还是死的？',
    context: '',
    choice: [
      { name: '活', desc: '猫是活的' },
      { name: '死', desc: '猫是死的' },
      { name: '叠加态', desc: '打开盒子观测之前，猫处于活与死的叠加态，两种答案都不确定' },
    ],
  },
  {
    id: 'bug',
    title: '工单是不是 bug',
    type: 'noul',
    question: '客户是在报告软件缺陷吗？',
    context: '我点了「支付」之后，结账页面一片空白。换了两个浏览器都一样。',
    noul: {
      trueText: '客户描述了产品出错或不符合预期的行为',
      falseText: '客户只是在提问，或者在提功能需求',
    },
  },
  {
    id: 'team',
    title: '工单分给哪个组',
    type: 'choice',
    question: '这张工单应该由哪个组负责？',
    context: '我点了「支付」之后，结账页面一片空白。换了两个浏览器都一样。',
    choice: [
      { name: '支付组', desc: '结账、计费、支付处理相关的问题' },
      { name: '前端组', desc: '页面渲染、布局、浏览器兼容性问题' },
      { name: '账号组', desc: '登录、权限、个人资料相关的问题' },
    ],
  },
  {
    id: 'urgency',
    title: '紧急程度',
    type: 'score',
    question: '这张工单有多紧急？',
    context: '企业版客户：我点了「支付」之后，结账页面一片空白。换了两个浏览器都一样。',
    score: [{ text: '可以等下个版本' }, { text: '这周内要修好' }, { text: '正在影响收入，必须立刻处理' }],
  },
  {
    id: 'review',
    title: '评论有多正面',
    type: 'score',
    question: '这条评论的情绪有多正面？',
    context: '这家餐厅还行吧，菜的味道不错，但是上菜实在太慢了。',
    score: [{ text: '非常负面' }, { text: '偏负面' }, { text: '中性' }, { text: '偏正面' }, { text: '非常正面' }],
  },
];
