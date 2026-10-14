import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import { createRequest, isPublicAddress, readText, validateUrl } from '../lib/network.mjs';

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

test('limits decoded response size and reads gzip JSON', async () => {
  const encoded = Object.assign(Readable.from([gzipSync('{"list":[]}')]), { headers: { 'content-encoding': 'gzip' } });
  assert.equal(await readText(encoded), '{"list":[]}');
  await assert.rejects(readText(response('oversized'), 4), /响应过大/);
  const compressed = Object.assign(Readable.from([gzipSync('a'.repeat(1000))]), { headers: { 'content-encoding': 'gzip' } });
  await assert.rejects(readText(compressed, 100), /响应过大/);
});
