import test from 'node:test';
import assert from 'node:assert/strict';
import { repairAddress, repairImport } from '../lib/import-repair.mjs';
import { importConfig, validateConfig } from '../lib/config.mjs';

const emptyConfig = () => ({ sources: [], platforms: [], parsers: [] });
const source = (id, api = 'https://example.com/api.php') => ({ id, name: `源 ${id}`, api, enabled: true });
const importFixture = input => importConfig(emptyConfig(), input);
const rejected = operation => assert.throws(operation, error => [400, 403].includes(error.status));

test('address repair accepts common copy formats and retains complete query parameters', () => {
  const expected = 'https://example.com/api.php?token=a%2Bb&next=https%3A%2F%2Fexample.org%2Fa%3Fx%3D1&url={url}';
  const formats = [
    expected.slice('https://'.length),
    expected.replace('https:', ''),
    `  ${expected}  `,
    `[影视源](${expected})`,
    `"${expected}"`,
    `'${expected}'`,
    `\`${expected}\``,
    `<${expected}>`,
    `\`\`\`\n${expected}\n\`\`\``,
    `\`\`\`text\n${expected}\n\`\`\``,
    expected.replace('https://', 'https\\://'),
    expected.replace('https://', 'https：//'),
    expected.replaceAll('&', '&amp;'),
  ];
  for (const value of formats) assert.equal(repairAddress(value), expected, value);
  assert.equal(repairAddress('example.com:8443/api?token=one'), 'https://example.com:8443/api?token=one');
  assert.equal(repairAddress('http://example.com:8080/api?token=one'), 'http://example.com:8080/api?token=one');
});

test('GitHub file links become raw links without losing branch, path or query literals', () => {
  const suffix = 'owner/project/feature/config/sources.json?token=a%2Bb&url={url}';
  const expected = `https://raw.githubusercontent.com/${suffix}`;
  assert.equal(repairAddress(`https://github.com/owner/project/blob/feature/config/sources.json?token=a%2Bb&url={url}`), expected);
  assert.equal(repairAddress(`https://github.com/owner/project/raw/feature/config/sources.json?token=a%2Bb&url={url}`), expected);
  assert.equal(repairAddress(expected), expected);
});

test('address repair retains the public URL security boundary instead of repairing unsafe targets', () => {
  for (const value of [
    '127.0.0.1/api', '//10.1.2.3/api', 'https://192.168.1.10/api',
    'http://169.254.169.254/latest', 'http://[::1]/api', 'http://[::ffff:127.0.0.1]/api',
    'http://2130706433/api', 'http://0x7f000001/api', 'http://%31%32%37.0.0.1/api',
    'https://user:password@example.com/api', 'https://%75ser:p%40ss@example.com/api',
    'javascript:alert(1)', 'file:///etc/passwd', 'content://media/video/1', 'ftp://example.com/api',
    '[本地源](http://127.0.0.1/api)', '"http://[::1]/api"',
  ]) rejected(() => repairAddress(value));
  for (const value of [null, undefined, {}, 123, '', ' '.repeat(8), 'x'.repeat(4097)]) {
    rejected(() => repairAddress(value));
  }
});

test('api_site object accepts URL strings and explicit address aliases before normal validation', () => {
  const repaired = repairImport({ api_site: {
    literal: 'example.com/api.php?token=123',
    alias: { title: 'URL 别名', url: '//example.org/vod?token=a%2Bb' },
    base: { name: 'Base 别名', baseUrl: 'https\\://example.net/vod' },
  } });
  const config = importFixture(repaired.config);
  assert.deepEqual(config.sources.map(row => [row.id, row.name, row.api]), [
    ['literal', 'literal', 'https://example.com/api.php?token=123'],
    ['alias', 'URL 别名', 'https://example.org/vod?token=a%2Bb'],
    ['base', 'Base 别名', 'https://example.net/vod'],
  ]);
  assert.equal(config.sources.every(row => row.enabled === true), true);
  assert.equal(repaired.warnings.length, 3);
});

test('nonempty api_site arrays use explicit IDs or stable generated IDs', () => {
  const input = { api_site: [
    { id: 'first', name: '第一源', api: 'example.com/api.php' },
    { key: 'second', name: '第二源', url: 'https://example.org/api.php' },
    { name: '未指定标识', baseUrl: 'https://example.net/api.php?token=keep' },
  ] };
  const first = importFixture(input);
  const again = importFixture(structuredClone(input));
  assert.deepEqual(first.sources.map(row => row.id), again.sources.map(row => row.id));
  assert.equal(first.sources[0].id, 'first');
  assert.equal(first.sources[1].id, 'second');
  assert.match(first.sources[2].id, /^import-[a-f0-9]{16}$/);
  assert.equal(first.sources[2].api, 'https://example.net/api.php?token=keep');
  for (const api_site of [[], null, 'wrong', [null], ['https://example.com/api'], [[]]]) {
    rejected(() => importFixture({ api_site }));
  }
});

test('source-only import fills required arrays, merges IDs, and preserves unrelated settings', () => {
  const current = validateConfig({
    sources: [source('retained'), source('replace')],
    platforms: [{ id: 'home', name: '原平台', url: 'https://example.org/', enabled: false }],
    parsers: [{ id: 'original', name: '原地址', url: '', enabled: true }],
    showAdult: true,
    subscriptions: [{ id: 'feed', name: '订阅', url: 'https://example.net/config.json', enabled: false }],
    liveSources: [{ id: 'tv', name: '直播', url: 'https://example.net/live.m3u', enabled: true }],
  });
  const original = structuredClone(current);
  const result = importConfig(current, { sources: [
    { id: 'replace', name: '新地址', url: 'example.org/new-api', enabled: false },
    { key: 'new', title: '新源', api: 'https://example.net/api' },
  ] });
  assert.deepEqual(result.sources.map(row => row.id), ['retained', 'replace', 'new']);
  assert.equal(result.sources[1].api, 'https://example.org/new-api');
  assert.equal(result.sources[1].enabled, false);
  for (const kind of ['platforms', 'parsers', 'subscriptions', 'liveSources']) {
    assert.deepEqual(result[kind], current[kind]);
  }
  assert.equal(result.showAdult, true);
  assert.deepEqual(current, original);
});

test('TVBox type-1 direct JSON APIs convert while XML and scripted entries only produce warnings', () => {
  const marker = '__vipvideo_import_fixture_executed';
  globalThis[marker] = false;
  try {
    const repaired = repairImport(JSON.stringify({ sites: [
      { key: 'json', name: 'JSON 接口', type: 1, api: 'example.com/api.php?token=keep' },
      { key: 'json-string', name: '字符串类型', type: '1', api: 'https://example.org/api.php' },
      { key: 'xml', name: 'XML 接口', type: 0, api: 'https://example.net/xml.php' },
      { key: 'script', name: '脚本接口', type: 3, api: 'csp_Test', ext: `globalThis.${marker}=true` },
      { key: 'jar', name: 'JAR 接口', type: 1, api: 'https://example.net/spider.jar?token=1' },
    ] }));
    const config = importFixture(repaired.config);
    assert.deepEqual(config.sources.map(row => row.id), ['json', 'json-string']);
    assert.equal(config.sources[0].api, 'https://example.com/api.php?token=keep');
    assert.equal(repaired.warnings.filter(row => /未导入/.test(row)).length, 3);
    assert.equal(globalThis[marker], false);
    rejected(() => importFixture({ sites: [{ key: 'only-script', type: 3, api: 'csp_Test' }] }));
    rejected(() => importFixture({ sites: [{ key: 'only-xml', type: 0, api: 'https://example.net/xml.php' }] }));
  } finally {
    delete globalThis[marker];
  }
});

test('duplicate IDs in converted arrays fail instead of silently overwriting imported entries', () => {
  const rows = [source('same'), { ...source('same'), api: 'https://example.org/other' }];
  for (const input of [
    { api_site: rows },
    { sites: rows.map(row => ({ ...row, key: row.id, type: 1 })) },
    { sources: rows },
    { api_site: [{ key: 'same', name: 'A', api: 'https://example.com/api' }, { id: 'same', name: 'B', api: 'https://example.org/api' }] },
  ]) assert.throws(() => importFixture(input), error => error.status === 400 && /重复/.test(error.message));
});

test('JSONC and fenced JSON allow comments and trailing commas without modifying quoted URLs', () => {
  const api = 'https://example.com/a//b?literal=/*keep*/&comma=,}&url={url}';
  const fixture = `\`\`\`json\n{
    // This text is a comment, not an interface.
    "api_site": {
      "fixture": {
        "name": "固定 \\"样例\\" // 字样",
        "api": ${JSON.stringify(api)}, /* trailing object comma follows */
      },
    },
  }\n\`\`\``;
  const imported = importFixture(fixture);
  assert.equal(imported.sources.length, 1);
  assert.equal(imported.sources[0].api, api);
  assert.equal(imported.sources[0].name, '固定 "样例" // 字样');
  const array = importFixture('{/*lead*/"api_site":[{"id":"array","name":"数组","api":"https://example.org/api",},],}');
  assert.equal(array.sources[0].id, 'array');
});

test('invalid JSON, oversized payloads and malformed values remain validation errors', () => {
  const invalidInputs = [
    null, [], 12, 'null', '[1]', '{not json}', '{"api_site":{}} trailing',
    '{"api_site":{}, /* unterminated', '{"api_site":{"a":{"api":"https://example.com/api}}}',
    ' '.repeat(1024 * 1024 + 1),
    { api_site: { bad: null } },
    { api_site: { bad: { name: '无地址', api: null } } },
    { api_site: { bad: { name: 123, api: 'https://example.com/api' } } },
    { sources: null },
    { sources: [null] },
    { sources: [{ ...source('bad'), enabled: 'false' }] },
    { sources: [source('__proto__')] },
    { sources: [source('valid')], showAdult: 'false' },
    { sites: null },
    { sites: [null] },
  ];
  for (const input of invalidInputs) rejected(() => importFixture(input));
});

test('ordinary config validation applies address repair consistently and keeps empty parser mode', () => {
  const result = validateConfig({
    sources: [{ ...source('source'), api: 'example.com/api.php?url={url}&amp;token=keep' }],
    platforms: [{ id: 'home', name: '平台', url: '[平台](https://example.org/home)' }],
    parsers: [{ id: 'direct', name: '原地址', url: '' }, { id: 'parser', name: '解析', url: 'https：//example.net/?url={url}' }],
    subscriptions: [{ id: 'feed', name: '订阅', url: 'https://github.com/owner/project/blob/main/sources.json' }],
    liveSources: [{ id: 'tv', name: '直播', url: '//example.org/live.m3u?token=a%2Bb' }],
  });
  assert.equal(result.sources[0].api, 'https://example.com/api.php?url={url}&token=keep');
  assert.equal(result.platforms[0].url, 'https://example.org/home');
  assert.equal(result.parsers[0].url, '');
  assert.equal(result.parsers[1].url, 'https://example.net/?url={url}');
  assert.equal(result.subscriptions[0].url, 'https://raw.githubusercontent.com/owner/project/main/sources.json');
  assert.equal(result.liveSources[0].url, 'https://example.org/live.m3u?token=a%2Bb');
  assert.throws(() => validateConfig({ ...emptyConfig(), parsers: [{ id: 'bad', name: '坏线路', url: null }] }), { status: 400 });
});
