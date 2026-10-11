// Pure helpers for the side-by-side page (versus.html): the models to compare, one
// request per model, and a plain-language comparison of their answers. No DOM access
// here, so the module runs in the browser and under `node --test`, like core.js.

import { MODELS, buildRequest, describeConfidence, findModel } from './core.js';

export const MIN_MODELS = 2;
export const MAX_MODELS = 4;
// Compared on a first visit.
export const DEFAULT_MODELS = ['typesafe/jev-1.13', 'openai/gpt-6-luna-decisions'];

// "typesafe/jev-1.13:nitro" → "typesafe/jev-1.13".
const withoutVariant = (id) => id.replace(/:[^/]*$/, '');

// A short name for a model in the results: its OpenRouter name without the provider
// ("TypeSafe: Jev 1.13" → "Jev 1.13"), a built-in model's label without its notes, or
// else the id. A routing variant the name does not cover stays visible
// ("Jev 1.13:nitro"), so two variants of one model never read as the same model.
export function modelName(id, catalog) {
  const raw = String(id ?? '').trim();
  const entry = findModel(raw, catalog);
  const builtin = MODELS.find((m) => m.id === raw) ?? MODELS.find((m) => m.id === withoutVariant(raw));
  // Only a "Provider: " prefix goes; a name that is really an id ("a/b:free") stays whole.
  const fromCatalog = entry ? entry.name.replace(/^[^:/]+:\s+/, '').trim() : '';
  const fromBuiltin = builtin ? builtin.label.replace(/（.*$/, '').trim() : '';
  const name = fromCatalog || fromBuiltin;
  if (!name) return raw;
  const base = fromCatalog ? entry.id : builtin.id;
  const variant = raw.slice(withoutVariant(raw).length);
  return variant && !base.endsWith(variant) ? `${name}${variant}` : name;
}

// Names for the models being compared; where two would read the same, their ids.
export function modelNames(ids, catalog) {
  const names = ids.map((id) => modelName(id, catalog));
  return names.map((name, i) => (names.indexOf(name) === names.lastIndexOf(name) ? name : String(ids[i] ?? '').trim()));
}

const indexesWhere = (list, test) => list.map((v, i) => (test(v, i) ? i : -1)).filter((i) => i >= 0);

// Problems with the chosen models. Each error names the rows it is about, like the
// option errors of buildRequest.
export function checkModels(ids) {
  const list = ids.map((id) => String(id ?? '').trim());
  const errors = [];
  const blank = indexesWhere(list, (id) => !id);
  if (blank.length) {
    errors.push({
      field: 'models',
      message: `第 ${blank.map((i) => i + 1).join('、')} 个模型的名称是空的，请填写或删除这一行`,
      rows: blank,
    });
  }
  const spaced = indexesWhere(list, (id) => /\s/.test(id));
  if (spaced.length) errors.push({ field: 'models', message: '模型名称里不能有空格', rows: spaced });
  const dupes = [...new Set(list.filter((id, i) => id && list.indexOf(id) !== i))];
  if (dupes.length) {
    errors.push({
      field: 'models',
      message: `同一个模型选了不止一次：${dupes.join('、')}，请换成别的模型`,
      rows: indexesWhere(list, (id) => dupes.includes(id)),
    });
  }
  if (list.length < MIN_MODELS) errors.push({ field: 'models', message: `至少要选 ${MIN_MODELS} 个模型才能对比` });
  if (list.length > MAX_MODELS) errors.push({ field: 'models', message: `最多对比 ${MAX_MODELS} 个模型` });
  return errors;
}

// One request per model, identical apart from `model`; text only. Returns { ok, errors,
// bodies, items, stateSource }. The question and options are the same for every model,
// so their errors are reported once.
export function buildVersusRequests(form, models) {
  const ids = models.map((id) => String(id ?? '').trim());
  const errors = checkModels(ids);
  // A stand-in model, so a model problem is not reported a second time.
  const shared = buildRequest({ ...form, model: 'model', images: [] });
  if (!shared.ok) errors.push(...shared.errors.filter((e) => e.field !== 'model'));
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    items: shared.items,
    stateSource: shared.stateSource,
    bodies: ids.map((model) => ({ ...shared.body, model })),
  };
}

// The model a new row starts with: the first one in the menu that is not chosen yet,
// passing over aliases such as ~typesafe/jev-latest (they point at a listed model).
export function nextModel(ids, menuIds) {
  const used = new Set(ids.map((id) => String(id ?? '').trim()));
  const free = menuIds.filter((id) => !used.has(id));
  return free.find((id) => !id.startsWith('~')) ?? free[0] ?? '';
}

// The saved model list, cleaned up: strings only, at most MAX_MODELS, topped up from
// the defaults to MIN_MODELS.
export function restoreModels(saved) {
  const list = (Array.isArray(saved) ? saved : [])
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .slice(0, MAX_MODELS);
  for (const id of DEFAULT_MODELS) if (list.length < MIN_MODELS && !list.includes(id)) list.push(id);
  return list;
}

// ---- comparing the answers --------------------------------------------------

const countWord = (n) => (n === 2 ? '两个' : `${n} 个`);
const percent = (v) => `${v}%`;
const points = (v) => `${v} 个百分点`;

// Models grouped by what they answered, in order of first appearance.
function groupBy(entries, keyOf, labelOf) {
  const groups = [];
  for (const e of entries) {
    const key = keyOf(e);
    const group = groups.find((g) => g.key === key);
    if (group) group.names.push(e.name);
    else groups.push({ key, label: labelOf(e), names: [e.name] });
  }
  return groups;
}

// "A 65%，B 96%，相差 31 个百分点"; with more than two models only the highest and the
// lowest are named. `values` are { name, value }, already rounded as shown.
function spreadText(values, format, formatGap) {
  const all = values.map((v) => v.value);
  const max = Math.max(...all);
  const min = Math.min(...all);
  if (max === min) return `都是 ${format(max)}`;
  const gap = `相差 ${formatGap(max - min)}`;
  if (values.length === 2) return `${values[0].name} ${format(values[0].value)}，${values[1].name} ${format(values[1].value)}，${gap}`;
  const at = (x) => values.filter((v) => v.value === x).map((v) => v.name).join('、');
  return `最高 ${at(max)} ${format(max)}，最低 ${at(min)} ${format(min)}，${gap}`;
}

// The option (or score level) whose probability differs most between the models that
// returned probabilities; null with fewer than two of them. `nameOf` names the option.
function widestGapPoint(answered, nameOf, sameText) {
  const measured = answered.filter((e) => !e.result.estimated);
  if (measured.length < 2) return null;
  const options = [];
  for (const e of measured) {
    for (const it of e.result.items) if (!options.some((o) => o.key === it.key)) options.push(it);
  }
  let widest = null;
  for (const opt of options) {
    const values = measured.map((e) => ({ name: e.name, value: e.result.items.find((it) => it.key === opt.key)?.pct ?? 0 }));
    const all = values.map((v) => v.value);
    const gap = Math.max(...all) - Math.min(...all);
    const top = Math.max(...all);
    // On a tie, the option the models rate highest: with two options both differ alike.
    if (!widest || gap > widest.gap || (gap === widest.gap && top > widest.top)) widest = { opt, values, gap, top };
  }
  return widest.gap === 0 ? sameText : `概率相差最大的是${nameOf(widest.opt)}：${spreadText(widest.values, percent, points)}`;
}

function confidencePoint(answered) {
  const values = answered
    .filter((e) => e.result.confidence != null)
    .map((e) => ({ name: e.name, value: Math.round(e.result.confidence * 100) }));
  if (values.length < 2) return null;
  return `置信度：${spreadText(values, (v) => `${v}%（${describeConfidence(v / 100)}）`, points)}`;
}

function summarizeChoice(answered, who) {
  const labelOf = (e) => e.result.items.find((it) => it.key === e.result.winner)?.label ?? String(e.result.winner);
  const groups = groupBy(answered, (e) => e.result.winner, labelOf);
  const main =
    groups.length === 1
      ? `${who}都选了「${groups[0].label}」`
      : groups.map((g) => `${g.names.join('、')} 选了「${g.label}」`).join('；');
  // Only models that returned probabilities can be compared option by option.
  const notes = [widestGapPoint(answered, (it) => `「${it.label}」`, '每个选项的概率都完全一样')].filter(Boolean);
  const guessed = answered.filter((e) => e.result.estimated);
  if (guessed.length) notes.push(`${guessed.map((e) => e.name).join('、')} 没有返回各选项的概率，只比较了选哪个`);
  const conf = confidencePoint(answered);
  if (conf) notes.push(conf);
  return { agree: groups.length === 1, main, notes };
}

function summarizeNoul(answered, who) {
  const verdict = (w) => (w === 'true' ? '判断为「是」' : w === 'false' ? '判断为「否」' : '认为“是”和“否”各占一半');
  const groups = groupBy(answered, (e) => e.result.winner, (e) => verdict(e.result.winner));
  const main =
    groups.length === 1 ? `${who}都${groups[0].label}` : groups.map((g) => `${g.names.join('、')} ${g.label}`).join('；');
  const values = answered.map((e) => ({ name: e.name, value: e.result.items[0].pct }));
  return { agree: groups.length === 1, main, notes: [`“是”的概率：${spreadText(values, percent, points)}`] };
}

function summarizeScore(answered, who) {
  const level = (e) => Math.round(e.result.score);
  const labelOf = (e) => `第 ${level(e) + 1} 档「${e.result.items[level(e)]?.label ?? ''}」`;
  const groups = groupBy(answered, level, labelOf);
  const main =
    groups.length === 1
      ? `${who}都最接近${groups[0].label}`
      : groups.map((g) => `${g.names.join('、')} 最接近${g.label}`).join('；');
  const values = answered.map((e) => ({ name: e.name, value: Math.round((e.result.score + 1) * 100) / 100 }));
  const notes = [`得分：${spreadText(values, (v) => v.toFixed(2), (v) => `${v.toFixed(2)} 档`)}`];
  // Close scores can hide very different spreads (one model sure of the middle, another
  // torn between both ends), so the level that differs most is named too.
  const gap = widestGapPoint(answered, (it) => `第 ${Number(it.key) + 1} 档「${it.label}」`, '每一档的概率都完全一样');
  if (gap) notes.push(gap);
  const conf = confidencePoint(answered);
  if (conf) notes.push(conf);
  return { agree: groups.length === 1, main, notes };
}

// The comparison shown above the charts. `entries` has one item per model, in order:
// { name, result } for an answer (from readAnswer), { name, error } for a call that
// failed (error from parseError). Returns { state, main, points }: state is 'agree',
// 'differ', or 'none' when fewer than two models answered.
export function summarizeComparison(type, entries) {
  const answered = entries.filter((e) => e.result);
  const failed = entries.filter((e) => !e.result);
  const failures = failed.map((e) => `${e.name} 调用失败：${e.error?.title ?? '没有结果'}`);
  if (answered.length < 2) {
    if (answered.length) return { state: 'none', main: `只有 ${answered[0].name} 返回了结果，没法对比`, points: failures };
    // The same problem everywhere (a wrong key, no network): say it once, with its fix.
    const titles = new Set(failed.map((e) => e.error?.title));
    if (titles.size === 1 && failed[0]?.error?.title) {
      const { title, hint } = failed[0].error;
      return { state: 'none', main: `所有模型都调用失败了：${title}`, points: hint ? [hint] : [] };
    }
    return { state: 'none', main: '所有模型都调用失败了', points: failures };
  }
  const who = `${failed.length ? '返回结果的' : ''}${countWord(answered.length)}模型`;
  const summary =
    type === 'noul' ? summarizeNoul(answered, who) : type === 'score' ? summarizeScore(answered, who) : summarizeChoice(answered, who);
  return { state: summary.agree ? 'agree' : 'differ', main: summary.main, points: [...summary.notes, ...failures] };
}
