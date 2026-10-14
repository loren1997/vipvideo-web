import { googleQueryUrl, bingQueryUrl, quarkSearchQueries, quarkSearchPageState, extractQuarkSearchResults, extractQuarkArticle, classifyQuarkCandidate } from './quark-google-search.mjs';

const blocked = value => /g-recaptcha|h-captcha|cf-chl-|our systems have detected|unusual traffic|<title[^>]*>[^<]*(?:验证码|安全验证|登录|sign\s?in|log\s?in)|<title[^>]*>\s*人机验证\s*<\/title\s*>|^(?:人机验证|安全验证|检测到异常流量)/i.test(value);
const direct = value => { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'pan.quark.cn' && /^\/s\/[a-z0-9]{6,32}\/?$/i.test(url.pathname); };
const reasons = { browserUnavailable: '动态网页搜索助手未启动，请更新部署配置', browserTimeout: '动态网页读取超时', browserBlocked: '网页要求验证或暂时限制访问', browserLocked: '公开文章要求登录或回复，无法匿名读取', browserBusy: '动态网页搜索繁忙，请稍后重试' };

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
    const report = cause => { signal?.throwIfAborted(); notes.add(reasons[cause?.quarkPoolReason] || '动态网页暂时无法读取'); };
    // The main app may already have spent eight seconds on its search API.
    const searchEnd = Math.min(end - 1000, now() + Math.max(1000, Math.min(12000, end - now() - 32000)));
    const googleEnd = Math.min(end - 1000, Math.max(now() + 1000, end - 12000));
    let googleStopped = false;
    const collect = (result, engine) => {
      let matched = false;
      for (const row of extractQuarkSearchResults(result.html, { ...query, engine, url: result.url, now: now() })) {
        matched ||= classifyQuarkCandidate(row.name, query) === 'matched';
        if (direct(row.url)) merge([row]);
        else if (!articles.has(row.url) && articles.size < 12) articles.set(row.url, row);
      }
      return matched;
    };
    const search = async (engine, term, rss = false) => {
      const searchDeadline = engine === 'Google' ? googleEnd : searchEnd;
      if (now() >= searchDeadline || engine === 'Google' && googleStopped) return;
      const url = engine === 'Google' ? googleQueryUrl(term, query.page) : bingQueryUrl(term, query.page, rss);
      try {
        signal?.throwIfAborted();
        const result = engine === 'Google' || !read ? await render(url, { signal, deadline: Math.min(searchDeadline, now() + 20000) }) : await read(url, { signal, deadline: Math.min(searchEnd, now() + 3000) });
        const state = quarkSearchPageState(result.html, result.url);
        if (state !== 'ready') {
          if (engine === 'Google') googleStopped = true;
          notes.add(state === 'blocked' ? '搜索网页要求验证，已切换其他公开渠道' : '搜索网页需要 JavaScript，已切换其他公开渠道');
          return;
        }
        if (collect(result, engine) && engine === 'Google') googleStopped = true;
      } catch (cause) { report(cause); if (engine === 'Google') googleStopped = true; }
    };
    for (const term of quarkSearchQueries(query)) {
      if (now() >= searchEnd && (googleStopped || now() >= googleEnd)) break;
      if (read) await Promise.all([search('Google', term), search('Bing', term)]);
      else await search('Google', term);
      if ((read && articles.size < 6 && rows.size < 3) || (!read && !articles.size && !rows.size)) await search('Bing', term, true);
      if (!read && (rows.size || articles.size)) break;
    }
    const selected = [...articles.values()].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1)).slice(0, 5);
    const loaded = new Map(), excluded = new Set();
    const parse = (row, result) => extractQuarkArticle(result.html, { ...query, url: result.url, requireYear: row.googleRedirect === true, now: now() }).rows;
    // Read all selected articles before an unrelated dynamic page can spend the remaining budget.
    if (read && selected.length && now() < end - 1000) {
      const deadline = Math.min(end - 1000, now() + 8000);
      const controller = new AbortController(), reading = AbortSignal.any([signal, controller.signal].filter(Boolean));
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now()));
      let cursor = 0, stop;
      const prefetch = async () => {
        while (cursor < selected.length && now() < deadline && !reading.aborted) {
          const row = selected[cursor++];
          try {
            const result = await read(row.url, { signal: reading, deadline });
            if (reading.aborted || now() > deadline) return;
            if (blocked(result.html)) throw Object.assign(new Error('网页要求验证'), { quarkPoolReason: 'browserBlocked' });
            const found = parse(row, result);
            if (!found.length && /本帖含有特定内容，请回复后再查看|kehua-hidden-block--locked/.test(result.html)) throw Object.assign(new Error('公开文章要求登录或回复'), { quarkPoolReason: 'browserLocked' });
            loaded.set(row.url, result); merge(found);
          } catch (cause) {
            signal?.throwIfAborted();
            if (reading.aborted) return;
            if (cause.quarkPoolReason === 'browserBlocked' || cause.quarkPoolReason === 'browserLocked') excluded.add(row.url);
            report(cause);
          }
        }
      };
      try {
        await Promise.race([Promise.all([prefetch(), prefetch()]), new Promise(resolve => {
          stop = resolve; reading.addEventListener('abort', stop, { once: true }); if (reading.aborted) resolve();
        })]);
      } finally { clearTimeout(timer); reading.removeEventListener('abort', stop); }
      signal?.throwIfAborted();
      if (reading.aborted) notes.add('公开文章读取超时');
    }
    const shell = row => {
      const result = loaded.get(row.url);
      return typeof result?.html === 'string' && (quarkSearchPageState(result.html, result.url) === 'javascript' || !result.html.replace(/<(head|title|script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').replace(/<[^>]*>/g, '').trim());
    };
    const dynamic = selected.filter(row => !excluded.has(row.url)).sort((a, b) => Number(Boolean(shell(b))) - Number(Boolean(shell(a))));
    for (const row of dynamic) {
      if (read && rows.size) break;
      if (now() >= end - 1000 || rows.size >= 30) break;
      try {
        signal?.throwIfAborted();
        const result = await render(row.url, { signal, deadline: Math.min(end, now() + 12000) });
        if (blocked(result.text || '')) throw Object.assign(new Error('网页要求验证'), { quarkPoolReason: 'browserBlocked' });
        merge(parse(row, result));
      } catch (cause) { report(cause); }
    }
    const result = [...rows.values()].sort((a, b) => (b.publishedAt ?? -1) - (a.publishedAt ?? -1)).slice(0, 30);
    if (!result.length) result.reason = notes.size ? [...notes].join('；') : articles.size ? '已读取相关公开网页，但未找到可核验的夸克分享链接' : '未找到与片名相符的公开网页结果';
    return result;
  };
}
