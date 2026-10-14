import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuarkTelegramSearch, extractQuarkTelegramResults, searchTelegramQuark } from '../lib/quark-telegram-search.mjs';
import { quarkPasswordDate } from '../lib/quark-google-search.mjs';

const now = Date.parse('2026-10-15T00:00:00Z'), pageUrl = 'https://t.me/s/Quark_Movies?q=%E5%B8%8C%E6%9C%9B';
const post = (id, heading, body, date = '2026-10-14T00:00:00Z') => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div data-post="Quark_Movies/${id}" class="js-widget_message tgme_widget_message"><div class="tgme_widget_message_text js-message_text">名称：<b>${heading}</b><br/><br/>${body}</div><div class="tgme_widget_message_footer"><a href="https://t.me/Quark_Movies/${id}"><time datetime="${date}"></time></a></div></div></div>`;
const extract = (html, options = {}) => extractQuarkTelegramResults(html, { url: pageUrl, title: '希望', aliases: ['Hope'], year: 2026, now, ...options });
const link = 'https://pan.quark.cn/s/abc123456789';

test('extracts same-post Quark links at different positions and sorts real publication dates', () => {
  const old = post(10, '希望 Hope (2026) 1080p', `<div>介绍</div>链接：<a href="${link}">夸克</a><br/>提取码：A1b2`, '2026-10-10T00:00:00Z');
  const recent = post(12, '希望 HOPE（2026）4K', `先提供链接 ${link.replace('abc123456789', 'bbb123456789')}<br/>简介：电影`, '2026-10-14T00:00:00Z');
  const result = extract(old + recent);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].publishedAt, Date.parse('2026-10-14T00:00:00Z'));
  assert.equal(result.rows[1].url, link + '?pwd=A1b2');
  assert.equal(result.nextBefore, '10');
});

test('does not borrow a matching film title from descriptions, other posts or the channel header', () => {
  const html = `<h1>希望 (2026)</h1>` + post(10, '阳光女子合唱团 (2026)', `故事充满希望 ${link}`) + post(11, '希望 (2026)', '暂无链接') + `<aside>${link}</aside>`;
  assert.deepEqual(extract(html).rows, []);
});

test('does not borrow the links beneath another explicit film name in a mixed post', () => {
  const html = post(10, '希望 (2026)', `简介：当前影片<br/>名称：<b>另一个电影 (2026)</b><br/><a href="${link}">夸克</a>`);
  assert.deepEqual(extract(html).rows, []);
});

test('requires the film year when provided and rejects wrong titles, sequels and generic names', () => {
  for (const heading of ['希望 (2013)', '希望', 'Hope Returns (2026)', '希望之城 (2026)', '夸克网盘资源 (2026)']) assert.deepEqual(extract(post(10, heading, link)).rows, [], heading);
});

test('keeps bilingual aliases and normalizes highlight markup in the heading', () => {
  const html = post(10, '<mark>希望</mark> HOPE (2026)', `<a href="${link}?pwd=xy12">资源</a>`);
  assert.equal(extract(html).rows[0].url, link + '?pwd=xy12');
});

test('keeps dates from the matching post, ignores future dates and deduplicates by latest post', () => {
  const html = post(10, '希望 (2026)', link, '2026-10-10T00:00:00Z') + post(11, '希望 (2026)', link, '2026-10-14T00:00:00Z') + post(12, '希望 (2026)', link.replace('abc123456789', 'bbb123456789'), '2099-01-01T00:00:00Z');
  const result = extract(html).rows;
  assert.equal(result.length, 2);
  assert.equal(result[0].publishedAt, Date.parse('2026-10-14T00:00:00Z'));
  assert.equal(result[1].publishedAt, undefined);
});

test('keeps a same-post extraction code even when the plain duplicate appears first', () => {
  const html = post(10, '希望 (2026)', `<a href="${link}">夸克</a><br/><a href="${link}?pwd=AB12">夸克</a>`);
  assert.equal(extract(html).rows[0].url, link + '?pwd=AB12');
});

test('retains the newest known code without lending it the newer uncoded post date', () => {
  const html = post(10, '希望 (2026)', link + '?pwd=old1', '2026-10-10T00:00:00Z') + post(12, '希望 (2026)', link + '?pwd=new2', '2026-10-12T00:00:00Z') + post(14, '希望 (2026)', link, '2026-10-14T00:00:00Z') + post(11, '希望 (2026)', link + '?pwd=old3', '2026-10-11T00:00:00Z');
  const row = extract(html).rows[0];
  assert.equal(row.url, link + '?pwd=new2');
  assert.equal(row.publishedAt, Date.parse('2026-10-14T00:00:00Z'));
  assert.equal(row[quarkPasswordDate], Date.parse('2026-10-12T00:00:00Z'));
});

test('takes the dated footer rather than the earlier photo link to the same post', () => {
  const html = post(10, '希望 (2026)', link).replace('<div class="tgme_widget_message_text', '<a href="https://t.me/Quark_Movies/10">海报</a><div class="tgme_widget_message_text');
  assert.equal(extract(html).rows[0].publishedAt, Date.parse('2026-10-14T00:00:00Z'));
});

test('rejects oversized documents, unrelated domains, private links and malformed post identity', () => {
  const html = post(10, '希望 (2026)', `<a href="http://127.0.0.1:8888/s/abc123456789">夸克</a>`);
  assert.deepEqual(extract(html).rows, []);
  for (const url of ['http://t.me/s/Quark_Movies', 'https://t.me.example/s/Quark_Movies', 'https://t.me/s/Other', 'https://t.me:443/s/Other']) assert.deepEqual(extract(post(10, '希望 (2026)', link), { url }).rows, []);
  assert.deepEqual(extract('x'.repeat(512 * 1024 + 1)).rows, []);
  assert.deepEqual(extract(post(10, '希望 (2026)', link).replace('Quark_Movies/10', 'Other/10')).rows, []);
});

test('first page uses only the primary title and one official alias, with shared bounds', async () => {
  const calls = [];
  const rows = await searchTelegramQuark('希望', { aliases: ['希望', 'Hope', '호프'], year: 2026, now: () => now, deadline: now + 9000, read: async (url, duration, maxBytes, end) => {
    calls.push({ url: new URL(url), duration, maxBytes, end });
    return { html: post(10, '希望 HOPE (2026)', link), url };
  } });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('q')), ['希望', 'Hope']);
  assert.ok(calls.every(call => call.duration <= 5000 && call.maxBytes === 512 * 1024 && call.end === now + 9000));
});

test('find more follows same-query before cursors instead of rereading only the first page', async () => {
  const calls = [];
  const rows = await createQuarkTelegramSearch()('希望', { year: 2026, page: 2, now: () => now, read: async url => {
    const query = new URL(url); calls.push(query.searchParams.get('before'));
    return post(calls.length === 1 ? 30 : calls.length === 2 ? 20 : 10, '希望 (2026)', link.replace('abc123456789', `${calls.length}bc123456789`));
  } });
  assert.deepEqual(calls, [null, '30', '20']);
  assert.equal(rows.length, 3);
});

test('never follows a cursor from another channel and stops repeated cursors', async () => {
  let count = 0;
  await createQuarkTelegramSearch()('希望', { page: 2, now: () => now, read: async () => { count++; return post(30, '希望 (2026)', link); } });
  assert.equal(count, 2);
  count = 0;
  await createQuarkTelegramSearch()('希望', { page: 2, now: () => now, read: async () => { count++; return post(30, '希望 (2026)', link).replaceAll('Quark_Movies/30', 'Other/30'); } });
  assert.equal(count, 1);
});

test('find more advances both official names and reaches alias-only results on pages two and three', async () => {
  const search = createQuarkTelegramSearch(), calls = [];
  const read = async url => {
    const query = new URL(url), q = query.searchParams.get('q'), before = query.searchParams.get('before');
    calls.push({ q, before });
    const id = before ? Number(before) - 10 : 30;
    return post(id, q === 'Hope' ? 'Hope (2026)' : '其他影片 (2026)', id < 30 ? link.replace('abc123456789', `abc0000000${id}`) : '暂无链接');
  };
  const options = { aliases: ['Hope'], year: 2026, now: () => now, read };
  assert.equal((await search('希望', options)).length, 0);
  assert.equal((await search('希望', { ...options, page: 1 })).length, 1);
  assert.equal((await search('希望', { ...options, page: 2 })).length, 1);
  assert.deepEqual(calls, [{ q: '希望', before: null }, { q: 'Hope', before: null }, { q: '希望', before: '30' }, { q: 'Hope', before: '30' }, { q: '希望', before: '20' }, { q: 'Hope', before: '20' }]);
});

test('a cold find-more request bootstraps fairly within three reads and retry resets cursors', async () => {
  const search = createQuarkTelegramSearch(), calls = [];
  const options = { aliases: ['Hope'], year: 2026, now: () => now, read: async url => {
    const query = new URL(url); calls.push({ q: query.searchParams.get('q'), before: query.searchParams.get('before') });
    return post(query.searchParams.has('before') ? 20 : 30, '希望 Hope (2026)', link);
  } };
  await search('希望', { ...options, page: 1 });
  assert.deepEqual(calls, [{ q: '希望', before: null }, { q: 'Hope', before: null }, { q: '希望', before: '30' }]);
  calls.length = 0;
  await search('希望', options);
  assert.deepEqual(calls, [{ q: '希望', before: null }, { q: 'Hope', before: null }]);
});

test('the cross-query merge preserves a known code when a newer alias post omits it', async () => {
  const rows = await createQuarkTelegramSearch()('希望', { aliases: ['Hope'], year: 2026, now: () => now, read: async url => new URL(url).searchParams.get('q') === '希望' ? post(10, '希望 (2026)', link + '?pwd=AB12', '2026-10-10T00:00:00Z') : post(12, 'Hope (2026)', link, '2026-10-12T00:00:00Z') });
  assert.equal(rows[0].url, link + '?pwd=AB12');
  assert.equal(rows[0][quarkPasswordDate], Date.parse('2026-10-10T00:00:00Z'));
  assert.equal(rows[0].publishedAt, Date.parse('2026-10-12T00:00:00Z'));
});

test('same-film concurrent searches serialize cursor updates and cancelled reads do not skip a page', async () => {
  const search = createQuarkTelegramSearch(), calls = []; let release, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const options = { year: 2026, now: () => now, read: async url => {
    const before = new URL(url).searchParams.get('before'); calls.push(before);
    if (calls.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return post(before ? Number(before) - 10 : 30, '希望 (2026)', link);
  } };
  const first = search('希望', options); await beginning;
  const second = search('希望', { ...options, page: 1 });
  await Promise.resolve(); assert.equal(calls.length, 1);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, [null, '30']);
  const controller = new AbortController();
  await assert.rejects(search('希望', { ...options, page: 2, signal: controller.signal, read: async url => { calls.push(new URL(url).searchParams.get('before')); controller.abort(); return post(10, '希望 (2026)', link); } }), { name: 'AbortError' });
  await search('希望', { ...options, page: 2 });
  assert.deepEqual(calls.slice(-2), ['20', '20']);
});

test('an aborted queued search releases its turn without letting a later caller overtake an active read', async () => {
  const search = createQuarkTelegramSearch(), calls = []; let release, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const options = { year: 2026, now: () => now, read: async url => {
    const before = new URL(url).searchParams.get('before'); calls.push(before);
    if (calls.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return post(before ? 20 : 30, '希望 (2026)', link);
  } };
  const first = search('希望', options); await beginning;
  const controller = new AbortController(), queued = search('希望', { ...options, page: 1, signal: controller.signal });
  controller.abort(); await assert.rejects(queued, { name: 'AbortError' });
  const last = search('希望', { ...options, page: 1 });
  await Promise.resolve(); assert.equal(calls.length, 1);
  release(); await Promise.all([first, last]);
  assert.deepEqual(calls, [null, '30']);
});

test('cancelling the alias read rolls back the already fetched primary cursor as well', async () => {
  const search = createQuarkTelegramSearch(), calls = [], controller = new AbortController();
  const options = { aliases: ['Hope'], year: 2026, now: () => now, read: async url => {
    const query = new URL(url); calls.push({ q: query.searchParams.get('q'), before: query.searchParams.get('before') });
    return post(query.searchParams.has('before') ? 20 : 30, '希望 Hope (2026)', link);
  } };
  await search('希望', options);
  await assert.rejects(search('希望', { ...options, page: 1, signal: controller.signal, read: async url => {
    const html = await options.read(url);
    if (new URL(url).searchParams.get('q') === 'Hope') controller.abort();
    return html;
  } }), { name: 'AbortError' });
  calls.length = 0; await search('希望', { ...options, page: 1 });
  assert.deepEqual(calls, [{ q: '希望', before: '30' }, { q: 'Hope', before: '30' }]);
});

test('time waiting for the same-film lock counts against the caller deadline', async () => {
  const search = createQuarkTelegramSearch(), calls = []; let clock = now, release, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const options = { year: 2026, now: () => clock, read: async url => {
    const before = new URL(url).searchParams.get('before'); calls.push(before);
    if (calls.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return post(before ? 20 : 30, '希望 (2026)', link);
  } };
  const first = search('希望', options); await beginning;
  const queued = search('希望', { ...options, page: 1, deadline: clock + 1000 });
  clock += 2000; release(); await first;
  assert.equal((await queued).reason, '公开频道搜索超时');
  assert.equal(calls.length, 1);
  await search('希望', { ...options, page: 1 });
  assert.deepEqual(calls, [null, '30']);
});

test('cursor memory expires after two minutes and keeps at most thirty-two film keys', async () => {
  const search = createQuarkTelegramSearch(), calls = []; let clock = now;
  const options = { year: 2026, now: () => clock, read: async url => {
    const query = new URL(url), before = query.searchParams.get('before'); calls.push(before);
    return post(before ? Number(before) - 10 : 30, `${query.searchParams.get('q')} (2026)`, link);
  } };
  for (let index = 0; index < 33; index++) await search(`电影${index}`, options);
  calls.length = 0; await search('电影0', { ...options, page: 1 });
  assert.deepEqual(calls, [null, '30', '20']);
  clock += 120_001; calls.length = 0;
  await search('电影0', { ...options, page: 2 });
  assert.deepEqual(calls, [null, '30', '20']);
});

test('honors expired deadlines and cancellation without making extra requests', async () => {
  let count = 0;
  assert.deepEqual(await searchTelegramQuark('希望', { now: () => now, deadline: now - 1, read: async () => { count++; } }), []);
  assert.equal(count, 0);
  const controller = new AbortController();
  await assert.rejects(searchTelegramQuark('希望', { aliases: ['Hope'], now: () => now, signal: controller.signal, read: async () => { count++; controller.abort(); return ''; } }), { name: 'AbortError' });
  assert.equal(count, 1);
});

test('does not accept redirects outside the public channel and preserves bounded errors', async () => {
  const rows = await searchTelegramQuark('希望', { now: () => now, read: async () => ({ html: post(10, '希望 (2026)', link), url: 'https://example.com/article' }) });
  assert.deepEqual(rows, []);
  const failed = await searchTelegramQuark('希望', { now: () => now, read: async () => { throw new Error('request timeout'); } });
  assert.equal(failed.reason, '公开频道搜索超时');
});
