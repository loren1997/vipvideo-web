import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

function failure(message, status = 502, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status });
}

export function isPublicAddress(value) {
  const address = String(value).replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  let expanded = address;
  if (expanded.includes('.')) {
    const split = expanded.lastIndexOf(':');
    const octets = expanded.slice(split + 1).split('.').map(Number);
    expanded = `${expanded.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [left, right] = expanded.split('::');
  const start = left ? left.split(':').map(part => parseInt(part, 16)) : [];
  const end = right ? right.split(':').map(part => parseInt(part, 16)) : [];
  const words = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill(0), ...end];
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  return words[0] >= 0x2000 && words[0] <= 0x3fff &&
    !(words[0] === 0x2001 && (words[1] <= 0x01ff || words[1] === 0x0db8)) &&
    words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] < 0x1000);
}

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch (cause) { throw failure('链接格式无效', 400, cause); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw failure('仅支持不含用户名和密码的 HTTP / HTTPS 链接', 400);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.toLowerCase() === 'localhost' || hostname.toLowerCase().endsWith('.localhost') ||
      (isIP(hostname) && !isPublicAddress(hostname))) {
    throw failure('不允许访问内网或保留地址', 403);
  }
  url.hash = '';
  return url;
}

export function createRequest({ lookup = dnsLookup, httpRequest = http.request, httpsRequest = https.request } = {}) {
  const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 6, maxTotalSockets: 24, maxFreeSockets: 2, timeout: 15000 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 6, maxTotalSockets: 24, maxFreeSockets: 2, timeout: 15000 }) };
  for (const agent of Object.values(agents)) {
    const getName = agent.getName;
    // 仅复用同一已验证公网 IP 的连接，DNS 变化仍需重新校验并建连。
    agent.getName = function (options) { return `${getName.call(this, options)}:${options.validatedAddress}`; };
  }
  return async function safeRequest(value, { headers = {}, timeout = 8000, method = 'GET', body, followRedirects = true, signal } = {}) {
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw failure('不支持的请求方法', 400);
    if (typeof followRedirects !== 'boolean') throw failure('重定向设置无效', 400);
    if (body !== undefined && (method !== 'POST' || !(typeof body === 'string' || Buffer.isBuffer(body)) || Buffer.byteLength(body) > 65536)) throw failure('请求正文无效或超过 64 KiB', 400);
    const deadline = Date.now() + timeout;
    let url = validateUrl(value);
    let requestHeaders = { ...headers };
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw failure('影视源请求超时');
        let timer;
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const literalFamily = isIP(hostname);
        const records = await Promise.race([
          literalFamily ? [{ address: hostname, family: literalFamily }] : lookup(hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(failure('影视源请求超时')), remaining); }),
        ]).finally(() => clearTimeout(timer));
        signal?.throwIfAborted();
        const publicRecords = records.filter(record => isPublicAddress(record.address));
        if (!publicRecords.length) {
          throw failure('不允许访问内网或保留地址', 403);
        }
        const selected = publicRecords.find(record => record.family === 4) || publicRecords[0];
        const response = await new Promise((resolve, reject) => {
          const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
          const outgoing = transport(url, {
            method, agent: agents[url.protocol], validatedAddress: selected.address, signal,
            headers: { 'accept-encoding': 'identity', ...requestHeaders },
            // 固定已验证的地址，避免校验后再次 DNS 解析产生重绑定。
            lookup: (_host, options, callback) => options.all
              ? callback(null, [selected]) : callback(null, selected.address, selected.family),
          }, resolve);
          const headerTimer = setTimeout(() => outgoing.destroy(failure('影视源请求超时')), Math.max(1, deadline - Date.now()));
          outgoing.once('response', () => clearTimeout(headerTimer));
          outgoing.once('error', error => { clearTimeout(headerTimer); reject(error); });
          outgoing.end(body);
        });
        response.finalUrl = url.href;
        response.setTimeout?.(timeout, () => response.destroy(failure('影视源读取超时')));
        if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
        const location = response.headers.location;
        response.destroy();
        if (!followRedirects || method === 'POST') throw failure('此请求不允许重定向');
        if (!location) throw failure('影视源重定向缺少目标链接');
        if (redirects === 3) throw failure('影视源重定向次数过多');
        const next = validateUrl(new URL(location, url).href);
        if (next.origin !== url.origin) requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => !['cookie', 'authorization', 'proxy-authorization'].includes(key.toLowerCase())));
        url = next;
      }
    } catch (cause) {
      if (cause.status) throw cause;
      throw failure('无法连接影视源，请稍后重试', 502, cause);
    }
  };
}

export const request = createRequest();

export async function readBuffer(response, maxBytes = 4 * 1024 * 1024) {
  const encoding = String(response.headers?.['content-encoding'] || 'identity').toLowerCase();
  const decompressors = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
  if (encoding !== 'identity' && !decompressors[encoding]) {
    response.destroy();
    throw failure('影视源使用了不支持的内容编码');
  }
  const stream = encoding === 'identity' ? response : response.pipe(decompressors[encoding]());
  const onError = error => stream.destroy(error);
  if (stream !== response) response.on('error', onError);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw failure('影视源响应过大');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } catch (cause) {
    response.destroy();
    stream.destroy();
    throw cause.status ? cause : failure('读取影视源失败', 502, cause);
  } finally {
    if (stream !== response) response.off('error', onError);
  }
}

export async function readText(response, maxBytes) {
  return (await readBuffer(response, maxBytes)).toString('utf8');
}
