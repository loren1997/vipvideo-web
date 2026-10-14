import { validateUrl } from './network.mjs';
import { extractQuarkArticle, quarkPasswordDate } from './quark-google-search.mjs';

const CHANNEL = 'Quark_Movies', MAX_BODY = 512 * 1024;
const attribute = (value, name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(value)?.slice(1).find(value => value !== undefined) || '';
const hasClass = (value, name) => attribute(value, 'class').split(/\s+/).includes(name);
const titlePrefix = /^(?:\s|<[^>]+>)*(?:名称|标题)(?:\s|<[^>]+>)*[:：](?:\s|<[^>]+>)*/i;

function mergeRow(rows, row) {
  const url = new URL(row.url), previous = rows.get(url.pathname);
  const codeDate = row[quarkPasswordDate] ?? row.publishedAt ?? 0, previousCodeDate = previous?.[quarkPasswordDate] ?? previous?.publishedAt ?? 0;
  const replace = !previous || url.searchParams.has('pwd') && (!new URL(previous.url).searchParams.has('pwd') || codeDate > previousCodeDate);
  const selected = { ...(replace ? row : previous) }, date = Math.max(row.publishedAt || 0, previous?.publishedAt || 0);
  if (new URL(selected.url).searchParams.has('pwd')) selected[quarkPasswordDate] = replace ? codeDate : previousCodeDate;
  if (date) selected.publishedAt = date;
  rows.set(url.pathname, selected);
}

function divs(html, name, limit = 100) {
  const found = [], tags = /<\/?div\b[^>]*>/gi;
  let tag;
  while ((tag = tags.exec(html)) && found.length < limit) {
    if (/^<\//.test(tag[0]) || !hasClass(tag[0], name)) continue;
    const start = tags.lastIndex; let depth = 1, end;
    while ((end = tags.exec(html))) {
      depth += /^<\//.test(end[0]) ? -1 : 1;
      if (!depth) { found.push({ attributes: tag[0], html: html.slice(start, end.index) }); break; }
    }
  }
  return found;
}

function publicPage(value) {
  try {
    const url = validateUrl(value);
    return url.protocol === 'https:' && url.hostname === 't.me' && !url.port && new RegExp(`^/(?:s/)?${CHANNEL}(?:/[1-9]\\d{0,12})?/?$`, 'i').test(url.pathname) ? url : null;
  } catch { return null; }
}

export function extractQuarkTelegramResults(html, { url, title, aliases = [], year, now = Date.now() } = {}) {
  const rows = new Map(), page = publicPage(url); let nextBefore;
  if (!page || typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) return { rows: [], nextBefore };
  for (const post of divs(html, 'tgme_widget_message_wrap')) {
    const message = divs(post.html, 'tgme_widget_message', 1)[0];
    const id = new RegExp(`^${CHANNEL}/([1-9]\\d{0,12})$`, 'i').exec(attribute(message?.attributes || '', 'data-post'))?.[1];
    if (!id) continue;
    if (!nextBefore || Number(id) < Number(nextBefore)) nextBefore = id;
    const body = divs(message.html, 'tgme_widget_message_text', 1)[0]?.html;
    if (!body) continue;
    const lines = body.split(/<br\b[^>]*>|\r?\n/i), heading = lines[0].replace(titlePrefix, '');
    const postUrl = `https://t.me/${CHANNEL}/${id}`;
    const dateAnchor = [...message.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].find(match => attribute(match[1], 'href') === postUrl && /<time\b/i.test(match[2]));
    const date = dateAnchor && /<time\b[^>]*>/i.exec(dateAnchor[2])?.[0] || '';
    const sections = lines.map((line, index) => index && titlePrefix.test(line) ? `<h2>${line.replace(titlePrefix, '')}</h2>` : line).join('<br/>');
    const links = sections.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>|<[^>]*>|https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?[^\s<>"'，。]*)?/gi, value => value.startsWith('<') ? value : `<a href="${value}">夸克链接</a>`);
    const result = extractQuarkArticle(`<article><h1>${heading}</h1>${links}${date}</article>`, { url: postUrl, title, aliases, year, requireYear: /^(?:19|20)\d{2}$/.test(String(year)), now });
    for (const row of result.rows) mergeRow(rows, row);
  }
  return { rows: [...rows.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)), nextBefore };
}

export function createQuarkTelegramSearch() {
  const cache = new Map();
  return async function searchTelegramQuark(keyword, { aliases = [], year, page = 0, read, deadline, now = Date.now, signal } = {}) {
    const rows = new Map(), end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now() + 10_000);
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 1000 || typeof read !== 'function' || now() >= end) return [];
    signal?.throwIfAborted();
    const title = keyword.trim(), names = [...new Set([title, ...(Array.isArray(aliases) ? aliases.slice(0, 10) : []).filter(value => typeof value === 'string' && value.trim() && value.length <= 300).map(value => value.trim())])].slice(0, 2);
    const key = JSON.stringify([title, names, year]);
    for (const [key, value] of cache) if (!value.users && value.expires <= now()) cache.delete(key);
    let entry = cache.get(key);
    if (!entry) {
      if (cache.size >= 32) {
        const idle = [...cache].find(([, value]) => !value.users);
        if (!idle) return Object.assign([], { reason: '公开频道搜索繁忙，请稍后重试' });
        cache.delete(idle[0]);
      }
      entry = { queries: [], next: 0, expires: now() + 120_000, users: 0, tail: Promise.resolve() };
      cache.set(key, entry);
    }
    const previous = entry.tail; let release, timer, onAbort, reason = '';
    const gate = new Promise(resolve => { release = resolve; });
    entry.tail = previous.then(() => gate); entry.users++;
    try {
      await Promise.race([previous, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('公开频道搜索超时')), Math.max(1, end - now()));
        onAbort = () => reject(signal.reason); signal?.addEventListener('abort', onAbort, { once: true });
      })]);
      signal?.throwIfAborted();
      if (now() >= end) return Object.assign([], { reason: '公开频道搜索超时' });
      const reset = !(Number(page) > 0) || entry.expires <= now() || !entry.queries.length;
      const queries = reset ? names.map(name => ({ name, before: undefined, exhausted: false })) : entry.queries.map(value => ({ ...value }));
      const failed = new Set(), maximum = Number(page) > 0 && reset ? 3 : names.length;
      let next = reset ? 0 : entry.next;
      for (let requests = 0; requests < maximum && now() < end; requests++) {
        signal?.throwIfAborted();
        let query;
        for (let count = 0; count < queries.length; count++) {
          const candidate = queries[next]; next = (next + 1) % queries.length;
          if (!candidate.exhausted && !failed.has(candidate.name)) { query = candidate; break; }
        }
        if (!query) break;
        const address = `https://t.me/s/${CHANNEL}?` + new URLSearchParams({ q: query.name, ...(query.before ? { before: query.before } : {}) });
        try {
          const result = await read(address, Math.min(5000, end - now()), MAX_BODY, end);
          signal?.throwIfAborted();
          if (now() >= end) { reason = '公开频道搜索超时'; break; }
          const parsed = extractQuarkTelegramResults(typeof result === 'string' ? result : result?.html, { url: typeof result === 'string' ? address : result?.url || address, title, aliases, year, now: now() });
          for (const row of parsed.rows) mergeRow(rows, row);
          query.exhausted = !parsed.nextBefore || query.before !== undefined && Number(parsed.nextBefore) >= Number(query.before);
          if (!query.exhausted) query.before = parsed.nextBefore;
        } catch (error) {
          signal?.throwIfAborted(); failed.add(query.name);
          reason = /超时|timeout|timed out/i.test(error?.message || '') ? '公开频道搜索超时' : '公开频道暂时无法读取';
        }
      }
      signal?.throwIfAborted();
      entry.queries = queries; entry.next = next; entry.expires = now() + 120_000;
    } catch (error) {
      signal?.throwIfAborted();
      reason = '公开频道搜索超时';
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release(); entry.users--;
    }
    const results = [...rows.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    if (reason) results.reason = reason;
    return results;
  };
}

export const searchTelegramQuark = createQuarkTelegramSearch();
