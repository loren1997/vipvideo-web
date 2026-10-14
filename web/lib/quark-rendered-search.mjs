import { googleQueryUrl, bingQueryUrl, quarkSearchQueries, quarkSearchPageState, extractQuarkSearchResults, extractQuarkArticle, classifyQuarkCandidate } from './quark-google-search.mjs';

const blocked = value => /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)|^(?:人机验证|安全验证|检测到异常流量)/i.test(value);
const direct = value => { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'pan.quark.cn' && /^\/s\/[a-z0-9]{6,32}\/?$/i.test(url.pathname); };
const reasons = { browserUnavailable: '动态网页搜索助手未启动，请更新部署配置', browserTimeout: '动态网页读取超时', browserBlocked: '网页要求验证或暂时限制访问', browserBusy: '动态网页搜索繁忙，请稍后重试' };

// Public pages only; the renderer never receives the family's cloud credentials.
export function createQuarkRenderedSearch({ render, read, now = Date.now }) {
  return async (query, { signal, deadline = now() + 45000 } = {}) => {
    signal?.throwIfAborted();
    if (deadline <= now()) return [];
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
    const searchEnd = Math.min(end - 1000, now() + 12000);
    let googleStopped = false, googleJavascript;
    const collect = (result, engine) => {
      for (const row of extractQuarkSearchResults(result.html, { ...query, engine, url: result.url, now: now() })) {
        if (direct(row.url)) merge([row]);
        else if (!articles.has(row.url) && articles.size < 12) articles.set(row.url, row);
      }
    };
    const search = async (engine, term, rss = false) => {
      if (now() >= searchEnd || engine === 'Google' && googleStopped) return;
      const url = engine === 'Google' ? googleQueryUrl(term, query.page) : bingQueryUrl(term, query.page, rss);
      try {
        signal?.throwIfAborted();
        const result = read ? await read(url, { signal, deadline: Math.min(searchEnd, now() + 3000) }) : await render(url, { signal, deadline: Math.min(end, now() + 8000) });
        const state = quarkSearchPageState(result.html, result.url);
        if (state !== 'ready') {
          if (engine === 'Google' && state === 'javascript') googleJavascript = url;
          if (engine === 'Google') googleStopped = true;
          notes.add(state === 'blocked' ? '搜索网页要求验证，已切换其他公开渠道' : '搜索网页需要 JavaScript，已切换其他公开渠道');
          return;
        }
        collect(result, engine);
      } catch (cause) { report(cause); if (engine === 'Google') googleStopped = true; }
    };
    for (const term of quarkSearchQueries(query)) {
      if (now() >= searchEnd) break;
      // HTTP search channels share a small budget; browser work is reserved for actual articles.
      if (read) await Promise.all([search('Google', term), search('Bing', term)]);
      else await search('Google', term);
      if ((read && articles.size < 6 && rows.size < 3) || (!read && !articles.size && !rows.size)) await search('Bing', term, true);
      if (!read && (rows.size || articles.size)) break;
    }
    if (read && googleJavascript && !rows.size && !articles.size && now() < end - 1000) {
      try {
        const result = await render(googleJavascript, { signal, deadline: Math.min(end - 1000, now() + 8000) });
        if (quarkSearchPageState(result.html, result.url) === 'blocked') throw Object.assign(new Error('搜索网站要求验证码'), { quarkPoolReason: 'browserBlocked' });
        collect(result, 'Google');
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
    if (!result.length) result.reason = notes.size ? [...notes].join('；') : articles.size ? '已读取相关公开网页，但未找到可核验的夸克分享链接' : '未找到与片名相符的公开网页结果';
    return result;
  };
}
