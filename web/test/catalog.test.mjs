import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCatalog } from '../lib/catalog.mjs';

const config = { sources: [{ id: 'a', name: '甲源', api: 'https://a.example/api.php?token=keep&ids=stale&wd=old', enabled: true }, { id: 'b', name: '乙源', api: 'https://b.example/api.php', enabled: true }] };
function response(list, extra = {}) { return Object.assign(Readable.from([Buffer.from(JSON.stringify({ list, ...extra }))]), { statusCode: 200, headers: {} }); }
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

const classes = [
  { type_id: 1, type_name: '电影', type_pid: 0 },
  { type_id: 2, type_name: '连续剧', type_pid: 0 },
  { type_id: 4, type_name: '动漫', type_pid: 0 },
  { type_id: 6, type_name: '动作片', type_pid: 1 },
  { type_id: 7, type_name: '喜剧片', type_pid: 1 },
  { type_id: 8, type_name: '爱情片', type_pid: 1 },
  { type_id: 9, type_name: '科幻片', type_pid: 1 },
  { type_id: 13, type_name: '国产剧', type_pid: 2 },
  { type_id: 14, type_name: '欧美剧', type_pid: 2 },
  { type_id: 29, type_name: '国产动漫', type_pid: 4 },
  { type_id: 30, type_name: '日韩动漫', type_pid: 4 },
  { type_id: 99, type_name: '伦理片', type_pid: 1 },
];

test('browses real parent categories, keeps business parameters, and excludes mixed and adult content', async () => {
  const calls = [];
  const source = { ...config.sources[0], api: 'https://a.example/api?token=keep&ac=detail&ids=old&wd=old&t=999&pg=88' };
  const catalog = createCatalog({ request: async url => {
    calls.push(new URL(url));
    if (url.searchParams.get('ac') === 'list') return response([], { class: classes });
    const type = url.searchParams.get('t');
    const items = type === '1' ? [
      video(1, '电影样例', '2026', { type_id: 6, type_name: '动作片', vod_remarks: 'HD' }),
      video(2, '电视剧样例', '2026', { type_id: 13, type_name: '国产剧' }),
      video(3, '成人样例', '2026', { type_id: 99, type_name: '伦理片' }),
      video(4, '标签缺失的成人样例', '2026', { type_id: 99, type_name: '其他' }),
      video(5, '另一个成人样例', '2026', { type_name: '成人动画' }),
    ] : [video(type, '分类样例', '2026', { type_id: type === '2' ? 13 : 29, type_name: type === '2' ? '国产剧' : '国产动漫', vod_remarks: '更新至10集' })];
    return response(items, { pagecount: '2' });
  } });
  for (const category of ['movie', 'tv', 'anime']) {
    const result = await catalog.browse({ sources: [source] }, { category });
    assert.equal(result.category, category);
    assert.equal(result.page, 1);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].category, category);
    assert.equal(result.groups[0].type, category === 'movie' ? 'movie' : 'series');
    assert.equal(result.groups[0].remarks, category === 'movie' ? 'HD' : '更新至10集');
    assert.equal(result.groups[0].items[0].remarks, result.groups[0].remarks);
    assert.equal(result.groups[0].items[0].typeName, result.groups[0].typeName);
    assert.equal('quality' in result.groups[0], false);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.failedSources, []);
  }
  assert.equal(calls.filter(url => url.searchParams.get('ac') === 'list').length, 1);
  assert.deepEqual(calls.slice(1).map(url => url.searchParams.get('t')), ['1', '2', '4']);
  for (const url of calls) {
    assert.equal(url.searchParams.get('token'), 'keep');
    assert.equal(url.searchParams.has('wd'), false);
    assert.equal(url.searchParams.has('ids'), false);
    assert.equal(url.searchParams.get('pg'), url.searchParams.get('ac') === 'list' ? null : '1');
  }
});

for (const withParents of [true, false]) test(`falls back from empty parent to at most three matching leaves (${withParents ? 'with' : 'without'} type_pid)`, async () => {
  const calls = [];
  const catalog = createCatalog({ request: async url => {
    if (url.searchParams.get('ac') === 'list') return response([], { class: withParents ? classes : classes.map(({ type_pid, ...type }) => type) });
    const type = url.searchParams.get('t');
    calls.push(type);
    return response(type === '1' ? [] : [video(type, `分类 ${type}`, '2026', { type_id: type, type_name: classes.find(item => String(item.type_id) === type).type_name })], { pagecount: type === '6' ? 3 : 1 });
  } });
  const result = await catalog.browse({ sources: [config.sources[0]] });
  assert.deepEqual(calls, ['1', '6', '7', '8']);
  assert.equal(result.groups.length, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.failedSources, []);
});

test('isolates source failures, supports one source, and reports the last page', async () => {
  const calls = [];
  const catalog = createCatalog({ request: async url => {
    calls.push(new URL(url));
    if (url.hostname === 'b.example') throw new Error('unavailable');
    if (url.searchParams.get('ac') === 'list') return response([], { class: classes });
    return response([video(1, '正常结果', '2026', { type_name: '动作片' })], { pagecount: '2' });
  } });
  const result = await catalog.browse(config);
  assert.equal(result.groups[0].items[0].source, 'a');
  assert.deepEqual(result.failedSources.map(item => item.source), ['b']);
  assert.equal(result.hasMore, true);
  const before = calls.length;
  const selected = await catalog.browse(config, { source: 'a', page: '2' });
  assert.equal(selected.page, 2);
  assert.equal(selected.hasMore, false);
  assert.deepEqual(selected.failedSources, []);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).searchParams.get('pg'), '2');
});

test('uses real type names when class is absent and rejects unidentifiable mixed results', async () => {
  const calls = [];
  const catalog = createCatalog({ request: async url => {
    calls.push(new URL(url));
    if (url.searchParams.get('ac') === 'list') return response([]);
    return response([
      video(1, '电影', '2026', { type_name: '科幻片' }),
      video(2, '电视剧', '2026', { type_name: '国产剧' }),
      video(3, '动漫', '2026', { type_name: '日韩动漫' }),
      video(4, '综艺', '2026', { type_name: '综艺' }),
      video(5, '成人', '2026', { type_name: '福利电影' }),
    ], { total: 40, limit: 20 });
  } });
  const result = await catalog.browse({ sources: [config.sources[0]] });
  assert.deepEqual(result.groups.map(group => group.title), ['电影']);
  assert.equal(result.hasMore, true);
  assert.equal(calls[1].searchParams.has('t'), false);
  const unknown = createCatalog({ request: async () => response([video(1, '未知分类')]) });
  const rejected = await unknown.browse({ sources: [config.sources[0]] });
  assert.equal(rejected.groups.length, 0);
  assert.match(rejected.failedSources[0].error, /可识别的影片分类/);
});

test('validates browse category, strict page strings, and disabled or missing sources', async () => {
  let calls = 0;
  const catalog = createCatalog({ request: async () => { calls++; return response([]); } });
  for (const category of ['', 'series', 'variety', null, {}, ['movie']]) await assert.rejects(catalog.browse(config, { category }), { status: 400 });
  for (const page of ['', '01', ' 1', '1.0', '1e0', '101', 0, -1, 101, 1.5, NaN, null, {}, [1]]) await assert.rejects(catalog.browse(config, { page }), { status: 400 });
  for (const source of ['', 'missing', null]) await assert.rejects(catalog.browse(config, { source }), { status: 400 });
  await assert.rejects(catalog.browse({ sources: [{ ...config.sources[0], enabled: false }] }, { source: 'a' }), { status: 400 });
  assert.equal(calls, 0);
  assert.deepEqual(await catalog.browse({ sources: [] }), { category: 'movie', page: 1, groups: [], failedSources: [], hasMore: false });
});

test('caches classifications and pages without leaking mutable results, then refreshes expiry and config changes', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const catalog = createCatalog({ request: async url => {
    calls++;
    if (url.searchParams.get('ac') === 'list') return response([], { class: classes });
    return response([video(1, url.hostname, '2026', { type_name: '动作片' })], { pagecount: 3 });
  } });
  const state = { sources: [{ ...config.sources[0] }] };
  const first = await catalog.browse(state);
  first.groups[0].title = '调用方修改';
  assert.equal((await catalog.browse(state)).groups[0].title, 'a.example');
  assert.equal(calls, 2);
  await Promise.all([catalog.browse(state, { page: 2 }), catalog.browse(state, { page: 2 })]);
  assert.equal(calls, 3);
  state.sources[0].api = 'https://changed.example/api';
  assert.equal((await catalog.browse(state)).groups[0].title, 'changed.example');
  assert.equal(calls, 5);
  now += 180001;
  await catalog.browse(state);
  assert.equal(calls, 7);
  state.sources[0].enabled = false;
  assert.equal((await catalog.browse(state)).groups.length, 0);
  assert.equal(calls, 7);
  state.sources[0].enabled = true;
  await catalog.browse(state);
  assert.equal(calls, 9);
});

test('preserves TV keys from a line-free category list through search and multi-episode detail', async () => {
  const catalog = createCatalog({ request: async url => {
    if (url.searchParams.get('ac') === 'list') return response([], { class: classes });
    const full = url.searchParams.has('ids');
    return response([video(13, '国产剧样例', '2026', {
      type_id: 13, type_name: '国产剧', vod_remarks: '全24集',
      vod_play_url: full ? '第1集$https://cdn.example/1.m3u8#第2集$https://cdn.example/2.m3u8' : '',
    })], { pagecount: 1 });
  } });
  const local = { sources: [config.sources[0]] };
  const browse = await catalog.browse(local, { category: 'tv' });
  const search = await catalog.search(local, '国产剧样例');
  const detail = await catalog.detail(local, 'a', '13');
  assert.equal(browse.groups[0].type, 'series');
  assert.equal(browse.groups[0].key, search.groups[0].key);
  assert.equal(search.groups[0].key, detail.key);
  assert.equal(detail.lines[0].episodes.length, 2);
  assert.equal(detail.remarks, '全24集');
});

test('keeps an explicit animation movie as a movie across browsing and detail', async () => {
  const catalog = createCatalog({ request: async url => url.searchParams.get('ac') === 'list' ? response([], { class: classes }) : response([video(5, '动画电影样例', '2026', { type_name: '动画电影' })], { pagecount: 1 }) });
  const local = { sources: [config.sources[0]] };
  const browse = await catalog.browse(local, { category: 'anime' });
  const detail = await catalog.detail(local, 'a', '5');
  assert.equal(browse.groups[0].type, 'movie');
  assert.equal(browse.groups[0].key, detail.key);
});

test('inherits the movie directory for an animation film without letting the browse hint change its key', async () => {
  const catalog = createCatalog({ request: async url => url.searchParams.get('ac') === 'list'
    ? response([], { class: [...classes, { type_id: 42, type_name: '动画片', type_pid: 1 }] })
    : response([video(42, '动画片样例', '2026', { type_id: 42, type_name: '动画片' })], { pagecount: 1 }) });
  const local = { sources: [config.sources[0]] };
  const browse = await catalog.browse(local, { category: 'movie' });
  const detail = await catalog.detail(local, 'a', '42');
  assert.equal(browse.groups[0].category, 'movie');
  assert.equal(browse.groups[0].type, 'movie');
  assert.equal(detail.type, 'movie');
  assert.equal(browse.groups[0].key, detail.key);
});

test('shares short detail cache for detail then playback, but rechecks source access and API changes', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const catalog = createCatalog({ request: async url => { calls++; return response([video(1, url.hostname)]); } });
  const state = { sources: [{ ...config.sources[0] }] };
  const [detail, playback] = await Promise.all([catalog.detail(state, 'a', '1'), catalog.detail(state, 'a', '1')]);
  assert.equal(calls, 1);
  assert.deepEqual(detail, playback);
  detail.title = '调用方修改';
  assert.equal((await catalog.detail(state, 'a', '1')).title, 'a.example');
  state.sources[0].enabled = false;
  await assert.rejects(catalog.detail(state, 'a', '1'), { status: 400 });
  assert.equal(calls, 1);
  state.sources[0].enabled = true;
  state.sources[0].api = 'https://changed.example/api';
  assert.equal((await catalog.detail(state, 'a', '1')).title, 'changed.example');
  assert.equal(calls, 2);
  now += 30001;
  await catalog.detail(state, 'a', '1');
  assert.equal(calls, 3);
});

test('limits concurrent browse, search and detail upstream requests to three together', async () => {
  let active = 0;
  let maximum = 0;
  const catalog = createCatalog({ request: async url => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (url.searchParams.get('ac') === 'list') return response([], { class: classes });
    return response([video(1, '聚合样例', '2026', { type_name: url.searchParams.get('t') === '2' ? '国产剧' : '动作片' })], { pagecount: 1 });
  } });
  const state = { sources: Array.from({ length: 8 }, (_, index) => ({ id: String(index), name: String(index), api: `https://s${index}.example/api` })) };
  const [movie, tv, search] = await Promise.all([catalog.browse(state), catalog.browse(state, { category: 'tv' }), catalog.search(state, '聚合'), catalog.detail(state, '0', '1')]);
  assert.equal(maximum, 3);
  assert.equal(movie.groups[0].items.length, 8);
  assert.equal(tv.groups[0].items.length, 8);
  assert.equal(search.groups[0].items.length, 8);
});

test('expires a browsing request after eight seconds and allows a later retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready = false;
  let classCalls = 0;
  const catalog = createCatalog({ request: async url => {
    if (url.searchParams.get('ac') === 'list') { classCalls++; return response([], { class: classes }); }
    if (!ready) return new Promise(() => {});
    return response([video(1, '重试成功', '2026', { type_name: '动作片' })], { pagecount: 1 });
  } });
  const state = { sources: [config.sources[0]] };
  const pending = catalog.browse(state);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(8000);
  assert.equal((await pending).failedSources[0].error, '影视源请求超时');
  ready = true;
  assert.equal((await catalog.browse(state)).groups[0].title, '重试成功');
  assert.equal(classCalls, 1);
});

const adultClasses = [
  ...classes,
  { type_id: 100, type_name: '成人国产剧', type_pid: 2 },
  { type_id: 101, type_name: '成人国产动漫', type_pid: 4 },
  { type_id: 102, type_name: '中性子分类', type_pid: 99 },
];
function adultFixtures() {
  return [
    video(1, '限制级标识研究', '2026', { type_id: 6, type_name: '动作片', vod_content: '讨论成人与限制级分类标识', vod_remarks: '更新至18集' }),
    video(102, '限制级测试影片 102', '2026', { type_id: 102, type_name: '剧情片' }),
    video(100, '限制级测试影片 100', '2026', { type_id: 100, type_name: '国产剧' }),
    video(101, '限制级测试影片 101', '2026', { type_id: 101, type_name: '国产动漫' }),
    video(201, '限制级测试影片 201', '2026', { type_id: 6, type_name: '动作片', vod_class: '剧情,限制级' }),
    video(202, '限制级测试影片 202', '2026', { type_id: 6, type_name: '动作片', vod_type_name: '成人电影' }),
    video(203, '限制级测试影片 203', '2026', { type_id: 6, type_name: '动作片', vod_remarks: 'R18+' }),
    video(204, '限制级测试影片 204', '2026', { type_id: 6, type_name: '动作片', vod_tag: '18禁' }),
    video(205, '限制级测试影片 205', '2026', { type_id: 6, type_name: '三级电影' }),
  ];
}

test('hides adult search results by default using classes and explicit labels, then responds immediately to the switch', async () => {
  const catalog = createCatalog({ request: async () => response(adultFixtures(), { class: adultClasses }) });
  const state = { sources: [config.sources[0]] };
  const hidden = await catalog.search(state, '测试');
  assert.deepEqual(hidden.groups.map(group => group.title), ['限制级标识研究']);
  state.showAdult = true;
  const visible = await catalog.search(state, '测试');
  assert.equal(visible.groups.length, adultFixtures().length);
  assert.equal(visible.groups[0].category, 'movie');
  assert.ok(visible.groups.slice(1).every(group => group.category === 'adult' && group.items[0].category === 'adult'));
  assert.equal(visible.groups.find(group => group.items[0].id === '203').remarks, 'R18+');
  assert.equal(visible.groups.find(group => group.items[0].id === '100').type, 'series');
  state.showAdult = false;
  assert.deepEqual((await catalog.search(state, '测试')).groups.map(group => group.title), ['限制级标识研究']);
});

test('requires explicit adult browsing permission, preserves true movie or series keys, and never mixes normal directories', async () => {
  let calls = 0;
  const fixtures = adultFixtures();
  const catalog = createCatalog({ request: async url => {
    calls++;
    if (url.searchParams.get('ac') === 'list') return response([], { class: adultClasses });
    const type = url.searchParams.get('t');
    return response(['100', '101', '102'].includes(type) ? fixtures.filter(item => String(item.type_id) === type) : [
      ...fixtures,
      video(2, '普通电视剧样例', '2026', { type_id: 13, type_name: '国产剧' }),
      video(3, '普通动漫样例', '2026', { type_id: 29, type_name: '国产动漫' }),
    ], { pagecount: 1 });
  } });
  const state = { sources: [config.sources[0]] };
  await assert.rejects(catalog.browse(state, { category: 'adult' }), { status: 403, message: '三级内容已隐藏，请先在设置中开启显示' });
  assert.equal(calls, 0);
  state.showAdult = true;
  const adult = await catalog.browse(state, { category: 'adult' });
  assert.equal(adult.groups.length, 3);
  assert.ok(adult.groups.every(group => group.category === 'adult' && group.items[0].category === 'adult'));
  assert.deepEqual(adult.groups.map(group => group.type), ['series', 'series', 'movie']);
  for (const category of ['movie', 'tv', 'anime']) {
    const result = await catalog.browse(state, { category });
    assert.equal(result.groups.length, 1);
    assert.ok(result.groups.every(group => group.category === category));
    assert.ok(result.groups.every(group => !group.items.some(item => item.category === 'adult')));
  }
  state.showAdult = false;
  await assert.rejects(catalog.browse(state, { category: 'adult' }), { status: 403 });
  assert.equal((await catalog.browse(state)).groups[0].title, '限制级标识研究');
});

test('rechecks adult detail visibility after a successful cache hit and refuses hidden labeled details', async () => {
  let calls = 0;
  const fixtures = adultFixtures();
  const catalog = createCatalog({ request: async url => { calls++; return response(fixtures.filter(item => String(item.vod_id) === url.searchParams.get('ids')), { class: adultClasses }); } });
  const state = { sources: [config.sources[0]], showAdult: true };
  const detail = await catalog.detail(state, 'a', '102');
  assert.equal(detail.category, 'adult');
  assert.equal(detail.type, 'movie');
  state.showAdult = false;
  await assert.rejects(catalog.detail(state, 'a', '102'), { status: 403, message: '三级内容已隐藏，请先在设置中开启显示' });
  assert.equal(calls, 1);
  await assert.rejects(catalog.detail(state, 'a', '201'), { status: 403 });
  assert.equal(calls, 2);
  state.showAdult = true;
  assert.equal((await catalog.detail(state, 'a', '102')).key, detail.key);
  assert.equal(calls, 2);
});

test('loads a shared class map to identify neutral descendants of adult classes in search and detail', async () => {
  let classCalls = 0;
  let videoCalls = 0;
  const item = adultFixtures().find(item => item.vod_id === 102);
  const catalog = createCatalog({ request: async url => {
    if (url.searchParams.get('ac') === 'list') { classCalls++; return response([], { class: adultClasses }); }
    videoCalls++;
    return response([item]);
  } });
  const state = { sources: [config.sources[0]] };
  assert.equal((await catalog.search(state, '测试')).groups.length, 0);
  state.showAdult = true;
  assert.equal((await catalog.search(state, '测试')).groups[0].category, 'adult');
  assert.equal((await catalog.detail(state, 'a', '102')).category, 'adult');
  assert.equal(classCalls, 1);
  assert.equal(videoCalls, 3);
  state.showAdult = false;
  await assert.rejects(catalog.detail(state, 'a', '102'), { status: 403 });
  assert.equal(videoCalls, 3);
});

test('uses explicit labels without an adult class and keeps a mixed-source group restricted', async () => {
  for (const classList of [[], classes.filter(type => type.type_id !== 99)]) {
  const catalog = createCatalog({ request: async url => url.searchParams.get('ac') === 'list' ? response([], { class: classList }) : response([
    video(1, '中性分类样例', '2026', { type_name: '剧情片' }),
    video(2, '中性分类样例', '2026', { type_name: '剧情片', vod_tag: '三级' }),
    video(3, '限制级测试影片', '2026', { type_name: '动画电影', vod_class: '限制级' }),
  ], { pagecount: 1 }) });
  const state = { sources: [config.sources[0]], showAdult: true };
  const adult = await catalog.browse(state, { category: 'adult' });
  assert.deepEqual(adult.groups.map(group => group.items[0].id), ['2', '3']);
  const search = await catalog.search(state, '样例');
  assert.equal(search.groups[0].category, 'adult');
  assert.equal(search.groups[0].items.length, 2);
  state.showAdult = false;
  const hidden = await catalog.search(state, '样例');
  assert.equal(hidden.groups[0].category, 'movie');
  assert.deepEqual(hidden.groups[0].items.map(item => item.id), ['1']);
  }
});
