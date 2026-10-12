import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCatalog } from '../lib/catalog.mjs';

const config = { sources: [{ id: 'a', name: '甲源', api: 'https://a.example/api.php?token=keep&ids=stale&wd=old', enabled: true }, { id: 'b', name: '乙源', api: 'https://b.example/api.php', enabled: true }] };
function response(list) { return Object.assign(Readable.from([Buffer.from(JSON.stringify({ list }))]), { statusCode: 200, headers: {} }); }
function video(id, title = '影片', year = '2026', extra = {}) { return { vod_id: id, vod_name: title, vod_year: year, vod_play_from: '直链', vod_play_url: '正片$https://cdn.example/v.mp4?token=a%2Fb&dollar=$keep', ...extra }; }

test('aggregates matching title/year/type with all sources while preserving query tokens', async () => {
  const calls = [];
  const catalog = createCatalog({ request: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(url.hostname === 'a.example' ? [video(1, '影 片'), video(2, '影片', '2025'), video(3, '影片', '2026', { type_name: '连续剧' })] : [video(9)]);
  } });
  const result = await catalog.search(config, '  影片  ');
  assert.equal(result.groups.length, 3);
  assert.deepEqual(result.groups[0].items.map(item => item.source), ['a', 'b']);
  assert.deepEqual(result.failedSources, []);
  assert.equal(calls[0].url.searchParams.get('token'), 'keep');
  assert.equal(calls[0].url.searchParams.get('ac'), 'videolist');
  assert.equal(calls[0].url.searchParams.get('wd'), '影片');
  assert.equal(calls[0].url.searchParams.has('ids'), false);
  assert.equal(calls[0].options.timeout, 8000);
});

test('preserves every line, episode and URL query when reading detail', async () => {
  const catalog = createCatalog({ request: async url => {
    assert.equal(url.searchParams.get('ids'), '7');
    assert.equal(url.searchParams.has('wd'), false);
    return response([video(7, '连续影片', '2026', { vod_play_from: '高清$$$备用$$$网页', vod_play_url: '第01集$https://cdn.example/1.m3u8?token=a%2Fb&x=$value#第02集$https://cdn.example/2.m3u8?token=two$$$第01集$https://cdn.example/1.mp4?token=mp4$$$解析$https://jx.example/player?url=https%3A%2F%2Fv.example%2Fwatch', vod_content: '<p>影片简介</p><script>alert(1)</script>' })]);
  } });
  const result = await catalog.detail(config, 'a', '7');
  assert.equal(result.type, 'series');
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines[0].episodes.length, 2);
  assert.equal(result.lines[0].episodes[0].type, 'hls');
  assert.equal(result.lines[0].episodes[0].url, 'https://cdn.example/1.m3u8?token=a%2Fb&x=$value');
  assert.equal(result.lines[1].episodes[0].type, 'mp4');
  assert.equal(result.lines[2].episodes[0].type, 'page');
  assert.equal(result.description, '影片简介');
});

test('recognizes extensionless HLS playback from AppleCMS line hints', async () => {
  const catalog = createCatalog({ request: async () => response([video(5, '影片', '2026', { vod_play_from: 'ffm3u8$$$MP4$$$解析', vod_play_url: '正片$https://cdn.example/play?token=hls$$$正片$https://cdn.example/play?token=mp4$$$网页$https://jx.example/?url=https%3A%2F%2Fcdn.example%2Fmovie.m3u8' })]) });
  const result = await catalog.detail(config, 'a', '5');
  assert.deepEqual(result.lines.map(line => line.episodes[0].type), ['hls', 'mp4', 'page']);
});

test('returns successful source results along with source failures', async () => {
  const catalog = createCatalog({ request: async url => {
    if (url.hostname === 'b.example') throw Object.assign(new Error('影视源请求超时'), { status: 502 });
    return response([video(1)]);
  } });
  const result = await catalog.search(config, '影片');
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.failedSources, [{ source: 'b', name: '乙源', error: '影视源请求超时' }]);
});

test('never runs more than three source requests together', async () => {
  let active = 0;
  let maximum = 0;
  const catalog = createCatalog({ request: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return response([video(1)]);
  } });
  const sources = Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: String(index), api: 'https://video.example/api' }));
  const result = await catalog.search({ sources }, '影片');
  assert.equal(maximum, 3);
  assert.equal(result.groups[0].items.length, 8);
});

test('enforces an eight-second deadline even before response headers arrive', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = createCatalog({ request: () => new Promise(() => {}) });
  const pending = catalog.search({ sources: [config.sources[0]] }, '影片');
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(result.failedSources[0].error, '影视源请求超时');
});

test('validates search and detail identifiers and ignores disabled sources', async () => {
  const catalog = createCatalog({ request: async () => response([]) });
  await assert.rejects(catalog.search(config, ''), { status: 400 });
  await assert.rejects(catalog.search(config, 'x'.repeat(101)), { status: 400 });
  await assert.rejects(catalog.detail(config, 'missing', '1'), { status: 400 });
  await assert.rejects(catalog.detail(config, 'a', '\u0000'), { status: 400 });
  await assert.rejects(catalog.detail(config, 'a', '1'), /影片不存在/);
  assert.deepEqual(await catalog.search({ sources: [{ ...config.sources[0], enabled: false }] }, '影片'), { groups: [], failedSources: [] });
});
