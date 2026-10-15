import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createRequest } from '../lib/network.mjs';
import { createQuarkBrowser } from '../lib/quark-browser.mjs';

const executablePath = [process.env.CHROMIUM_PATH, process.env.BROWSER_EXECUTABLE, '/usr/bin/chromium', chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value));
const response = (body, statusCode = 200, headers = { 'content-type': 'text/html; charset=utf-8' }) => Object.assign(typeof body === 'string' ? Readable.from([Buffer.from(body)]) : body, { statusCode, headers });

function fixture(routes, { lookup, trace } = {}) {
  const calls = [], lookups = [], browsers = [], launchOptions = [];
  let active = 0, maximum = 0;
  const transport = (url, options, callback) => {
    const outgoing = new EventEmitter();
    let incoming;
    outgoing.destroy = error => { incoming?.destroy(error); outgoing.emit('error', error); };
    const abort = () => outgoing.destroy(options.signal.reason);
    outgoing.end = () => queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        if (error) return outgoing.destroy(error);
        trace?.({ event: 'route', ordinal: calls.length + 1, publicReload: /(?:^|;\s*)public_reload=ready(?:;|$)/.test(options.headers.cookie || '') });
        calls.push({ url: url.href, headers: options.headers, addresses });
        const route = routes[url.pathname];
        incoming = route ? route(url, options) : response('', 404);
        incoming.once('close', () => options.signal?.removeEventListener('abort', abort));
        options.signal?.addEventListener('abort', abort, { once: true });
        outgoing.emit('response', incoming);
        callback(incoming);
      });
    });
    return outgoing;
  };
  const safeRequest = createRequest({ lookup: async host => {
    lookups.push(host);
    return lookup ? lookup(host) : host.endsWith('.private.example') ? [{ address: '192.168.1.20', family: 4 }] : [{ address: '10.1.2.3', family: 4 }, { address: '8.8.8.8', family: 4 }];
  }, httpRequest: transport, httpsRequest: transport });
  const renderer = createQuarkBrowser({ safeRequest, executablePath, launch: async options => {
    launchOptions.push(options);
    trace?.({ event: 'launch-start' });
    const browser = await chromium.launch(options);
    trace?.({ event: 'launch-ready', version: browser.version() });
    browsers.push(browser);
    maximum = Math.max(maximum, ++active);
    browser.once('disconnected', () => active--);
    return browser;
  } });
  return { renderer, calls, lookups, browsers, launchOptions, active: () => active, maximum: () => maximum };
}

test('rejects malicious entry URLs and an already cancelled job before launching', async () => {
  let launches = 0;
  const renderer = createQuarkBrowser({ launch: () => { launches++; throw Error('unexpected launch'); } });
  for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'http://localhost/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/', 'https://user:secret@public.example/']) await assert.rejects(renderer.render(url), /内网|HTTP/);
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(renderer.render('https://public.example/', { signal: controller.signal }), /already cancelled/);
  await assert.rejects(renderer.render('https://public.example/', { deadline: Date.now() - 1 }), { quarkPoolReason: 'browserTimeout', quarkBrowserPhase: 'queue' });
  assert.equal(launches, 0);
  await renderer.close();
});

test('browser launch timeouts remain distinct from missing or broken browser installations', async t => {
  for (const [name, expected] of [['TimeoutError', 'browserTimeout'], ['Error', 'browserUnavailable']]) {
    const renderer = createQuarkBrowser({ executablePath: 'synthetic-browser', launch: async () => { throw Object.assign(new Error('synthetic launch failure'), { name }); } });
    try { await assert.rejects(renderer.render('https://public.example/'), { quarkPoolReason: expected, ...(name === 'TimeoutError' ? { quarkBrowserPhase: 'launch' } : {}) }); }
    finally { await renderer.close(); }
  }
});

test('a context timeout reports its phase and releases the launched browser', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let entered, closed = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const renderer = createQuarkBrowser({ executablePath: 'synthetic-browser', launch: async () => ({
    version: () => '1.0',
    newContext: () => { entered(); return new Promise(() => {}); },
    close: async () => { closed++; },
  }) });
  try {
    const result = assert.rejects(renderer.render('https://public.example/private-token?pwd=secret', { deadline: Date.now() + 100 }), error => {
      assert.equal(error.quarkPoolReason, 'browserTimeout');
      assert.equal(error.quarkBrowserPhase, 'context');
      assert.doesNotMatch(error.message, /private-token|secret/);
      return true;
    });
    await started;
    t.mock.timers.tick(100);
    await result;
    assert.equal(closed, 1);
  } finally { await renderer.close(); }
});

test('headless Chromium renders through the validated transport', { skip: executablePath ? false : 'No local Chromium; set CHROMIUM_PATH to run rendering and SSRF fixtures.' }, async t => {
  await t.test('waits for a script-only page to reload into a visible article using temporary public cookies', async t => {
    const started = performance.now(), events = [];
    const trace = entry => { if (events.length < 16) events.push({ elapsedMs: Math.round((performance.now() - started) * 100) / 100, ...entry }); };
    let failed;
    const value = fixture({
      '/delayed-article': (_url, options) => /public_reload=ready/.test(options.headers.cookie || '')
        ? response('<title>希望 (2026)</title><article><h1>希望 (2026)</h1><a href="https://pan.quark.cn/s/reload26">夸克网盘分享</a></article>')
        : response('<script>document.cookie="public_reload=ready; Secure; SameSite=Lax";setTimeout(()=>location.reload(),1200)</script>'),
    }, { trace });
    try {
      trace({ event: 'render-start' });
      const result = await value.renderer.render('https://page.example/delayed-article');
      trace({ event: 'render-ready' });
      assert.equal(result.title, '希望 (2026)');
      assert.match(result.html, /https:\/\/pan\.quark\.cn\/s\/reload26/);
      assert.equal(value.calls.length, 2);
      assert.match(value.calls[1].headers.cookie, /public_reload=ready/);
      assert.ok(value.calls.every(call => call.addresses.every(record => record.address === '8.8.8.8')));
    } catch (error) { failed = error; throw error; }
    finally {
      try { await value.renderer.close(); }
      finally { t.diagnostic(JSON.stringify({ executablePath, events, ...(failed ? { reason: failed.quarkPoolReason || failed.name, phase: failed.quarkBrowserPhase } : { completed: true }) })); }
    }
    assert.equal(value.active(), 0);
  });

  await t.test('hidden text and hidden public links cannot make an empty article ready', async () => {
    const value = fixture({ '/empty-article': () => response('<title>Empty</title><div hidden>隐藏正文</div><div style="opacity:0"><a href="https://pan.quark.cn/s/hidden26">隐藏链接</a></div>') });
    const started = Date.now();
    try {
      await assert.rejects(value.renderer.render('https://page.example/empty-article', { deadline: started + 3500 }), { quarkPoolReason: 'browserTimeout' });
      assert.ok(Date.now() - started < 5000);
    } finally { await value.renderer.close(); }
    assert.equal(value.active(), 0);
  });

  await t.test('keeps dynamic visible article structure while blocking private frames/fetch/redirect/WS and credentials', async () => {
    let directConnections = 0;
    const trap = http.createServer((_request, reply) => { directConnections++; reply.end('private'); });
    await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
    const privateUrl = `http://127.0.0.1:${trap.address().port}/secret`;
    const script = `
      document.title = '动态电影 2026';
      document.cookie = 'public_session=temporary';
      window.open('https://popup.example/escaped');
      try { new WebSocket('${privateUrl.replace('http:', 'ws:')}'); } catch {}
      try { new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:3478'}]}); } catch {}
      for (const target of ['${privateUrl}', 'https://api.private.example/secret', '/private-redirect', '/dns-redirect']) fetch(target).catch(() => {});
      fetch('/api', {headers:{Authorization:'Bearer forbidden'}}).then(reply => reply.json()).then(data => {
        document.querySelector('article').innerHTML = '<h1>动态电影 2026</h1><p>2026年10月14日公开分享</p><object class="object-height"><a href="'+data.url+'">动态电影 2026 夸克</a></object>';
      });
    `;
    const value = fixture({
      '/start': () => response('', 302, { location: 'https://page.example/article' }),
      '/article': () => response(`<title>JS shell</title><meta property="article:published_time" content="2026-10-14T10:00:00+08:00"><meta itemprop="datePublished" content="2026-10-14"><script type="application/ld+json">{"datePublished":"2026-10-14"}</script><nav class="recommendations"><a href="https://pan.quark.cn/s/other123">其他电影</a></nav><article class="post-content"></article><div hidden>隐藏私货</div><div style="display:none">不可见正文</div><iframe src="https://frame.private.example/secret"></iframe><iframe src="https://page.example/private-redirect"></iframe><script>${script}</script><img src="https://image.example/pixel"><audio autoplay src="https://media.example/sound"></audio>`, 200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['http_session=fresh; HttpOnly; SameSite=Lax; Secure'] }),
      '/clean': () => response('<title>clean</title><main>Public page</main>'),
      '/api': () => response('{"url":"https://pan.quark.cn/s/fixture123?pwd=abc1"}', 200, { 'content-type': 'application/json' }),
      '/private-redirect': () => response('', 302, { location: privateUrl }),
      '/dns-redirect': () => response('', 302, { location: 'https://redirect.private.example/secret' }),
    });
    try {
      const render = async url => {
        try { return await value.renderer.render(url); }
        catch (error) {
          const requests = {};
          for (const call of value.calls) { const path = new URL(call.url).pathname; requests[path] = (requests[path] || 0) + 1; }
          console.error('Chromium fixture failed:', JSON.stringify({ reason: error.quarkPoolReason, phase: error.quarkBrowserPhase, launches: value.launchOptions.length, launched: value.browsers.length, requests, lookups: value.lookups.length }));
          throw error;
        }
      };
      const result = await render('https://page.example/start');
      assert.equal(result.url, 'https://page.example/article');
      assert.equal(result.title, '动态电影 2026');
      assert.match(result.html, /<article class="post-content"><h1>动态电影 2026<\/h1>/);
      assert.match(result.html, /fixture123\?pwd=abc1/);
      assert.match(result.html, /<nav class="recommendations">/);
      assert.match(result.html, /article:published_time/);
      assert.match(result.html, /itemprop="datePublished"/);
      assert.match(result.html, /application\/ld\+json/);
      assert.doesNotMatch(result.html, /隐藏私货|不可见正文|<iframe|document\.cookie/);
      assert.equal(result.links.find(link => link.url.includes('fixture123')).text, '动态电影 2026 夸克');
      assert.ok(!value.lookups.includes('frame.private.example'));
      assert.ok(value.lookups.includes('api.private.example'));
      assert.ok(value.lookups.includes('redirect.private.example'));
      assert.ok(value.calls.every(call => !/private\.example|127\.0\.0\.1|image\.example|media\.example|popup\.example/.test(call.url)));
      assert.ok(value.calls.every(call => call.addresses[0].address === '8.8.8.8'));
      assert.ok(value.calls.every(call => !call.headers.authorization));
      const cookie = value.calls.find(call => call.url.endsWith('/api')).headers.cookie;
      assert.match(cookie, /public_session=temporary/);
      assert.match(cookie, /http_session=fresh/);
      assert.equal(directConnections, 0);
      assert.equal(value.active(), 0);
      assert.ok(value.browsers.every(browser => !browser.isConnected()));
      const options = value.launchOptions[0];
      assert.equal(options.headless, true);
      for (const flag of ['--mute-audio', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND']) assert.ok(options.args.includes(flag));
      await render('https://page.example/clean');
      assert.equal(value.calls.find(call => call.url.endsWith('/clean')).headers.cookie, undefined);
      assert.equal(value.active(), 0);
    } finally {
      await value.renderer.close();
      await new Promise(resolve => trap.close(resolve));
    }
  });

  await t.test('private main-document redirects fail without transport access to the target', async () => {
    const value = fixture({ '/redirect': () => response('', 302, { location: 'https://main.private.example/secret' }) });
    try {
      await assert.rejects(value.renderer.render('https://page.example/redirect'), { status: 403 });
      assert.deepEqual(value.calls.map(call => call.url), ['https://page.example/redirect']);
      assert.ok(value.lookups.includes('main.private.example'));
      assert.equal(value.active(), 0);
    } finally { await value.renderer.close(); }
  });

  await t.test('stops at a Google verification navigation without fetching or retrying it', async () => {
    const value = fixture({ '/search': () => response('<title>Search</title><script>location.href="https://www.google.com/sorry/index"</script>') });
    try {
      await assert.rejects(value.renderer.render('https://www.google.com/search'), { quarkPoolReason: 'browserBlocked' });
      assert.deepEqual(value.calls.map(call => new URL(call.url).pathname), ['/search']);
      assert.equal(value.active(), 0);
    } finally { await value.renderer.close(); }
  });

  await t.test('request floods stop the process and a failed page is not a successful render', async () => {
    const value = fixture({
      '/flood': () => response('<title>Flood</title><script>for(let i=0;i<100;i++)fetch("/telemetry",{method:"POST"}).catch(()=>{})</script>'),
      '/failed': () => response('<meta charset="utf-8"><title>Movie title</title><main>加载失败\n请稍后重试</main>'),
    });
    try {
      await assert.rejects(value.renderer.render('https://page.example/flood'), { quarkPoolReason: 'browserFailed' });
      assert.ok(value.calls.every(call => !call.url.endsWith('/telemetry')));
      assert.equal(value.active(), 0);
      await assert.rejects(value.renderer.render('https://page.example/failed'), /公开网页加载失败/);
      assert.equal(value.active(), 0);
    } finally { await value.renderer.close(); }
  });

  await t.test('cancellation releases the process, queued cancellation starts no process, and the next job works', async () => {
    let started;
    const loaded = new Promise(resolve => { started = resolve; });
    const value = fixture({
      '/hang': () => { started(); return response(new Readable({ read() {} })); },
    });
    const other = fixture({ '/ready': () => response('<title>ready</title><article><h1>Ready</h1><a href="https://pan.quark.cn/s/ready123">Ready 2026</a></article>') });
    const firstController = new AbortController(), queuedController = new AbortController();
    const first = value.renderer.render('https://page.example/hang', { signal: firstController.signal });
    const firstRejected = assert.rejects(first, /cancel first/);
    try {
      await loaded;
      const queued = other.renderer.render('https://page.example/ready', { signal: queuedController.signal });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(other.launchOptions.length, 0);
      queuedController.abort(new Error('cancel queued'));
      await assert.rejects(queued, /cancel queued/);
      firstController.abort(new Error('cancel first'));
      await firstRejected;
      assert.equal(value.active(), 0);
      assert.equal(value.launchOptions.length, 1);
      const result = await other.renderer.render('https://page.example/ready');
      assert.equal(result.title, 'ready');
      assert.equal(other.launchOptions.length, 1);
      assert.equal(value.maximum(), 1);
      assert.equal(value.active(), 0);
      assert.equal(other.active(), 0);
    } finally { firstController.abort(); await value.renderer.close(); await other.renderer.close(); }
  });

  await t.test('deadline and close terminate active work and refuse later jobs', async () => {
    let loaded;
    const started = new Promise(resolve => { loaded = resolve; });
    const value = fixture({ '/hang': () => { loaded(); return response(new Readable({ read() {} })); } });
    try {
      await assert.rejects(value.renderer.render('https://page.example/hang', { deadline: Date.now() + 200 }), { quarkPoolReason: 'browserTimeout' });
      assert.equal(value.active(), 0);
      const job = value.renderer.render('https://page.example/hang');
      const rejected = assert.rejects(job, { quarkPoolReason: 'browserUnavailable' });
      await started;
      await value.renderer.close();
      await rejected;
      assert.equal(value.active(), 0);
      await assert.rejects(value.renderer.render('https://page.example/hang'), { quarkPoolReason: 'browserUnavailable' });
    } finally { await value.renderer.close(); }
  });
});
