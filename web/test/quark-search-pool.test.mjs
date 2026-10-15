import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createQuarkSearchPool } from '../lib/quark-search-pool.mjs';
import { createQuarkSearchRequest } from '../lib/quark-search.mjs';
import { createRequest, readText } from '../lib/network.mjs';
import { searchGoogleQuark } from '../lib/quark-google-search.mjs';
import { createQuarkTelegramSearch } from '../lib/quark-telegram-search.mjs';

const KEY = 'quark-search-pool-v1';
const official = 'https://so.252035.xyz/api/search', backup = 'https://backup.example/api/search';
const quarkUrl = 'https://pan.quark.cn/s/abcdef123456';
const json = (url = quarkUrl, title = '电影') => JSON.stringify({ code: 0, data: { results: [{ title, links: [{ type: 'quark', url, password: '1234' }] }] } });
const response = (body, statusCode = 200) => Object.assign(Readable.from([body]), { statusCode, headers: {} });
const rss = (url, title = '电影') => `<rss><channel><item><title>${title}</title><link>${url || 'https://example.org'}</link></item></channel></rss>`;
const flush = async () => { for (let index = 0; index < 5; index++) await new Promise(done => setImmediate(done)); };

test('known registered shares reveal older buffered channel results without changing shared searches', async () => {
  const clock = Date.parse('2026-10-15T00:00:00Z'), address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B';
  const rows = Array.from({ length: 40 }, (_, index) => ({ name: '希望 (2026)', url: 'https://pan.quark.cn/s/buffer' + String(index).padStart(4, '0'), publishedAt: clock - index * 1000 }));
  let release, channelCalls = 0;
  const f = fixture({ now: () => clock, request: async () => response(JSON.stringify({ results: rows.slice(0, 30) })),
    telegramSearch: async () => { channelCalls++; await new Promise(resolve => { release = resolve; }); return rows.slice(30); } });
  try {
    const initial = JSON.parse(await readText(await f.pool.request(address, { year: '2026' })));
    assert.deepEqual(initial.results.map(row => row.url), rows.slice(0, 30).map(row => row.url));
    assert.equal(initial.pending, true);
    const knownShares = initial.results.map(row => row.url), options = { year: '2026', knownShares };
    const waiting = JSON.parse(await readText(await f.pool.request(address, { ...options, poll: true })));
    assert.equal(waiting.results.length, 0); assert.equal(waiting.pending, true);
    await readText(await f.pool.request(address, options));
    assert.equal(channelCalls, 1); assert.equal(f.calls.length, 1);
    release(); await flush();
    const later = JSON.parse(await readText(await f.pool.request(address, { ...options, poll: true })));
    assert.deepEqual(later.results.map(row => row.url), rows.slice(30).map(row => row.url));
    assert.equal(later.pending, undefined);
    const original = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true })));
    assert.deepEqual(original.results.map(row => row.url), initial.results.map(row => row.url));
    assert.equal(channelCalls, 1); assert.equal(f.calls.length, 1);
  } finally { release?.(); await f.pool.stop(); }
});

test('known-share hints accept only bounded canonical Quark paths and never become request or cache keys', async () => {
  const clock = Date.parse('2026-10-15T00:00:00Z'), address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B';
  const rows = Array.from({ length: 40 }, (_, index) => ({ name: '希望 (2026)', url: 'https://pan.quark.cn/s/buffer' + String(index).padStart(4, '0'), publishedAt: clock - index * 1000 }));
  const f = fixture({ now: () => clock, request: async () => response(JSON.stringify({ results: rows })) });
  const poll = async knownShares => JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares })));
  try {
    await readText(await f.pool.request(address, { year: '2026' }));
    const malformed = ['http://pan.quark.cn/s/buffer0000', 'https://pan.quark.cn.evil/s/buffer0000', 'https://evil@pan.quark.cn/s/buffer0000',
      'https://pan.quark.cn:444/s/buffer0000', 'file:///buffer0000', rows[0].url + '?pwd=invalid!', rows[0].url + '?extra=' + 'x'.repeat(2048), {}, null];
    assert.equal((await poll(malformed)).results[0].url, rows[0].url);
    assert.equal((await poll(rows[0].url)).results[0].url, rows[0].url);
    const duplicate = await poll([rows[0].url, rows[0].url + '/', rows[0].url + '?pwd=1234']);
    assert.equal(duplicate.results.length, 30); assert.equal(duplicate.results[0].url, rows[1].url);
    const oversized = await poll([...Array(128).fill(rows[0].url), rows[1].url]);
    assert.equal(oversized.results[0].url, rows[1].url, 'entries beyond the 128-item hint limit are not inspected');
    assert.equal((await poll(rows.slice(0, 30).map(row => row.url))).results.length, 10);
    assert.equal((await poll()).results.length, 30, 'one caller cannot hide shares from another consumer');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.knownShares, undefined);
    assert.ok(!f.calls[0].url.includes('knownShares'));
  } finally { await f.pool.stop(); }
});

test('candidate buffering remains bounded at 128 while each consumer receives at most thirty', async () => {
  const clock = Date.parse('2026-10-15T00:00:00Z'), address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B';
  const rows = Array.from({ length: 220 }, (_, index) => ({ name: '希望 (2026)', url: 'https://pan.quark.cn/s/bounded' + String(index).padStart(4, '0'), publishedAt: clock - index * 1000 }));
  const f = fixture({ now: () => clock, request: async () => response(JSON.stringify({ results: rows })) });
  try {
    const first = JSON.parse(await readText(await f.pool.request(address, { year: '2026' }))), knownShares = first.results.map(row => row.url), counts = [first.results.length];
    for (let page = 0; page < 5; page++) {
      const result = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares })));
      assert.ok(result.results.length <= 30);
      counts.push(result.results.length); knownShares.push(...result.results.map(row => row.url));
    }
    assert.deepEqual(counts, [30, 30, 30, 30, 8, 0]);
    assert.equal(new Set(knownShares).size, 128);
    assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('a registered folder hint never hides a root candidate or a candidate from another folder', async t => {
  const address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B', folderA = 'a'.repeat(32), folderB = 'b'.repeat(32);
  for (const source of [quarkUrl, quarkUrl + '#/list/share/' + folderB]) await t.test(source === quarkUrl ? 'root' : 'other folder', async () => {
    const f = fixture({ request: async () => response(json(source, '希望 (2026)')) });
    try {
      await readText(await f.pool.request(address, { year: '2026' }));
      for (const folder of [folderA, folderA.toUpperCase()]) {
        const result = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares: [quarkUrl + '#/list/share/' + folder] })));
        assert.deepEqual(result.results.map(row => row.url.split('?')[0]), [quarkUrl]);
      }
      assert.equal(f.calls.length, 1);
    } finally { await f.pool.stop(); }
  });
});

test('an explicit root-folder hint is equivalent to the root and does not remove it from shared storage', async () => {
  const address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B', f = fixture({ request: async () => response(json(quarkUrl, '希望 (2026)')) });
  try {
    await readText(await f.pool.request(address, { year: '2026' }));
    for (const suffix of ['', '#', '#/list/share/0', '#/list/share/0/']) {
      const result = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares: [quarkUrl + suffix] })));
      assert.equal(result.results.length, 0);
    }
    const original = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true })));
    assert.equal(original.results.length, 1); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('malformed folder hints are ignored rather than being downgraded into a known root share', async () => {
  const address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B', f = fixture({ request: async () => response(json(quarkUrl, '希望 (2026)')) });
  try {
    await readText(await f.pool.request(address, { year: '2026' }));
    for (const suffix of ['#junk', '#list/share/0', '#/list/share/00', '#/list/share/' + 'a'.repeat(31), '#/list/share/' + 'g'.repeat(32), '#/list/share/0/child', '#/list/share/' + 'a'.repeat(32) + '/child']) {
      const result = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares: [quarkUrl + suffix] })));
      assert.equal(result.results.length, 1, suffix);
    }
    assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('the first explicit web search preserves older normal-search candidates without asking providers to resend them', async () => {
  const clock = Date.parse('2026-10-15T00:00:00Z'), address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B';
  const rows = Array.from({ length: 40 }, (_, index) => ({ name: '希望 (2026)', url: 'https://pan.quark.cn/s/carried' + String(index).padStart(4, '0'), publishedAt: clock - index * 1000 }));
  let apiCalls = 0, channelCalls = 0;
  const f = fixture({ now: () => clock, googleSearch: async () => [], request: async url => {
    const provider = new URL(url).hostname === 'manual.example';
    return response(JSON.stringify({ results: provider && ++apiCalls === 1 ? rows.slice(0, 30) : [] }));
  }, telegramSearch: async () => ++channelCalls === 1 ? rows.slice(30) : [] });
  try {
    const initial = JSON.parse(await readText(await f.pool.request(address, { year: '2026' })));
    await flush();
    const completed = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true })));
    assert.equal(completed.pending, undefined);
    assert.deepEqual(completed.results.map(row => row.url), rows.slice(0, 30).map(row => row.url));
    const buffered = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true, knownShares: initial.results.map(row => row.url) })));
    assert.deepEqual(buffered.results.map(row => row.url), rows.slice(30).map(row => row.url));
    const more = JSON.parse(await readText(await f.pool.request(address, { year: '2026', webSearch: true, forceRefresh: true, knownShares: initial.results.map(row => row.url) })));
    assert.deepEqual(more.results.map(row => row.url), rows.slice(30).map(row => row.url));
    await flush();
    const normal = JSON.parse(await readText(await f.pool.request(address, { year: '2026', poll: true })));
    assert.deepEqual(normal.results.map(row => row.url), completed.results.map(row => row.url));
    assert.equal(apiCalls, 3, 'the empty refresh tries the original title and its existing year variant'); assert.equal(channelCalls, 2);
  } finally { await f.pool.stop(); }
});

test('cross-mode candidate carryover requires the exact work, aliases, year and endpoint and an unexpired entry', async t => {
  const address = 'https://manual.example/api/search?kw=%E5%B8%8C%E6%9C%9B';
  for (const variation of ['work', 'aliases', 'year', 'endpoint', 'expired']) await t.test(variation, async () => {
    let clock = Date.parse('2026-10-15T00:00:00Z'), emitted = false;
    const f = fixture({ now: () => clock, googleSearch: async () => [], request: async url => {
      const provider = new URL(url).hostname.endsWith('.example');
      const results = provider && !emitted ? [{ name: '希望', url: quarkUrl }] : [];
      if (provider) emitted = true;
      return response(JSON.stringify({ results }));
    } });
    try {
      const initial = JSON.parse(await readText(await f.pool.request(address, { year: '2026' })));
      assert.equal(initial.results.length, 1);
      await flush();
      if (variation === 'expired') clock += 120001;
      const target = variation === 'endpoint' ? address.replace('manual.example', 'other.example') : variation === 'work' ? address.replace('%E5%B8%8C%E6%9C%9B', '%E7%9B%BC%E6%9C%9B') : address;
      const options = { year: variation === 'year' ? '2025' : '2026', ...(variation === 'work' ? { aliases: ['希望'] } : variation === 'aliases' ? { aliases: ['Hope'] } : {}), webSearch: true, forceRefresh: true };
      const more = JSON.parse(await readText(await f.pool.request(target, options)));
      assert.deepEqual(more.results, [], variation);
    } finally { await f.pool.stop(); }
  });
});

test('public channel results merge after a fast API response, polls reuse work and more advances its page', async () => {
  const channelCalls = []; let release;
  const f = fixture({ request: async () => response(json(quarkUrl, '希望 (2026)')),
    telegramSearch: async (title, options) => {
      channelCalls.push({ title, page: options.page });
      assert.equal(options.year, '2026'); assert.ok(options.deadline <= Date.now() + 35000);
      await options.read('https://t.me/s/Quark_Movies?q=希望', 1000, 512 * 1024, options.deadline);
      if (channelCalls.length === 1) await new Promise(resolve => { release = resolve; });
      return [{ name: '希望 (2026)', url: 'https://pan.quark.cn/s/channel2026' }];
    },
  });
  const url = 'https://manual.example/api/search?kw=希望';
  try {
    const early = JSON.parse(await readText(await f.pool.request(url, { year: '2026' })));
    assert.equal(early.results.length, 1); assert.equal(early.pending, true);
    await f.pool.request(url, { year: '2026', poll: true }); assert.equal(channelCalls.length, 1);
    release(); await flush();
    const done = JSON.parse(await readText(await f.pool.request(url, { year: '2026', poll: true })));
    assert.equal(done.results.length, 2); assert.equal(done.pending, undefined);
    await f.pool.request(url, { year: '2026', forceRefresh: true }); await flush();
    assert.deepEqual(channelCalls.map(row => row.page), [0, 1]);
    assert.ok(f.calls.filter(row => row.url.startsWith('https://t.me/')).every(row => row.options.followRedirects && row.options.signal));
  } finally { release?.(); await f.pool.stop(); }
});

test('stopping public channel search cancels its request and late results cannot survive', async () => {
  let channelSignal, sawAbort = false;
  const f = fixture({ telegramSearch: async (_title, { signal }) => {
    channelSignal = signal;
    await new Promise((_, reject) => signal.addEventListener('abort', () => { sawAbort = true; reject(signal.reason); }, { once: true }));
    return [{ name: '电影', url: 'https://pan.quark.cn/s/latetelegram' }];
  } });
  await f.pool.request('https://manual.example/api/search?kw=电影');
  await f.pool.stop(); assert.equal(sawAbort, true); assert.equal(channelSignal.aborted, true);
});

test('public channel batches publish partial results while polls reuse the running search', async () => {
  let release;
  const pages = [];
  const f = fixture({ request: value => response(value.includes('bing.com') ? '<rss><channel></channel></rss>' : '{"results":[]}'),
    telegramSearch: async (_title, options) => {
      pages.push(options.page);
      if (pages.length === 1) {
        options.onResults([{ name: '希望 (2026)', url: 'https://pan.quark.cn/s/channelpartial' }]);
        await new Promise(resolve => { release = resolve; });
        return Object.assign([], { pending: true });
      }
      return [{ name: '希望 (2026)', url: 'https://pan.quark.cn/s/channelcontinued' }];
    },
  });
  const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('希望');
  const read = options => f.pool.request(url, { year: '2026', ...options }).then(readText).then(JSON.parse);
  try {
    const early = await read({});
    assert.equal(early.pending, true);
    assert.equal(early.results.length, 1);
    await read({ poll: true });
    assert.deepEqual(pages, [0]);
    release();
    await flush();
    const done = await read({ poll: true });
    assert.deepEqual(pages, [0, 1]);
    assert.equal(done.pending, undefined);
    assert.equal(done.results.length, 2);
  } finally { release?.(); await f.pool.stop(); }
});

test('one public channel read can time out without cancelling the shared search', async () => {
  let entrySignal;
  const f = fixture({ request: value => response(value.includes('bing.com') ? '<rss><channel></channel></rss>' : '{"results":[]}'),
    telegramSearch: async (_title, options) => {
      entrySignal = options.signal;
      const local = new AbortController();
      local.abort(new DOMException('Single channel deadline', 'TimeoutError'));
      await assert.rejects(options.read('https://t.me/s/Quark_Movies?q=test', 1000, 512 * 1024, options.deadline, local.signal), /搜索请求超时/);
      assert.equal(entrySignal.aborted, false);
      return [{ name: '希望 (2026)', url: 'https://pan.quark.cn/s/channelhealthy' }];
    },
  });
  const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('希望');
  try {
    await f.pool.request(url, { year: '2026' });
    await flush();
    const done = JSON.parse(await readText(await f.pool.request(url, { year: '2026', poll: true })));
    assert.equal(entrySignal.aborted, false);
    assert.ok(done.results.length, JSON.stringify(done));
    assert.equal(done.results[0].url, 'https://pan.quark.cn/s/channelhealthy');
    assert.equal(f.calls.some(call => new URL(call.url).hostname === 't.me'), false);
  } finally { await f.pool.stop(); }
});

test('a public channel adapter that stays pending cannot run an unbounded number of batches', async () => {
  let batches = 0;
  const f = fixture({ telegramSearch: async () => { batches++; return Object.assign([], { pending: true }); } });
  try {
    await f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('电影'));
    await flush();
    assert.equal(batches, 6);
  } finally { await f.pool.stop(); }
});

test('channel cursors continue past the fourth page while Google page numbers wrap and polls do not restart work', async () => {
  const channelCalls = [], renderedPages = [], channel = createQuarkTelegramSearch({ channels: ['Quark_Movies'] });
  const fourth = 'https://pan.quark.cn/s/abc000000070';
  const f = fixture({ telegramSearch: channel,
    request: value => {
      const url = new URL(value);
      if (url.hostname !== 't.me') return response(url.hostname.includes('bing.com') ? '<rss><channel></channel></rss>' : '{"results":[]}');
      const q = url.searchParams.get('q'), before = url.searchParams.get('before'), id = before ? Number(before) - 10 : 100;
      channelCalls.push({ q, before });
      const body = q === 'Hope' && id === 70 ? `<a href="${fourth}">夸克</a>` : '暂无链接';
      return response(`<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="Quark_Movies/${id}"><div class="tgme_widget_message_text">名称：希望 Hope (2026)<br/>${body}</div><a href="https://t.me/Quark_Movies/${id}"><time datetime="2026-10-14T00:00:00Z"></time></a></div></div>`);
    },
    renderSearch: async query => { renderedPages.push(query.page); return []; },
  });
  const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('希望');
  const read = async options => JSON.parse(await readText(await f.pool.request(url, { aliases: ['Hope'], year: '2026', ...options })));
  try {
    let completed;
    for (let index = 0; index < 4; index++) {
      const options = { webSearch: true, ...(index ? { forceRefresh: true } : {}) };
      await read(options); await flush();
      const requests = channelCalls.length, renders = renderedPages.length;
      completed = await read({ ...options, poll: true });
      assert.equal(channelCalls.length, requests); assert.equal(renderedPages.length, renders);
      assert.equal(completed.pending, undefined);
    }
    for (const q of ['希望', 'Hope']) assert.deepEqual(channelCalls.filter(call => call.q === q).map(call => call.before), [null, '100', '90', '80', '70', '60', '50', '40', '30', '20', '10']);
    assert.deepEqual(renderedPages, [0, 1, 2, 0], JSON.stringify({ completed, requests: channelCalls.length }));
    assert.ok(completed.results.some(row => row.url === fourth));
  } finally { await f.pool.stop(); }
});

function fixture({ request, discoveryRequest, webRequest, renderSearch, telegramSearch, googleSearch = async () => { throw new Error('Fixture Google search unavailable'); }, saved, now = Date.now } = {}) {
  const metadata = new Map(saved ? [[KEY, JSON.stringify(saved)]] : []), calls = [], discoveryCalls = [];
  const store = { meta: key => metadata.get(key), setMeta: (key, value) => metadata.set(key, value) };
  const transport = async (url, options) => { calls.push({ url, options }); return request ? request(url, options) : response(json(undefined, new URL(url).searchParams.get('kw') || '电影')); };
  const pool = createQuarkSearchPool({ store, now, googleSearch, renderSearch, telegramSearch, webRequest: webRequest || transport,
    request: transport,
    discoveryRequest: async (url, options) => {
      discoveryCalls.push({ url, options });
      if (discoveryRequest) return discoveryRequest(url, options);
      if (url.includes('api.github.com')) return response(JSON.stringify({ homepage: 'https://published.example/' }));
      if (url.includes('raw.githubusercontent.com')) return response('Published endpoint https://readme.example/api/search');
      return response(rss('https://rss.example/api/search'));
    },
  });
  return { pool, metadata, store, calls, discoveryCalls };
}
const savedBackup = now => ({ candidates: [{ url: backup, automatic: true, status: 'healthy', addedAt: now - 100, checkedAt: now - 1, failures: 0, retryAt: 0 }] });
const lookup = async (pool, url = 'https://manual.example/api/search?kw=电影') => JSON.parse(await readText(await pool.request(url, { headers: { Cookie: 'user-cookie', Authorization: 'user-token' } })));

test('only matching film titles are recommended; unnamed resources are separate and other films or years are discarded', async () => {
  const rows = [
    { name: '【电影】一路平安 (2026) 4K', url: quarkUrl },
    { name: '一路超平安 (2026)', url: 'https://pan.quark.cn/s/other12345' },
    { name: '一路平安归来 (2026)', url: 'https://pan.quark.cn/s/sequel1234' },
    { name: '一路平安 (2025)', url: 'https://pan.quark.cn/s/wrongyear1' },
    { name: '网盘资源链接', url: 'https://pan.quark.cn/s/unknown123' },
    { url: 'https://pan.quark.cn/s/unnamed123' },
  ];
  const f = fixture({ request: () => response(JSON.stringify({ results: rows })) });
  try {
    const data = await lookup(f.pool, 'https://manual.example/api/search?' + new URLSearchParams({ kw: '一路平安 2026' }));
    assert.deepEqual(data.results.map(row => row.url), [quarkUrl]);
    assert.deepEqual(data.unverified.map(row => row.url), ['https://pan.quark.cn/s/unknown123', 'https://pan.quark.cn/s/unnamed123']);
    assert.equal((await lookup(f.pool, 'https://manual.example/api/search?' + new URLSearchParams({ kw: '一路平安 2026' }))).unverified.length, 2);
  } finally { await f.pool.stop(); }
});

test('scheduled maintenance removes only automatic endpoints with failures spanning a day without new discovery', async t => {
  const day = 86_400_000, clock = 4 * day;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: clock });
  const row = (url, changes = {}) => ({ url, automatic: true, status: 'paused', failures: 3, addedAt: day, firstFailedAt: day, checkedAt: 2 * day, retryAt: clock + 60_000, ...changes });
  const f = fixture({ saved: { lastDiscovery: clock, candidates: [
    row('https://expired.example/api/search'),
    row('https://transient.example/api/search', { firstFailedAt: clock - 1000, checkedAt: clock }),
    row('https://manual.example/api/search', { automatic: false }),
    row('http://pansou:8888/api/search', { automatic: false }),
  ] } });
  try {
    f.pool.start(); t.mock.timers.tick(0); await flush();
    const rows = f.pool.status().candidates;
    assert.ok(!rows.some(row => row.apiUrl.includes('expired.example')));
    for (const part of ['transient.example', 'manual.example', 'pansou:8888']) assert.ok(rows.some(row => row.apiUrl.includes(part)));
    assert.equal(f.discoveryCalls.length, 0);
    assert.ok(!JSON.parse(f.metadata.get(KEY)).candidates.some(row => row.url.includes('expired.example')));
  } finally { await f.pool.stop(); }
});

test('removed public interfaces stay retired for seven days while an explicit manual configuration remains usable', async () => {
  let clock = 4 * 86_400_000;
  const retiredUrl = 'https://expired.example/api/search';
  const f = fixture({ now: () => clock, saved: { retired: [{ url: retiredUrl, expires: clock + 7 * 86_400_000 }] }, discoveryRequest: url => response(url.includes('api.github.com') ? JSON.stringify({ homepage: 'https://expired.example/' }) : retiredUrl) });
  try {
    await f.pool.discover(); assert.ok(!f.pool.status().candidates.some(row => row.apiUrl === retiredUrl));
    const data = await lookup(f.pool, retiredUrl + '?kw=电影'); assert.equal(data.results.length, 1);
    const saved = JSON.parse(f.metadata.get(KEY));
    assert.equal(saved.candidates.find(row => row.url === retiredUrl).automatic, false);
    assert.ok(!saved.retired.some(row => row.url === retiredUrl));
    clock += 86_400_000; await f.pool.discover();
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === retiredUrl).automatic, false);
  } finally { await f.pool.stop(); }
});

test('successful search clears the automatic endpoint failure window before later failures', async () => {
  let clock = 4 * 86_400_000;
  const f = fixture({ now: () => clock, saved: { candidates: [{ ...savedBackup(clock).candidates[0], failures: 2, firstFailedAt: clock - 86_400_000 }] } });
  try {
    await lookup(f.pool);
    const row = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup);
    assert.equal(row.failures, 0); assert.equal(row.firstFailedAt, undefined);
  } finally { await f.pool.stop(); }
});

test('rotating public repository metadata discovers deployment APIs but never calls an unverified candidate in the foreground', async () => {
  let clock = 4 * 86_400_000;
  const f = fixture({ now: () => clock, discoveryRequest: url => {
    if (url.includes('/search/repositories')) return response(JSON.stringify({ items: [
      { homepage: 'https://deployed.example/' }, { homepage: 'http://127.0.0.1/' }, { homepage: 'https://user:secret@unsafe.example/' },
    ] }));
    return response(url.includes('api.github.com') ? '{}' : '');
  } });
  try {
    await f.pool.discover();
    assert.ok(f.discoveryCalls.some(call => call.url.includes('/search/repositories')));
    assert.ok(f.pool.status().candidates.some(row => row.apiUrl === 'https://deployed.example/api/search'));
    assert.ok(f.pool.status().candidates.every(row => !/127\.0\.0\.1|unsafe/.test(row.apiUrl)));
    const saved = JSON.parse(f.metadata.get(KEY)), pending = saved.candidates.find(row => row.url.includes('deployed.example'));
    pending.status = 'pending';
    const foreground = fixture({ now: () => clock, saved });
    try { await lookup(foreground.pool); assert.ok(!foreground.calls.some(call => call.url.includes('deployed.example'))); }
    finally { await foreground.pool.stop(); }
    assert.ok(f.discoveryCalls.length <= 4); assert.ok(f.calls.length <= 2);
  } finally { await f.pool.stop(); }
});

test('documented Pansousuo API uses q and pan and validates items share URLs and access codes', async () => {
  const f = fixture({ request: url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('q'), '遮天'); assert.equal(parsed.searchParams.get('pan'), 'quark'); assert.equal(parsed.searchParams.get('sort'), 'latest');
    assert.equal(parsed.searchParams.has('kw'), false);
    return response(JSON.stringify({ items: [
      { title: '遮天 4K', pan: 'quark', share_url: quarkUrl, access_code: 'abcd' },
      { title: '遮天', pan: 'baidu', share_url: quarkUrl },
      { title: '遮天', pan: 'quark', share_url: 'http://127.0.0.1/private' },
      { title: '遮天', pan: 'quark', share_url: 'https://user:secret@pan.quark.cn/s/abcdef123456' },
    ], total: 4 }));
  } });
  try {
    const data = await lookup(f.pool, 'https://www.pansousuo.com/api/search?kw=遮天');
    assert.equal(data.results.length, 1); assert.equal(data.results[0].name, '遮天 4K'); assert.equal(data.results[0].url, quarkUrl + '?pwd=abcd');
  } finally { await f.pool.stop(); }
});

test('Google reader follows public regional redirects with DNS checks and no household credentials', async () => {
  for (const target of ['https://www.google.com.hk/search', 'http://127.0.0.1/private', 'https://rebound.example/search']) {
    const calls = [], lookups = [];
    const transport = (url, options, callback) => {
      const outgoing = new EventEmitter();
      outgoing.destroy = error => { if (error) queueMicrotask(() => outgoing.emit('error', error)); };
      outgoing.end = () => queueMicrotask(() => {
        calls.push({ url: url.href, headers: options.headers });
        const incoming = url.hostname === 'www.google.com' ? response('', 301) : response(`<a href="${quarkUrl}">电影 夸克资源</a>`);
        if (url.hostname === 'www.google.com') incoming.headers.location = target;
        callback(incoming);
      });
      return outgoing;
    };
    const guarded = createRequest({ lookup: async hostname => {
      lookups.push(hostname); return [{ address: hostname === 'rebound.example' ? '192.168.1.2' : '8.8.8.8', family: 4 }];
    }, httpRequest: transport, httpsRequest: transport });
    const search = createQuarkSearchRequest({ request: guarded });
    const f = fixture({ request: (url, options) => search(url, options), googleSearch: searchGoogleQuark });
    try {
      const data = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true, headers: { Cookie: 'secret-cookie', Authorization: 'secret-token' } })));
      if (target.includes('google.com.hk')) { assert.equal(data.results.length, 1); assert.ok(lookups.includes('www.google.com.hk')); }
      else { assert.equal(data.results.length, 0); assert.match(data.reason, /安全检查拒绝/); assert.ok(!calls.some(call => call.url === target)); }
      assert.ok(calls.every(call => !/secret-cookie|secret-token|cookie|authorization/i.test(JSON.stringify(call.headers))));
      assert.ok(f.calls.filter(call => call.url.includes('bing.com')).every(call => call.options.followRedirects === true));
    } finally { await f.pool.stop(); }
  }
});

test('public metadata, README and RSS add bounded candidates and only compatible searches with Quark links establish health', async () => {
  const f = fixture({ request: url => response(new URL(url).hostname === 'so.252035.xyz' ? '{"status":"ok","auth_enabled":false}' : json()) });
  try {
    await f.pool.discover();
    const status = f.pool.status();
    assert.equal(f.discoveryCalls.length, 4); assert.equal(f.calls.length, 2);
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://readme.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://rss.example/api/search' && row.status === 'pending'));
    assert.ok(status.candidates.some(row => row.apiUrl === official && row.status === 'paused'));
    assert.ok(status.candidates.some(row => row.apiUrl === 'https://published.example/api/search' && row.status === 'healthy'));
    assert.equal(status.healthy, 1); assert.equal(status.suspended, 1);
    assert.ok(f.calls.every(call => new URL(call.url).searchParams.get('conc') === '1'));
    assert.ok([...f.calls, ...f.discoveryCalls].every(call => !/user-cookie|user-token|authorization|cookie/i.test(JSON.stringify(call.options))));
    await f.pool.discover(); assert.equal(f.discoveryCalls.length, 4);
  } finally { await f.pool.stop(); }
});

test('empty search JSON stays pending and HTML with a share cannot become a healthy API', async () => {
  const f = fixture({ request: url => response(new URL(url).hostname === 'so.252035.xyz' ? '{"results":[]}' : `<html>${quarkUrl}</html>`) });
  try {
    await f.pool.discover();
    assert.equal(f.pool.status().healthy, 0);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === official).status, 'pending');
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('published.example')).status, 'paused');
  } finally { await f.pool.stop(); }
});

test('failed primaries are temporarily skipped, backups survive restart, and the current configured primary recovers automatically', async () => {
  let clock = 1000, broken = true;
  const f = fixture({ now: () => clock, saved: savedBackup(clock), request: url => response(new URL(url).hostname === 'manual.example' && broken ? 'private remote failure user-token <html>' : json(), new URL(url).hostname === 'manual.example' && broken ? 503 : 200) });
  let restarted;
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    await lookup(f.pool); assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    const view = JSON.stringify(f.pool.status()); assert.equal(view.includes('user-token'), false); assert.equal(view.includes('<html>'), false);
    await f.pool.stop();
    const calls = [];
    restarted = createQuarkSearchPool({ store: f.store, now: () => clock, request: async url => { calls.push(url); return response(json()); }, discoveryRequest: () => assert.fail('restart does not synchronously fetch public directories') });
    await lookup(restarted); assert.ok(calls.every(url => !url.includes('manual.example')));
    clock += 15 * 60_000 + 1; broken = false;
    await lookup(restarted); assert.ok(calls.some(url => url.includes('manual.example')));
    assert.equal(restarted.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'healthy');
    const before = calls.length;
    await lookup(restarted, 'https://changed.example/api/search?kw=新影片');
    assert.ok(calls.slice(before).some(url => url.includes('changed.example')));
    assert.ok(calls.slice(before).every(url => !url.includes('manual.example')));
  } finally { await f.pool.stop(); await restarted?.stop(); }
});

test('empty successful searches preserve health and public RSS supplies results when APIs have no matching resource', async () => {
  const f = fixture({ saved: savedBackup(Date.now()), request: url => response(url.includes('bing.com') ? rss(quarkUrl) : '{"results":[]}') });
  try {
    const result = await lookup(f.pool);
    assert.equal(result.results[0].url, quarkUrl);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
    const fallback = new URL(f.calls.at(-1).url); assert.equal(fallback.searchParams.get('q'), '"电影" 夸克 网盘');
  } finally { await f.pool.stop(); }
});

test('Bing articles become Quark candidates when Google and the configured API have no results', async () => {
  const f = fixture({ request: (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'manual.example') return response('{"results":[]}');
    if (parsed.hostname.endsWith('.bing.com')) {
      assert.equal(parsed.searchParams.get('q'), '"一路超平安" 夸克 网盘');
      assert.equal(options.followRedirects, true);
      return response('<rss><channel><item><title>一路超平安 (2026) 4K资源</title><link>https://posts.example/movie</link></item></channel></rss>');
    }
    assert.equal(url, 'https://posts.example/movie'); assert.equal(options.followRedirects, true);
    return response(`<title>一路超平安 4K资源</title><article><a href="${quarkUrl}">夸克下载</a></article>`);
  } });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?' + new URLSearchParams({ kw: '一路超平安' }));
    assert.equal(result.results.length, 1); assert.equal(result.results[0].url, quarkUrl);
    assert.equal(f.calls.length, 3); assert.ok(f.calls.every(call => call.options.timeout <= 8000));
  } finally { await f.pool.stop(); }
});

test('a healthy fast primary returns before a slow backup and stop cancels the backup without further persistence', async () => {
  let clock = 1000, release;
  const f = fixture({ now: () => clock, saved: savedBackup(clock), request: url => url.includes('backup.example') ? new Promise(done => { release = done; }) : response(json()) });
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    assert.equal(f.calls.length, 2); assert.equal(typeof release, 'function');
    let stopped = false; const pending = f.pool.stop().then(() => { stopped = true; });
    await flush(); assert.equal(stopped, true);
    const saved = f.metadata.get(KEY);
    clock = 2000; release(response(json())); await pending;
    assert.equal(stopped, true);
    assert.equal(f.metadata.get(KEY), saved);
  } finally { await f.pool.stop(); }
});

test('six-hour background health verification restores a paused automatic backup without rediscovering directories', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let broken = true;
  const f = fixture({ saved: { ...savedBackup(Date.now()), lastDiscovery: Date.now() }, request: url => {
    if (url.includes('bing.com')) return response(rss(quarkUrl));
    if (url.includes('backup.example')) return response(broken ? 'offline' : json(), broken ? 503 : 200);
    return response('{"results":[]}');
  } });
  try {
    await lookup(f.pool); assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'paused');
    f.pool.start(); t.mock.timers.tick(0); await flush();
    broken = false; t.mock.timers.tick(6 * 60 * 60_000); await flush();
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
    assert.equal(f.discoveryCalls.length, 0);
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup).failures, 0);
  } finally { await f.pool.stop(); }
});

test('pending or repeatedly failed automatic records cannot fill the pool and block a new endpoint or remove the manual primary', async () => {
  let clock = 1000;
  const candidates = Array.from({ length: 8 }, (_, index) => ({ url: `https://old${index}.example/api/search`, automatic: true, status: 'pending', failures: 0, addedAt: index + 1, checkedAt: 0, retryAt: 0 }));
  const f = fixture({ now: () => clock, saved: { candidates }, request: url => response(url.includes('manual.example') ? 'bad' : url.includes('bing.com') ? rss() : json()) });
  try {
    await lookup(f.pool); clock++;
    await f.pool.discover();
    const rows = f.pool.status().candidates;
    assert.ok(rows.length <= 8); assert.ok(rows.some(row => row.apiUrl.includes('published.example')));
    assert.ok(rows.some(row => row.apiUrl.includes('manual.example')));
    assert.ok(rows.some(row => row.apiUrl.includes('readme.example')));
  } finally { await f.pool.stop(); }
});

test('switching through nine manual endpoints keeps the ninth usable without growing or weakening discovery limits', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, request: url => {
    const index = /^manual(\d+)\.example$/.exec(new URL(url).hostname)?.[1];
    assert.ok(index, 'only the selected manual endpoint should be queried');
    return response(json('https://pan.quark.cn/s/endpoint' + index, '电影'));
  } });
  try {
    for (let index = 1; index <= 9; index++) {
      clock++;
      const url = `https://manual${index}.example/api/search`;
      const result = await lookup(f.pool, url + '?kw=电影');
      assert.deepEqual(result.results.map(row => row.url), [`https://pan.quark.cn/s/endpoint${index}?pwd=1234`]);
      assert.ok(f.pool.status().candidates.length <= 8);
      assert.ok(f.pool.status().candidates.some(row => row.apiUrl === url));
    }
    assert.equal(f.calls.length, 9);
    const beforeDiscovery = f.pool.status().candidates.map(row => row.apiUrl);
    assert.equal(beforeDiscovery.length, 8);
    assert.ok(!beforeDiscovery.includes('https://manual1.example/api/search'));
    await f.pool.discover();
    assert.deepEqual(f.pool.status().candidates.map(row => row.apiUrl), beforeDiscovery, 'automatic discovery must not evict manual history or grow a full pool');
    assert.equal(f.calls.length, 9);
  } finally { await f.pool.stop(); }
});

test('foreground returns pending while two APIs retain eight seconds and RSS then gets a fresh budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const releases = [];
  const f = fixture({ saved: savedBackup(Date.now()), request: url => url.includes('bing.com') ? response(rss(quarkUrl)) : new Promise(done => releases.push(done)) });
  try {
    const pending = lookup(f.pool); await flush(); assert.equal(releases.length, 2);
    t.mock.timers.tick(150); await flush(); assert.equal((await pending).pending, true);
    t.mock.timers.tick(7850); await flush();
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { poll: true })));
    assert.equal(result.results[0].url, quarkUrl); assert.equal(Date.now(), 9000);
    assert.equal(f.calls.at(-1).options.timeout, 1500);
    for (const done of releases) { const late = response(json()); done(late); await flush(); assert.equal(late.destroyed, true); }
  } finally { await f.pool.stop(); }
});

test('API and stalled RSS phases remain bounded after the pending foreground response', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stalled = [];
  const f = fixture({ saved: savedBackup(Date.now()), request: () => { const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); stalled.push(stream); return stream; } });
  try {
    const pending = lookup(f.pool); await flush();
    t.mock.timers.tick(150); await flush(); assert.equal((await pending).pending, true);
    t.mock.timers.tick(7850); await flush(); assert.equal(stalled.length, 3);
    t.mock.timers.tick(3000); await flush();
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { poll: true })));
    assert.deepEqual(result.results, []); assert.match(result.reason, /超时/);
    assert.equal(Date.now(), 12000); assert.equal(result.pending, undefined); assert.ok(stalled.every(stream => stream.destroyed));
  } finally { await f.pool.stop(); }
});

test('all foreground requests share two network slots and caller credentials never reach the transport', async () => {
  let active = 0, peak = 0;
  const f = fixture({ saved: savedBackup(Date.now()), request: async (_url, options) => {
    assert.equal(/cookie|authorization|user-cookie|user-token/i.test(JSON.stringify(options)), false);
    peak = Math.max(peak, ++active); await new Promise(done => setImmediate(done)); active--; return response(json());
  } });
  try { await Promise.all([lookup(f.pool), lookup(f.pool), lookup(f.pool)]); assert.equal(peak, 2); }
  finally { await f.pool.stop(); }
});

test('local queue timeouts never suspend a healthy endpoint that did not receive a request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const idle = 'https://idle.example/api/search';
  const saved = savedBackup(Date.now()); saved.candidates.push({ url: idle, automatic: false, status: 'healthy', addedAt: 1, checkedAt: 999, failures: 0, retryAt: 0 });
  const f = fixture({ saved, request: url => url.includes('bing.com') ? response(rss(quarkUrl)) : new Promise(() => {}) });
  try {
    const pending = Promise.all([lookup(f.pool, 'https://first.example/api/search?kw=一'), lookup(f.pool, 'https://second.example/api/search?kw=二'), lookup(f.pool, idle + '?kw=三')]);
    await flush(); t.mock.timers.tick(5500); await flush(); t.mock.timers.tick(200); await flush(); await pending;
    assert.ok(f.calls.every(call => !call.url.includes('idle.example')));
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl === idle).status, 'healthy');
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === idle).failures, 0);
  } finally { await f.pool.stop(); }
});

test('stop after acquiring work slots prevents dispatch and any persistence', async () => {
  const f = fixture({ saved: savedBackup(Date.now()) }), saved = f.metadata.get(KEY);
  const pending = assert.rejects(lookup(f.pool), /公开搜索已停止/);
  for (let count = 0; count < 3; count++) await Promise.resolve();
  assert.equal(f.calls.length, 0);
  await f.pool.stop(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.metadata.get(KEY), saved);
  assert.equal(f.pool.status().candidates.find(row => row.apiUrl === backup).status, 'healthy');
});

test('long encoded movie titles fit the existing request URL budget and never appear in the public pool status', async () => {
  const title = '电影'.repeat(150), url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: title });
  assert.ok(url.length > 2048);
  const f = fixture();
  try {
    assert.equal((await lookup(f.pool, url)).results.length, 1);
    assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), title);
    assert.equal(JSON.stringify(f.pool.status()).includes(title), false);
  } finally { await f.pool.stop(); }
});

test('public discovery and query URLs reject credentials, private literals and DNS rebinding while retaining only the exact existing sidecar exception', async () => {
  let publicCalls = 0;
  const guarded = createRequest({ lookup: async () => [{ address: '172.20.0.5', family: 4 }], httpRequest: () => assert.fail('private address must never be connected'), httpsRequest: () => assert.fail('private address must never be connected') });
  const search = createQuarkSearchRequest({ request: guarded, httpTransport: () => { throw new Error('fixture sidecar unavailable'); } });
  const f = fixture({ request: async (url, options) => { publicCalls++; return search(url, options); }, discoveryRequest: url => {
    if (url.includes('api.github.com')) return response('{"homepage":"http://127.0.0.1"}');
    return response('http://127.0.0.1/api/search https://bad.example/api/search?token=secret http://pansou:8888/api/search');
  } });
  try {
    for (const url of ['http://127.0.0.1/api/search?kw=x', 'http://PANSOU:8888/api/search?kw=x', 'http://pansou:8889/api/search?kw=x', 'https://public.example/api/search?kw=x&token=secret', 'https://user:secret@public.example/api/search?kw=x']) await assert.rejects(lookup(f.pool, url));
    assert.equal(publicCalls, 0);
    await f.pool.discover(); assert.equal(f.pool.status().candidates.length, 3);
    assert.ok(f.pool.status().candidates.every(row => [official, 'https://pansou.252035.xyz/api/search', 'https://www.pansousuo.com/api/search'].includes(row.apiUrl)));
    const rebound = await lookup(f.pool, 'https://rebind.example/api/search?kw=x');
    assert.deepEqual(rebound.results, []); assert.match(rebound.reason, /安全检查拒绝/);
    assert.equal(JSON.stringify(f.pool.status()).includes('secret'), false);
    const sidecar = await lookup(f.pool, 'http://pansou:8888/api/search?kw=x');
    assert.deepEqual(sidecar.results, []); assert.match(sidecar.reason, /连接失败/);
    assert.ok(f.calls.some(call => call.url.startsWith('http://pansou:8888/api/search?')));
  } finally { await f.pool.stop(); }
});

test('stop waits for current jobs, scheduled discovery stays single flight, and the stopped pool accepts no further work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let release;
  const f = fixture({ discoveryRequest: () => new Promise(done => { release = done; }) });
  f.pool.start(); t.mock.timers.tick(0); await flush();
  const discovery = f.pool.discover(); assert.equal(f.discoveryCalls.length, 1);
  let stopped = false; const pending = f.pool.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
  release(response('{"homepage":"https://published.example/"}')); await discovery; await pending;
  assert.equal(stopped, true); assert.equal(f.pool.status().enabled, false);
  assert.equal(f.calls.length, 0); assert.equal(f.discoveryCalls.length, 1);
  t.mock.timers.tick(7 * DAY); await flush(); assert.equal(f.discoveryCalls.length, 1);
  await assert.rejects(lookup(f.pool), /公开搜索已停止/);
});

test('complete titles are queried before year hints and unrelated titles or conflicting release years are excluded', async () => {
  const f = fixture({ request: url => {
    const word = new URL(url).searchParams.get('kw');
    if (word === '电影 2026') return response(json('https://pan.quark.cn/s/wrong123456', '其他电影 2025'));
    assert.equal(word, '电影');
    return response(JSON.stringify({ results: [
      { name: '电影 (2026) 4K', url: quarkUrl },
      { name: '电影 2025 1080p', url: 'https://pan.quark.cn/s/old12345678' },
      { name: '另一个片名 2026', url: 'https://pan.quark.cn/s/other123456' },
    ] }));
  } });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl]);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['电影']);
  } finally { await f.pool.stop(); }
});

test('explicit bounded aliases improve candidate ranking and English titles require complete word boundaries for relevance', async () => {
  const f = fixture({ request: url => {
    const word = new URL(url).searchParams.get('kw');
    return response(word === 'IT' ? JSON.stringify({ results: [
      { name: 'ＩＴ (2017) 4K', url: quarkUrl },
      { name: 'Reality (2017)', url: 'https://pan.quark.cn/s/wrong123456' },
      { name: 'It 1990', url: 'https://pan.quark.cn/s/old12345678' },
    ] }) : '{"results":[]}');
  } });
  try {
    const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('小丑回魂 2017');
    const result = JSON.parse(await readText(await f.pool.request(url, { aliases: [null, 'IT', 'Bad\nAlias', '第二个别名', '不应搜索'], headers: { Cookie: 'user-cookie' } })));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl]);
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['小丑回魂', 'IT']);
    assert.ok(f.calls.every(call => !JSON.stringify(call.options).includes('user-cookie')));
  } finally { await f.pool.stop(); }
});

test('fast APIs merge within 150 ms and duplicate share IDs retain the extraction password', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const another = 'https://pan.quark.cn/s/second123456';
  const f = fixture({ saved: savedBackup(Date.now()), request: async url => {
    if (!url.includes('backup.example')) return response(JSON.stringify({ results: [{ name: '电影', url: quarkUrl }] }));
    await new Promise(done => setTimeout(done, 100));
    return response(JSON.stringify({ results: [
      { name: '电影 4K', url: quarkUrl, password: '5678' },
      { name: '电影 HD', url: another },
      { name: '电影 蓝光', url: another + '?pwd=AB12' },
    ] }));
  } });
  try {
    let finished = false;
    const pending = lookup(f.pool).then(result => { finished = true; return result; });
    await flush(); t.mock.timers.tick(99); await flush(); assert.equal(finished, false);
    t.mock.timers.tick(1); await flush();
    const result = await pending;
    assert.equal(Date.now(), 1100); assert.equal(result.results.length, 2);
    assert.equal(result.results[0].url, quarkUrl + '?pwd=5678');
    assert.equal(result.results[1].url, another + '?pwd=AB12');
  } finally { await f.pool.stop(); }
});

test('a slow second API does not delay the first result and enriches a two-minute retry cache', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const another = 'https://pan.quark.cn/s/second123456';
  let release, delayed = true;
  const f = fixture({ saved: savedBackup(Date.now()), request: url => url.includes('backup.example') && delayed ? new Promise(done => { release = done; }) : response(json(url.includes('backup.example') ? another : quarkUrl)) });
  try {
    let finished = false;
    const pending = lookup(f.pool).then(result => { finished = true; return result; });
    await flush(); t.mock.timers.tick(149); await flush(); assert.equal(finished, false);
    t.mock.timers.tick(1); await flush(); assert.equal((await pending).results.length, 1);
    delayed = false; release(response(json(another))); await flush();
    assert.equal((await lookup(f.pool)).results.length, 2); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(120_000);
    assert.equal((await lookup(f.pool)).results.length, 2); assert.equal(f.calls.length, 4);
  } finally { await f.pool.stop(); }
});

test('the retry cache stays bounded to 32 queries and is never persisted', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 33; index++) await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片' + index));
    assert.equal(f.calls.length, 33);
    await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片32'));
    assert.equal(f.calls.length, 33);
    await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('影片0'));
    assert.equal(f.calls.length, 34);
    assert.equal(f.metadata.get(KEY).includes('影片'), false);
    assert.equal(f.metadata.get(KEY).includes('pan.quark.cn'), false);
  } finally { await f.pool.stop(); }
});

test('concurrent requests for one film share one API request and both receive their cached results', async () => {
  const f = fixture({ request: async () => { await new Promise(done => setImmediate(done)); return response(json()); } });
  try {
    const results = await Promise.all([lookup(f.pool), lookup(f.pool)]);
    assert.deepEqual(results.map(result => result.results.length), [1, 1]);
    assert.equal((await lookup(f.pool)).results.length, 1); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('RSS fallback recommends matching titles and separates unnamed candidates for review', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel>' +
    `<item><title><![CDATA[电影 (2026) 4K]]></title><link>${quarkUrl}?pwd=1234</link></item>` +
    '<item><title>电影 2025</title><link>https://pan.quark.cn/s/old12345678</link></item>' +
    '<item><title>另一个片名 2026</title><link>https://pan.quark.cn/s/wrong123456</link></item>' +
    '<item><link>https://pan.quark.cn/s/unnamed12345</link></item></channel></rss>' : '{"results":[]}') });
  try {
    const result = await lookup(f.pool, 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234']);
    assert.deepEqual(result.unverified.map(row => row.url), ['https://pan.quark.cn/s/unnamed12345']);
    assert.equal(result.unverified[0].name, '未提供资源标题');
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get('q'), '"电影" 2026 夸克 网盘');
  } finally { await f.pool.stop(); }
});

test('stop during a pending API prevents title and alias retries', async () => {
  let release;
  const f = fixture({ request: () => new Promise(done => { release = done; }) });
  const pending = assert.rejects(f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'), { aliases: ['Movie'] }), /公开搜索已停止/);
  await flush(); assert.equal(typeof release, 'function');
  const saved = f.metadata.get(KEY), stopped = f.pool.stop();
  release(response('{"results":[]}')); await pending; await stopped;
  assert.equal(f.calls.length, 1); assert.equal(f.metadata.get(KEY), saved);
});

test('stop during pending RSS rejects a late result without cache or persistence writes', async () => {
  let release;
  const f = fixture({ request: url => url.includes('bing.com') ? new Promise(done => { release = done; }) : response('{"results":[]}') });
  const pending = assert.rejects(f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026'), { aliases: ['Movie'] }), /公开搜索已停止/);
  await flush(); assert.equal(typeof release, 'function');
  const before = f.calls.length, saved = f.metadata.get(KEY), stopped = f.pool.stop();
  release(response(rss(quarkUrl))); await pending; await stopped;
  assert.equal(f.calls.length, before); assert.equal(f.metadata.get(KEY), saved);
  await assert.rejects(lookup(f.pool), /公开搜索已停止/);
});

test('explicit more checks APIs and continues public pages within two network slots, merging by date and share ID', async () => {
  let active = 0, peak = 0, googleCalls = 0;
  const at = Date.now();
  const latest = Date.parse('2026-10-13T00:00:00Z'), older = Date.parse('2026-09-01T00:00:00Z');
  const f = fixture({ now: () => at, saved: savedBackup(at), request: async (url, options) => {
    assert.equal(/cookie|authorization|user-cookie|user-token/i.test(JSON.stringify(options)), false);
    peak = Math.max(peak, ++active); await new Promise(done => setImmediate(done)); active--;
    return response(url.includes('bing.com') ? `<rss><channel><item><title>电影 2026</title><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate><link>${quarkUrl}?pwd=1234</link></item><item><title>电影 4K</title><link>https://pan.quark.cn/s/unknown12345</link></item></channel></rss>` : '<html>public index</html>');
  }, googleSearch: async (keyword, { read, deadline, now }) => {
    googleCalls++; assert.equal(keyword, '电影'); assert.equal(deadline - now(), 3000);
    await read('https://www.google.com/search?q=' + encodeURIComponent(keyword), 3000, 512 * 1024, deadline);
    await read('https://index.example/movie', 3000, 512 * 1024, deadline);
    return [
      { name: '电影 (2026) 4K', url: quarkUrl, publishedAt: latest },
      { name: '电影 (2026) HD', url: 'https://pan.quark.cn/s/old12345678', publishedAt: older },
      { name: '电影 (2025)', url: 'https://pan.quark.cn/s/wrong123456', publishedAt: latest },
    ];
  } });
  try {
    const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026');
    const result = JSON.parse(await readText(await f.pool.request(url, { webSearch: true, headers: { Cookie: 'user-cookie' } })));
    assert.equal(googleCalls, 1); assert.equal(peak, 2);
    assert.ok(f.calls.some(call => /manual\.example/.test(call.url))); assert.ok(f.calls.some(call => /backup\.example/.test(call.url)));
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/old12345678', 'https://pan.quark.cn/s/unknown12345']);
    assert.deepEqual(result.results.map(row => row.publishedAt), [latest, older, undefined]);
  } finally { await f.pool.stop(); }
});

test('successful API results avoid web scraping and preserve parent dates in newest-first stable order', async () => {
  const recent = Date.parse('2026-10-13T12:00:00Z');
  const f = fixture({ googleSearch: () => assert.fail('working APIs do not need Google'), renderSearch: () => assert.fail('matching APIs do not need browser work'), request: () => response(JSON.stringify({ results: [
    { title: '电影', links: [{ type: 'quark', url: quarkUrl }] },
    { title: '电影 HD', datetime: '2025-01-01T00:00:00Z', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/old12345678' }] },
    { title: '电影 4K', datetime: '2026-10-13T12:00:00Z', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/latest123456' }] },
    { title: '电影 无日期', date: '2027', links: [{ type: 'quark', url: 'https://pan.quark.cn/s/unknown12345' }] },
  ] })) });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results.map(row => row.url), ['https://pan.quark.cn/s/latest123456', 'https://pan.quark.cn/s/old12345678', quarkUrl, 'https://pan.quark.cn/s/unknown12345']);
    assert.equal(result.results[0].publishedAt, recent); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('web results survive one engine failing and API and web caches remain separate', async () => {
  let googleCalls = 0;
  const other = 'https://pan.quark.cn/s/second123456';
  const f = fixture({ request: url => response(url.includes('bing.com') ? 'blocked' : json(), url.includes('bing.com') ? 403 : 200), googleSearch: async () => { googleCalls++; return [{ name: '电影', url: other }]; } });
  try {
    assert.equal((await lookup(f.pool)).results[0].url, quarkUrl + '?pwd=1234'); assert.equal(googleCalls, 0);
    const web = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.deepEqual(new Set(web.results.map(row => row.url)), new Set([quarkUrl + '?pwd=1234', other])); assert.equal(googleCalls, 1);
    await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true }); assert.equal(googleCalls, 1);
    assert.equal((await lookup(f.pool)).results[0].url, quarkUrl + '?pwd=1234');
  } finally { await f.pool.stop(); }
});

test('unmatched APIs automatically use Google and its reads cannot exceed the remaining total budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const stalled = [];
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response(rss(quarkUrl));
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); stalled.push(stream); return stream;
  }, googleSearch: async (_keyword, { read, deadline }) => { await read('https://www.google.com/search?q=movie', 3000, 512 * 1024, deadline); return []; } });
  try {
    const pending = lookup(f.pool); await flush(); assert.equal(stalled.length, 1);
    t.mock.timers.tick(150); await flush(); assert.equal((await pending).pending, true);
    t.mock.timers.tick(7850); await flush(); assert.equal(stalled.length, 2);
    assert.equal(f.calls.find(call => call.url.includes('google.com')).options.timeout, 3000);
    t.mock.timers.tick(3000); await flush();
    const complete = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { poll: true })));
    assert.equal(complete.results[0].url, quarkUrl); assert.equal(Date.now(), 12000);
    assert.ok(stalled.every(stream => stream.destroyed));
  } finally { await f.pool.stop(); }
});

test('daily public discovery rotates wider Chinese queries and deployment sources with four bounded directory requests', async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  try {
    const queries = [];
    for (let day = 0; day < 7; day++) {
      const before = f.discoveryCalls.length;
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 4);
      queries.push(new URL(f.discoveryCalls.at(-1).url).searchParams.get('q'));
      await f.pool.discover(); assert.equal(f.discoveryCalls.length - before, 4);
      clock += DAY + 1;
    }
    assert.equal(new Set(queries.slice(0, 6)).size, 6); assert.equal(queries[0], queries[6]);
    assert.ok(queries.some(query => query.includes('夸克'))); assert.ok(queries.some(query => query.includes('网盘搜索')));
    assert.equal(JSON.parse(f.metadata.get(KEY)).discoveryCursor, 7);
    assert.ok(f.pool.status().candidates.length <= 8);
  } finally { await f.pool.stop(); }
});

test('duplicate dated API shares keep the latest extraction code even when a newer post has no code', async () => {
  const old = { name: '电影 旧码', url: quarkUrl + '?pwd=OLD1', datetime: '2026-10-10T00:00:00Z' };
  const fresh = { name: '电影 新码', url: quarkUrl + '?pwd=NEW2', datetime: '2026-10-11T00:00:00Z' };
  const noCode = { name: '电影 最新帖子无码', url: quarkUrl, datetime: '2026-10-12T00:00:00Z' };
  for (const rows of [[old, fresh], [fresh, old], [old, noCode, fresh], [fresh, noCode, old]]) {
    const f = fixture({ request: () => response(JSON.stringify({ results: rows })) });
    try {
      const result = await lookup(f.pool);
      assert.equal(result.results.length, 1); assert.equal(result.results[0].url, quarkUrl + '?pwd=NEW2');
      assert.equal(result.results[0].name, '电影 新码');
      assert.equal(result.results[0].publishedAt, Date.parse(rows.includes(noCode) ? noCode.datetime : fresh.datetime));
      assert.deepEqual(Object.keys(result.results[0]).sort(), ['name', 'password', 'publishedAt', 'url']);
    } finally { await f.pool.stop(); }
  }
});

test('cross-engine merging preserves the actual code date through a newer RSS post without a password', async () => {
  const f = fixture({ googleSearch: async () => [{ name: '电影 新码', url: quarkUrl + '?pwd=NEW2', publishedAt: Date.parse('2026-10-11T00:00:00Z') }], request: () => response('<rss><channel>' +
    `<item><title>电影 旧码</title><pubDate>Sat, 10 Oct 2026 00:00:00 GMT</pubDate><link>${quarkUrl}?pwd=OLD1</link></item>` +
    `<item><title>电影 新帖子无码</title><pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate><link>${quarkUrl}</link></item></channel></rss>`) });
  try {
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.equal(result.results.length, 1); assert.equal(result.results[0].url, quarkUrl + '?pwd=NEW2');
    assert.equal(result.results[0].name, '电影 新码');
    assert.equal(result.results[0].publishedAt, Date.parse('2026-10-12T00:00:00Z'));
    const cached = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { webSearch: true })));
    assert.deepEqual(cached, result); assert.equal(f.calls.length, 2);
  } finally { await f.pool.stop(); }
});

test('untrusted future dates and numeric bare years cannot lead API sorting or enter its retry cache', async () => {
  const clock = Date.parse('2026-10-14T00:00:00Z'), recent = clock - DAY;
  const f = fixture({ now: () => clock, request: () => response(JSON.stringify({ results: [
    { name: '电影 超远未来', publishedAt: Date.parse('2099-01-01T00:00:00Z'), url: quarkUrl },
    { name: '电影 裸年份', publishedAt: 2026, url: 'https://pan.quark.cn/s/bare12345678' },
    { name: '电影 真实日期', publishedAt: recent / 1000, url: 'https://pan.quark.cn/s/recent123456' },
    { name: '电影 明天以内', publishedAt: clock + DAY, url: 'https://pan.quark.cn/s/edge12345678' },
  ] })) });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results.map(row => row.url), ['https://pan.quark.cn/s/edge12345678', 'https://pan.quark.cn/s/recent123456', quarkUrl, 'https://pan.quark.cn/s/bare12345678']);
    assert.deepEqual(result.results.map(row => row.publishedAt), [clock + DAY, recent, undefined, undefined]);
    assert.deepEqual(await lookup(f.pool), result); assert.equal(f.calls.length, 1);
  } finally { await f.pool.stop(); }
});

test('future dates are discarded before web results merge and cached ordering', async () => {
  const clock = Date.parse('2026-10-14T00:00:00Z'), recent = clock - DAY;
  const f = fixture({ now: () => clock, googleSearch: async () => [
    { name: '电影 未来', publishedAt: clock + DAY + 1, url: quarkUrl },
    { name: '电影 最近', publishedAt: recent, url: 'https://pan.quark.cn/s/recent123456' },
  ], request: () => response(`<rss><channel><item><title>电影 未来RSS</title><pubDate>Thu, 01 Jan 2099 00:00:00 GMT</pubDate><link>https://pan.quark.cn/s/rss123456789</link></item></channel></rss>`) });
  try {
    const url = 'https://manual.example/api/search?kw=电影';
    const result = JSON.parse(await readText(await f.pool.request(url, { webSearch: true })));
    assert.equal(result.results[0].url, 'https://pan.quark.cn/s/recent123456');
    assert.deepEqual(result.results.map(row => row.publishedAt), [recent, undefined, undefined]);
    assert.deepEqual(JSON.parse(await readText(await f.pool.request(url, { webSearch: true }))), result);
  } finally { await f.pool.stop(); }
});

test('discovery retains valid Quark candidates for real catalogue naming variations and incomplete API metadata', async () => {
  const cases = [
    ['quality note', '遮天', { results: [{ title: '遮天 全季合集', links: [{ type: 'quark', url: quarkUrl, note: '4K1080P' }] }] }, '遮天'],
    ['missing title', '遮天', { results: [{ links: [{ type: 'quark', url: quarkUrl }] }] }, '未提供资源标题', [], 'unverified'],
    ['mixed collection years', '遮天', { results: [{ title: '遮天 动画持续更新至EP150 全季合集2022-2026', url: quarkUrl }] }, '遮天'],
    ['season status suffix with canonical alias', '一念永恒 完结季', { results: [{ title: '一念永恒 第一二三季合集', url: quarkUrl }] }, '一念永恒', ['一念永恒']],
    ['explicit abbreviated catalogue alias', '转生成为哥布林有什么问题吗？', { results: [{ title: '转生成为哥布林', url: quarkUrl }] }, '转生成为哥布林', ['转生成为哥布林']],
    ['recognizable data array', '遮天', { code: 200, data: [{ title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
    ['target after first 30 links', '遮天', { results: [...Array.from({ length: 30 }, (_, index) => ({ title: '公开资源' + index, url: 'https://pan.quark.cn/s/abcdef' + String(index).padStart(6, '0') })), { title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
    ['target after first 100 rows', '遮天', { results: [...Array.from({ length: 100 }, () => ({ title: '其他记录', links: [{ type: 'baidu', url: 'https://example.org' }] })), { title: '遮天 全季合集', url: quarkUrl }] }, '遮天'],
  ];
  for (const [label, keyword, body, expectedName, aliases = [], group = 'results'] of cases) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? rss() : JSON.stringify(body)) });
    try {
      const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?' + new URLSearchParams({ kw: keyword }), { year: '2023', aliases })));
      assert.ok(result[group].length > 0, label); assert.ok(result[group].length <= 30, label);
      assert.equal(result[group][0].url, quarkUrl, label); assert.ok(result[group][0].name.includes(expectedName), label);
    } finally { await f.pool.stop(); }
  }
});

test('canonical titles keep numeric endings when an explicit release year is supplied', async () => {
  for (const title of ['银翼杀手 2049', '希望2026']) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? rss() : json(undefined, title)) });
    try {
      const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: title });
      const result = JSON.parse(await readText(await f.pool.request(url, { year: title.startsWith('银翼') ? '2017' : '2026' })));
      assert.equal(result.results.length, 1); assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), title);
      assert.equal(f.calls.length, 1);
    } finally { await f.pool.stop(); }
  }
});

test('canonical web titles and explicit aliases reach Google without stripping numeric endings twice', async () => {
  const f = fixture({ request: () => response('<rss><channel></channel></rss>'), googleSearch: async (title, options) => {
    assert.equal(title, '银翼杀手 2049'); assert.equal(options.titleOnly, true);
    assert.deepEqual(options.aliases, ['Blade Runner 2049']);
    return [{ name: '银翼杀手 2049', url: quarkUrl }];
  } });
  try {
    const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: '银翼杀手 2049' });
    const result = JSON.parse(await readText(await f.pool.request(url, { year: '2017', aliases: ['Blade Runner 2049'], webSearch: true })));
    assert.equal(result.results.length, 1);
    assert.equal(new URL(f.calls.find(call => call.url.includes('bing.com')).url).searchParams.get('q'), '"银翼杀手 2049" 2017 夸克 网盘');
  } finally { await f.pool.stop(); }
});

test('an explicit unknown year still marks a numeric-ending title as canonical and stays separate from legacy queries', async () => {
  const f = fixture();
  try {
    const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: '银翼杀手 2049' });
    const canonical = JSON.parse(await readText(await f.pool.request(url, { year: '' })));
    assert.equal(canonical.results.length, 1);
    assert.equal(new URL(f.calls[0].url).searchParams.get('kw'), '银翼杀手 2049');
    await f.pool.request(url, { year: '' }); assert.equal(f.calls.length, 1);
    const legacy = JSON.parse(await readText(await f.pool.request(url)));
    assert.equal(legacy.results.length, 1);
    assert.equal(new URL(f.calls[1].url).searchParams.get('kw'), '银翼杀手');
    assert.equal(f.calls.length, 2);
  } finally { await f.pool.stop(); }
});

test('unknown candidates stay separate while a necessary explicit alias is still searched', async () => {
  const f = fixture({ request: url => response(new URL(url).searchParams.get('kw') === 'IT' ? json(quarkUrl, 'IT (2017)') : json('https://pan.quark.cn/s/weak12345678', '网盘资源链接')) });
  try {
    const result = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?' + new URLSearchParams({ kw: '小丑回魂' }), { year: '2017', aliases: ['IT'] })));
    assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('kw')), ['小丑回魂', 'IT']);
    assert.deepEqual(result.results.map(row => row.url), [quarkUrl + '?pwd=1234']);
    assert.deepEqual(result.unverified.map(row => row.url), ['https://pan.quark.cn/s/weak12345678?pwd=1234']);
  } finally { await f.pool.stop(); }
});

test('empty API searches expose fixed web failures instead of disguising them as a plain no-result response', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? 'blocked user-cookie' : '{"results":[]}', url.includes('bing.com') ? 403 : 200), googleSearch: async () => { throw new Error('private upstream failure user-token'); } });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results, []); assert.equal(result.reason, 'Google 公开搜索：搜索服务连接失败；Bing 公开搜索：搜索接口返回 HTTP 403');
    assert.equal(/user-cookie|user-token|private upstream|https?:/i.test(result.reason), false);
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'pending');
  } finally { await f.pool.stop(); }
});

test('upgrading retries the current paused manual API once while preserving automatic backoff and failed restart backoff', async () => {
  const clock = Date.now(), manual = 'https://manual.example/api/search';
  const saved = { candidates: [
    { url: manual, automatic: false, status: 'paused', failures: 3, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 6 * 60 * 60_000 },
    { url: backup, automatic: true, status: 'paused', failures: 2, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 60 * 60_000 },
  ] };
  const f = fixture({ saved, now: () => clock, request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : 'offline', url.includes('bing.com') ? 200 : 503) });
  let restarted;
  try {
    f.metadata.set('quark-search-recall-v2', '1');
    await lookup(f.pool);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    assert.equal(f.metadata.get('quark-search-availability-v3'), '1');
    assert.equal(f.metadata.get('quark-search-recall-v2'), '1');
    const failed = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === manual);
    assert.equal(failed.failures, 4); assert.equal(failed.status, 'paused'); assert.ok(failed.retryAt > clock);
    const automatic = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === backup);
    assert.equal(automatic.failures, 2); assert.equal(automatic.retryAt, clock + 60 * 60_000); assert.equal(automatic.status, 'paused');
    await f.pool.stop();
    const calls = [];
    restarted = createQuarkSearchPool({ store: f.store, now: () => clock, googleSearch: async () => [], request: async url => { calls.push(url); return response('<rss><channel></channel></rss>'); } });
    await lookup(restarted);
    assert.ok(calls.every(url => !url.includes('manual.example') && !url.includes('backup.example')));
    assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === manual).failures, 4);
  } finally { await f.pool.stop(); await restarted?.stop(); }
});

test('a successful one-time manual API retry clears failure count through normal health validation', async () => {
  const clock = Date.now();
  const f = fixture({ now: () => clock, saved: { candidates: [{ url: 'https://manual.example/api/search', automatic: false, status: 'paused', failures: 5, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 60 * 60_000 }] } });
  try {
    assert.equal((await lookup(f.pool)).results.length, 1);
    const current = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('manual.example'));
    assert.equal(current.status, 'healthy'); assert.equal(current.failures, 0); assert.equal(current.retryAt, 0);
    assert.equal(f.metadata.get('quark-search-availability-v3'), '1');
  } finally { await f.pool.stop(); }
});

test('real PanSou omitted empty arrays preserve a usable API for the next film', async () => {
  const f = fixture({ request: url => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('bing.com')) return response('blocked', 403);
    return response(parsed.searchParams.get('kw') === '电影' ? '{"code":0,"message":"success","data":{"total":0}}' : json(undefined, '遮天'));
  } });
  try {
    const empty = await lookup(f.pool);
    assert.deepEqual(empty.results, []); assert.ok(!/格式|JSON/.test(empty.reason));
    assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'pending');
    assert.equal((await lookup(f.pool, 'https://manual.example/api/search?kw=遮天')).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 2);
  } finally { await f.pool.stop(); }
});

test('an optional keyword exhausting its short budget cannot disable an API that already answered another keyword', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture({ request: async url => {
    const parsed = new URL(url), keyword = parsed.searchParams.get('kw');
    if (parsed.hostname.includes('bing.com')) return response('blocked', 403);
    if (keyword === '你我对抗全世界') { await new Promise(done => setTimeout(done, 4000)); return response('{"code":0,"message":"success","data":{"total":0,"results":[]}}'); }
    if (keyword === '遮天') return response(json(undefined, '遮天'));
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }); stream.write('{'); return stream;
  } });
  try {
    const pending = f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('你我对抗全世界'), { year: '2026' });
    await flush(); t.mock.timers.tick(4000); await flush();
    assert.equal(JSON.parse(await readText(await pending)).pending, true);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example'))[1].options.timeout, 4000);
    t.mock.timers.tick(4000); await flush();
    const first = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=' + encodeURIComponent('你我对抗全世界'), { year: '2026', poll: true })));
    assert.deepEqual(first.results, []); assert.match(first.reason, /超时/);
    const primary = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('manual.example'));
    assert.equal(primary.status, 'pending'); assert.equal(primary.failures, 0); assert.equal(primary.retryAt, 0);
    assert.equal((await lookup(f.pool, 'https://manual.example/api/search?kw=遮天')).results.length, 1);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 3);
  } finally { await f.pool.stop(); }
});

test('only explicit valid PanSou zero-result responses can omit the arrays', async () => {
  const invalid = [
    { code: 0, data: { total: 0, results: null } },
    { code: 0, data: { total: 0, merged_by_type: [] } },
    { code: 0, data: { total: '0' } },
    { code: 0, data: { total: 1 } },
    { code: 500, message: 'private user-cookie', data: { total: 0 } },
    { success: true, data: { total: 0 } },
    { status: 'ok', total: 0, auth_enabled: false },
  ];
  for (const body of invalid) {
    const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : JSON.stringify(body)) });
    try {
      const result = await lookup(f.pool);
      assert.deepEqual(result.results, []); assert.match(result.reason, /响应格式不兼容/);
      assert.equal(result.reason.includes('user-cookie'), false);
      assert.equal(f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example')).status, 'paused');
    } finally { await f.pool.stop(); }
  }
  const f = fixture({ request: () => response(JSON.stringify({ code: 0, data: { total: 0, results: [{ title: '电影', links: [{ type: 'quark', url: quarkUrl }] }] } })) });
  try { assert.equal((await lookup(f.pool)).results.length, 1); }
  finally { await f.pool.stop(); }
});

test('a genuine full-budget connection failure still backs off and the next film explains the retry window safely', async () => {
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response('upstream private user-cookie', 503);
    throw Object.assign(new Error('connect http://private.example user-token user-cookie'), { code: 'ECONNREFUSED' });
  } });
  try {
    const first = await lookup(f.pool);
    assert.deepEqual(first.results, []); assert.match(first.reason, /已配置搜索接口：搜索服务拒绝连接/);
    assert.match(first.reason, /HTTP 503/);
    const primary = f.pool.status().candidates.find(row => row.apiUrl.includes('manual.example'));
    assert.equal(primary.status, 'paused'); assert.ok(primary.retryAt > Date.now());
    const second = await lookup(f.pool, 'https://manual.example/api/search?kw=遮天');
    assert.deepEqual(second.results, []); assert.match(second.reason, /15 分钟后重试/);
    assert.equal(f.calls.filter(call => call.url.includes('manual.example')).length, 1);
    assert.equal(/private\.example|user-token|user-cookie/.test(JSON.stringify([first, second])), false);
  } finally { await f.pool.stop(); }
});

test('a first request with little budget left after queuing cannot pause an untested API', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture({ request: async url => {
    const parsed = new URL(url);
    if (parsed.hostname.includes('bing.com')) return response('<rss><channel></channel></rss>');
    if (parsed.hostname === 'short.example') throw Object.assign(new Error('private connection detail'), { code: 'ECONNREFUSED' });
    await new Promise(done => setTimeout(done, 3700)); return response(json());
  } });
  try {
    const pending = Promise.all(['https://busy1.example/api/search?kw=电影', 'https://busy2.example/api/search?kw=电影', 'https://short.example/api/search?kw=电影'].map(url => lookup(f.pool, url)));
    await flush(); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(3700); await flush();
    assert.ok((await pending).every(row => row.pending === true));
    const results = await Promise.all(['https://busy1.example/api/search?kw=电影', 'https://busy2.example/api/search?kw=电影', 'https://short.example/api/search?kw=电影'].map(async url => JSON.parse(await readText(await f.pool.request(url, { poll: true })))));
    assert.deepEqual(results.map(row => row.results.length), [1, 1, 0]);
    const short = f.calls.find(call => call.url.includes('short.example'));
    assert.equal(short.options.timeout, 4300);
    const state = JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url.includes('short.example'));
    assert.equal(state.status, 'pending'); assert.equal(state.failures, 0); assert.equal(state.retryAt, 0);
  } finally { await f.pool.stop(); }
});

test('HTML search failures expose a fixed non-JSON diagnostic without echoing upstream content', async () => {
  const f = fixture({ request: url => response(url.includes('bing.com') ? '<rss><channel></channel></rss>' : '<html>Cookie user-cookie Authorization user-token</html>') });
  try {
    const result = await lookup(f.pool);
    assert.deepEqual(result.results, []); assert.match(result.reason, /搜索接口未返回 JSON/);
    assert.equal(/user-cookie|user-token|Authorization|<html>/.test(result.reason), false);
  } finally { await f.pool.stop(); }
});

test('the fixed built-in helper backs off for 10, 20, 40 and at most 60 seconds after DNS startup failures', async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, request: url => {
    if (!url.startsWith('http://pansou:8888/')) return response('<rss><channel></channel></rss>');
    throw Object.assign(new Error('private http://pansou:8888/ Cookie user-cookie'), { status: 502, cause: Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }) });
  } });
  try {
    for (const delay of [10_000, 20_000, 40_000, 60_000, 60_000]) {
      const result = await lookup(f.pool, 'http://pansou:8888/api/search?kw=电影');
      assert.match(result.reason, /找不到搜索助手，请确认 pansou 服务已启动/);
      const current = f.pool.status().candidates.find(row => row.apiUrl === 'http://pansou:8888/api/search');
      assert.equal(current.retryAt - clock, delay);
      const before = f.calls.filter(call => call.url.startsWith('http://pansou:8888/')).length;
      const paused = await lookup(f.pool, 'http://pansou:8888/api/search?kw=遮天');
      assert.match(paused.reason, new RegExp((delay / 1000) + ' 秒后重试'));
      assert.equal(f.calls.filter(call => call.url.startsWith('http://pansou:8888/')).length, before);
      assert.equal(/private|user-cookie|http:\/\//.test(result.reason), false);
      clock = current.retryAt;
    }
  } finally { await f.pool.stop(); }
});

test('an old long pause on the fixed helper is lifted without another migration marker', async () => {
  const clock = Date.now(), sidecar = 'http://pansou:8888/api/search';
  const f = fixture({ now: () => clock, saved: { candidates: [{ url: sidecar, automatic: false, status: 'paused', failures: 5, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + 30 * 60_000 }] } });
  f.metadata.set('quark-search-availability-v3', '1');
  const beforeKeys = [...f.metadata.keys()].sort();
  try {
    const result = await lookup(f.pool, sidecar + '?kw=遮天');
    assert.equal(result.results.length, 1);
    assert.equal(f.calls.filter(call => call.url.startsWith(sidecar)).length, 1);
    const current = f.pool.status().candidates.find(row => row.apiUrl === sidecar);
    assert.equal(current.status, 'healthy'); assert.equal(current.retryAt, 0);
    assert.deepEqual([...f.metadata.keys()].sort(), beforeKeys);
  } finally { await f.pool.stop(); }
});

test('public network diagnostics use fixed categories without confusing a public DNS failure with the built-in helper', async () => {
  const cases = [
    ['ENOTFOUND', /域名解析失败/], ['EAI_AGAIN', /域名暂时无法解析/],
    ['ECONNREFUSED', /拒绝连接/], ['ENETUNREACH', /网络不可达/], ['EHOSTUNREACH', /网络不可达/],
    ['ECONNRESET', /连接中断/], ['EPIPE', /连接中断/], ['ETIMEDOUT', /请求超时/],
    ['CERT_HAS_EXPIRED', /TLS 验证或握手失败/], ['ERR_TLS_CERT_ALTNAME_INVALID', /TLS 验证或握手失败/],
    ['UNRECOGNIZED_PRIVATE_CODE', /连接失败/],
  ];
  for (const [code, expected] of cases) {
    const clock = Date.now();
    const f = fixture({ now: () => clock, request: url => {
      if (url.includes('bing.com')) return response('<rss><channel></channel></rss>');
      throw Object.assign(new Error('private http://private.example Cookie user-cookie'), { status: 502, cause: Object.assign(new Error('private DNS Authorization user-token'), { code }) });
    } });
    try {
      const result = await lookup(f.pool, 'https://pansou.example/api/search?kw=电影');
      assert.match(result.reason, expected);
      assert.equal(/private|user-cookie|user-token|Authorization|https?:|pansou/.test(result.reason), false);
      const current = f.pool.status().candidates.find(row => row.apiUrl === 'https://pansou.example/api/search');
      assert.equal(current.retryAt - clock, 15 * 60_000);
    } finally { await f.pool.stop(); }
  }
});

test('Google DNS diagnostics stay generic and unsupported content encoding has a fixed response error', async () => {
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response('<rss><channel></channel></rss>');
    const upstream = response('private body user-cookie'); upstream.headers['content-encoding'] = 'unsupported'; return upstream;
  }, googleSearch: async () => { throw Object.assign(new Error('private Google DNS user-token'), { code: 'ENOTFOUND' }); } });
  try {
    const result = await lookup(f.pool);
    assert.match(result.reason, /搜索响应内容异常/); assert.match(result.reason, /Google 公开搜索：搜索服务域名解析失败/);
    assert.equal(/private|user-cookie|user-token|pansou|http/.test(result.reason), false);
  } finally { await f.pool.stop(); }
});

test('a short persisted helper pause survives restart while old public pauses remain unchanged', async () => {
  let clock = Date.now();
  const sidecar = 'http://pansou:8888/api/search', publicApi = 'https://manual.example/api/search';
  for (const [url, delay] of [[sidecar, 60_000], [publicApi, 30 * 60_000]]) {
    const f = fixture({ now: () => clock, saved: { candidates: [{ url, automatic: false, status: 'paused', failures: 6, addedAt: clock - 1000, checkedAt: clock - 100, retryAt: clock + delay }] } });
    f.metadata.set('quark-search-availability-v3', '1');
    try {
      const result = await lookup(f.pool, url + '?kw=电影');
      assert.match(result.reason, url === sidecar ? /60 秒后重试/ : /30 分钟后重试/);
      assert.ok(f.calls.every(call => !call.url.startsWith(url)));
      const current = f.pool.status().candidates.find(row => row.apiUrl === url);
      assert.equal(current.retryAt, clock + delay);
      assert.equal(JSON.parse(f.metadata.get(KEY)).candidates.find(row => row.url === url).failures, 6);
    } finally { await f.pool.stop(); }
  }
});

const DAY = 86_400_000;
const emptyRss = '<rss><channel></channel></rss>';

test('pending render work shares normal/web queries and polls only snapshots without repeating any transport', async () => {
  let release, renders = 0, input, options, googleCalls = 0;
  const at = Date.now(), url = 'https://manual.example/api/search?kw=电影', query = { year: '2026', aliases: ['Movie'] };
  const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'),
    googleSearch: async () => { googleCalls++; return []; },
    renderSearch: (value, settings) => { renders++; input = value; options = settings; return new Promise(done => { release = done; }); } });
  const read = settings => f.pool.request(url, settings).then(readText).then(JSON.parse);
  try {
    const missing = await read({ ...query, poll: true, forceRefresh: true }); assert.deepEqual(missing.results, []); assert.equal(missing.pending, undefined); assert.equal(f.calls.length, 0); assert.equal(renders, 0);
    const first = await read(query); assert.equal(first.pending, true); assert.equal(first.retryAfterMs, 1500); assert.deepEqual(first.results, []);
    assert.equal(googleCalls, 0); assert.ok(f.calls.some(call => call.url.includes('bing.com'))); assert.ok(f.calls.some(call => call.url.includes('manual.example')));
    assert.deepEqual(input, { title: '电影', aliases: ['Movie'], year: '2026', page: 0 }); assert.equal(options.signal.aborted, false); assert.ok(options.deadline >= at + 45000);
    const calls = f.calls.length, staticCalls = googleCalls;
    assert.equal((await read({ ...query, poll: true })).pending, true); assert.equal((await read(query)).pending, true);
    assert.equal(f.calls.length, calls); assert.equal(googleCalls, staticCalls); assert.equal(renders, 1);
    assert.equal((await read({ ...query, webSearch: true, forceRefresh: true })).pending, true); assert.equal(renders, 1, 'normal and explicit fresh web requests share one active render');
    release([{ name: '电影 2026 4K', url: quarkUrl, publishedAt: at }, { name: '完全不同作品', url: 'https://pan.quark.cn/s/other123456' }, { name: '未提供资源标题', url: 'https://pan.quark.cn/s/unknown123456' }]);
    await flush(); const completedCalls = f.calls.length;
    for (const webSearch of [false, true]) {
      const result = await read({ ...query, webSearch, poll: true });
      assert.equal(result.pending, undefined); assert.deepEqual(result.results.map(row => row.url), [quarkUrl]); assert.equal(result.unverified.length, 1);
    }
    assert.equal(f.calls.length, completedCalls); assert.equal(renders, 1);
    await read(query); assert.equal(f.calls.length, completedCalls, 'successful render rows remain cached');
  } finally { release?.([]); await f.pool.stop(); }
});

test('an explicit fresh web search bypasses completed result and render caches while preserving valid old rows', async t => {
  for (const initialWeb of [false, true]) await t.test(initialWeb ? 'refresh a previous web search' : 'refresh a previous normal render', async () => {
    const releases = [];
    let renders = 0, googleCalls = 0;
    const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'),
      googleSearch: async () => { googleCalls++; return []; },
      renderSearch: () => { renders++; return new Promise(resolve => releases.push(resolve)); } });
    const url = 'https://manual.example/api/search?kw=电影', read = options => f.pool.request(url, options).then(readText).then(JSON.parse);
    try {
      assert.equal((await read({ webSearch: initialWeb })).pending, true);
      releases[0]([{ name: '电影', url: quarkUrl }]); await flush();
      assert.equal((await read({ webSearch: initialWeb })).results.length, 1);
      assert.equal(renders, 1); assert.equal(googleCalls, 0);
      const previousRows = [quarkUrl];
      const refreshed = await read({ webSearch: true, forceRefresh: true });
      assert.equal(refreshed.pending, true); assert.deepEqual(refreshed.results.map(row => row.url), previousRows);
      assert.equal(renders, 2); assert.equal(googleCalls, 0);
      const calls = f.calls.length;
      assert.equal((await read({ webSearch: true, forceRefresh: true })).pending, true);
      assert.equal((await read({ webSearch: true, poll: true, forceRefresh: true })).pending, true);
      assert.equal(renders, 2); assert.equal(googleCalls, 0); assert.equal(f.calls.length, calls);
      releases[1]([{ name: '电影', url: 'https://pan.quark.cn/s/fresh123456' }, { name: '其他作品', url: 'https://pan.quark.cn/s/unrelated123' }]); await flush();
      const complete = await read({ webSearch: true, poll: true, forceRefresh: true });
      assert.equal(complete.pending, undefined);
      assert.deepEqual(complete.results.map(row => row.url), [...previousRows, 'https://pan.quark.cn/s/fresh123456']);
      assert.equal(renders, 2); assert.equal(googleCalls, 0); assert.equal(f.calls.length, calls);
    } finally { for (const release of releases) release([]); await f.pool.stop(); }
  });
});

test('simultaneous fresh web requests share the in-flight fast search and do not turn forced polls into searches', async () => {
  let release, googleCalls = 0, renders = 0;
  const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'),
    googleSearch: async () => { googleCalls++; return []; },
    renderSearch: () => { renders++; return new Promise(resolve => { release = resolve; }); } });
  const url = 'https://manual.example/api/search?kw=电影', settings = { webSearch: true, forceRefresh: true };
  const read = options => f.pool.request(url, options).then(readText).then(JSON.parse);
  try {
    const first = read(settings); await flush();
    const second = read(settings); await flush();
    const calls = f.calls.length;
    assert.equal((await read({ ...settings, poll: true })).pending, true);
    assert.equal(googleCalls, 0); assert.equal(f.calls.length, calls);
    release([]); await Promise.all([first, second]); await flush();
    assert.equal(googleCalls, 0); assert.equal(renders, 1);
  } finally { release?.([]); await f.pool.stop(); }
});

test('completed empty or busy render snapshots remain pollable while a manual retry can start fresh work', async t => {
  for (const busy of [false, true]) await t.test(busy ? 'busy' : 'empty', async () => {
    let renders = 0;
    const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'), googleSearch: async () => [],
      renderSearch: async () => { renders++; if (busy) throw Object.assign(new Error('private upstream secret'), { status: 503 }); return []; } });
    const url = 'https://manual.example/api/search?kw=电影', read = poll => f.pool.request(url, poll ? { poll: true } : {}).then(readText).then(JSON.parse);
    try {
      await read(false); await flush(); const calls = f.calls.length;
      const completed = await read(true); assert.deepEqual(completed.results, []); assert.equal(completed.pending, undefined); assert.doesNotMatch(completed.reason || '', /private|secret/);
      await read(true); assert.equal(f.calls.length, calls); assert.equal(renders, 1, 'poll never recreates completed empty work');
      await read(false); await flush(); assert.equal(renders, 2, 'manual retry can recover from empty or busy work');
      assert.ok(f.calls.length > calls);
    } finally { await f.pool.stop(); }
  });
});

test('render has its own 45-second deadline and a timed-out poll never queues another browser', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let renders = 0, aborted = false;
  const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'), googleSearch: async () => [],
    renderSearch: (_query, { signal, deadline }) => new Promise((_, reject) => {
      renders++; assert.equal(deadline, 46000); signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
  const url = 'https://manual.example/api/search?kw=电影';
  try {
    const first = JSON.parse(await readText(await f.pool.request(url))); assert.equal(first.pending, true);
    t.mock.timers.tick(44999); await flush(); assert.equal(aborted, false);
    t.mock.timers.tick(1); await flush(); assert.equal(aborted, true);
    const completed = JSON.parse(await readText(await f.pool.request(url, { poll: true })));
    assert.equal(completed.pending, undefined); assert.match(completed.reason, /公开网页搜索超时/); assert.equal(renders, 1);
  } finally { await f.pool.stop(); }
});

test('stop aborts render first and drains the actual worker before returning, ignoring late rows', async () => {
  let release, signal, stopped = false;
  const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'), googleSearch: async () => [],
    renderSearch: (_query, options) => { signal = options.signal; return new Promise(done => { release = done; }); } });
  try {
    assert.equal((await lookup(f.pool)).pending, true); const metadata = f.metadata.get(KEY);
    const stopping = f.pool.stop().then(() => { stopped = true; }); await flush();
    assert.equal(signal.aborted, true); assert.equal(stopped, false, 'worker cleanup is drained');
    release([{ name: '电影', url: quarkUrl }]); await stopping; assert.equal(f.metadata.get(KEY), metadata);
    await assert.rejects(f.pool.request('https://manual.example/api/search?kw=电影', { poll: true }), { status: 503 });
  } finally { release?.([]); await f.pool.stop(); }
});

test('public article reads use the separate safe web transport with browser headers while APIs keep their own headers', async () => {
  const webCalls = [];
  const f = fixture({ request: value => response(value.includes('bing.com') ? emptyRss : '{"results":[]}'),
    webRequest: async (url, options) => { webCalls.push({ url, options }); return Object.assign(response('<html>public article</html>'), { finalUrl: 'https://article.example/resolved' }); },
    googleSearch: async (_title, { read, deadline }) => { const page = await read('https://article.example/movie', 3000, 512 * 1024, deadline); assert.match(page.html, /public article/); assert.equal(page.url, 'https://article.example/resolved'); return [{ name: '电影', url: quarkUrl }]; } });
  try {
    assert.equal((await lookup(f.pool)).results[0].url, quarkUrl); assert.equal(webCalls.filter(call => call.url.includes('article.example')).length, 1);
    const options = webCalls[0].options; assert.equal(options.followRedirects, true); assert.match(options.headers['user-agent'], /^Mozilla\/5\.0/);
    assert.match(options.headers.accept, /text\/html/); assert.equal(options.headers['accept-language'], 'zh-CN,zh;q=0.9');
    assert.equal(options.headers.cookie, undefined); assert.equal(options.headers.authorization, undefined);
    assert.equal(f.calls[0].options.headers['user-agent'], 'VipVideo-Web-quark-search'); assert.match(f.calls[0].options.headers.accept, /application\/json/);
  } finally { await f.pool.stop(); }
});

test('each completed more request advances bounded pages with or without a browser while polls never search', async t => {
  for (const browser of [false, true]) await t.test(browser ? 'browser helper' : 'static Google fallback without helper', async () => {
  const staticPages = [], renderedPages = [];
  const f = fixture({ request: url => response(url.includes('bing.com') ? emptyRss : '{"results":[]}'),
    googleSearch: async (_title, options) => { staticPages.push(options.page); return browser ? [] : [{ name: '电影 (2026) 夸克网盘', url: 'https://pan.quark.cn/s/page000' + options.page }]; },
    ...(browser ? { renderSearch: async query => { renderedPages.push(query.page); return [{ name: '电影 (2026) 夸克网盘', url: 'https://pan.quark.cn/s/page000' + query.page }]; } } : {}) });
  const url = 'https://manual.example/api/search?kw=' + encodeURIComponent('电影 2026');
  const read = async options => JSON.parse(await readText(await f.pool.request(url, options)));
  try {
    for (const page of [0, 1, 2, 0]) {
      await read({ webSearch: true, forceRefresh: true }); await flush();
      const calls = f.calls.length, searches = staticPages.length;
      const completed = await read({ webSearch: true, poll: true, forceRefresh: true });
      assert.ok(completed.results.some(row => row.url.endsWith('page000' + page)));
      assert.equal(f.calls.length, calls); assert.equal(staticPages.length, searches);
    }
    assert.deepEqual(staticPages, browser ? [] : [0, 1, 2, 0]); assert.deepEqual(renderedPages, browser ? [0, 1, 2, 0] : []);
  } finally { await f.pool.stop(); }
  });
});

test('an unconfigured default RSS entry tries the fixed PanSou helper and existing healthy backup before web search', async () => {
  const sidecar = 'http://pansou:8888/api/search', at = Date.now();
  const f = fixture({ saved: savedBackup(at), googleSearch: () => assert.fail('matching helpers answer normal default searches'),
    request: (url, options) => {
      assert.ok(url.startsWith(sidecar) || url.startsWith(backup));
      assert.equal(options.followRedirects, false); assert.equal(options.headers.cookie, undefined); assert.equal(options.headers.authorization, undefined);
      return response(json(url.startsWith(sidecar) ? quarkUrl : 'https://pan.quark.cn/s/backup123456', '希望 (2026) 夸克网盘'));
    } });
  try {
    const input = 'https://www.bing.com/search?' + new URLSearchParams({ q: '希望 site:pan.quark.cn/s', format: 'rss' });
    const result = JSON.parse(await readText(await f.pool.request(input, { year: '2026', aliases: ['Hope'] })));
    assert.equal(result.results.length, 2);
    assert.ok(f.calls.some(call => call.url.startsWith(sidecar))); assert.ok(f.calls.some(call => call.url.startsWith(backup)));
    const calls = f.calls.length; await f.pool.request(input, { year: '2026', aliases: ['Hope'], poll: true }); assert.equal(f.calls.length, calls);
  } finally { await f.pool.stop(); }
});

test('more refreshes the configured helper and retains its matches while continuing independent public pages', async () => {
  let googleCalls = 0;
  const f = fixture({ request: url => response(url.includes('bing.com') ? emptyRss : json()),
    googleSearch: async () => { googleCalls++; return [{ name: '电影 (2026) 夸克资源', url: 'https://pan.quark.cn/s/webadded123' }]; } });
  const url = 'http://pansou:8888/api/search?kw=电影';
  try {
    const result = JSON.parse(await readText(await f.pool.request(url, { webSearch: true, forceRefresh: true, year: '2026' })));
    assert.deepEqual(new Set(result.results.map(row => row.url)), new Set([quarkUrl + '?pwd=1234', 'https://pan.quark.cn/s/webadded123']));
    assert.equal(googleCalls, 1);
    assert.equal(new URL(f.calls.find(call => call.url.startsWith('http://pansou:8888/')).url).searchParams.get('refresh'), 'true');
    const calls = f.calls.length;
    await f.pool.request(url, { webSearch: true, poll: true, forceRefresh: true, year: '2026' });
    assert.equal(f.calls.length, calls); assert.equal(googleCalls, 1);
  } finally { await f.pool.stop(); }
});

test('a 6.2-second exact-film helper completes after the foreground response and normal/web polls share its snapshot', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const title = '生化危机：爆发夜'; let releaseApi, releaseRender, apiCalls = 0, renders = 0;
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response(emptyRss);
    apiCalls++; return new Promise(resolve => { releaseApi = resolve; });
  }, renderSearch: () => { renders++; return new Promise(resolve => { releaseRender = resolve; }); } });
  const url = 'http://pansou:8888/api/search?' + new URLSearchParams({ kw: title });
  const read = async options => JSON.parse(await readText(await f.pool.request(url, { year: '2026', ...options })));
  try {
    const initial = read({}); await flush(); t.mock.timers.tick(150); await flush();
    assert.equal((await initial).pending, true); assert.equal(apiCalls, 1); assert.equal(renders, 0);
    assert.equal((await read({ webSearch: true, forceRefresh: true })).pending, true);
    assert.equal(renders, 1, 'only explicit more starts renderer while the helper is still pending');
    const beforePoll = f.calls.length; await read({ poll: true }); await read({ webSearch: true, poll: true });
    assert.equal(f.calls.length, beforePoll); assert.equal(apiCalls, 1);
    t.mock.timers.tick(6050); releaseApi(response(json(quarkUrl, title + ' (2026) 夸克网盘'))); await flush();
    const late = await read({ poll: true }); assert.equal(late.results[0].url, quarkUrl + '?pwd=1234'); assert.equal(late.pending, true, 'renderer is still pending');
    releaseRender([]); await flush();
    const complete = await read({ webSearch: true, poll: true }); assert.equal(complete.results.length, 1); assert.equal(complete.pending, undefined);
    assert.equal(apiCalls, 1); assert.equal(renders, 1);
  } finally { releaseApi?.(response('{"results":[]}')); releaseRender?.([]); await f.pool.stop(); }
});

test('a slow empty helper leaves a complete Google SERP and article budget for the exact film', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const title = '生化危机：爆发夜', budgets = []; let releaseApi, apiCalls = 0;
  const f = fixture({ googleSearch: searchGoogleQuark,
    request: () => ++apiCalls === 1 ? new Promise(resolve => { releaseApi = resolve; }) : response('{"results":[]}'),
    webRequest: async (url, options) => {
      budgets.push({ article: url.includes('article.example'), timeout: options.timeout });
      if (url.includes('bing.com')) return response(emptyRss);
      if (url.includes('google.com')) {
        await new Promise(resolve => setTimeout(resolve, 1400));
        return response(`<a href="https://article.example/movie"><h3>${title} (2026) 夸克网盘</h3></a>`);
      }
      const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      const timer = setTimeout(() => stream.end(`<title>${title} (2026)</title><article><a href="${quarkUrl}">夸克网盘</a></article>`), 900);
      stream.once('close', () => clearTimeout(timer)); return stream;
    } });
  const url = 'https://manual.example/api/search?' + new URLSearchParams({ kw: title });
  try {
    const initial = f.pool.request(url, { year: '2026' }); await flush(); t.mock.timers.tick(150); await flush();
    assert.equal(JSON.parse(await readText(await initial)).pending, true);
    t.mock.timers.tick(6050); releaseApi(response('{"results":[]}')); await flush();
    t.mock.timers.tick(1400); await flush(); t.mock.timers.tick(900); await flush();
    const complete = JSON.parse(await readText(await f.pool.request(url, { year: '2026', poll: true })));
    assert.equal(complete.results[0].url, quarkUrl); assert.equal(complete.pending, undefined);
    assert.equal(budgets.find(row => row.article).timeout, 1600, 'article receives the remainder of a fresh three-second web phase');
  } finally { releaseApi?.(response('{"results":[]}')); await f.pool.stop(); }
});

test('stop settles a pending helper and discards its later valid result without restarting a poll', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let releaseApi;
  const f = fixture({ request: () => new Promise(resolve => { releaseApi = resolve; }) });
  try {
    const initial = lookup(f.pool); await flush(); t.mock.timers.tick(150); await flush(); assert.equal((await initial).pending, true);
    await f.pool.stop();
    const late = response(json()); releaseApi(late); await flush(); assert.equal(late.destroyed, true);
    await assert.rejects(lookup(f.pool), /已停止/);
  } finally { releaseApi?.(response('{"results":[]}')); await f.pool.stop(); }
});

test('a normal helper matching after four seconds never starts browser or public search work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let releaseApi, renders = 0;
  const f = fixture({ request: () => new Promise(resolve => { releaseApi = resolve; }),
    googleSearch: () => assert.fail('a matching normal helper does not need public search'), renderSearch: () => { renders++; return []; } });
  try {
    const initial = lookup(f.pool); await flush(); t.mock.timers.tick(150); await flush(); assert.equal((await initial).pending, true); assert.equal(renders, 0);
    t.mock.timers.tick(3850); releaseApi(response(json())); await flush();
    const complete = JSON.parse(await readText(await f.pool.request('https://manual.example/api/search?kw=电影', { poll: true })));
    assert.equal(complete.results.length, 1); assert.equal(complete.pending, undefined); assert.equal(renders, 0); assert.equal(f.calls.length, 1);
  } finally { releaseApi?.(response('{"results":[]}')); await f.pool.stop(); }
});

test('the default RSS and explicit PanSou endpoint share pending work while a different configured API stays isolated', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const releases = new Map(); let apiCalls = 0;
  const f = fixture({ request: url => {
    if (url.includes('bing.com')) return response(emptyRss);
    apiCalls++; return new Promise(resolve => releases.set(new URL(url).hostname, resolve));
  } });
  const input = 'https://www.bing.com/search?' + new URLSearchParams({ q: '电影 site:pan.quark.cn/s', format: 'rss' });
  const sidecar = 'http://pansou:8888/api/search?kw=电影', other = 'https://changed.example/api/search?kw=电影';
  try {
    const initial = f.pool.request(input); await flush(); t.mock.timers.tick(150); await flush(); await initial;
    await f.pool.request(sidecar); assert.equal(apiCalls, 1, 'same actual helper is reused after configuration switches to its explicit URL');
    const changed = f.pool.request(other); await flush(); t.mock.timers.tick(150); await flush(); await changed; assert.equal(apiCalls, 2);
    releases.get('changed.example')(response(json('https://pan.quark.cn/s/newapi123456'))); await flush();
    releases.get('pansou')(response(json(quarkUrl))); await flush();
    const current = JSON.parse(await readText(await f.pool.request(other, { poll: true })));
    assert.deepEqual(current.results.map(row => row.url), ['https://pan.quark.cn/s/newapi123456?pwd=1234']);
    const previous = JSON.parse(await readText(await f.pool.request(sidecar, { poll: true })));
    assert.deepEqual(previous.results.map(row => row.url), [quarkUrl + '?pwd=1234']); assert.equal(apiCalls, 2);
  } finally { for (const release of releases.values()) release(response('{"results":[]}')); await f.pool.stop(); }
});

test('background queries stay capped at thirty-two while preserving the two transport slots', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let active = 0, peak = 0;
  const f = fixture({ request: async url => { peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return response(url.includes('bing.com') ? emptyRss : '{"results":[]}'); },
    renderSearch: (_query, { signal }) => new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  try {
    const requests = Array.from({ length: 32 }, (_, index) => f.pool.request('https://manual.example/api/search?kw=电影' + index));
    await flush(); t.mock.timers.tick(150); await flush();
    assert.ok((await Promise.all(requests)).every(Boolean));
    const calls = f.calls.length;
    await assert.rejects(f.pool.request('https://manual.example/api/search?kw=另一个影片'), { status: 503 });
    assert.equal(f.calls.length, calls); assert.ok(peak <= 2);
  } finally { await f.pool.stop(); }
});

test('a fast primary result stays pending until the slow backup merges without a duplicate query', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let releaseBackup;
  const f = fixture({ saved: savedBackup(Date.now()), request: url => url.includes('backup.example') ? new Promise(resolve => { releaseBackup = resolve; }) : response(json()) });
  const url = 'https://manual.example/api/search?kw=电影';
  try {
    const initial = lookup(f.pool); await flush(); t.mock.timers.tick(150); await flush();
    const early = await initial; assert.equal(early.results.length, 1); assert.equal(early.pending, true);
    await f.pool.request(url); assert.equal(f.calls.length, 2);
    t.mock.timers.tick(6050); releaseBackup(response(json('https://pan.quark.cn/s/latebackup1'))); await flush();
    const complete = JSON.parse(await readText(await f.pool.request(url, { poll: true })));
    assert.equal(complete.results.length, 2); assert.equal(complete.pending, undefined); assert.equal(f.calls.length, 2);
  } finally { releaseBackup?.(response('{"results":[]}')); await f.pool.stop(); }
});
