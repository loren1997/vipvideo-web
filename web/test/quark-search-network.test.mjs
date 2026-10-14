import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import { createQuarkPublicRequest } from '../lib/quark-search-network.mjs';
import { request as networkRequest, readText } from '../lib/network.mjs';

const proxy = 'http://127.0.0.1:10808';
const socket = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; }, unshift() {} });
function fixture({ records = {}, routes = {}, connectStatus = 200, waitConnect = false, waitTls = false, certificateError = false, unauthorized = false } = {}) {
  const calls = { dns: [], proxy: [], https: [], tls: [], tunnels: [], secure: [], completed: 0 };
  const response = route => Object.assign(Readable.from([Buffer.from(route.body || '')]), { statusCode: route.status || 200, headers: route.location ? { location: route.location } : {} });
  const outgoing = () => {
    const request = new EventEmitter(); request.destroyed = false;
    request.destroy = error => { if (request.destroyed) return; request.destroyed = true; queueMicrotask(() => { if (error) request.emit('error', error); request.emit('close'); }); };
    return request;
  };
  const lookup = async host => { calls.dns.push(host); return [{ address: records[host] || '8.8.8.8', family: (records[host] || '').includes(':') ? 6 : 4 }]; };
  const proxyRequest = (endpoint, options, callback) => {
    const request = outgoing(); calls.proxy.push({ endpoint, options, request });
    request.end = body => queueMicrotask(() => {
      if (request.destroyed) return;
      if (options.method === 'CONNECT') {
        if (waitConnect) return;
        const tunnel = socket(); calls.tunnels.push(tunnel);
        request.emit('connect', { statusCode: connectStatus }, tunnel, Buffer.alloc(0));
      } else {
        const incoming = response(routes[options.path] || { body: 'http body' });
        calls.proxy.at(-1).body = body;
        incoming.once('end', () => request.emit('close'));
        request.emit('response', incoming); callback(incoming);
      }
    }); return request;
  };
  const httpsRequest = (url, options, callback) => {
    const request = outgoing(); calls.https.push({ url, options, request });
    request.end = body => options.agent.createConnection({}, (error, secure) => {
      calls.completed++;
      if (error) return request.destroy(error);
      if (request.destroyed) return secure.destroy();
      const incoming = response(routes[url.href] || { body: 'https body' });
      calls.https.at(-1).body = body;
      incoming.once('end', () => request.emit('close'));
      request.emit('response', incoming); callback(incoming);
    }); return request;
  };
  const tlsConnect = options => {
    calls.tls.push(options);
    const secure = socket(); secure.authorized = !unauthorized; calls.secure.push(secure);
    queueMicrotask(() => {
      if (waitTls || secure.destroyed) return;
      if (certificateError) secure.emit('error', Object.assign(new Error('certificate mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));
      else secure.emit('secureConnect');
    }); return secure;
  };
  return { calls, request: createQuarkPublicRequest({ proxy, lookup, proxyRequest, httpsRequest, tlsConnect }) };
}

test('unset or empty proxy preserves the direct safe request and does not require a global proxy', () => {
  for (const value of ['', '   ']) assert.equal(createQuarkPublicRequest({ proxy: value }), networkRequest);
});

test('only a trusted explicit HTTP endpoint without credentials or extra URL components is accepted', () => {
  for (const value of ['https://proxy.example:10808', 'socks5://proxy.example:10808', 'http://user:secret@proxy.example', 'http://proxy.example/path', 'http://proxy.example/?key=secret', 'http://proxy.example/#secret', 'http://proxy.example/?', 'http://proxy.example/#', 'not a proxy', 123, null]) {
    assert.throws(() => createQuarkPublicRequest({ proxy: value }), error => /^QUARK_SEARCH_PROXY_/.test(error.code) && !error.message.includes('secret'));
  }
  assert.equal(typeof createQuarkPublicRequest({ proxy: 'http://proxy.internal:10808' }), 'function');
});

test('HTTP absolute-form requests pin the validated numeric destination and preserve its original Host', async () => {
  for (const address of ['8.8.8.8', '2001:4860:4860::8888']) {
    const input = fixture({ records: { 'public.example': address } });
    const response = await input.request('http://public.example:8080/video?q=one', { method: 'POST', body: 'payload', headers: { Cookie: 'target-cookie', Authorization: 'target-auth', 'Proxy-Authorization': 'must-not-leak', Host: 'forged.example' } });
    assert.equal(await readText(response), 'http body');
    const call = input.calls.proxy[0], numeric = address.includes(':') ? `[${address}]` : address;
    assert.equal(call.endpoint.href, proxy + '/');
    assert.equal(call.options.path, `http://${numeric}:8080/video?q=one`);
    assert.deepEqual(input.calls.dns, ['public.example']);
    assert.equal(call.options.headers.host, 'public.example:8080');
    assert.equal(call.options.headers.Cookie, 'target-cookie');
    assert.equal(call.options.headers.Authorization, 'target-auth');
    assert.equal(call.options.headers['Proxy-Authorization'], undefined);
    assert.equal(call.options.lookup, undefined); assert.equal(call.options.agent, false);
    assert.equal(call.body, 'payload');
  }
});

test('HTTPS CONNECT uses a validated IP while target TLS and headers retain the original identity', async () => {
  const input = fixture();
  const response = await input.request('https://public.example:8443/video', { headers: { Cookie: 'target-cookie', Authorization: 'target-auth', 'pRoXy-AuThOrIzAtIoN': 'must-not-leak' } });
  assert.equal(await readText(response), 'https body');
  const connect = input.calls.proxy[0], destination = input.calls.https[0], secure = input.calls.tls[0];
  assert.equal(connect.options.method, 'CONNECT'); assert.equal(connect.options.path, '8.8.8.8:8443');
  assert.deepEqual(connect.options.headers, { host: '8.8.8.8:8443' });
  assert.equal(destination.url.href, 'https://public.example:8443/video');
  assert.equal(destination.options.headers.host, 'public.example:8443');
  assert.equal(destination.options.headers.Cookie, 'target-cookie');
  assert.equal(destination.options.headers.Authorization, 'target-auth');
  assert.ok(!Object.keys(destination.options.headers).some(name => name.toLowerCase() === 'proxy-authorization'));
  assert.equal(secure.servername, 'public.example'); assert.equal(secure.rejectUnauthorized, true);
  assert.deepEqual(secure.ALPNProtocols, ['http/1.1']); assert.equal(secure.socket, input.calls.tunnels[0]);
  assert.equal(secure.checkServerIdentity('ignored-name', { subjectaltname: 'DNS:public.example' }), undefined);
  assert.equal(secure.checkServerIdentity('public.example', { subjectaltname: 'DNS:wrong.example' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(input.calls.completed, 1);
});

test('IPv6 CONNECT authority uses brackets and IP literals do not invent an SNI hostname', async () => {
  const address = '2001:4860:4860::8888', input = fixture();
  const response = await input.request(`https://[${address}]/video`); await readText(response);
  assert.equal(input.calls.proxy[0].options.path, `[${address}]:443`);
  assert.equal(input.calls.tls[0].servername, undefined);
  const certificate = { subjectaltname: `IP Address:${address}` }, expected = checkServerIdentity(address, certificate);
  assert.equal(input.calls.tls[0].checkServerIdentity('ignored', certificate)?.code, expected?.code);
  assert.equal(input.calls.tls[0].checkServerIdentity('ignored', { subjectaltname: 'IP Address:2001:4860:4860::8844' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.deepEqual(input.calls.dns, []);
});

test('IPv4 literal TLS identity accepts only its real IP SAN without an invented SNI hostname', async () => {
  const input = fixture(), response = await input.request('https://8.8.8.8/video'); await readText(response);
  assert.equal(input.calls.proxy[0].options.path, '8.8.8.8:443'); assert.equal(input.calls.tls[0].servername, undefined);
  assert.equal(input.calls.tls[0].checkServerIdentity('ignored', { subjectaltname: 'IP Address:8.8.8.8' }), undefined);
  assert.equal(input.calls.tls[0].checkServerIdentity('ignored', { subjectaltname: 'IP Address:1.1.1.1' }).code, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('redirects revalidate and repin every destination and strip cross-origin credentials', async () => {
  const input = fixture({ records: { 'first.example': '8.8.8.8', 'second.example': '1.1.1.1' }, routes: {
    'https://first.example/start': { status: 302, location: 'https://second.example/final' },
    'https://second.example/final': { body: 'redirected body' },
  } });
  const response = await input.request('https://first.example/start', { headers: { Cookie: 'target-cookie', Authorization: 'target-auth', 'Proxy-Authorization': 'proxy-secret' } });
  assert.equal(await readText(response), 'redirected body');
  assert.equal(response.finalUrl, 'https://second.example/final');
  assert.deepEqual(input.calls.dns, ['first.example', 'second.example']);
  assert.deepEqual(input.calls.proxy.map(call => call.options.path), ['8.8.8.8:443', '1.1.1.1:443']);
  assert.equal(input.calls.https[1].options.headers.Cookie, undefined);
  assert.equal(input.calls.https[1].options.headers.Authorization, undefined);
});

test('private initial addresses and redirect DNS never reach the proxy', async () => {
  const input = fixture({ records: { 'private.example': '10.0.0.2' }, routes: { 'https://public.example/start': { status: 302, location: 'https://private.example/final' } } });
  await assert.rejects(input.request('https://private.example/start'), { status: 403 });
  assert.equal(input.calls.proxy.length, 0);
  await assert.rejects(input.request('https://public.example/start'), { status: 403 });
  assert.equal(input.calls.proxy.length, 1); assert.equal(input.calls.https.length, 1);
  await assert.rejects(input.request('http://127.0.0.1/video'), { status: 403 });
  assert.equal(input.calls.proxy.length, 1);
});

test('failed CONNECT destroys pending tunnel work without sending target credentials or starting TLS', async () => {
  const input = fixture({ connectStatus: 407 });
  await assert.rejects(input.request('https://public.example/video'), error => error.status === 502 && error.cause.code === 'QUARK_SEARCH_PROXY_CONNECT_FAILED');
  assert.equal(input.calls.proxy[0].request.destroyed, true);
  assert.equal(input.calls.tunnels[0].destroyed, true); assert.equal(input.calls.tls.length, 0);
  assert.equal(input.calls.completed, 1);
});

test('TLS certificate errors and unauthorized connections are never accepted', async () => {
  for (const option of [{ certificateError: true }, { unauthorized: true }]) {
    const input = fixture(option);
    await assert.rejects(input.request('https://public.example/video'), { status: 502 });
    assert.equal(input.calls.tls[0].rejectUnauthorized, true);
    assert.equal(input.calls.tunnels[0].destroyed, true); assert.equal(input.calls.secure[0].destroyed, true);
    assert.equal(input.calls.proxy[0].request.destroyed, true); assert.equal(input.calls.completed, 1);
  }
});

test('abort during CONNECT or TLS immediately closes unfinished sockets and invokes its callback once', async () => {
  for (const option of [{ waitConnect: true }, { waitTls: true }]) {
    const input = fixture(option), controller = new AbortController();
    const pending = input.request('https://public.example/video', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    const rejected = assert.rejects(pending, { status: 502 }); controller.abort(); await rejected;
    assert.equal(input.calls.proxy[0].request.destroyed, true);
    assert.ok(input.calls.tunnels.every(value => value.destroyed));
    assert.ok(input.calls.secure.every(value => value.destroyed));
    assert.equal(input.calls.completed, 1);
    if (option.waitConnect) {
      const late = socket(); input.calls.proxy[0].request.emit('connect', { statusCode: 200 }, late, Buffer.alloc(0));
      assert.equal(late.destroyed, true);
    } else input.calls.secure[0].emit('secureConnect');
    assert.equal(input.calls.completed, 1);
  }
});

test('the original header deadline cancels a stalled CONNECT without waiting for its longer fallback timer', async () => {
  const input = fixture({ waitConnect: true }), started = Date.now();
  await assert.rejects(input.request('https://public.example/video', { timeout: 40 }), { status: 502 });
  assert.ok(Date.now() - started < 1500);
  assert.equal(input.calls.proxy[0].request.destroyed, true); assert.equal(input.calls.completed, 1);
});

test('the native HTTPS ClientRequest consumes a complete delayed body before destroying its tunnel agent', async () => {
  let tunnel, secure, wire = '', bodyTimer;
  const request = createQuarkPublicRequest({ proxy, lookup: async () => [{ address: '8.8.8.8', family: 4 }], proxyRequest: (_endpoint, options) => {
    assert.equal(options.method, 'CONNECT'); assert.equal(options.path, '8.8.8.8:443');
    const outgoing = new EventEmitter(); outgoing.destroy = () => {}; outgoing.end = () => queueMicrotask(() => {
      tunnel = socket(); outgoing.emit('connect', { statusCode: 200 }, tunnel, Buffer.alloc(0));
    }); return outgoing;
  }, tlsConnect: () => {
    secure = new Duplex({ read() {}, write(chunk, _encoding, done) {
      wire += chunk.toString(); done();
      if (!wire.includes('\r\n\r\n') || bodyTimer) return;
      this.push('HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nfirst');
      bodyTimer = setTimeout(() => { this.push('second'); this.push(null); }, 15);
    }, destroy(error, done) { clearTimeout(bodyTimer); tunnel.destroy(); done(error); } });
    secure.authorized = true; secure.encrypted = true;
    secure.setTimeout = secure.setNoDelay = secure.setKeepAlive = () => secure;
    queueMicrotask(() => secure.emit('secureConnect')); return secure;
  } });
  const response = await request('https://public.example/video?q=one');
  assert.equal(await readText(response), 'firstsecond');
  assert.match(wire, /^GET \/video\?q=one HTTP\/1\.1\r\n/i);
  assert.match(wire, /\r\nhost: public\.example\r\n/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secure.destroyed, true); assert.equal(tunnel.destroyed, true);
});
