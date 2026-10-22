import test from 'node:test';
import assert from 'node:assert/strict';
import { importConfig, validateConfig, validateRecord, validatePlayerPreferences } from '../lib/config.mjs';

test('ad intervals require bounded explicit scopes and finite positions', () => {
  const range = { scope: JSON.stringify(['source', '1', 'hls', '第1集']), start: 10, end: 30 };
  assert.deepEqual(validatePlayerPreferences({ key: 'film', skipAds: true, adRanges: [range] }).adRanges, [range]);
  for (const input of [{ skipAds: null }, { adRanges: null }, { adRanges: [{ ...range, end: 9 }] },
    { adRanges: [{ ...range, end: 700 }] }, { adRanges: [{ ...range, start: NaN }] },
    { adRanges: [{ ...range, scope: '' }] }, { adRanges: Array(21).fill(range) }]) {
    assert.throws(() => validatePlayerPreferences({ key: 'film', ...input }), { status: 400 });
  }
});

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

test('adult visibility defaults off, is strictly boolean and survives source-only imports', () => {
  assert.equal(validateConfig(config()).showAdult, false);
  const current = { ...config(), showAdult: true };
  assert.equal(validateConfig(current).showAdult, true);
  for (const showAdult of ['false', 1, null, {}]) assert.throws(() => validateConfig({ ...config(), showAdult }), { status: 400 });
  assert.equal(importConfig(current, { api_site: {} }).showAdult, true);
  assert.equal(importConfig(current, { platformlist: [], list: [] }).showAdult, true);
  assert.equal(importConfig(current, config()).showAdult, true);
  assert.equal(importConfig(current, { ...config(), showAdult: false }).showAdult, false);
});

test('subscriptions and live sources validate separately and survive a source-only import', () => {
  const subscription = { id: 'feed', name: '源订阅', url: 'https://example.com/config.json', enabled: false };
  const live = { id: 'tv', name: '直播', url: 'https://example.com/cn.m3u', enabled: true };
  const current = validateConfig({ ...config(), subscriptions: [subscription], liveSources: [live] });
  const result = importConfig(current, { api_site: {} });
  assert.deepEqual(result.subscriptions, [subscription]);
  assert.deepEqual(result.liveSources, [live]);
  assert.deepEqual(validateConfig(config()).subscriptions, []);
  for (const kind of ['subscriptions', 'liveSources']) {
    for (const value of [null, {}, Array(21).fill(subscription), [{ ...subscription, enabled: 'false' }], [{ ...subscription, id: '__proto__' }]]) {
      assert.throws(() => validateConfig({ ...config(), [kind]: value }), { status: 400 });
    }
    assert.throws(() => validateConfig({ ...config(), [kind]: [{ ...subscription, url: 'http://127.0.0.1/list' }] }), { status: 403 });
  }
});

test('player preferences enforce meaningful durations, speeds and boolean switches', () => {
  assert.deepEqual(validatePlayerPreferences({ key: 'film' }), { key: 'film', introSeconds: 0, outroSeconds: 0, autoNext: true, danmakuEnabled: true, danmakuRows: 1, skipAds: false, adRanges: [], speed: 1 });
  assert.equal(validatePlayerPreferences({ key: 'film', speed: 3, introSeconds: 90, outroSeconds: 120 }).speed, 3);
  for (const input of [{ introSeconds: -1 }, { outroSeconds: 601 }, { introSeconds: 1.5 }, { outroSeconds: '30' }, { autoNext: 'false' }, { danmakuEnabled: null }, { speed: 9 }, { speed: '2' }]) {
    assert.throws(() => validatePlayerPreferences({ key: 'film', ...input }), { status: 400 });
  }
});

test('danmaku rows default to one and accept only integer counts from one to ten', () => {
  assert.equal(validatePlayerPreferences({ key: 'film' }).danmakuRows, 1);
  for (const danmakuRows of [1, 4, 10]) assert.equal(validatePlayerPreferences({ key: 'film', danmakuRows }).danmakuRows, danmakuRows);
  for (const danmakuRows of [0, -1, 11, 1.5, NaN, Infinity, null, true, '1', [], {}]) {
    assert.throws(() => validatePlayerPreferences({ key: 'film', danmakuRows }), { status: 400 });
  }
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
  assert.equal(validateRecord({ ...base, category: 'adult' }, true).category, 'adult');
  assert.throws(() => validateRecord({ ...base, category: 'unknown' }, true), { status: 400 });
  assert.equal(validateRecord({ ...base, duration: 100, position: 105 }, true).position, 100);
  for (const position of [-1, Infinity, '10', NaN]) assert.throws(() => validateRecord({ ...base, position }, true), { status: 400 });
  assert.throws(() => validateRecord({ ...base, episode: 1.5 }, true), { status: 400 });
  const link = validateRecord({ key: 'link:https://example.com', title: '网页', url: 'https://example.com', mode: 'parser' }, true);
  assert.equal(link.source, '');
  assert.equal(link.mode, 'parser');
  assert.equal(link.position, 0);
});

test('cloud library history retains opaque asset identity without requiring a temporary playback URL', () => {
  const record = { key: 'quark-library:12345', title: '影片', source: 'quark-library', id: '12345', type: 'movie', url: '', quarkAsset: 'a'.repeat(32), episodeName: '影片.mkv', position: 55, duration: 100 };
  const saved = validateRecord(record, true);
  assert.equal(saved.quarkAsset, record.quarkAsset); assert.equal(saved.url, undefined); assert.equal(saved.episodeName, '影片.mkv');
  for (const value of ['https://example.com/movie', 'private-fid', '', 'a'.repeat(33), 123]) assert.throws(() => validateRecord({ ...record, quarkAsset: value }, true), { status: 400 });
  assert.throws(() => validateRecord({ ...record, source: 'ordinary-source' }, true), { status: 400 });
});
