import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { catalogLanguage } from '../lib/catalog-filters.mjs';
import { createNetflixCatalog, isNetflixId } from '../lib/netflix-catalog.mjs';

const TOKEN = 'fake.tmdb.read-token';
const NOW = Date.parse('2026-10-20T00:00:00Z');
const movie = (id, extra = {}) => ({ id, title: `影片 ${id}`, adult: false, genre_ids: [18], release_date: '2025-01-01', vote_count: 25,
  vote_average: 8, poster_path: '/title.jpg', ...extra });
const tv = (id, extra = {}) => ({ id, name: `剧集 ${id}`, adult: false, genre_ids: [18], first_air_date: '2024-01-01', origin_country: ['JP'], ...extra });
const query = extra => ({ category: 'movie', sort: 'release-score', page: 1, ...extra });
const providerList = [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 1796, provider_name: 'Netflix Standard with Ads' },
  { provider_id: 459, provider_name: 'Netflix Free' }, { provider_id: 9, provider_name: 'Amazon Prime Video' }];
const response = (url, data, statusCode = 200, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), { statusCode, headers, finalUrl: url.href });
const list = (rows, page, emptyPages = 0) => ({
  page, results: rows.slice((page - 1) * 20, page * 20), total_results: rows.length, total_pages: rows.length ? Math.ceil(rows.length / 20) : emptyPages,
});

function mockRequest({ discover, detail, countries = ['JP', 'US', 'US', '../untrusted'] } = {}) {
  const calls = [];
  async function request(address, options) {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.equal(url.searchParams.has('api_key'), false);
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(options.followRedirects, false);
    if (options.signal.aborted) throw options.signal.reason;
    calls.push(url);
    if (url.pathname === '/3/watch/providers/regions') return response(url, { results: countries.map(iso_3166_1 => ({ iso_3166_1 })) });
    if (/^\/3\/watch\/providers\/(movie|tv)$/.test(url.pathname)) return response(url, { results: providerList });
    if (/^\/3\/discover\/(movie|tv)$/.test(url.pathname)) {
      assert.equal(url.searchParams.get('with_watch_providers'), '8|1796|459');
      assert.equal(url.searchParams.get('with_watch_monetization_types'), 'flatrate|free|ads');
      assert.equal(url.searchParams.get('include_adult'), 'false');
      return discover(url);
    }
    return detail(url);
  }
  return { request, calls };
}

async function settled(catalog, values = query()) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = catalog.browse(values);
    if (!result.syncing) return result;
    await delay(10);
  }
  assert.fail('TMDB fixture sync did not settle');
}

test('catalog languages normalize Chinese audio aliases independently of production country and subtitles', () => {
  for (const raw of ['zh', 'cn', 'cmn', 'yue', 'ＺＨ', '汉语普通话', '粵語', 'Cantonese', 'zh-Hant']) assert.equal(catalogLanguage(raw), 'zh');
  for (const [raw, code] of [['英语', 'en'], ['jpn', 'ja'], ['韓文', 'ko'], ['por', 'pt'], ['fil', 'fil']]) assert.equal(catalogLanguage(raw), code);
  for (const raw of ['中文字幕', '中国大陆', 'unknown', 'und', 'all', '']) assert.equal(catalogLanguage(raw), '');
});

test('Netflix library unions every discovered region, excludes non-Netflix providers and paginates beyond page 25', async t => {
  const source = mockRequest({
    discover(url) {
      const region = url.searchParams.get('watch_region'), page = Number(url.searchParams.get('page'));
      const rows = url.pathname.endsWith('/tv') ? region === 'JP' ? [tv(1), tv(2, { genre_ids: [16] }), tv(3, { genre_ids: [10764] }), tv(4, { name: '幻想录（AI 漫剧）', genre_ids: [16] })] : []
        : region === 'JP' ? [movie(1), movie(760, { title: '日本限定', genre_ids: [16], origin_country: ['JP'], release_date: '2026-01-01' })]
          : [...Array.from({ length: 759 }, (_, index) => movie(index + 1, { origin_country: ['US'] })), movie(761, { adult: true })];
      return response(url, list(rows, page, 1));
    },
  });
  const catalog = createNetflixCatalog({ token: TOKEN, now: () => NOW, request: source.request });
  t.after(() => catalog.stop());
  const pending = catalog.browse(query());
  assert.equal(pending.syncing, true);
  assert.deepEqual(pending.items, []);
  assert.deepEqual(pending.coverageRegions, []);
  const catalogPage = await settled(catalog);
  assert.equal(catalogPage.total, 760);
  assert.equal(catalogPage.items.length, 30);
  assert.equal(catalogPage.updatedAt, NOW);
  assert.deepEqual(catalogPage.coverageRegions, ['JP', 'US']);
  assert.deepEqual(catalogPage.items[0].availabilityRegions, ['JP']);
  assert.equal(catalogPage.items[0].title, '日本限定');
  assert.deepEqual(catalogPage.items[1].availabilityRegions, ['JP', 'US']);
  assert.equal(catalogPage.attribution, 'TMDB · JustWatch');
  assert.ok(catalogPage.hasMore);
  const collected = new Set();
  for (let page = 1; page <= 26; page++) {
    const catalogPage = catalog.browse(query({ page }));
    assert.equal(catalogPage.items.length, page === 26 ? 10 : 30);
    assert.equal(catalogPage.hasMore, page < 26);
    for (const item of catalogPage.items) {
      assert.ok(!collected.has(item.id));
      collected.add(item.id);
    }
  }
  assert.equal(collected.size, 760);
  assert.ok(!collected.has('tmdb:movie:761'));
  assert.deepEqual(catalog.browse(query({ category: 'tv' })).items.map(item => item.id), ['tmdb:tv:1']);
  assert.deepEqual(catalog.browse(query({ category: 'anime' })).items.map(item => item.id), ['tmdb:tv:2']);
  assert.deepEqual(catalog.browse(query({ category: 'motion-comic' })).items.map(item => item.id), ['tmdb:tv:4']);
  assert.deepEqual(catalog.browse(query({ category: 'variety' })).items.map(item => item.id), ['tmdb:tv:3']);
  assert.deepEqual(catalog.browse(query({ genre: '动画', year: '2026', country: '日本' })).items.map(item => [item.id, item.type, item.category, item.typeName]), [['tmdb:movie:760', 'movie', 'movie', '电影']]);
  assert.equal(catalog.poster('tmdb:movie:760'), 'https://image.tmdb.org/t/p/w342/title.jpg');
  assert.equal(source.calls.filter(url => url.pathname.endsWith('/regions')).length, 1);
});

test('Netflix retains the complete saved union across restart and failed region refresh', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-netflix-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const source = mockRequest({ discover(url) { return response(url, list(url.pathname.endsWith('/movie') ? [movie(111)] : [], 1)); } });
  const catalog = createNetflixCatalog({ token: TOKEN, now: () => NOW, request: source.request, dataDir });
  const current = await settled(catalog);
  assert.equal(current.total, 1);
  await catalog.stop();
  const failing = mockRequest({ discover(url) {
    return url.searchParams.get('watch_region') === 'US' ? response(url, {}, 429, { 'retry-after': '3600' })
      : response(url, list(url.pathname.endsWith('/movie') ? [movie(222)] : [], 1));
  } });
  const restarted = createNetflixCatalog({ token: TOKEN, now: () => NOW + 90000000, request: failing.request, dataDir });
  t.after(() => restarted.stop());
  const reloading = restarted.browse(query());
  assert.ok(reloading.stale && reloading.syncing);
  assert.deepEqual(reloading.items.map(item => item.id), ['tmdb:movie:111']);
  const stale = await settled(restarted);
  assert.ok(stale.stale);
  assert.match(stale.errors[0], /请求受限/);
  assert.deepEqual(stale.items.map(item => item.id), ['tmdb:movie:111']);
  assert.equal(stale.updatedAt, NOW);
});

test('Netflix exposes the staged first load and resumes only failed markets across retry and restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-netflix-resume-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const countries = ['DE', 'JP', 'US'];
  const first = mockRequest({ countries, discover(url) {
    const region = url.searchParams.get('watch_region'), page = Number(url.searchParams.get('page'));
    if (region === 'JP') return response(url, { message: TOKEN }, 404);
    const rows = url.pathname.endsWith('/tv') ? [] : region === 'DE' ? Array.from({ length: 35 }, (_, index) => movie(index + 1))
      : Array.from({ length: 31 }, (_, index) => movie(index + 35));
    return response(url, list(rows, page));
  } });
  let now = NOW;
  const catalog = createNetflixCatalog({ token: TOKEN, request: first.request, dataDir, now: () => now });
  t.after(() => catalog.stop());
  const partial = await settled(catalog);
  assert.ok(partial.provisional);
  assert.equal(partial.unavailable, false);
  assert.equal(partial.updatedAt, NOW);
  assert.deepEqual(partial.coverageRegions, ['DE', 'US']);
  assert.deepEqual(partial.syncProgress, { completed: 2, total: 3 });
  assert.match(partial.errors[0], /JP 电影第 1 页/);
  assert.ok(!partial.errors[0].includes(TOKEN));
  assert.equal(partial.items.length, 30);
  assert.ok(partial.hasMore);
  assert.equal(catalog.browse(query({ page: 2 })).items.length, 30);
  assert.equal(catalog.browse(query({ page: 3 })).items.length, 5);
  assert.equal(catalog.poster('tmdb:movie:62'), 'https://image.tmdb.org/t/p/w342/title.jpg');
  const before = first.calls.length;
  assert.equal(catalog.browse(query()).syncing, false);
  assert.equal(first.calls.length, before);
  now += 11 * 60000;
  assert.ok((await settled(catalog)).provisional);
  assert.deepEqual(first.calls.slice(before).map(url => url.searchParams.get('watch_region')).filter(Boolean), ['JP']);
  await catalog.stop();

  const restart = mockRequest({ countries, discover(url) {
    assert.equal(url.searchParams.get('watch_region'), 'JP');
    return response(url, list(url.pathname.endsWith('/movie') ? [movie(66)] : [], 1));
  } });
  const resumed = createNetflixCatalog({ token: TOKEN, request: restart.request, dataDir, now: () => now });
  t.after(() => resumed.stop());
  const restored = resumed.browse(query());
  assert.ok(restored.syncing && restored.provisional);
  assert.deepEqual(restored.syncProgress, { completed: 2, total: 3 });
  assert.equal(restored.total, 65);
  const complete = await settled(resumed);
  assert.equal(complete.provisional, false);
  assert.deepEqual(complete.coverageRegions, ['DE', 'JP', 'US']);
  assert.equal(complete.total, 66);
  assert.deepEqual(complete.errors, []);
  assert.deepEqual(restart.calls.map(url => url.searchParams.get('watch_region')).filter(Boolean), ['JP', 'JP']);
  await assert.rejects(access(join(dataDir, 'netflix-tmdb-v1.pending.json')), { code: 'ENOENT' });
});

test('Netflix resumes legacy stages and fills original language when a title is rediscovered', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-netflix-language-resume-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'netflix-tmdb-v1.pending.json'), JSON.stringify({ version: 1, at: NOW, startedAt: NOW,
    targetRegions: ['JP', 'US'], coverageRegions: ['JP'], providers: '1796|459|8:1796|459|8',
    rows: [movie(1), movie(2)].map(row => ({ ...row, kind: 'movie', regions: ['JP'] })),
  }));
  const source = mockRequest({ countries: ['JP', 'US'], discover(url) {
    assert.equal(url.searchParams.get('watch_region'), 'US');
    const rows = url.pathname.endsWith('/movie') ? [movie(1, { original_language: 'cn', genre_ids: [16] }),
      movie(3, { original_language: 'cmn' }), movie(4, { title: '中文译名', original_title: 'An English movie', original_language: 'en', origin_country: ['CN'] })]
      : [tv(1, { original_language: 'ja' })];
    return response(url, list(rows, 1));
  } });
  const catalog = createNetflixCatalog({ token: TOKEN, request: source.request, dataDir, now: () => NOW });
  t.after(() => catalog.stop());
  const initial = catalog.browse(query({ language: 'zh' }));
  assert.ok(initial.provisional && initial.syncing);
  assert.deepEqual(initial.items, []);
  assert.equal(catalog.browse(query()).total, 2);

  const result = await settled(catalog, query({ language: 'zh' }));
  assert.equal(result.provisional, false);
  assert.deepEqual(result.items.map(row => [row.id, row.language]), [['tmdb:movie:1', 'zh'], ['tmdb:movie:3', 'zh']]);
  assert.deepEqual(result.items[0].availabilityRegions, ['JP', 'US']);
  assert.deepEqual(result.facets.languages, ['en', 'zh']);
  assert.deepEqual(catalog.browse(query({ language: 'cn' })).items.map(row => row.id), ['tmdb:movie:1', 'tmdb:movie:3']);
  assert.deepEqual(catalog.browse(query({ language: 'en', country: '中国大陆' })).items.map(row => row.id), ['tmdb:movie:4']);
  assert.equal(catalog.browse(query({ language: 'all' })).total, 4);
  assert.deepEqual(catalog.browse(query({ language: 'ja', category: 'tv' })).items.map(row => row.id), ['tmdb:tv:1']);
  assert.deepEqual(source.calls.map(url => url.searchParams.get('watch_region')).filter(Boolean), ['US', 'US']);
  await catalog.stop();
  const reopened = createNetflixCatalog({ token: TOKEN, dataDir, now: () => NOW, request: () => assert.fail('fresh language-aware snapshot should not refresh') });
  t.after(() => reopened.stop());
  const stored = reopened.browse(query({ language: 'zh' }));
  assert.equal(stored.syncing, false);
  assert.deepEqual(stored.items.map(row => row.id), ['tmdb:movie:1', 'tmdb:movie:3']);
});

test('Netflix starts refreshing legacy complete snapshots before their ordinary expiry', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-netflix-language-refresh-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'netflix-tmdb-v1.json'), JSON.stringify({ version: 1, at: NOW, coverageRegions: ['US'],
    rows: [{ ...movie(11), kind: 'movie', regions: ['US'] }],
  }));
  const source = mockRequest({ countries: ['US'], discover(url) {
    return response(url, list(url.pathname.endsWith('/movie') ? [movie(11, { original_language: 'zh' })] : [], 1));
  } });
  const catalog = createNetflixCatalog({ token: TOKEN, now: () => NOW, request: source.request, dataDir });
  t.after(() => catalog.stop());
  const existing = catalog.browse(query({ language: 'all' }));
  assert.ok(existing.syncing);
  assert.equal(existing.provisional, false);
  assert.deepEqual(existing.items.map(row => row.id), ['tmdb:movie:11']);
  assert.equal(catalog.browse(query({ language: 'zh' })).total, 0);
  assert.deepEqual((await settled(catalog, query({ language: 'zh' }))).items.map(row => row.id), ['tmdb:movie:11']);
});

test('Netflix partitions a capped TMDB result and retries a region whose pages shift', async t => {
  const lowVotes = Array.from({ length: 10000 }, (_, index) => movie(index + 1, { release_date: '' }));
  const highVotes = [movie(10001, { vote_count: 1500000000 })];
  let shiftedPage = false;
  const source = mockRequest({ countries: ['US'], discover(url) {
    const page = Number(url.searchParams.get('page'));
    if (url.pathname.endsWith('/tv')) return response(url, list([], page));
    const minimum = url.searchParams.get('vote_count.gte');
    if (minimum === null) return response(url, { page: 1, total_pages: 500, total_results: 10001, results: lowVotes.slice(0, 20) });
    if (minimum !== '0') return response(url, list(highVotes, page));
    const data = list(lowVotes, page);
    if (page === 2 && !shiftedPage) {
      shiftedPage = true;
      data.results[0] = lowVotes[19];
    }
    return response(url, data);
  } });
  const catalog = createNetflixCatalog({ token: TOKEN, now: () => NOW, request: source.request });
  t.after(() => catalog.stop());
  const synced = await settled(catalog);
  assert.ok(shiftedPage);
  assert.deepEqual(synced.errors, []);
  assert.equal(synced.total, 10001);
  assert.equal(catalog.browse(query({ page: 334 })).items.length, 11);
  assert.equal(source.calls.filter(url => url.pathname.endsWith('/discover/movie') && !url.searchParams.has('vote_count.gte')).length, 2);
});

test('Netflix detail keeps explicit season, episode and year without accepting arbitrary identities or adult records', async t => {
  const source = mockRequest({ detail(url) {
    const id = Number(url.pathname.split('/').at(-1));
    return response(url, tv(id, { original_name: 'Original Show', adult: id === 2, genres: [{ id: 18 }], overview: '简介', poster_path: '//attacker.test/poster.jpg',
      seasons: [{ season_number: 2, episode_count: 2, air_date: '2025-02-29' }, { season_number: 0, episode_count: 40 },
        { season_number: 1, episode_count: 1, air_date: '2024-01-01' }, { season_number: 3, episode_count: -1 }],
    }));
  } });
  const catalog = createNetflixCatalog({ token: TOKEN, now: () => NOW, request: source.request });
  t.after(() => catalog.stop());
  assert.ok(isNetflixId('tmdb:tv:1'));
  assert.equal(isNetflixId('tmdb:tv:9007199254740993'), false);
  const result = await catalog.detail('tmdb:tv:1');
  assert.equal(result.key, 'quark-library:tmdb:tv:1');
  assert.equal(result.episodeCount, 3);
  assert.deepEqual(result.lines[0].episodes, [
    { name: '第1季 第1集', season: 1, seasonYear: '2024' },
    { name: '第2季 第1集', season: 2 }, { name: '第2季 第2集', season: 2 },
  ]);
  assert.equal(result.netflix, false);
  assert.deepEqual(result.aliases, ['Original Show']);
  assert.equal(catalog.poster(result.id), undefined);
  assert.equal((await catalog.detail('tmdb:tv:1')).description, '简介');
  assert.equal(source.calls.length, 1);
  await assert.rejects(catalog.detail('tmdb:tv:2'), { status: 404 });
  await assert.rejects(catalog.detail('tmdb:tv:https://example.com'), { status: 400 });
  assert.equal(source.calls.length, 2);
});

test('Netflix does not expose old rows or contact TMDB when the token is not configured', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-netflix-unconfigured-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, 'netflix-tmdb-v1.json');
  await writeFile(file, JSON.stringify({ version: 1, at: NOW, coverageRegions: ['JP'], rows: [{ ...movie(123), kind: 'movie', regions: ['JP'] }] }));
  const catalog = createNetflixCatalog({ dataDir, now: () => NOW, request: () => assert.fail('unexpected TMDB request') });
  t.after(() => catalog.stop());
  assert.ok(catalog.browse(query()).unconfigured);
  assert.equal(catalog.browse(query()).syncing, false);
  assert.deepEqual(catalog.browse(query()).items, []);
  assert.equal(catalog.poster('tmdb:movie:123'), undefined);
  await assert.rejects(catalog.detail('tmdb:movie:123'), { status: 503 });
});
