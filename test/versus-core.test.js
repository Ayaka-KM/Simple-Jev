import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUESTION_KEY, displayItems, parseCatalog, parseError, readAnswer } from '../public/js/core.js';
import {
  DEFAULT_MODELS,
  MAX_MODELS,
  buildVersusRequests,
  checkModels,
  modelName,
  modelNames,
  nextModel,
  restoreModels,
  summarizeComparison,
} from '../public/js/versus-core.js';

const decisions = (id, name, slug = '') => ({
  id,
  name,
  canonical_slug: slug,
  architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
});

const catalog = parseCatalog({
  data: [
    decisions('typesafe/jev-1.13', 'TypeSafe: Jev 1.13', 'typesafe/jev-1.13-20260917'),
    decisions('openai/gpt-6-luna-decisions', 'OpenAI: GPT-6 Luna Decisions', 'openai/gpt-6-luna-decisions-20261006'),
    decisions('inception/mercury-decide:free', 'Inception: Mercury Decide (free)'),
    decisions('acme/odd', 'acme/odd:beta'),
  ],
});

const form = {
  type: 'choice',
  question: '薛定谔的猫是活的还是死的？',
  context: '',
  noul: { trueText: '', falseText: '' },
  choice: [
    { name: '活', desc: '猫是活的' },
    { name: '死', desc: '猫是死的' },
  ],
  score: [{ text: '低' }, { text: '中' }, { text: '高' }],
};

describe('modelName / modelNames', () => {
  it('uses the OpenRouter name without the provider, also for a dated slug', () => {
    assert.equal(modelName('typesafe/jev-1.13', catalog), 'Jev 1.13');
    assert.equal(modelName('openai/gpt-6-luna-decisions-20261006', catalog), 'GPT-6 Luna Decisions');
    assert.equal(modelName('inception/mercury-decide:free', catalog), 'Mercury Decide (free)');
  });
  it('keeps a routing variant the name does not cover', () => {
    assert.equal(modelName('typesafe/jev-1.13:nitro', catalog), 'Jev 1.13:nitro');
    assert.equal(modelName(' typesafe/jev-1.13:nitro ', null), 'Jev 1.13:nitro');
  });
  it('falls back to the built-in labels without their notes, then to the id', () => {
    assert.equal(modelName('typesafe/jev-1.13', null), 'Jev 1.13');
    assert.equal(modelName('~typesafe/jev-latest', null), 'Jev Latest');
    assert.equal(modelName('openai/gpt-6-luna-decisions', null), 'GPT-6 Luna Decisions');
    assert.equal(modelName('acme/thing', catalog), 'acme/thing');
    assert.equal(modelName('', catalog), '');
  });
  it('keeps a catalog name that is really an id whole', () => {
    assert.equal(modelName('acme/odd', catalog), 'acme/odd:beta');
  });
  it('shows ids where two names would read the same', () => {
    assert.deepEqual(modelNames(['typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', 'openai/gpt-6-luna-decisions'], catalog), [
      'typesafe/jev-1.13',
      'typesafe/jev-1.13-20260917',
      'GPT-6 Luna Decisions',
    ]);
  });
});

describe('checkModels', () => {
  it('accepts two to four different models', () => {
    assert.deepEqual(checkModels(DEFAULT_MODELS), []);
  });
  it('names blank rows, rows with spaces and repeated models', () => {
    const errors = checkModels(['typesafe/jev-1.13', ' ', 'a b', ' typesafe/jev-1.13']);
    assert.deepEqual(
      errors.map((e) => [e.message, e.rows]),
      [
        ['第 2 个模型的名称是空的，请填写或删除这一行', [1]],
        ['模型名称里不能有空格', [2]],
        ['同一个模型选了不止一次：typesafe/jev-1.13，请换成别的模型', [0, 3]],
      ],
    );
  });
  it('needs at least two and at most four models', () => {
    assert.match(checkModels(['typesafe/jev-1.13'])[0].message, /至少要选 2 个模型/);
    assert.match(checkModels(['a/1', 'a/2', 'a/3', 'a/4', 'a/5'])[0].message, new RegExp(`最多对比 ${MAX_MODELS} 个模型`));
  });
});

describe('buildVersusRequests', () => {
  it('builds one text-only request per model, identical apart from the model', () => {
    const r = buildVersusRequests({ ...form, images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }, [' typesafe/jev-1.13', 'openai/gpt-6-luna-decisions']);
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.bodies.map((b) => b.model),
      ['typesafe/jev-1.13', 'openai/gpt-6-luna-decisions'],
    );
    assert.deepEqual({ ...r.bodies[0], model: '' }, { ...r.bodies[1], model: '' });
    assert.deepEqual(Object.keys(r.bodies[0]), ['model', 'state', 'questions']);
    assert.equal(r.bodies[0].state, '薛定谔的猫是活的还是死的？');
    assert.deepEqual(r.bodies[0].questions[QUESTION_KEY].criteria, { 活: '猫是活的', 死: '猫是死的' });
    assert.deepEqual(
      r.items.map((it) => it.key),
      ['活', '死'],
    );
    assert.equal(r.stateSource, 'question');
  });
  it('reports question and option problems once, and model problems by row', () => {
    const r = buildVersusRequests({ ...form, question: ' ', choice: [{ name: '活' }, { name: '' }] }, ['typesafe/jev-1.13', '']);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.errors.map((e) => e.field),
      ['models', 'question', 'options'],
    );
    assert.deepEqual(r.errors[0].rows, [1]);
  });
});

describe('nextModel / restoreModels', () => {
  const menu = ['typesafe/jev-1.13', '~typesafe/jev-latest', 'openai/gpt-6-luna-decisions', 'cloudflare/clef-omni'];
  it('starts a new row with the first free model in the menu, passing over aliases', () => {
    assert.equal(nextModel(DEFAULT_MODELS, menu), 'cloudflare/clef-omni');
    assert.equal(nextModel([...DEFAULT_MODELS, 'cloudflare/clef-omni'], menu), '~typesafe/jev-latest');
    assert.equal(nextModel(menu, menu), '');
  });
  it('cleans up the saved list and tops it up to two models', () => {
    assert.deepEqual(restoreModels(null), DEFAULT_MODELS);
    assert.deepEqual(restoreModels([' acme/x ', 3, null]), ['acme/x', 'typesafe/jev-1.13']);
    assert.deepEqual(restoreModels(['typesafe/jev-1.13']), ['typesafe/jev-1.13', 'openai/gpt-6-luna-decisions']);
    assert.deepEqual(restoreModels(['a/1', 'a/2', 'a/3', 'a/4', 'a/5']), ['a/1', 'a/2', 'a/3', 'a/4']);
    // A row left blank stays, so the form comes back as it was.
    assert.deepEqual(restoreModels(['typesafe/jev-1.13', '']), ['typesafe/jev-1.13', '']);
  });
});

describe('summarizeComparison', () => {
  const choiceItems = displayItems('choice', form);
  const choice = (probs, extra = {}) =>
    readAnswer('choice', { answers: { [QUESTION_KEY]: { type: 'choice', probabilities: probs, ...extra } } }, choiceItems);
  const noul = (p) => readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'noul', noul: p } } }, displayItems('noul', form));
  const levels = displayItems('score', { score: [{ text: '非常负面' }, { text: '偏负面' }, { text: '中性' }, { text: '偏正面' }] });
  const score = (s, extra = {}) => readAnswer('score', { answers: { [QUESTION_KEY]: { type: 'score', score: s, ...extra } } }, levels);

  it('says when two models pick the same option, and where their probabilities differ most', () => {
    const s = summarizeComparison('choice', [
      { name: 'Jev 1.13', result: choice({ 活: 0.65, 死: 0.35 }, { choice: '活', confidence: 0.3 }) },
      { name: 'GPT-6 Luna Decisions', result: choice({ 活: 0.96, 死: 0.04 }, { choice: '活', confidence: 0.92 }) },
    ]);
    assert.equal(s.state, 'agree');
    assert.equal(s.main, '两个模型都选了「活」');
    assert.deepEqual(s.points, [
      '概率相差最大的是「活」：Jev 1.13 65%，GPT-6 Luna Decisions 96%，相差 31 个百分点',
      '置信度：Jev 1.13 30%（低），GPT-6 Luna Decisions 92%（高），相差 62 个百分点',
    ]);
  });

  it('groups models by their pick and names the extremes when there are more than two', () => {
    const s = summarizeComparison('choice', [
      { name: 'A', result: choice({ 活: 0.74, 死: 0.26 }, { choice: '活' }) },
      { name: 'B', result: choice({ 活: 0.39, 死: 0.61 }, { choice: '死' }) },
      { name: 'C', result: choice({ 活: 0.74, 死: 0.26 }, { choice: '活' }) },
    ]);
    assert.equal(s.state, 'differ');
    assert.equal(s.main, 'A、C 选了「活」；B 选了「死」');
    assert.equal(s.points[0], '概率相差最大的是「活」：最高 A、C 74%，最低 B 39%，相差 35 个百分点');
  });

  it('compares only the pick of a model that returned no probabilities', () => {
    const s = summarizeComparison('choice', [
      { name: 'A', result: choice(undefined, { choice: '死' }) },
      { name: 'B', result: choice({ 活: 0.5, 死: 0.5 }, { choice: '死' }) },
    ]);
    assert.equal(s.main, '两个模型都选了「死」');
    assert.deepEqual(s.points, ['A 没有返回各选项的概率，只比较了选哪个']);
  });

  it('says so when every option has the same probability', () => {
    const s = summarizeComparison('choice', [
      { name: 'A', result: choice({ 活: 0.5, 死: 0.5 }, { choice: '活' }) },
      { name: 'B', result: choice({ 活: 0.5, 死: 0.5 }, { choice: '活' }) },
    ]);
    assert.equal(s.points[0], '每个选项的概率都完全一样');
  });

  it('compares yes/no answers by the probability of yes', () => {
    const agree = summarizeComparison('noul', [
      { name: 'A', result: noul(0.96) },
      { name: 'B', result: noul(0.72) },
    ]);
    assert.equal(agree.main, '两个模型都判断为「是」');
    assert.deepEqual(agree.points, ['“是”的概率：A 96%，B 72%，相差 24 个百分点']);
    const differ = summarizeComparison('noul', [
      { name: 'A', result: noul(0.8) },
      { name: 'B', result: noul(0.5) },
      { name: 'C', result: noul(0.8) },
    ]);
    assert.equal(differ.state, 'differ');
    assert.equal(differ.main, 'A、C 判断为「是」；B 认为“是”和“否”各占一半');
    assert.equal(differ.points[0], '“是”的概率：最高 A、C 80%，最低 B 50%，相差 30 个百分点');
  });

  it('compares scores by the nearest level and the score itself', () => {
    const s = summarizeComparison('score', [
      { name: 'Jev 1.13', result: score(1.85, { confidence: 0.51 }) },
      { name: 'GPT-6 Luna Decisions', result: score(0.99, { confidence: 0.17, probabilities: { 0: 0, 1: 0.45, 2: 0.11, 3: 0.44 } }) },
    ]);
    assert.equal(s.state, 'differ');
    assert.equal(s.main, 'Jev 1.13 最接近第 3 档「中性」；GPT-6 Luna Decisions 最接近第 2 档「偏负面」');
    assert.deepEqual(s.points, [
      '得分：Jev 1.13 2.85，GPT-6 Luna Decisions 1.99，相差 0.86 档',
      '置信度：Jev 1.13 51%（中），GPT-6 Luna Decisions 17%（低），相差 34 个百分点',
    ]);
    const same = summarizeComparison('score', [
      { name: 'A', result: score(2) },
      { name: 'B', result: score(2) },
    ]);
    assert.equal(same.main, '两个模型都最接近第 3 档「中性」');
    assert.deepEqual(same.points, ['得分：都是 3.00']);
  });

  it('names the level whose probability differs most when the scores are close', () => {
    // Shaped like real answers from 2026-10-11: nearly the same score, very different spreads.
    const s = summarizeComparison('score', [
      { name: 'Jev 1.13', result: score(2.07, { confidence: 0.82, probabilities: { 0: 0.07, 1: 0.78, 2: 0.15, 3: 0 } }) },
      { name: 'GPT-6 Luna Decisions', result: score(1.99, { confidence: 0.17, probabilities: { 0: 0.45, 1: 0.11, 2: 0.44, 3: 0 } }) },
    ]);
    assert.equal(s.state, 'agree');
    assert.deepEqual(s.points, [
      '得分：Jev 1.13 3.07，GPT-6 Luna Decisions 2.99，相差 0.08 档',
      '概率相差最大的是第 2 档「偏负面」：Jev 1.13 78%，GPT-6 Luna Decisions 11%，相差 67 个百分点',
      '置信度：Jev 1.13 82%（高），GPT-6 Luna Decisions 17%（低），相差 65 个百分点',
    ]);
  });

  it('compares the models that answered and lists the ones that failed', () => {
    const error = parseError(429, '{"error":{"message":"Rate limited"}}');
    const s = summarizeComparison('noul', [
      { name: 'A', result: noul(0.9) },
      { name: 'B', error },
      { name: 'C', result: noul(0.9) },
    ]);
    assert.equal(s.state, 'agree');
    assert.equal(s.main, '返回结果的两个模型都判断为「是」');
    assert.deepEqual(s.points, ['“是”的概率：都是 90%', 'B 调用失败：请求太频繁']);
  });

  it('cannot compare fewer than two answers', () => {
    const unauthorized = parseError(401, '{"error":{"message":"No auth credentials found"}}');
    const one = summarizeComparison('noul', [
      { name: 'A', result: noul(0.9) },
      { name: 'B', error: unauthorized },
    ]);
    assert.deepEqual(one, { state: 'none', main: '只有 A 返回了结果，没法对比', points: ['B 调用失败：API Key 无效或缺失'] });
    const same = summarizeComparison('noul', [
      { name: 'A', error: unauthorized },
      { name: 'B', error: unauthorized },
    ]);
    assert.equal(same.main, '所有模型都调用失败了：API Key 无效或缺失');
    assert.deepEqual(same.points, [unauthorized.hint]);
    const mixed = summarizeComparison('noul', [
      { name: 'A', error: unauthorized },
      { name: 'B', error: parseError(429, '') },
    ]);
    assert.equal(mixed.main, '所有模型都调用失败了');
    assert.deepEqual(mixed.points, ['A 调用失败：API Key 无效或缺失', 'B 调用失败：请求太频繁']);
  });
});
