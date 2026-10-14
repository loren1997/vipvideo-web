import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuarkRenderedSearch } from '../lib/quark-rendered-search.mjs';
import { createQuarkBrowserSearch } from '../lib/quark-browser-client.mjs';
import { createBrowserWorker } from '../browser-worker.mjs';
import http from 'node:http';

const query = { title: '希望2026', year: '2026', aliases: [] };
const article = (id, date, position = 0) => `<html><head><meta property="og:title" content="2026韩国电影希望Hope！科幻动作！"><meta itemprop="datePublished" content="${date}"></head><body><main><p>2026韩国电影希望Hope！科幻动作！</p>${'<p>正文介绍</p>'.repeat(position)}<div><span><a href="https://pan.quark.cn/s/${id}">夸克网盘分享</a></span></div></main><aside><a href="https://pan.quark.cn/s/other0000">无关资源</a></aside></body></html>`;
const serp = '<a href="https://public.example/older"><h3>希望 HOPE (2026) 夸克</h3></a><a href="https://public.example/newer"><h3>2026韩国电影希望Hope！夸克网盘分享</h3></a><a href="https://public.example/wrong"><h3>希望 (2013) 夸克网盘</h3></a>';
const bingSerp = '<ol><li class="b_algo"><h2><a href="https://public.example/older">希望 HOPE (2026) 夸克网盘</a></h2></li><li class="b_algo"><h2><a href="https://public.example/newer">2026韩国电影希望Hope！夸克网盘分享</a></h2></li></ol>';

test('advanced Google search opens matching articles, extracts anchors at any position, and sorts by actual publication time', async () => {
  const calls = [];
  const search = createQuarkRenderedSearch({ render: async url => {
    calls.push(url);
    return { url, html: url.includes('google.com/search') ? serp : article(url.endsWith('older') ? 'older0000' : 'newer0000', url.endsWith('older') ? '2026-09-01' : '2026-10-01', url.endsWith('older') ? 0 : 20) };
  } });
  const rows = await search(query);
  assert.equal(new URL(calls[0]).searchParams.get('q'), '"希望" 2026 夸克 网盘');
  assert.equal(new URL(calls[0]).searchParams.get('tbs'), 'sbd:1');
  assert.equal(new URL(calls[0]).searchParams.get('udm'), '14');
  assert.deepEqual(rows.map(row => new URL(row.url).pathname), ['/s/newer0000', '/s/older0000']);
  assert.equal(calls.length, 3); assert.ok(!calls.some(url => url.endsWith('wrong')));
});

test('browser headers HTTP path can finish without starting a browser and fallback renders only incomplete pages', async () => {
  let renders = 0;
  const search = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('google') ? serp : article('http0000', '2026-09-13', 10) }), render: async () => { renders++; throw new Error('not needed'); } });
  assert.equal((await search(query)).length, 1); assert.equal(renders, 0);
  const fallback = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('bing') ? bingSerp : url.includes('google') ? '<noscript>Please enable JavaScript to use Google Search.</noscript>' : '' }), render: async url => { renders++; assert.ok(!url.includes('google') && !url.includes('bing')); return { url, html: article('jslink00', '2026-09-13') }; } });
  assert.equal((await fallback(query)).length, 1); assert.equal(renders, 2);
});

test('compact title uses separate year, retries an exact alias and never claims an unrelated article', async () => {
  const words = [];
  const search = createQuarkRenderedSearch({ render: async url => {
    if (url.includes('google')) { const word = new URL(url).searchParams.get('q'); words.push(word); return { url, html: word === '"希望" 2026 夸克 网盘' ? '' : serp }; }
    return { url, html: '<main><h1>其他电影 (2026)</h1><a href="https://pan.quark.cn/s/unrelated">分享</a></main>' };
  } });
  assert.equal((await search({ ...query, aliases: ['Hope'] })).length, 0);
  assert.deepEqual(words, ['"希望" 2026 夸克 网盘', '"Hope" 2026 夸克 网盘']);
});

test('one failed article does not hide other results, cancellation and deadline stop new requests', async () => {
  const search = createQuarkRenderedSearch({ render: async url => { if (url.endsWith('older')) throw new Error('unavailable'); return { url, html: url.includes('google') ? serp : article('valid0000', '2026-09-13') }; } });
  assert.equal((await search(query)).length, 1);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(search(query, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(await search(query, { deadline: Date.now() - 1 }), []);
});

test('cloud search companion only receives title metadata through a fixed endpoint', async () => {
  let captured;
  const search = createQuarkBrowserSearch({ fetch: async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ results: [] }), { status: 200 }); } });
  await search({ ...query, cookie: 'must-never-leave-main-app' });
  assert.equal(captured.url, 'http://quark-browser:3020/search');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(captured.options.body)), ['title', 'aliases', 'year', 'page', 'budgetMs']);
  assert.ok(!captured.options.body.includes('must-never-leave-main-app'));
  const missing = createQuarkBrowserSearch({ fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.match((await missing(query)).reason, /更新部署配置/);
});

test('isolated worker rejects URL and credential input without launching browser and has no account routes', async t => {
  let renders = 0, closed = false;
  const app = createBrowserWorker({ browser: { render: async () => { renders++; }, close: async () => { closed = true; } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); assert.equal(closed, true); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  assert.equal((await fetch(base + '/health')).status, 200);
  for (const extra of [{ url: 'http://127.0.0.1' }, { cookie: 'private' }, ...[-1, 3, 1.5, '1'].map(page => ({ page }))]) {
    const response = await fetch(base + '/search', { method: 'POST', body: JSON.stringify({ ...query, budgetMs: 1000, ...extra }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(base + '/api/quark/settings')).status, 404);
  assert.equal(renders, 0);
});

test('worker executes title to Google to article to share end to end and only returns matched public links', async t => {
  const calls = [];
  const app = createBrowserWorker({ browser: { render: async () => { throw new Error('HTTP was sufficient'); }, close: async () => {} },
    read: async url => { calls.push(url); return { url, html: url.includes('google') ? serp : article('worker00', '2026-09-13', 15) }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/search', { method: 'POST', body: JSON.stringify({ ...query, budgetMs: 5000 }) });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://pan.quark.cn/s/worker00');
  assert.equal(calls.filter(url => url.startsWith('https://public.example/')).length, 2); assert.ok(calls.length <= 8); assert.ok(!JSON.stringify(result).includes('<html>'));
});

test('Bing RSS can supply articles when Google asks for verification', async () => {
  let renders = 0;
  const search = createQuarkRenderedSearch({ read: async url => ({ url, html: url.includes('bing') ? '<rss><channel><item><title>希望 HOPE (2026) 夸克</title><link>https://public.example/newer</link></item></channel></rss>' : url.includes('google') ? '<title>安全验证</title><div class="g-recaptcha"></div>' : article('bing0000', '2026-09-13') }),
    render: async () => { renders++; throw new Error('captcha must not start browser'); } });
  assert.equal((await search(query)).length, 1);
  assert.equal(renders, 0);
});

test('Google JavaScript shells stop after one read while Chinese Bing independently finds exact official aliases', async () => {
  const calls = [];
  const search = createQuarkRenderedSearch({ render: () => assert.fail('readable public pages do not need Chromium'), read: async (url, { deadline }) => {
    calls.push({ url, deadline });
    if (url.includes('google')) return { url, html: '<title>Google Search</title><a href="/httpservice/retry/enablejs">Please enable JavaScript to use Google Search.</a>' };
    if (url.includes('bing')) return { url, html: new URL(url).searchParams.get('q').startsWith('"호프"') ? '<ol><li class="b_algo"><h2><a href="https://public.example/hope">호프 (2026) 夸克网盘</a></h2></li></ol>' : '<rss><channel></channel></rss>' };
    return { url, html: '<title>호프 (2026) 夸克网盘</title><main><a href="https://pan.quark.cn/s/korean001">点击获取</a></main>' };
  } });
  const started = Date.now();
  const rows = await search({ title: '希望', aliases: ['Hope', '호프'], year: '2026' });
  assert.deepEqual(rows.map(row => row.url), ['https://pan.quark.cn/s/korean001']);
  assert.equal(calls.filter(call => call.url.includes('google')).length, 1);
  assert.ok(calls.filter(call => call.url.includes('bing')).every(call => call.deadline <= started + 12000));
});

test('worker accepts page two and sends bounded later-page offsets to each public search channel', async t => {
  const urls = [];
  const app = createBrowserWorker({ browser: { render: () => assert.fail('empty search results do not launch Chromium'), close: async () => {} },
    read: async url => { urls.push(new URL(url)); return { url, html: '<rss><channel></channel></rss>' }; } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/search', { method: 'POST', body: JSON.stringify({ ...query, page: 2, budgetMs: 3000 }) });
  assert.equal(response.status, 200);
  assert.ok(urls.some(url => url.hostname === 'www.google.com' && url.searchParams.get('start') === '20'));
  assert.ok(urls.some(url => url.hostname === 'cn.bing.com' && url.searchParams.get('first') === '21'));
  assert.ok(urls.length <= 6);
});

test('worker decodes Chinese titles split across HTTP chunks and aborts its entire search at the supplied budget', async t => {
  let title;
  const app = createBrowserWorker({ browser: { render: async () => { throw new Error('not needed'); }, close: async () => {} }, read: async (url, { signal }) => {
    title = new URL(url).searchParams.get('q');
    await new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const body = Buffer.from(JSON.stringify({ ...query, budgetMs: 1100 }));
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/search', method: 'POST' }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(data) }));
    });
    req.on('error', reject);
    (async () => { for (const byte of body) { req.write(Buffer.from([byte])); await new Promise(done => setImmediate(done)); } req.end(); })().catch(reject);
  });
  assert.equal(title, '"希望" 2026 夸克 网盘');
  assert.equal(result.status, 504); assert.equal(result.value.reason, 'browserTimeout');
});
