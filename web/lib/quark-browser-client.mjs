import { Readable } from 'node:stream';
import { readText } from './network.mjs';

export function createQuarkBrowserSearch({ fetch = globalThis.fetch } = {}) {
  return async (query, { signal, deadline = Date.now() + 45000 } = {}) => {
    const budgetMs = Math.max(1, Math.min(45000, deadline - Date.now()));
    const timeout = AbortSignal.timeout(budgetMs + 1000);
    try {
      const response = await fetch('http://quark-browser:3020/search', {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: query.title, aliases: query.aliases || [], year: String(query.year || ''), page: query.page ?? 0, budgetMs }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const result = JSON.parse(await readText(Readable.fromWeb(response.body), 128 * 1024));
      if (!response.ok) throw Object.assign(new Error('动态搜索助手不可用'), { quarkPoolReason: result.reason === 'browserBusy' ? 'browserBusy' : result.reason === 'browserTimeout' ? 'browserTimeout' : 'browserUnavailable' });
      if (!Array.isArray(result.results) || result.results.length > 30) throw new Error('动态搜索响应格式错误');
      const rows = result.results;
      if (typeof result.reason === 'string') rows.reason = result.reason.slice(0, 300);
      return rows;
    } catch (cause) {
      signal?.throwIfAborted();
      const rows = [];
      rows.reason = cause.quarkPoolReason === 'browserBusy' ? '动态网页搜索繁忙，请稍后重试' : timeout.aborted || cause.name === 'TimeoutError' || cause.quarkPoolReason === 'browserTimeout' ? '动态网页读取超时' : '动态网页搜索助手未启动，请更新部署配置';
      return rows;
    }
  };
}
