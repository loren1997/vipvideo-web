import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createQuarkBrowser } from './lib/quark-browser.mjs';
import { createQuarkRenderedSearch } from './lib/quark-rendered-search.mjs';
import { request, readText } from './lib/network.mjs';

async function readPublicPage(url, { deadline, signal }) {
    const budget = Math.max(1, deadline - Date.now());
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(budget)].filter(Boolean));
    const response = await request(url, { signal: bounded, timeout: budget, headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9',
    } });
    try {
      if (response.statusCode !== 200) throw Object.assign(new Error('公开网页暂时不可用'), { status: response.statusCode, quarkPoolReason: [403, 429].includes(response.statusCode) ? 'browserBlocked' : 'browserFailed' });
      return { url: response.finalUrl || url, html: await readText(response, 512 * 1024) };
    } finally { response.destroy(); }
}

export function createBrowserWorker({ browser = createQuarkBrowser(), read = readPublicPage } = {}) {
  const search = createQuarkRenderedSearch({ render: browser.render, read });
  let active, closing = false;
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); } };
    if (req.url === '/health' && req.method === 'GET') return json(closing ? 503 : 200, { ok: !closing });
    if (req.url !== '/search' || req.method !== 'POST') return json(404, { reason: '无此接口' });
    if (active || closing) return json(503, { reason: 'browserBusy' });
    const controller = new AbortController(); active = controller;
    const started = Date.now();
    let timeout = setTimeout(() => controller.abort(new Error('动态网页搜索超时')), 45000);
    const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('客户端已离开')); };
    res.once('close', disconnect);
    try {
      let body = ''; req.setEncoding('utf8');
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 6144) return json(413, { reason: '请求过大' }); }
      const input = JSON.parse(body);
      if (!input || Object.keys(input).some(key => !['title', 'aliases', 'year', 'page', 'budgetMs'].includes(key)) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300 || !Array.isArray(input.aliases) || input.aliases.length > 2 || input.aliases.some(value => typeof value !== 'string' || value.length > 300) || typeof input.year !== 'string' || !/^(?:(?:19|20)\d{2})?$/.test(input.year) || input.page !== undefined && (!Number.isInteger(input.page) || input.page < 0 || input.page > 2) || !Number.isFinite(input.budgetMs)) return json(400, { reason: '搜索参数无效' });
      const deadline = Math.min(started + 45000, Date.now() + Math.max(1, input.budgetMs));
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(new Error('动态网页搜索超时')), Math.max(1, deadline - Date.now()));
      const rows = await search({ title: input.title, aliases: input.aliases, year: input.year, page: input.page ?? 0 }, { deadline, signal: controller.signal });
      json(200, { results: rows, ...(rows.reason ? { reason: rows.reason } : {}) });
    } catch (cause) { json(controller.signal.aborted ? 504 : cause instanceof SyntaxError ? 400 : 502, { reason: controller.signal.aborted ? 'browserTimeout' : '动态网页暂时无法读取' }); }
    finally { clearTimeout(timeout); res.removeListener('close', disconnect); if (active === controller) active = undefined; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxConnections = 8;
  return { server, async close() { closing = true; active?.abort(new Error('搜索助手正在关闭')); server.closeAllConnections(); await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createBrowserWorker();
  app.server.listen(Number(process.env.PORT) || 3020, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close().catch(() => { process.exitCode = 1; }));
}
