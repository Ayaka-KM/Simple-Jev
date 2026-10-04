import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUESTION_KEY,
  buildCurl,
  buildRequest,
  buildState,
  describeNoul,
  displayItems,
  formatUsd,
  normalizeKey,
  parseError,
  readAnswer,
  resolveEndpoint,
  toPercents,
  validateKey,
} from '../public/js/core.js';

const baseForm = {
  model: 'typesafe/jev-1.13',
  question: '薛定谔的猫是活的还是死的？',
  context: '',
  noul: { trueText: '', falseText: '' },
  choice: [
    { name: '活', desc: '猫是活的', slot: 1 },
    { name: '死', desc: '猫是死的', slot: 2 },
  ],
  score: [{ text: '低' }, { text: '中' }, { text: '高' }],
};

describe('resolveEndpoint', () => {
  it('defaults to OpenRouter', () => {
    assert.deepEqual(resolveEndpoint(''), { ok: true, url: 'https://openrouter.ai/api/alpha/decisions', note: '' });
  });
  it('appends the Decisions path and drops trailing slashes', () => {
    assert.equal(resolveEndpoint('https://openrouter.ai/api///').url, 'https://openrouter.ai/api/alpha/decisions');
  });
  it('strips an OpenAI-style /v1 suffix', () => {
    const r = resolveEndpoint('https://openrouter.ai/api/v1');
    assert.equal(r.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.match(r.note, /v1/);
  });
  it('adds /api for the bare OpenRouter site', () => {
    assert.equal(resolveEndpoint('https://openrouter.ai').url, 'https://openrouter.ai/api/alpha/decisions');
  });
  it('keeps a full endpoint as-is', () => {
    assert.equal(
      resolveEndpoint('https://example.com/proxy/alpha/decisions').url,
      'https://example.com/proxy/alpha/decisions',
    );
  });
  it('drops query strings and fragments', () => {
    assert.equal(resolveEndpoint('https://example.com/api?x=1#y').url, 'https://example.com/api/alpha/decisions');
  });
  it('rejects plain http except for localhost and 127.0.0.1 (the hosts the CSP allows)', () => {
    assert.equal(resolveEndpoint('http://example.com/api').ok, false);
    assert.equal(resolveEndpoint('http://[::1]:8787/api').ok, false);
    assert.equal(resolveEndpoint('http://localhost:8787/api').url, 'http://localhost:8787/api/alpha/decisions');
    assert.equal(resolveEndpoint('http://127.0.0.1:8787/api').ok, true);
  });
  it('rejects garbage and embedded credentials', () => {
    assert.equal(resolveEndpoint('not a url').ok, false);
    assert.equal(resolveEndpoint('https://user:pw@example.com/api').ok, false);
  });
});

describe('API key helpers', () => {
  it('trims and drops a pasted Bearer prefix', () => {
    assert.equal(normalizeKey('  Bearer sk-or-v1-abc  '), 'sk-or-v1-abc');
  });
  it('flags empty keys and keys with spaces or non-ASCII', () => {
    assert.ok(validateKey(''));
    assert.ok(validateKey('sk or'));
    assert.ok(validateKey('sk-密钥'));
    assert.equal(validateKey('sk-or-v1-abc'), '');
  });
});

describe('buildState', () => {
  it('falls back to the question when context is empty', () => {
    assert.deepEqual(buildState('   ', 'Q?'), { state: 'Q?', source: 'question' });
  });
  it('sends JSON objects and arrays as structured data', () => {
    assert.deepEqual(buildState('{"tier":"enterprise"}', 'Q'), { state: { tier: 'enterprise' }, source: 'json' });
    assert.deepEqual(buildState('[1,2]', 'Q'), { state: [1, 2], source: 'json' });
  });
  it('keeps text that only looks like JSON as text', () => {
    assert.deepEqual(buildState('{not json', 'Q'), { state: '{not json', source: 'text' });
    assert.deepEqual(buildState('42', 'Q'), { state: '42', source: 'text' });
  });
});

describe('buildRequest', () => {
  it('builds a choice request in the documented shape', () => {
    const r = buildRequest({ ...baseForm, type: 'choice' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.body, {
      model: 'typesafe/jev-1.13',
      state: '薛定谔的猫是活的还是死的？',
      questions: {
        [QUESTION_KEY]: {
          type: 'choice',
          instructions: '薛定谔的猫是活的还是死的？',
          criteria: { 活: '猫是活的', 死: '猫是死的' },
        },
      },
    });
    assert.deepEqual(
      r.items.map((it) => [it.key, it.slot]),
      [
        ['活', 1],
        ['死', 2],
      ],
    );
  });

  it('omits noul criteria when both are blank, and fills in a missing side', () => {
    const blank = buildRequest({ ...baseForm, type: 'noul' });
    assert.equal(blank.body.questions[QUESTION_KEY].criteria, undefined);
    const half = buildRequest({ ...baseForm, type: 'noul', noul: { trueText: '是活的', falseText: '' } });
    assert.deepEqual(half.body.questions[QUESTION_KEY].criteria, { true: '是活的', false: '否' });
  });

  it('skips blank choice rows, uses the name when there is no description', () => {
    const r = buildRequest({
      ...baseForm,
      type: 'choice',
      choice: [
        { name: 'A', desc: '' },
        { name: '', desc: '' },
        { name: 'B', desc: 'b' },
      ],
    });
    assert.deepEqual(r.body.questions[QUESTION_KEY].criteria, { A: 'A', B: 'b' });
    assert.deepEqual(
      r.items.map((it) => it.key),
      ['A', 'B'],
    );
  });

  it('keeps an option named __proto__ as a plain key', () => {
    const r = buildRequest({
      ...baseForm,
      type: 'choice',
      choice: [
        { name: '__proto__', desc: 'x' },
        { name: 'b', desc: 'y' },
      ],
    });
    const json = JSON.parse(JSON.stringify(r.body));
    assert.deepEqual(Object.keys(json.questions[QUESTION_KEY].criteria), ['__proto__', 'b']);
  });

  it('reports missing names, duplicates and option counts, naming the offending rows', () => {
    const missing = buildRequest({ ...baseForm, type: 'choice', choice: [{ name: '', desc: 'only desc' }, { name: 'B' }] });
    assert.equal(missing.ok, false);
    const unnamed = missing.errors.find((e) => e.field === 'options' && /名称/.test(e.message));
    assert.deepEqual(unnamed.rows, [0]);

    const dupes = buildRequest({ ...baseForm, type: 'choice', choice: [{ name: 'A' }, { name: '' }, { name: 'A' }] });
    assert.deepEqual(dupes.errors.find((e) => /重复/.test(e.message)).rows, [0, 2]);

    const one = buildRequest({ ...baseForm, type: 'choice', choice: [{ name: 'A' }] });
    assert.ok(one.errors.some((e) => /至少/.test(e.message)));

    const nine = buildRequest({
      ...baseForm,
      type: 'choice',
      choice: Array.from({ length: 9 }, (_, i) => ({ name: `o${i}` })),
    });
    assert.ok(nine.errors.some((e) => /最多/.test(e.message)));
  });

  it('builds score criteria in order', () => {
    const r = buildRequest({ ...baseForm, type: 'score' });
    assert.deepEqual(r.body.questions[QUESTION_KEY].criteria, ['低', '中', '高']);
    assert.deepEqual(
      r.items.map((it) => [it.key, it.label]),
      [
        ['0', '低'],
        ['1', '中'],
        ['2', '高'],
      ],
    );
  });

  it('rejects blank score levels instead of renumbering the rest', () => {
    const r = buildRequest({ ...baseForm, type: 'score', score: [{ text: '低' }, { text: ' ' }, { text: '高' }] });
    assert.equal(r.ok, false);
    const err = r.errors.find((e) => e.field === 'options');
    assert.match(err.message, /第 2 档/);
    assert.deepEqual(err.rows, [1]);
  });

  it('requires a question and a model without spaces', () => {
    const r = buildRequest({ ...baseForm, type: 'noul', question: ' ', model: 'typesafe/jev 1.13' });
    assert.deepEqual(r.errors.map((e) => e.field).sort(), ['model', 'question']);
  });
});

describe('displayItems', () => {
  it('labels blank rows so the preview stays readable', () => {
    const items = displayItems('choice', { choice: [{ name: '', desc: '', slot: 3 }] });
    assert.deepEqual(items, [{ key: '', label: '选项 1', desc: '', slot: 3 }]);
    assert.equal(displayItems('score', { score: [{ text: '' }] })[0].label, '第 1 档');
  });
});

describe('toPercents', () => {
  it('always adds up to 100', () => {
    assert.deepEqual(toPercents([0.74, 0.26]), [74, 26]);
    assert.deepEqual(toPercents([1 / 3, 1 / 3, 1 / 3]), [34, 33, 33]);
    assert.deepEqual(toPercents([0.78, 0.22, 0]), [78, 22, 0]);
    const odd = toPercents([0.333, 0.333, 0.333, 0.001]);
    assert.equal(
      odd.reduce((a, b) => a + b, 0),
      100,
    );
  });
  it('handles all-zero and bad input', () => {
    assert.deepEqual(toPercents([0, 0]), [0, 0]);
    assert.deepEqual(toPercents([NaN, -1, 1]), [0, 0, 100]);
  });
});

describe('readAnswer', () => {
  const choiceItems = [
    { key: '活', label: '活', desc: '', slot: 1 },
    { key: '死', label: '死', desc: '', slot: 2 },
  ];

  it('reads a choice answer in the order the user entered', () => {
    const json = {
      answers: {
        [QUESTION_KEY]: { type: 'choice', choice: '活', probabilities: { 死: 0.26, 活: 0.74 }, confidence: 0.48 },
      },
    };
    const r = readAnswer('choice', json, choiceItems);
    assert.deepEqual(
      r.items.map((it) => [it.key, it.pct]),
      [
        ['活', 74],
        ['死', 26],
      ],
    );
    assert.equal(r.winner, '活');
    assert.equal(r.confidence, 0.48);
  });

  it('lists options the API returned but we did not send', () => {
    const json = { answers: { [QUESTION_KEY]: { type: 'choice', choice: 'x', probabilities: { 活: 0.5, x: 0.5 } } } };
    const r = readAnswer('choice', json, choiceItems);
    assert.deepEqual(
      r.items.map((it) => it.key),
      ['活', '死', 'x'],
    );
  });

  it('falls back to the chosen option when probabilities are missing', () => {
    const json = { answers: { [QUESTION_KEY]: { type: 'choice', choice: '死' } } };
    const r = readAnswer('choice', json, choiceItems);
    assert.deepEqual(
      r.items.map((it) => it.pct),
      [0, 100],
    );
    assert.equal(r.estimated, true);
  });

  it('treats null or non-numeric fields as missing, not as 0', () => {
    const items = displayItems('noul', {});
    assert.throws(() => readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'noul', noul: null } } }, items), /noul/);
    const levels = displayItems('score', { score: [{ text: 'a' }, { text: 'b' }] });
    assert.throws(() => readAnswer('score', { answers: { [QUESTION_KEY]: { type: 'score', score: '' } } }, levels), /score/);
    const json = { answers: { [QUESTION_KEY]: { type: 'choice', choice: '活', probabilities: { 活: 1, 死: 0 }, confidence: null } } };
    assert.equal(readAnswer('choice', json, choiceItems).confidence, null);
  });

  it('treats an empty or all-null probabilities object as missing', () => {
    const levels = displayItems('score', { score: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    const nulls = { answers: { [QUESTION_KEY]: { type: 'score', score: 1.4, probabilities: { 0: null, 1: null, 2: null } } } };
    const r = readAnswer('score', nulls, levels);
    assert.equal(r.estimated, true);
    assert.equal(r.peak, null);
    const empty = { answers: { [QUESTION_KEY]: { type: 'choice', choice: '活', probabilities: {} } } };
    assert.equal(readAnswer('choice', empty, choiceItems).estimated, true);
  });

  it('shows no winner on an exact 50/50 noul', () => {
    const items = displayItems('noul', {});
    assert.equal(readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'noul', noul: 0.5 } } }, items).winner, null);
  });

  it('reads a noul answer as two shares', () => {
    const items = displayItems('noul', {});
    const r = readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'noul', noul: 0.96 } } }, items);
    assert.deepEqual(
      r.items.map((it) => it.pct),
      [96, 4],
    );
    assert.equal(r.winner, 'true');
  });

  it('reads a score answer with its distribution', () => {
    const items = displayItems('score', { score: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    const json = {
      answers: {
        [QUESTION_KEY]: { type: 'score', score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0.01, 2: 0.99 } },
      },
    };
    const r = readAnswer('score', json, items);
    assert.equal(r.score, 1.99);
    assert.equal(r.max, 2);
    assert.equal(r.peak, '2');
    assert.deepEqual(
      r.items.map((it) => it.pct),
      [0, 1, 99],
    );
  });

  it('clamps an out-of-range score', () => {
    const items = displayItems('score', { score: [{ text: 'a' }, { text: 'b' }] });
    const r = readAnswer('score', { answers: { [QUESTION_KEY]: { type: 'score', score: 7 } } }, items);
    assert.equal(r.score, 1);
  });

  it('rejects responses without our answer or with the wrong type', () => {
    assert.throws(() => readAnswer('noul', { answers: {} }, []), /没有找到答案/);
    assert.throws(
      () => readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'choice', choice: 'a' } } }, []),
      /不一致/,
    );
    assert.throws(() => readAnswer('noul', { answers: { [QUESTION_KEY]: { type: 'noul' } } }, []), /noul/);
  });
});

describe('describeNoul', () => {
  it('maps probabilities to plain words', () => {
    assert.equal(describeNoul(0.96).lean, 'true');
    assert.equal(describeNoul(0.5).text, '拿不准');
    assert.equal(describeNoul(0.17).lean, 'false');
  });
});

describe('parseError', () => {
  it('uses a friendly title and the API message', () => {
    const e = parseError(401, '{"error":{"message":"No auth credentials found","code":401}}');
    assert.equal(e.title, 'API Key 无效或缺失');
    assert.equal(e.detail, 'No auth credentials found');
  });
  it('flattens validation issues', () => {
    const msg = JSON.stringify([{ code: 'invalid_union', path: ['state'], message: 'Invalid input' }]);
    const e = parseError(400, JSON.stringify({ error: { message: msg, code: 400 } }));
    assert.equal(e.detail, 'state：Invalid input');
  });
  it('reads an error given as a plain string', () => {
    assert.equal(parseError(500, '{"error":"upstream exploded"}').detail, 'upstream exploded');
  });
  it('handles unknown statuses and non-JSON bodies', () => {
    const e = parseError(418, '<html>teapot</html>');
    assert.match(e.title, /418/);
    assert.equal(e.detail, '<html>teapot</html>');
  });
});

describe('formatUsd', () => {
  it('shows tiny costs without scientific notation', () => {
    assert.equal(formatUsd(0.000020412), '$0.0000204');
    assert.equal(formatUsd(0), '$0');
    assert.equal(formatUsd(1.5), '$1.5');
    assert.equal(formatUsd(undefined), '—');
  });
});

describe('buildCurl', () => {
  it('keeps the key out of the command and escapes single quotes', () => {
    const cmd = buildCurl('https://openrouter.ai/api/alpha/decisions', { state: "it's" });
    assert.match(cmd, /\$OPENROUTER_API_KEY/);
    assert.match(cmd, /it'\\''s/);
  });
  it('quotes the endpoint so shell metacharacters in it are inert', () => {
    const cmd = buildCurl("https://example.com/a;touch$IFS/tmp/x/alpha/decisions", {});
    assert.ok(cmd.startsWith("curl 'https://example.com/a;touch$IFS/tmp/x/alpha/decisions' \\"));
  });
});
