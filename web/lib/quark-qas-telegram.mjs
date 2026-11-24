import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { readText } from './network.mjs';

const SEARCH_URL = 'http://telegram-web:8765/search';
const LIMIT = 20;
const messages = {
  AUTH_REQUIRED: '请在夸克自动转存中重新登录 Telegram Web',
  FLOOD_WAIT: 'Telegram 暂时限制查询，请稍后再试',
  BUSY: 'Telegram Web 正在搜索其他资源，请稍后再试',
  TIMEOUT: 'Telegram Web 搜索超时，请继续搜索',
  BUDGET_EXHAUSTED: '本轮仅返回部分归档结果，可继续搜索',
  PAGINATION_FAILED: '归档列表暂未读完，可继续搜索',
};
const unavailable = '无法连接夸克自动转存的 Telegram Web 服务';
const status = (reason, rows = []) => Object.assign(rows, { reason });

export function createQuarkQasTelegramSearch({ tokenFile = process.env.QAS_TELEGRAM_TOKEN_FILE, request = httpRequest, readToken = readFile, now = Date.now } = {}) {
  if (!tokenFile) return undefined;
  return async (title, { signal, deadline = now() + 27000 } = {}) => {
    signal?.throwIfAborted();
    const query = typeof title === 'string' ? title.trim().slice(0, 300) : '';
    const budget = Math.min(25000, deadline - now() - 1000);
    if (!query || budget < 1000) return status(messages.TIMEOUT);
    const timeout = AbortSignal.timeout(budget + 1000);
    const searchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      let token;
      try { token = (await readToken(tokenFile, { encoding: 'utf8', signal: searchSignal })).trim(); }
      catch { signal?.throwIfAborted(); return status('Telegram Web 认证文件无法读取'); }
      if (!/^[a-f0-9]{64}$/.test(token)) return status('Telegram Web 认证文件无效');
      const body = JSON.stringify({ query, limit: LIMIT, timeout: budget / 1000 });
      response = await new Promise((resolve, reject) => {
        // Use a one-request direct agent so the shared credential never reaches a proxy.
        const outgoing = request(SEARCH_URL, { method: 'POST', agent: false, signal: searchSignal, headers: {
          authorization: 'Bearer ' + token, accept: 'application/json', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        } }, incoming => { incoming.on('error', () => {}); resolve(incoming); });
        outgoing.once('error', reject);
        outgoing.end(body);
      });
      if (response.statusCode === 401) return status('Telegram Web 服务认证失败，请检查共享认证文件');
      if (response.statusCode !== 200) return status(unavailable);
      const result = JSON.parse(await readText(response, 2 * 1024 * 1024));
      if (typeof result?.success !== 'boolean' || result.data?.scope !== 'archived') return status('Telegram Web 搜索响应格式不正确');
      if (result.data.authorized !== true) return status(messages.AUTH_REQUIRED);
      const rows = [];
      for (const row of Array.isArray(result.results) ? result.results.slice(0, LIMIT) : []) {
        if (row?.source_type !== 'telegram_web' || typeof row.title !== 'string' || typeof row.url !== 'string') continue;
        const name = row.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
        if (name) rows.push({ name, url: row.url, publishedAt: row.datetime });
      }
      const reason = Object.hasOwn(messages, result.code) ? messages[result.code] : '';
      if (!result.success) return status(reason || 'Telegram Web 归档搜索暂时失败', result.partial === true ? rows : []);
      return result.partial === true ? status(reason || messages.BUDGET_EXHAUSTED, rows) : rows;
    } catch {
      signal?.throwIfAborted();
      return status(timeout.aborted ? messages.TIMEOUT : unavailable);
    } finally { response?.destroy(); }
  };
}
