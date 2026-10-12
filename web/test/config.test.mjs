import test from 'node:test';
import assert from 'node:assert/strict';
import { importConfig, validateConfig, validateRecord } from '../lib/config.mjs';

const config = () => ({ sources: [{ id: 'old', name: '旧源', api: 'https://example.com/api', enabled: false }],
  platforms: [{ id: 'home', name: '入口', url: 'https://example.com/', category: 'video', enabled: true }], parsers: [] });

test('MoonTV import merges source IDs and preserves unrelated settings', () => {
  const current = config();
  const result = importConfig(current, { api_site: { old: { name: '更新', api: 'https://example.org/vod' }, second: { name: '新增', api: 'https://example.net/api' } } });
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].name, '更新');
  assert.deepEqual(result.platforms, current.platforms);
  assert.equal(current.sources[0].name, '旧源');
});

test('imports and settings reject unsafe, duplicate or malformed inputs', () => {
  for (const api of ['javascript:alert(1)', 'file:///etc/passwd', 'http://user:password@example.com', 'http://127.0.0.1/api', 'http://[::1]/api']) {
    assert.throws(() => importConfig(config(), { api_site: { bad: { name: '坏源', api } } }));
  }
  for (const input of [{ api_site: [] }, { api_site: null }, { platformlist: {} }, { list: 'wrong' }]) assert.throws(() => importConfig(config(), input), { status: 400 });
  assert.throws(() => validateConfig({ ...config(), sources: [...config().sources, ...config().sources] }), { status: 400 });
  assert.throws(() => validateConfig({ ...config(), sources: [{ ...config().sources[0], enabled: 'false' }] }), { status: 400 });
});

test('VipVideo platform/line config is compatible and keeps original-address mode', () => {
  const result = importConfig({ sources: [], platforms: [], parsers: [] }, {
    platformlist: [{ name: '视频', url: 'https://example.com', category: 'video' }],
    list: [{ name: '原地址', url: '' }, { name: '线路', url: 'https://example.org/?url={url}' }],
  });
  assert.equal(result.platforms[0].id, 'vip-platform-0');
  assert.equal(result.parsers[0].url, '');
  assert.equal(result.parsers[1].url, 'https://example.org/?url={url}');
});

test('progress validates numbers, caps to duration and supports link-only history', () => {
  const base = { key: 'film', title: '影片', source: 'site', id: '42', year: 2025, type: 'movie' };
  assert.equal(validateRecord({ ...base, duration: 100, position: 105 }, true).position, 100);
  for (const position of [-1, Infinity, '10', NaN]) assert.throws(() => validateRecord({ ...base, position }, true), { status: 400 });
  assert.throws(() => validateRecord({ ...base, episode: 1.5 }, true), { status: 400 });
  const link = validateRecord({ key: 'link:https://example.com', title: '网页', url: 'https://example.com', mode: 'parser' }, true);
  assert.equal(link.source, '');
  assert.equal(link.mode, 'parser');
  assert.equal(link.position, 0);
});
