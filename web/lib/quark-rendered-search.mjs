import { googleQueryUrl, extractQuarkSearchResults, extractQuarkArticle, classifyQuarkCandidate } from './quark-google-search.mjs';

const blocked = value => /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)|^(?:人机验证|安全验证|检测到异常流量)/i.test(value);
const direct = value => { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'pan.quark.cn' && /^\/s\/[a-z0-9]{6,32}\/?$/i.test(url.pathname); };
const reasons = { browserUnavailable: '动态网页搜索助手未启动，请更新部署配置', browserTimeout: '动态网页读取超时', browserBlocked: '网页要求验证或暂时限制访问', browserBusy: '动态网页搜索繁忙，请稍后重试' };

// Public pages only; the renderer never receives the family's cloud credentials.
export function createQuarkRenderedSearch({ render, read, now = Date.now }) {
  return async (query, { signal, deadline = now() + 45000 } = {}) => {
    const end = Math.min(deadline, now() + 45000), rows = new Map(), articles = new Map(), notes = new Set();
    const merge = items => {
      for (const row of items) {
        if (classifyQuarkCandidate(row.name, query) !== 'matched') continue;
        const key = new URL(row.url).href, previous = rows.get(key);
        if (!previous || (row.publishedAt ?? -1) > (previous.publishedAt ?? -1)) rows.set(key, row);
      }
    };
    const page = async (url, duration, usable) => {
      signal?.throwIfAborted();
      if (end <= now()) throw Object.assign(new Error('动态网页读取超时'), { quarkPoolReason: 'browserTimeout' });
      const deadline = Math.min(end, now() + duration);
      if (read) {
        try {
          const result = await read(url, { signal, deadline: Math.min(deadline, now() + 8000) });
          if (blocked(result.html)) throw Object.assign(new Error('网页要求验证'), { quarkPoolReason: 'browserBlocked' });
          if (usable(result)) return result;
        } catch (cause) { signal?.throwIfAborted(); if (cause.quarkPoolReason === 'browserBlocked') throw cause; }
      }
      const result = await render(url, { signal, deadline });
      if (blocked(result.text || '')) throw Object.assign(new Error('网页要求验证'), { quarkPoolReason: 'browserBlocked' });
      return result;
    };
    const report = cause => { signal?.throwIfAborted(); notes.add(reasons[cause?.quarkPoolReason] || '动态网页暂时无法读取'); };
    const terms = [query.title];
    const compact = /^(.+\p{Script=Han})((?:19|20)\d{2})$/u.exec(query.title);
    if (compact) terms.push(compact[1] + ' ' + compact[2]);
    else if (query.aliases?.[0] && query.aliases[0] !== query.title) terms.push(query.aliases[0]);
    for (const term of terms) {
      if (now() >= end - 1000) break;
      try {
        const parse = result => extractQuarkSearchResults(result.html, { ...query, url: result.url, now: now() });
        const result = await page(googleQueryUrl(term + ' 夸克 网盘'), 16000, value => parse(value).length > 0);
        const results = parse(result);
        for (const row of results) {
          if (direct(row.url)) merge([row]);
          else if (!articles.has(row.url) && articles.size < 12) articles.set(row.url, row);
        }
        // Visit articles before spending the remaining budget on a broader title variant.
        if (rows.size || articles.size) break;
      } catch (cause) { report(cause); if (['browserUnavailable', 'browserBlocked'].includes(cause?.quarkPoolReason)) break; }
    }
    if (read && !articles.size && !rows.size && now() < end - 1000) {
      try {
        const url = 'https://www.bing.com/search?' + new URLSearchParams({ format: 'rss', q: query.title + ' 夸克 网盘' });
        const result = await read(url, { signal, deadline: Math.min(end, now() + 5000) });
        for (const row of extractQuarkSearchResults(result.html, { ...query, engine: 'Bing', url: result.url, now: now() })) {
          if (direct(row.url)) merge([row]);
          else if (!articles.has(row.url) && articles.size < 12) articles.set(row.url, row);
        }
      } catch (cause) { report(cause); }
    }
    const sorted = [...articles.values()].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1));
    for (const row of sorted.slice(0, 5)) {
      if (now() >= end - 1000 || rows.size >= 30) break;
      try {
        const parse = result => extractQuarkArticle(result.html, { ...query, url: result.url, now: now() }).rows;
        const result = await page(row.url, 12000, value => parse(value).length > 0);
        merge(parse(result));
      } catch (cause) { report(cause); }
    }
    const result = [...rows.values()].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1)).slice(0, 30);
    if (!result.length && notes.size) result.reason = [...notes].join('；');
    return result;
  };
}
