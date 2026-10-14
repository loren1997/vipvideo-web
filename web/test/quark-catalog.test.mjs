import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuarkCatalog } from '../lib/quark-catalog.mjs';
import { createStore } from '../lib/store.mjs';
import { createRequest } from '../lib/network.mjs';

const ORIGIN = 'https://m.douban.com';
const CACHE_KEY = 'quark-library-douban-v1';
const HOUR = 3600000;
function memoryStore() {
  const values = new Map();
  return { values, meta: key => values.get(key), setMeta: (key, value) => values.set(key, value) };
}
function response(value, statusCode = 200, finalUrl) {
  return Object.assign(Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]), { statusCode, finalUrl, headers: {} });
}
function film(overrides = {}) {
  return { id: '123456', title: '海风来信', type: 'movie', year: '2025', card_subtitle: '2025 / 中国大陆 / 剧情 喜剧 / 导演 / 演员',
    pic: { normal: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p123456.jpg' }, rating: { count: 320, max: 10, value: 8.2 }, is_released: true, comment: '海边的故事。', ...overrides };
}
function fixture(handler, options = {}) {
  const store = options.store || memoryStore(), calls = [];
  const catalog = createQuarkCatalog({ store, ...options, request: async (value, settings) => {
    const url = new URL(value);
    calls.push({ url, settings });
    return handler ? handler(url, settings, calls.length) : response({ items: [film()], total: 1 }, 200, url.href);
  } });
  return { catalog, store, calls };
}

test('official public catalog supplies posters, scores and metadata without source configuration or credentials', async t => {
  const { catalog, calls, store } = fixture();
  t.after(() => catalog.stop());
  const result = await catalog.browse();
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.source, 'quark-library');
  assert.equal(item.id, '123456');
  assert.equal(item.key, 'quark-library:123456');
  assert.equal(item.title, '海风来信');
  assert.equal(item.year, '2025');
  assert.equal(item.type, 'movie');
  assert.equal(item.category, 'movie');
  assert.equal(item.douban.score, 8.2);
  assert.equal(item.douban.votes, 320);
  assert.equal(item.douban.url, 'https://movie.douban.com/subject/123456/');
  assert.equal(item.douban.attribution, '豆瓣公开列表');
  assert.deepEqual(item.genres, ['剧情', '喜剧']);
  assert.deepEqual(item.lines, [{ name: '夸克网盘', episodes: [{ name: '正片' }] }]);
  assert.equal(item.releaseDate, '');
  assert.deepEqual(result.errors, []);
  assert.equal(result.stale, false);
  assert.equal(result.hasMore, false);
  assert.ok(result.facets.genres.includes('惊悚'));
  assert.ok(result.facets.years.includes('2025'));
  assert.ok(result.facets.years.includes('1888'));
  assert.equal(calls[0].url.origin, ORIGIN);
  assert.equal(calls[0].url.pathname, '/rexxar/api/v2/movie/recommend');
  assert.equal(calls[0].url.searchParams.get('sort'), 'U');
  assert.equal(calls[0].settings.followRedirects, false);
  assert.equal(calls[0].settings.timeout, 8000);
  assert.equal(calls[0].settings.headers.cookie, undefined);
  assert.equal(store.values.has('config'), false);
});

test('year and genre are sent to Douban and checked again when upstream ignores one filter', async t => {
  const { catalog, calls } = fixture(url => response({ total: 65, items: [film(), film({ id: '999998', year: '2024' }), film({ id: '999999', card_subtitle: '2025 / 美国 / 恐怖 / 导演' })] }, 200, url.href));
  t.after(() => catalog.stop());
  const result = await catalog.browse({ genre: '喜剧', year: '2025', page: 2, sort: 'score' });
  assert.deepEqual(result.items.map(item => item.id), ['123456']);
  assert.equal(calls[0].url.searchParams.get('tags'), '喜剧,2025');
  assert.equal(calls[0].url.searchParams.get('start'), '20');
  assert.equal(calls[0].url.searchParams.get('count'), '20');
  assert.equal(calls[0].url.searchParams.get('sort'), 'S');
  assert.equal(result.hasMore, true);
});

test('popular released candidates sort by year or real score without pretending popularity is premiere order', async t => {
  const entries = [film({ id: '1', year: '2026', rating: { value: 0, count: 0 } }), film({ id: '2', year: '2025', rating: { value: 9.3, count: 23 } }), film({ id: '3', year: '2026', rating: { value: 8.6, count: 100 } })];
  const { catalog } = fixture(url => response({ items: entries, total: 3 }, 200, url.href));
  t.after(() => catalog.stop());
  assert.deepEqual((await catalog.browse({ sort: 'release' })).items.map(item => item.id), ['3', '1', '2']);
  assert.deepEqual((await catalog.browse({ sort: 'score' })).items.map(item => item.id), ['2', '3', '1']);
  assert.deepEqual((await catalog.browse({ sort: 'release-score' })).items.map(item => item.id), ['3', '1', '2']);
  assert.equal((await catalog.browse()).items.find(item => item.id === '1').douban.score, null);
  assert.match((await catalog.browse()).sortLabel, /热门已上映片目/);
});

test('default catalog excludes announced future titles but keeps genuinely released unrated films', async t => {
  const time = Date.UTC(2026, 9, 14), unrated = { count: 0, value: 0 };
  const entries = [film(), film({ id: '2', is_released: false, rating: { value: 8.9, count: 100 } }),
    film({ id: '3', is_released: undefined, year: '2027' }), film({ id: '4', is_released: undefined, pubdate: ['2026-12-20'] }),
    film({ id: '5', rating: unrated }), film({ id: '6', is_released: undefined, rating: unrated, playable_date: '2026-10-13 00:00:00' }),
    film({ id: '7', is_released: undefined, rating: unrated, pubdate: ['2026-10-12(中国大陆)'] }),
    film({ id: '8', is_released: true, year: '1994', pubdate: ['2026-12-01(重映)'] })];
  const { catalog, calls } = fixture(url => response({ items: entries, total: 8 }, 200, url.href), { now: () => time });
  t.after(() => catalog.stop());
  const items = (await catalog.browse()).items;
  assert.deepEqual(new Set(items.map(item => item.id)), new Set(['123456', '5', '6', '7', '8']));
  assert.ok(items.filter(item => ['5', '6', '7'].includes(item.id)).every(item => item.douban.score === null && item.releaseStatus === 'released'));
  assert.equal(items.find(item => item.id === '6').releaseDate, '');
  assert.equal(calls.length, 1);
});

test('real recommendation fields prioritize popular Chinese rated titles and never treat a user comment as a synopsis', async t => {
  const { catalog, calls } = fixture(url => response({ items: [film({ is_released: undefined, intro: undefined, comment: { comment: '这是用户短评，不是剧情简介。' } })], total: 1 }, 200, url.href));
  t.after(() => catalog.stop());
  const item = (await catalog.browse()).items[0];
  assert.equal(calls[0].url.searchParams.get('sort'), 'U');
  assert.equal(calls.length, 1);
  assert.equal(item.releaseStatus, 'screened');
  assert.equal(item.descriptionLanguage, 'unavailable');
  assert.match(item.description, /暂无中文剧情简介.*2025年电影.*剧情/);
  assert.ok(!item.description.includes('用户短评'));
});

test('an unrated candidate with unknown release status is checked from canonical detail instead of being dropped for score zero', async t => {
  const { catalog, calls } = fixture(url => url.pathname.endsWith('/recommend') ? response({ items: [film({ is_released: undefined, rating: { value: 0, count: 0 } })], total: 1 }, 200, url.href)
    : response(film({ is_released: true, rating: { value: 0, count: 0 }, intro: '这是一个关于故乡的温暖故事。' }), 200, url.href));
  t.after(() => catalog.stop());
  const result = await catalog.browse();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].douban.score, null);
  assert.equal(result.items[0].releaseStatus, 'released');
  assert.equal(result.items[0].descriptionLanguage, 'zh');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, '/rexxar/api/v2/movie/123456');
  assert.deepEqual(result.errors, []);
});

test('release verification checks at most four candidates and reports remaining unknown titles instead of displaying announced ones', async t => {
  const unknown = Array.from({ length: 8 }, (_, i) => film({ id: String(i + 1), is_released: undefined, rating: { count: 0, value: 0 } }));
  const { catalog, calls } = fixture(url => url.pathname.endsWith('/recommend') ? response({ items: [film(), ...unknown], total: 50 }, 200, url.href)
    : response(film({ id: url.pathname.split('/').at(-1), is_released: false, rating: { count: 0, value: 0 } }), 200, url.href));
  t.after(() => catalog.stop());
  const result = await catalog.browse();
  assert.deepEqual(result.items.map(item => item.id), ['123456']);
  assert.equal(calls.length, 5);
  assert.equal(result.hasMore, true);
  assert.ok(result.errors.some(value => value.includes('未核实上映状态')));
});

test('the extra release check has one two-second budget and never discards already loaded valid films on timeout', async t => {
  const signals = [];
  const { catalog, calls } = fixture((url, options) => {
    if (url.pathname.endsWith('/recommend')) return response({ items: [film(), ...Array.from({ length: 8 }, (_, i) => film({ id: String(i + 1), is_released: undefined, rating: { count: 0, value: 0 } }))], total: 50 }, 200, url.href);
    signals.push(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  t.after(() => catalog.stop());
  const started = Date.now(), result = await catalog.browse();
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(result.items.map(item => item.id), ['123456']);
  assert.ok(signals.length <= 2 && signals.length > 0);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(calls.length <= 5);
  assert.ok(result.errors.some(value => value.includes('未核实上映状态')));
});

test('Chinese canonical aliases and descriptions take precedence while foreign synopsis stays explicitly separate', async t => {
  const english = 'A lonely sailor returns home and searches for his family.';
  const { catalog } = fixture(url => response(film({ title: 'Sea Breeze', aka: ['海风来信', '海边来信'], original_title: 'Sea Breeze', intro: english }), 200, url.href));
  t.after(() => catalog.stop());
  const item = await catalog.detail('123456');
  assert.equal(item.title, '海风来信');
  assert.ok(item.aliases.includes('Sea Breeze'));
  assert.equal(item.descriptionLanguage, 'unavailable');
  assert.equal(item.originalDescription, english);
  assert.match(item.description, /^豆瓣暂无中文剧情简介/);
  assert.ok(!item.description.includes('lonely sailor'));
  const chinese = fixture(url => response(film({ intro: '一家人在海边寻找生活的希望。' }), 200, url.href));
  t.after(() => chinese.catalog.stop());
  assert.equal((await chinese.catalog.detail('123456')).descriptionLanguage, 'zh');
  assert.equal((await chinese.catalog.detail('123456')).originalDescription, undefined);
  const japanese = fixture(url => response(film({ intro: '海辺の町で家族を探している少年は新しい生活を始める。' }), 200, url.href));
  t.after(() => japanese.catalog.stop());
  assert.equal((await japanese.catalog.detail('123456')).descriptionLanguage, 'unavailable');
});

test('old cached premiere-order pages are invalidated without touching account or viewing data', async t => {
  const store = memoryStore(), old = fixture(undefined, { store });
  t.after(() => old.catalog.stop());
  await old.catalog.browse();
  const saved = JSON.parse(store.values.get(CACHE_KEY)); saved.version = 2;
  store.values.set(CACHE_KEY, JSON.stringify(saved));
  store.values.set('quark-settings-v1', 'private-account-marker');
  store.values.set('history-marker', 'viewing-data-marker');
  const fresh = fixture(url => response({ items: [film({ id: '2', title: '新目录影片' })], total: 1 }, 200, url.href), { store });
  t.after(() => fresh.catalog.stop());
  assert.deepEqual((await fresh.catalog.browse()).items.map(item => item.title), ['新目录影片']);
  assert.equal(fresh.calls.length, 1);
  assert.equal(store.values.get('quark-settings-v1'), 'private-account-marker');
  assert.equal(store.values.get('history-marker'), 'viewing-data-marker');
});

test('poster lookup stays synchronous and permits only trusted registered image hosts without extra catalog calls', async t => {
  const { catalog, calls } = fixture(url => response({ items: ['img1', 'img2', 'img3', 'img5', 'img9'].map((host, i) => film({ id: String(i + 1), pic: { large: `https://${host}.doubanio.com/view/photo/public/p1.jpg` } })), total: 5 }, 200, url.href));
  t.after(() => catalog.stop());
  assert.equal(catalog.poster('1'), undefined);
  await catalog.browse();
  for (let i = 1; i <= 5; i++) assert.match(catalog.poster(String(i)), /^https:\/\/img[12359]\.doubanio\.com\//);
  assert.equal(catalog.poster('../1'), undefined);
  assert.equal(catalog.poster('https://attacker.test/'), undefined);
  assert.equal(calls.length, 1);
  await catalog.stop();
  assert.equal(catalog.poster('1'), undefined);
});

test('a valid normal-size poster survives an invalid large URL and cached page posters survive bounded subject eviction', async t => {
  const { catalog, calls } = fixture(url => {
    const start = Number(url.searchParams.get('start'));
    return response({ items: Array.from({ length: 20 }, (_, index) => film({ id: String(start + index + 1), pic: { large: 'https://attacker.test/wrong.jpg', normal: 'https://img3.doubanio.com/view/photo/public/p1.jpg' } })), total: 400 }, 200, url.href);
  });
  t.after(() => catalog.stop());
  for (let page = 1; page <= 16; page++) await catalog.browse({ page });
  assert.equal(catalog.poster('1'), 'https://img3.doubanio.com/view/photo/public/p1.jpg');
  const first = await catalog.browse({ page: 1 });
  assert.equal(first.items[0].poster, catalog.poster(first.items[0].id));
  assert.equal(calls.length, 16);
});

test('cached cards respect a newly verified unreleased detail immediately', async t => {
  const { catalog } = fixture(url => url.pathname.endsWith('/recommend') ? response({ items: [film()], total: 1 }, 200, url.href) : response(film({ is_released: false }), 200, url.href));
  t.after(() => catalog.stop());
  assert.equal((await catalog.browse()).items.length, 1);
  assert.equal((await catalog.detail('123456')).releaseStatus, 'upcoming');
  assert.equal((await catalog.browse()).items.length, 0);
});

test('animation merges movie and television identities, genres and categories without confusing film with series', async t => {
  const { catalog, calls } = fixture(url => response({ items: [film({ type: url.pathname.includes('/tv/') ? 'tv' : 'movie', id: url.pathname.includes('/tv/') ? '2' : '1', card_subtitle: '2025 / 日本 / 喜剧 动画 / 导演' }), film({ id: '4', type: 'playlist' }), film({ id: '5', card_subtitle: '2025 / 美国 / 动作' })], total: 3 }, 200, url.href));
  t.after(() => catalog.stop());
  const result = await catalog.browse({ category: 'anime' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.searchParams.get('tags') === '动画'));
  assert.deepEqual(new Set(result.items.map(item => item.type)), new Set(['movie', 'series']));
  assert.ok(result.items.every(item => item.category === 'anime'));
});

test('a film directory rejects TV records even if an upstream recommendation mixes its response kinds', async t => {
  const { catalog } = fixture(url => response({ items: [film(), film({ id: '2', type: 'tv' })], total: 2 }, 200, url.href));
  t.after(() => catalog.stop());
  assert.deepEqual((await catalog.browse()).items.map(item => item.id), ['123456']);
});

test('a partially unavailable animation feed keeps cached matching titles and exposes its error until a short retry', async t => {
  let time = Date.now(), failed = false;
  const { catalog, calls } = fixture(url => {
    if (failed && url.pathname.includes('/tv/')) return response('', 403, url.href);
    return response({ items: [film({ id: url.pathname.includes('/tv/') ? '2' : '1', type: url.pathname.includes('/tv/') ? 'tv' : 'movie', card_subtitle: '2025 / 日本 / 动画' })], total: 30 }, 200, url.href);
  }, { now: () => time });
  t.after(() => catalog.stop());
  assert.equal((await catalog.browse({ category: 'anime' })).items.length, 2);
  time += HOUR + 1;
  failed = true;
  const partial = await catalog.browse({ category: 'anime' });
  assert.equal(partial.items.length, 2);
  assert.equal(partial.stale, true);
  assert.equal(partial.errors.length, 1);
  assert.equal(partial.hasMore, true);
  const cached = await catalog.browse({ category: 'anime' });
  assert.deepEqual(cached.errors, partial.errors);
  assert.equal(calls.length, 4);
  time += 60001;
  failed = false;
  const retried = await catalog.browse({ category: 'anime' });
  assert.deepEqual(retried.errors, []);
  assert.equal(retried.stale, false);
  assert.equal(calls.length, 6);
});

test('television and variety filters stay distinct and require recognizable official identities', async t => {
  const entries = [film({ id: '1', type: 'tv', card_subtitle: '2025 / 中国大陆 / 剧情 喜剧' }), film({ id: '2', type: 'tv', card_subtitle: '2025 / 中国大陆 / 真人秀 音乐' }), film({ id: '3', type: 'tv', card_subtitle: '2025 / 日本 / 动画' })];
  const { catalog, calls } = fixture(url => response({ items: entries, total: 3 }, 200, url.href));
  t.after(() => catalog.stop());
  assert.deepEqual((await catalog.browse({ category: 'tv' })).items.map(item => item.id), ['1']);
  const variety = await catalog.browse({ category: 'variety' });
  assert.ok(variety.items.find(item => item.id === '2'));
  assert.equal(variety.items.find(item => item.id === '2').category, 'variety');
  assert.equal(calls[1].url.searchParams.get('tags'), '综艺');
});

test('adult, invalid identity, unrelated object kinds and untrusted poster hosts are filtered safely', async t => {
  const entries = [film(), film({ id: '2', genres: ['情色'] }), film({ id: '3', is_restrictive: true }), film({ id: '../4' }), film({ id: '5', type: 'playlist' }), film({ id: '6', title: '' }), film({ id: '7', pic: { normal: 'http://127.0.0.1/secret' } }), film({ id: '8', pic: { normal: 'https://doubanio.com.attacker.test/a.jpg' } })];
  const { catalog } = fixture(url => response({ items: entries, total: entries.length }, 200, url.href));
  t.after(() => catalog.stop());
  const result = await catalog.browse();
  assert.deepEqual(result.items.map(item => item.id), ['123456', '7', '8']);
  assert.ok(result.items.filter(item => item.id !== '123456').every(item => item.poster === ''));
});

test('missing, invalid, zero-vote and non-ten-point ratings remain unknown', async t => {
  const ratings = [{}, { value: 0, count: 0 }, { value: 9.9, count: 0 }, { value: true, count: 2 }, { value: 11 }, { value: -1 }, { value: 5, max: 5 }, { value: '8.1', count: 20, max: 10 }];
  const { catalog } = fixture(url => response({ items: ratings.map((rating, index) => film({ id: String(index + 1), rating })), total: ratings.length }, 200, url.href));
  t.after(() => catalog.stop());
  assert.deepEqual((await catalog.browse()).items.sort((a, b) => Number(a.id) - Number(b.id)).map(item => item.douban.score), [null, null, null, null, null, null, null, 8.1]);
});

test('detail has canonical aliases, true premiere dates, verified scores and all known episodes', async t => {
  const { catalog, calls } = fixture(url => url.pathname.endsWith('/recommend') ? response({ items: [film({ type: 'tv' })], total: 1 }, 200, url.href) : response(film({ type: 'tv', genres: ['剧情', '喜剧'], pubdate: ['2025-02-30(错误)', '2025-03-05(中国大陆)', '2025-03-01(试映)'], playable_date: '2026-10-14', original_title: 'Sea Breeze', aka: ['海边来信', 'Sea Breeze'], episodes_count: 24, intro: '完整简介。' }), 200, url.href));
  t.after(() => catalog.stop());
  await catalog.browse({ category: 'tv' });
  const item = await catalog.detail('123456');
  assert.equal(calls[1].url.pathname, '/rexxar/api/v2/tv/123456');
  assert.equal(item.releaseDate, '2025-03-01');
  assert.deepEqual(item.aliases, ['海边来信', 'Sea Breeze']);
  assert.equal(item.description, '完整简介。');
  assert.equal(item.episodeCount, 24);
  assert.equal(item.lines[0].episodes.length, 24);
  assert.equal(item.lines[0].episodes[23].name, '第24集');
  assert.equal(item.douban.attribution, '豆瓣公开条目');
  assert.ok(item.lines[0].episodes.every(episode => !episode.url));
  assert.equal((await catalog.detail('123456')).lines[0].episodes.length, 24);
  assert.equal(calls.length, 2);
});

test('an unlisted numeric ID resolves only from canonical official movie or TV metadata', async t => {
  const { catalog, calls } = fixture(url => url.pathname.includes('/movie/') ? response({}, 404, url.href) : response(film({ type: 'tv', episodes_count: 12 }), 200, url.href));
  t.after(() => catalog.stop());
  assert.equal((await catalog.detail('123456')).type, 'series');
  assert.deepEqual(calls.map(call => call.url.pathname), ['/rexxar/api/v2/movie/123456', '/rexxar/api/v2/tv/123456']);
  for (const id of ['http://127.0.0.1/', '../1', '1?cookie=x', '0', '-1', '9999999999999999999999', true, {}]) await assert.rejects(catalog.detail(id), { status: 400 });
  assert.equal(calls.length, 2);
});

test('official movie-to-TV canonical redirects use one fixed-origin fallback and never follow arbitrary destinations', async t => {
  for (const location of ['https://m.douban.com/rexxar/api/v2/tv/123456', '/rexxar/api/v2/tv/123456']) {
    const { catalog, calls } = fixture(url => url.pathname.includes('/movie/') ? Object.assign(response('', 301, url.href), { headers: { location } }) : response(film({ type: 'tv', episodes_count: 12 }), 200, url.href));
    t.after(() => catalog.stop());
    assert.equal((await catalog.detail('123456')).type, 'series');
    assert.equal(calls.length, 2);
  }
  for (const location of ['http://127.0.0.1/secret', 'https://m.douban.com/rexxar/api/v2/tv/999999', 'https://sec.douban.com/captcha']) {
    const { catalog, calls } = fixture(url => Object.assign(response('', 301, url.href), { headers: { location } }));
    t.after(() => catalog.stop());
    await assert.rejects(catalog.detail('123456'));
    assert.equal(calls.length, 1);
  }
});

test('the real safe transport redirect rejection still permits only a fixed same-ID TV lookup', async t => {
  for (const location of [`${ORIGIN}/rexxar/api/v2/tv/123456`, 'http://127.0.0.1/private']) {
    const calls = [];
    const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: (url, _options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = error => queueMicrotask(() => outgoing.emit('error', error));
      outgoing.end = () => queueMicrotask(() => {
        calls.push(url.href);
        const incoming = url.pathname.includes('/movie/') ? Object.assign(response('', 301), { headers: { location } }) : response(film({ type: 'tv', episodes_count: 40 }));
        outgoing.emit('response', incoming); callback(incoming);
      });
      return outgoing;
    } });
    const catalog = createQuarkCatalog({ store: memoryStore(), request });
    t.after(() => catalog.stop());
    const detail = await catalog.detail('123456');
    assert.equal(detail.type, 'series');
    assert.equal(detail.episodeCount, 40);
    assert.deepEqual(calls, ['https://m.douban.com/rexxar/api/v2/movie/123456', 'https://m.douban.com/rexxar/api/v2/tv/123456']);
  }
});

test('mismatched and adult official details cannot become playable metadata', async t => {
  for (const raw of [film({ id: '654321' }), film({ genres: ['成人'] }), film({ type: 'playlist' })]) {
    const { catalog } = fixture(url => response(raw, 200, url.href));
    t.after(() => catalog.stop());
    await assert.rejects(catalog.detail('123456'));
  }
});

test('bad filters are rejected before any request and cannot turn the catalog into an arbitrary URL proxy', async t => {
  const { catalog, calls } = fixture();
  t.after(() => catalog.stop());
  for (const options of [null, [], { category: 'adult' }, { category: 'https://attacker.test' }, { genre: '情色' }, { genre: '喜剧&url=http://localhost' }, { year: '2025,2026' }, { year: '1800' }, { page: 0 }, { page: 0.5 }, { page: 26 }, { page: -1 }, { sort: 'http://localhost/' }]) await assert.rejects(catalog.browse(options), { status: 400 });
  assert.equal(calls.length, 0);
});

test('offline, verification, redirects, bad JSON and oversized responses report useful failures without fake cards', async t => {
  const cases = [async () => { throw new Error('DNS secret address'); }, async () => response('', 403), async () => response('', 429), async () => response({ items: [film()] }, 200, 'https://sec.douban.com/verify'), async () => response('<html>安全验证</html>'), async () => response({ items: Array(101).fill(film()) }), async () => response('x'.repeat(512 * 1024 + 1))];
  for (const handler of cases) {
    const { catalog } = fixture(handler);
    t.after(() => catalog.stop());
    const result = await catalog.browse();
    assert.deepEqual(result.items, []);
    assert.ok(result.errors.length > 0);
    assert.ok(!JSON.stringify(result).includes('secret address'));
  }
});

test('stale persisted SQLite catalog remains visible during an outage and retries are bounded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vipvideo-quark-catalog-'));
  const store = createStore(directory, { liveSources: [] });
  let time = Date.now(), requests = 0;
  const first = createQuarkCatalog({ store, now: () => time, request: async url => { requests++; return response({ items: [film()], total: 1 }, 200, url); } });
  await first.browse();
  await first.stop();
  store.close();
  const restored = createStore(directory, { liveSources: [] });
  time += HOUR + 1;
  const second = createQuarkCatalog({ store: restored, now: () => time, request: async () => { requests++; return response('', 403); } });
  t.after(async () => { await second.stop(); restored.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await second.browse();
  assert.equal(result.items[0].title, '海风来信');
  assert.equal(result.stale, true);
  assert.match(result.errors[0], /访问受限/);
  await second.browse();
  assert.equal(requests, 2);
});

test('stale detail uses trusted prior metadata on a transient failure and never substitutes another title', async t => {
  let time = Date.now(), fail = false;
  const { catalog } = fixture(url => fail ? response('', 403, url.href) : response(film({ pubdate: ['2025-01-02'], aka: ['Sea Breeze'] }), 200, url.href), { now: () => time });
  t.after(() => catalog.stop());
  assert.equal((await catalog.detail('123456')).releaseDate, '2025-01-02');
  time += 6 * HOUR + 1;
  fail = true;
  const cached = await catalog.detail('123456');
  assert.equal(cached.title, '海风来信');
  assert.equal(cached.stale, true);
  assert.ok(cached.errors.length > 0);
});

test('a refreshed adult classification removes even a previously trusted detail instead of returning stale content', async t => {
  let time = Date.now(), excluded = false;
  const { catalog } = fixture(url => response(film(excluded ? { genres: ['成人'], is_restrictive: true } : {}), 200, url.href), { now: () => time });
  t.after(() => catalog.stop());
  await catalog.detail('123456');
  time += 6 * HOUR + 1;
  excluded = true;
  await assert.rejects(catalog.detail('123456'), { status: 404, excluded: true });
});

test('duplicate catalog requests share work and at most two outbound reads run at once', async t => {
  let active = 0, peak = 0;
  const releases = [];
  const { catalog, calls } = fixture(async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(() => { active--; resolve(); }));
    return response({ items: [film({ type: url.pathname.includes('/tv/') ? 'tv' : 'movie', card_subtitle: '2025 / 日本 / 喜剧 动画' })], total: 1 }, 200, url.href);
  });
  t.after(() => catalog.stop());
  const first = catalog.browse({ category: 'anime' }), duplicate = catalog.browse({ category: 'anime' }), third = catalog.browse({ category: 'movie' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  releases.splice(0).forEach(release => release());
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(release => release());
  const [a, b] = await Promise.all([first, duplicate, third]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
  assert.equal(peak, 2);
  a.items[0].title = 'mutated';
  assert.equal((await catalog.browse({ category: 'anime' })).items[0].title, '海风来信');
});

test('stop cancels pending reads and queued callers, and makes no later outbound requests', async () => {
  const signals = [];
  const { catalog, calls } = fixture(async (_url, settings) => {
    signals.push(settings.signal);
    return new Promise((_, reject) => settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true }));
  });
  const work = [catalog.browse({ category: 'anime' }), catalog.browse({ genre: '喜剧' })];
  const settled = Promise.allSettled(work);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  await catalog.stop();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(calls.length, 2);
  await assert.rejects(catalog.browse({ genre: '动作' }), { status: 503 });
  await assert.rejects(catalog.detail('123456'), { status: 503 });
});

test('one eight-second budget includes lookup, response body and TV fallback without hanging', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { catalog, calls } = fixture(async (url, settings, index) => {
    if (index === 1) return response({}, 404, url.href);
    return new Promise((_, reject) => settings.signal.addEventListener('abort', () => reject(settings.signal.reason), { once: true }));
  });
  const work = catalog.detail('123456');
  const rejected = assert.rejects(work, { status: 504 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(8001);
  await rejected;
  await catalog.stop();
});

test('cache stays bounded and restored values cannot inject poster URLs, identities or adult metadata', async t => {
  const store = memoryStore();
  const items = [film(), film({ id: '2', genres: ['成人'] })];
  const { catalog } = fixture(url => response({ items, total: 500 }, 200, url.href), { store });
  t.after(() => catalog.stop());
  for (let page = 1; page <= 25; page++) await catalog.browse({ page });
  for (let page = 1; page <= 10; page++) await catalog.browse({ page, genre: '喜剧' });
  const saved = JSON.parse(store.values.get(CACHE_KEY));
  assert.equal(saved.pages.length, 32);
  assert.ok(saved.subjects.length <= 300);
  assert.ok(Buffer.byteLength(store.values.get(CACHE_KEY)) <= 2 * 1024 * 1024);
  saved.subjects[0][1].item.poster = 'http://127.0.0.1/private';
  saved.subjects[0][1].item.douban.url = 'https://attacker.test/fake-rating';
  store.values.set(CACHE_KEY, JSON.stringify(saved));
  const restored = createQuarkCatalog({ store, request: async () => response('', 403) });
  t.after(() => restored.stop());
  const detail = await restored.detail('123456');
  assert.equal(detail.poster, '');
  assert.equal(detail.douban.url, 'https://movie.douban.com/subject/123456/');
});
