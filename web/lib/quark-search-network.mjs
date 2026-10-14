import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { createRequest, isPublicAddress, request as networkRequest } from './network.mjs';

const failure = code => Object.assign(new Error(code), { code });
const destinationHeaders = (headers, host) => ({
  ...Object.fromEntries(Object.entries(headers || {}).filter(([name]) => !['host', 'proxy-authorization', 'proxy-connection'].includes(name.toLowerCase()))),
  host,
});

export function createQuarkPublicRequest({ proxy = process.env.QUARK_SEARCH_PROXY, lookup, proxyRequest = http.request, httpsRequest = https.request, tlsConnect = tls.connect } = {}) {
  if (proxy === undefined || typeof proxy === 'string' && !proxy.trim()) return networkRequest;
  let endpoint;
  try { endpoint = new URL(proxy); } catch { throw failure('QUARK_SEARCH_PROXY_INVALID'); }
  if (typeof proxy !== 'string' || endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.href !== endpoint.origin + '/') throw failure('QUARK_SEARCH_PROXY_HTTP_ONLY_NO_AUTH');

  const pinnedAddress = options => {
    const address = options.validatedAddress;
    if (!isIP(address) || !isPublicAddress(address)) throw failure('QUARK_SEARCH_PROXY_NONPUBLIC_TARGET');
    return isIP(address) === 6 ? `[${address}]` : address;
  };
  const httpRequest = (url, options, callback) => {
    const pinned = new URL(url);
    pinned.hostname = pinnedAddress(options);
    return proxyRequest(endpoint, { method: options.method, path: pinned.href, agent: false, signal: options.signal, headers: destinationHeaders(options.headers, url.host) }, callback);
  };
  const pinnedHttpsRequest = (url, options, callback) => {
    const authority = `${pinnedAddress(options)}:${url.port || 443}`, hostname = url.hostname.replace(/^\[|\]$/g, '');
    // One request per agent prevents reuse after the validated destination IP changes.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
    let cancel;
    agent.createConnection = (_options, done) => {
      let complete = false, proxyOutgoing, tunnel, secure, timer;
      const finish = (error, socket) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (error) { proxyOutgoing?.destroy(); tunnel?.destroy(); secure?.destroy(); }
        done(error, socket);
      };
      const abort = () => finish(options.signal?.reason || failure('ABORT_ERR'));
      cancel = error => finish(error || failure('ABORT_ERR'));
      timer = setTimeout(() => finish(failure('QUARK_SEARCH_PROXY_CONNECT_TIMEOUT')), 8000);
      try {
        proxyOutgoing = proxyRequest(endpoint, { method: 'CONNECT', path: authority, headers: { host: authority }, agent: false });
        proxyOutgoing.once('error', error => finish(error));
        proxyOutgoing.once('response', response => { response.destroy(); finish(failure('QUARK_SEARCH_PROXY_CONNECT_FAILED')); });
        proxyOutgoing.once('connect', (response, socket, head) => {
          if (complete) { socket.destroy(); return; }
          tunnel = socket;
          if (response.statusCode !== 200) return finish(failure('QUARK_SEARCH_PROXY_CONNECT_FAILED'));
          if (head.length) socket.unshift(head);
          try {
            secure = tlsConnect({ socket, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'], checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(hostname, certificate) });
            secure.once('error', error => finish(error));
            secure.once('secureConnect', () => secure.authorized ? finish(null, secure) : finish(failure('QUARK_SEARCH_PROXY_TLS_UNAUTHORIZED')));
          } catch (error) { finish(error); }
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        else proxyOutgoing.end();
      } catch (error) { finish(error); }
    };
    let outgoing;
    try { outgoing = httpsRequest(url, { ...options, agent, headers: destinationHeaders(options.headers, url.host) }, callback); }
    catch (error) { cancel?.(error); agent.destroy(); throw error; }
    outgoing.once('error', error => cancel?.(error));
    outgoing.once('close', () => { cancel?.(); agent.destroy(); });
    return outgoing;
  };
  return createRequest({ ...(lookup ? { lookup } : {}), httpRequest, httpsRequest: pinnedHttpsRequest });
}
