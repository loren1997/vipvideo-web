import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import { createRequest, isPublicAddress, readBuffer, readText, validateUrl } from '../lib/network.mjs';

function response(body = '', statusCode = 200, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { statusCode, headers });
}

function transport(routes, calls) {
  return (url, options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = error => queueMicrotask(() => outgoing.emit('error', error));
    outgoing.end = body => queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        calls.push({ url: url.href, options, addresses, body });
        const incoming = routes[url.href]();
        outgoing.emit('response', incoming);
        callback(incoming);
      });
    });
    return outgoing;
  };
}

test('fixed-origin POST sends a bounded body and never follows redirects with credentials', async () => {
  const calls = [];
  const routes = { 'https://cloud.example/api': () => response('ok'), 'https://cloud.example/redirect': () => response('', 302, { location: 'https://other.example/capture' }) };
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: transport(routes, calls) });
  const incoming = await request('https://cloud.example/api', { method: 'POST', body: '{"fid":"safe"}', followRedirects: false, headers: { Cookie: 'session=test' } });
  assert.equal(await readText(incoming), 'ok'); assert.equal(calls[0].body, '{"fid":"safe"}');
  await assert.rejects(request('https://cloud.example/redirect', { method: 'POST', body: '{}', headers: { Cookie: 'session=test' } }), /不允许重定向/);
  assert.equal(calls.length, 2);
  for (const options of [{ method: 'GET', body: 'bad' }, { method: 'POST', body: {} }, { method: 'POST', body: 'x'.repeat(65537) }]) await assert.rejects(request('https://cloud.example/api', options), { status: 400 });
});

test('cross-origin redirects strip sensitive headers and explicit redirect refusal reaches no new host', async () => {
  const calls = [];
  const routes = { 'https://cloud.example/start': () => response('', 302, { location: 'https://cdn.example/file' }), 'https://cdn.example/file': () => response('data') };
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: transport(routes, calls) });
  const incoming = await request('https://cloud.example/start', { headers: { cOOkie: 'secret', Authorization: 'secret', 'Proxy-Authorization': 'secret', Range: 'bytes=0-10' } });
  assert.equal(await readText(incoming), 'data');
  assert.equal(calls[1].options.headers.cOOkie, undefined); assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers['Proxy-Authorization'], undefined); assert.equal(calls[1].options.headers.Range, 'bytes=0-10');
  await assert.rejects(request('https://cloud.example/start', { followRedirects: false }), /不允许重定向/);
  assert.equal(calls.length, 3);
});

test('rejects private, documentation, multicast and mapped private addresses', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.31.1.1', '192.168.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', '::ffff:127.0.0.1', '::ffff:c0a8:1', 'invalid']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});

test('URL validation rejects credentials, unsafe protocols and obfuscated private literals', () => {
  for (const url of ['file:///etc/passwd', 'ftp://video.example/file', 'https://user:secret@video.example/', 'not-a-url']) assert.throws(() => validateUrl(url), { status: 400 });
  for (const url of ['http://localhost/', 'http://video.localhost/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/']) assert.throws(() => validateUrl(url), { status: 403 });
  assert.equal(validateUrl('https://media.example/movie.m3u8?token=a%2Fb&x=1#part').href, 'https://media.example/movie.m3u8?token=a%2Fb&x=1');
});

test('pins the validated DNS address and validates every redirect', async () => {
  const calls = [];
  const routes = {
    'https://source.example/api': () => response('', 302, { location: 'https://cdn.example/list?key=1' }),
    'https://cdn.example/list?key=1': () => response('ok'),
  };
  const lookupCalls = [];
  const safeRequest = createRequest({ lookup: async hostname => { lookupCalls.push(hostname); return [{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]; }, httpsRequest: transport(routes, calls) });
  const result = await safeRequest('https://source.example/api');
  assert.deepEqual(lookupCalls, ['source.example', 'cdn.example']);
  assert.deepEqual(calls[0].addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(calls[0].options.agent.keepAlive, true);
  assert.equal(result.finalUrl, 'https://cdn.example/list?key=1');
  assert.equal(await readText(result), 'ok');
});

test('reuses bounded media connections only for the same validated address while rechecking DNS', async t => {
  let connections = 0, lookups = 0, requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('part'); });
  server.on('connection', () => connections++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agents = new Set(), addresses = ['8.8.8.8', '8.8.8.8', '1.1.1.1', '10.0.0.1'];
  const request = createRequest({ lookup: async () => [{ address: addresses[lookups++], family: 4 }],
    httpRequest: (url, options, callback) => {
      agents.add(options.agent);
      return http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, callback);
    } });
  t.after(async () => { for (const agent of agents) agent?.destroy?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (let index = 0; index < 3; index++) assert.equal(await readText(await request('http://cdn.example/part.ts')), 'part');
  await assert.rejects(request('http://cdn.example/part.ts'), { status: 403 });
  assert.equal(lookups, 4, 'Every media request still validates current DNS records');
  assert.equal(requests, 3, 'A later private DNS answer must not reuse an existing public socket');
  assert.equal(connections, 2, 'The first two segments reuse a connection; a different validated IP uses a new one');
  assert.equal(agents.size, 1);
  const [agent] = agents;
  assert.equal(agent.keepAlive, true);
  assert.ok(agent.maxSockets <= 8 && agent.maxTotalSockets <= 32 && agent.maxFreeSockets <= 2);
});

test('aborting while waiting for response headers releases the outgoing media connection', async t => {
  let received, closed;
  const entered = new Promise(resolve => { received = resolve; }), disconnected = new Promise(resolve => { closed = resolve; });
  const server = http.createServer(req => { req.on('close', closed); received(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agents = new Set();
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpRequest: (url, options, callback) => {
    agents.add(options.agent);
    return http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, callback);
  } });
  t.after(async () => { for (const agent of agents) agent?.destroy?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController(), pending = request('http://cdn.example/slow.ts', { signal: controller.signal, timeout: 200 });
  await entered; controller.abort();
  await assert.rejects(pending, error => error.cause?.code === 'ABORT_ERR');
  await disconnected;
});

test('mixed DNS pins only a public answer and never connects to reserved answers or private redirect targets', async () => {
  const mixedCalls = [];
  const mixed = createRequest({ lookup: async () => [{ address: '10.0.0.1', family: 4 }, { address: '2001:db8::1', family: 6 }, { address: '8.8.8.8', family: 4 }], httpsRequest: transport({ 'https://source.example/': () => response('ok') }, mixedCalls) });
  assert.equal(await readText(await mixed('https://source.example/')), 'ok');
  assert.deepEqual(mixedCalls[0].addresses, [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(mixedCalls[0].options.validatedAddress, '8.8.8.8');
  let count = 0;
  const privateOnly = createRequest({ lookup: async () => [{ address: '198.18.0.1', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }], httpsRequest: () => { count++; } });
  await assert.rejects(privateOnly('https://source.example/'), { status: 403 });
  assert.equal(count, 0);
  const calls = [];
  const redirect = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: transport({ 'https://source.example/': () => response('', 302, { location: 'http://127.0.0.1/admin' }) }, calls) });
  await assert.rejects(redirect('https://source.example/'), { status: 403 });
  assert.equal(calls.length, 1);
});

test('limits redirect loops and reports DNS timeout', async () => {
  const calls = [];
  const looping = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: transport({ 'https://source.example/': () => response('', 302, { location: '/' }) }, calls) });
  await assert.rejects(looping('https://source.example/'), /重定向次数过多/);
  assert.equal(calls.length, 4);
  const hanging = createRequest({ lookup: () => new Promise(() => {}) });
  await assert.rejects(hanging('https://source.example/', { timeout: 10 }), /超时/);
});

test('bounded byte reads preserve non-UTF8 subtitle encodings through compression', async () => {
  const bytes = Buffer.from([0xff, 0xfe, 0x2d, 0x4e]);
  const encoded = Object.assign(Readable.from([gzipSync(bytes)]), { headers: { 'content-encoding': 'gzip' } });
  assert.deepEqual(await readBuffer(encoded), bytes);
  const tooLarge = Object.assign(Readable.from([gzipSync(bytes)]), { headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(readBuffer(tooLarge, bytes.length - 1), /响应过大/);
  assert.equal(tooLarge.destroyed, true);
});

test('limits decoded response size and reads gzip JSON', async () => {
  const encoded = Object.assign(Readable.from([gzipSync('{"list":[]}')]), { headers: { 'content-encoding': 'gzip' } });
  assert.equal(await readText(encoded), '{"list":[]}');
  await assert.rejects(readText(response('oversized'), 4), /响应过大/);
  const compressed = Object.assign(Readable.from([gzipSync('a'.repeat(1000))]), { headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(readText(compressed, 100), /响应过大/);
});

function resetTransport(steps, calls) {
  return (url, options, callback) => {
    const step = steps[calls.length]; assert.ok(step, 'unexpected network attempt');
    const outgoing = new EventEmitter(); outgoing.reusedSocket = step.reused === true;
    outgoing.destroy = error => { if (outgoing.destroyed) return; outgoing.destroyed = true; queueMicrotask(() => outgoing.emit('error', error)); };
    const abort = () => outgoing.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    outgoing.once('error', cleanup); outgoing.once('response', cleanup);
    outgoing.end = () => queueMicrotask(() => {
      step.before?.();
      if (outgoing.destroyed || step.stall) return;
      if (step.error) return outgoing.emit('error', Object.assign(new Error('fixture reset'), { code: step.error }));
      const incoming = step.incoming || response('ok', step.status || 200, step.headers);
      outgoing.emit('response', incoming); callback(incoming);
    });
    calls.push({ url: url.href, options, outgoing }); return outgoing;
  };
}

test('reused GET and HEAD resets retry once on a fresh bounded agent with the same pinned address and Range', async () => {
  for (const method of ['GET', 'HEAD']) {
    const calls = []; let lookups = 0;
    const request = createRequest({ lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; },
      httpsRequest: resetTransport([{ reused: true, error: 'ECONNRESET' }, {}], calls) });
    assert.equal(await readText(await request('https://cdn.example/video.mp4', { method, headers: { Range: 'bytes=100-199', Cookie: 'fixture=only' } })), 'ok');
    assert.equal(calls.length, 2); assert.equal(lookups, 1);
    const [first, retry] = calls.map(call => call.options);
    assert.equal(retry.method, method); assert.equal(retry.validatedAddress, first.validatedAddress);
    assert.equal(retry.headers.Range, first.headers.Range); assert.equal(retry.headers.Cookie, first.headers.Cookie);
    assert.notEqual(retry.agent, first.agent); assert.equal(retry.agent.keepAlive, false);
    assert.equal(retry.agent.maxSockets, 6); assert.equal(retry.agent.maxTotalSockets, 24);
    assert.equal(retry.headers.connection, 'close');
    for (const options of [first, retry]) options.lookup('cdn.example', {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
  }
});

test('stale-socket recovery never retries POST, new sockets, unrelated errors or upstream HTTP statuses', async () => {
  for (const step of [
    { reused: true, error: 'ECONNRESET', method: 'POST' }, { error: 'ECONNRESET' },
    ...['EPIPE', 'ETIMEDOUT', 'ABORT_ERR', 'CERT_HAS_EXPIRED'].map(error => ({ reused: true, error })),
    { reused: true, status: 429 }, { reused: true, status: 502 },
  ]) {
    const calls = [], request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: resetTransport([step], calls) });
    const pending = request('https://cdn.example/video.mp4', { method: step.method || 'GET' });
    if (step.error) await assert.rejects(pending, error => error.cause?.code === step.error);
    else { const incoming = await pending; assert.equal(incoming.statusCode, step.status); incoming.destroy(); }
    assert.equal(calls.length, 1);
  }
});

test('a fresh reset gets no second retry and redirects do not renew the recovery allowance or credentials', async () => {
  for (const redirect of [false, true]) {
    const calls = [], steps = [{ reused: true, error: 'ECONNRESET' }, redirect
      ? { status: 302, headers: { location: 'https://other.example/video.mp4' } } : { error: 'ECONNRESET' }];
    if (redirect) steps.push({ reused: true, error: 'ECONNRESET' });
    const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: resetTransport(steps, calls) });
    await assert.rejects(request('https://cdn.example/video.mp4', { headers: { Cookie: 'fixture=only', Authorization: 'fixture' } }), error => error.cause?.code === 'ECONNRESET');
    assert.equal(calls.length, redirect ? 3 : 2);
    if (redirect) { assert.equal(calls[2].options.headers.Cookie, undefined); assert.equal(calls[2].options.headers.Authorization, undefined); }
  }
});

test('stale-socket retry respects cancellation, the original deadline and aborts a pending fresh connection', async () => {
  for (const expired of [false, true]) {
    const calls = [], controller = new AbortController(), originalNow = Date.now; let clock = originalNow();
    const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: resetTransport([
      { reused: true, error: 'ECONNRESET', before: () => { if (expired) clock += 101; else controller.abort(); } },
    ], calls) });
    try {
      Date.now = () => clock;
      await assert.rejects(request('https://cdn.example/video.mp4', { signal: controller.signal, timeout: 100 }));
      assert.equal(calls.length, 1);
    } finally { Date.now = originalNow; }
  }
  const calls = [], controller = new AbortController();
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: resetTransport([
    { reused: true, error: 'ECONNRESET' }, { stall: true, before: () => controller.abort() },
  ], calls) });
  await assert.rejects(request('https://cdn.example/video.mp4', { signal: controller.signal }), error => error.cause?.code === 'ABORT_ERR');
  assert.equal(calls.length, 2); assert.equal(calls[1].outgoing.destroyed, true);
});

test('a reset after response headers is reported as a body failure without replaying the request', async () => {
  const calls = [], incoming = Object.assign(Readable.from((async function* () { yield 'part'; throw Object.assign(new Error('reset body'), { code: 'ECONNRESET' }); })()), { statusCode: 200, headers: {} });
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpsRequest: resetTransport([{ reused: true, incoming }], calls) });
  await assert.rejects(readText(await request('https://cdn.example/video.mp4')), error => error.cause?.code === 'ECONNRESET');
  assert.equal(calls.length, 1);
});

test('an owned HTTP server resetting a reused Range GET recovers on one new connection without Cookie', async t => {
  const sockets = new Set(), agents = new Set(), calls = []; let hits = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.range, 'bytes=0-1');
    if (++hits === 2) return req.socket.destroy();
    res.writeHead(206, { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/200' }); res.end('ok');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    const closed = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
    for (const agent of agents) agent.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await Promise.all(closed); assert.equal(sockets.size, 0);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpRequest: (url, options, callback) => {
    agents.add(options.agent);
    const outgoing = http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, callback);
    calls.push(outgoing); return outgoing;
  } });
  for (let index = 0; index < 2; index++) {
    const incoming = await request('http://cdn.example/video.mp4', { headers: { range: 'bytes=0-1' }, timeout: 1000 });
    assert.equal(incoming.statusCode, 206); assert.equal(await readText(incoming), 'ok');
  }
  assert.deepEqual(calls.map(call => call.reusedSocket), [false, true, false]); assert.equal(hits, 3);
});

test('the shared fresh retry pool queues its seventh connection and does not reuse completed retry sockets', async t => {
  const agents = new Set(), sockets = new Set(), outgoing = [], pending = [], held = [], controller = new AbortController();
  let entered, hits = 0, released = false, connections = 0;
  const sixEntered = new Promise(resolve => { entered = resolve; });
  const reply = res => { res.writeHead(200, { 'Content-Length': '2' }); res.end('ok'); };
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.connection, 'close');
    if (++hits === 6) entered();
    if (released) reply(res); else held.push(res);
  });
  server.on('connection', socket => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => {
    controller.abort(); await Promise.allSettled(pending);
    const closed = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
    for (const agent of agents) agent.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await Promise.all(closed); assert.equal(sockets.size, 0);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = createRequest({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], httpRequest: (url, options, callback) => {
    if (options.agent.keepAlive) return resetTransport([{ reused: true, error: 'ECONNRESET' }], [])(url, options, callback);
    agents.add(options.agent);
    const req = http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname }, callback); outgoing.push(req); return req;
  } });
  for (let index = 0; index < 7; index++) pending.push(request('http://cdn.example/video.mp4', { timeout: 1000, signal: controller.signal }).then(readText));
  await sixEntered;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hits, 6); assert.equal(connections, 6); assert.equal(agents.size, 1);
  released = true; for (const res of held) reply(res);
  assert.deepEqual(await Promise.all(pending), Array(7).fill('ok'));
  assert.equal(connections, 7); assert.ok(outgoing.every(req => req.reusedSocket === false));
});
