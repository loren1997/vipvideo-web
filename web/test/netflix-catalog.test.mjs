import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
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

test('Netflix library unions every discovered region, excludes non-Netflix providers and paginates beyond page 25', async t => {
  const source = mockRequest({
    discover(url) {
      const region = url.searchParams.get('watch_region'), page = Number(url.searchParams.get('page'));
      const rows = url.pathname.endsWith('/tv') ? region === 'JP' ? [tv(1), tv(2, { genre_ids: [16] }), tv(3, { genre_ids: [10764] })] : []
        : region === 'JP' ? [movie(1), movie(760, { title: '日本限定', origin_country: ['JP'], release_date: '2026-01-01' })]
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
  assert.deepEqual(catalog.browse(query({ category: 'variety' })).items.map(item => item.id), ['tmdb:tv:3']);
  assert.equal(catalog.browse(query({ genre: '剧情', year: '2026', country: '日本' })).total, 1);
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
