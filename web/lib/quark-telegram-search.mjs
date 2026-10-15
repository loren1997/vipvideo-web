import { validateUrl } from './network.mjs';
import { extractQuarkArticle, quarkPasswordDate } from './quark-google-search.mjs';

// PanSou's official channel catalog; each default has a readable, same-channel public post containing Quark links.
export const DEFAULT_QUARK_TELEGRAM_CHANNELS = Object.freeze([
  'Quark_Movies', 'ucquark', 'QuarkFree', 'kuakedongman', 'guoman4K', 'PanjClub', 'SharePanFilms',
  'Netdisk_Movies', 'yunpanquark', 'quark_res', 'baicaoZY', 'tgsearchers7', 'yunpanx', 'yydf_hzl',
  'Aliyun_4K_Movies', 'shareAliyun', 'dianying4k', 'WPpindao', 'Panzi88com', 'zh_vip', 'rbzhwpzy',
  'gokuapan', 'jxwpzy', 'TG654TG', 'yoyokuakeduanju', 'Q66Share', 'leoziyuan'
]);
export const QUARK_TELEGRAM_CHANNELS = DEFAULT_QUARK_TELEGRAM_CHANNELS;
const MAX_BODY = 512 * 1024;
const channelNames = values => [...new Map((Array.isArray(values) ? values : []).slice(0, 128).filter(value => typeof value === 'string' && /^[a-z][a-z0-9_]{4,31}$/i.test(value)).map(value => [value.toLowerCase(), value])).values()];
const attribute = (value, name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(value)?.slice(1).find(value => value !== undefined) || '';
const hasClass = (value, name) => attribute(value, 'class').split(/\s+/).includes(name);
const titlePrefix = /^(?:\s|<[^>]+>)*(?:【|\[)?(?:名称|标题)(?:】|\])?(?:\s|<[^>]+>)*[:：](?:\s|<[^>]+>)*/i;

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

function publicPage(value, channels = DEFAULT_QUARK_TELEGRAM_CHANNELS) {
  try {
    const url = validateUrl(value);
    const match = /^\/(?:s\/)?([a-z][a-z0-9_]{4,31})(?:\/[1-9]\d{0,12})?\/?$/i.exec(url.pathname);
    const channel = match && channels.find(value => value.toLowerCase() === match[1].toLowerCase());
    return url.protocol === 'https:' && url.hostname === 't.me' && !url.port && channel ? { url, channel } : null;
  } catch { return null; }
}

export function inspectQuarkTelegramChannel(html, { url, channel } = {}) {
  const page = publicPage(url, channelNames([channel]));
  if (!page || !new RegExp(`^/s/${page.channel}/?$`, 'i').test(page.url.pathname) || typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) return { readable: false, hasQuarkLinks: false };
  let readable = false, hasQuarkLinks = false;
  for (const post of divs(html, 'tgme_widget_message_wrap')) {
    const message = divs(post.html, 'tgme_widget_message', 1)[0];
    if (!new RegExp(`^${page.channel}/[1-9]\\d{0,12}$`, 'i').test(attribute(message?.attributes || '', 'data-post'))) continue;
    const body = divs(message.html, 'tgme_widget_message_text', 1)[0]?.html;
    if (!body?.trim()) continue;
    readable = true;
    const visible = body.replace(/<!--[\s\S]*?-->|<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)\s*>/gi, '');
    const links = [...visible.matchAll(/<a\b([^>]*)>/gi)].map(match => attribute(match[1], 'href')).concat(visible.replace(/<[^>]*>/g, ' ').match(/https:\/\/pan\.quark\.cn\/s\/[^\s<>"'，。]+/gi) || []);
    if (links.some(link => { try { const target = validateUrl(link); return target.protocol === 'https:' && target.hostname === 'pan.quark.cn' && !target.port && /^\/s\/[a-z0-9]{6,32}\/?$/i.test(target.pathname); } catch { return false; } })) hasQuarkLinks = true;
  }
  return { readable, hasQuarkLinks };
}

export function extractQuarkTelegramResults(html, { url, title, aliases = [], year, now = Date.now(), channels = DEFAULT_QUARK_TELEGRAM_CHANNELS } = {}) {
  const rows = new Map(), page = publicPage(url, channelNames(channels)); let nextBefore;
  if (!page || typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) return { rows: [], nextBefore };
  for (const post of divs(html, 'tgme_widget_message_wrap')) {
    const message = divs(post.html, 'tgme_widget_message', 1)[0];
    const id = new RegExp(`^${page.channel}/([1-9]\\d{0,12})$`, 'i').exec(attribute(message?.attributes || '', 'data-post'))?.[1];
    if (!id) continue;
    if (!nextBefore || Number(id) < Number(nextBefore)) nextBefore = id;
    const body = divs(message.html, 'tgme_widget_message_text', 1)[0]?.html;
    if (!body) continue;
    const lines = body.split(/<br\b[^>]*>|\r?\n/i), heading = lines[0].replace(titlePrefix, '');
    const postUrl = `https://t.me/${page.channel}/${id}`;
    const dateAnchor = [...message.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].find(match => attribute(match[1], 'href').toLowerCase() === postUrl.toLowerCase() && /<time\b/i.test(match[2]));
    const date = dateAnchor && /<time\b[^>]*>/i.exec(dateAnchor[2])?.[0] || '';
    const sections = lines.map((line, index) => index && titlePrefix.test(line) ? `<h2>${line.replace(titlePrefix, '')}</h2>` : line).join('<br/>');
    const links = sections.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>|<[^>]*>|https?:\/\/pan\.quark\.cn\/s\/[a-z0-9]{6,32}(?:\?[^\s<>"'，。]*)?/gi, value => value.startsWith('<') ? value : `<a href="${value}">夸克链接</a>`);
    const result = extractQuarkArticle(`<article><h1>${heading}</h1>${links}${date}</article>`, { url: postUrl, title, aliases, year, requireYear: /^(?:19|20)\d{2}$/.test(String(year)), now });
    for (const row of result.rows) mergeRow(rows, row);
  }
  return { rows: [...rows.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)), nextBefore };
}

export function createQuarkTelegramSearch({ channels = DEFAULT_QUARK_TELEGRAM_CHANNELS, resolveChannels } = {}) {
  const cache = new Map(), allowed = new Map(channelNames(channels).map(channel => [channel.toLowerCase(), channel]));
  let activeChannels = [...allowed.values()];
  return async function searchTelegramQuark(keyword, { aliases = [], year, page = 0, read, deadline, now = Date.now, signal, onResults } = {}) {
    const rows = new Map(), end = Math.min(Number.isFinite(deadline) ? deadline : Infinity, now() + 35_000);
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
      entry = { queries: [], failed: [], active: [], expires: now() + 120_000, users: 0, tail: Promise.resolve() };
      cache.set(key, entry);
    }
    const previous = entry.tail; let release, timer, onAbort, reason = '', pending = false, progress, interrupted;
    const gate = new Promise(resolve => { release = resolve; });
    entry.tail = previous.then(() => gate); entry.users++;
    try {
      interrupted = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('公开频道搜索超时')), Math.max(1, end - now()));
        onAbort = () => reject(signal.reason); signal?.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([previous, interrupted]);
      signal?.throwIfAborted();
      if (now() >= end) return Object.assign([], { reason: '公开频道搜索超时' });
      let channels = activeChannels;
      if (typeof resolveChannels === 'function') {
        try {
          const discovered = await Promise.race([resolveChannels({ read, deadline: end, signal }), interrupted]);
          signal?.throwIfAborted();
          if (!Array.isArray(discovered)) throw new Error('公开频道目录格式不兼容');
          for (const channel of channelNames(discovered)) if (allowed.size < 128 && !allowed.has(channel.toLowerCase())) allowed.set(channel.toLowerCase(), channel);
          channels = activeChannels = channelNames(discovered).map(channel => allowed.get(channel.toLowerCase())).filter(Boolean);
        } catch (error) { signal?.throwIfAborted(); reason = '公开频道目录暂时无法更新'; }
      }
      const active = new Set(channels);
      const reset = !(Number(page) > 0) || entry.expires <= now() || !entry.queries.length;
      const queries = reset ? [] : entry.queries.map(value => ({ ...value })), failed = new Set(reset ? [] : entry.failed);
      for (const channel of active) if (!entry.active.includes(channel)) failed.delete(channel);
      for (const [index, name] of names.entries()) for (const channel of active) {
        if (!queries.some(query => query.channel === channel && query.name === name)) queries.push({ channel, name, index, depth: 0, before: undefined, exhausted: false, attempted: false });
      }
      const maximum = Math.min(8, active.size === 1 ? Number(page) > 0 && reset ? 3 : names.length : 8);
      const available = () => queries.filter(query => active.has(query.channel) && !query.exhausted && !failed.has(query.channel));
      const snapshot = () => [...rows.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      const fetchQuery = async query => {
        const duration = Math.max(1, Math.min(3000, end - now())), controller = new AbortController();
        const abort = () => controller.abort(signal.reason), timeout = setTimeout(() => controller.abort(new Error('公开频道搜索超时')), duration);
        let onReadAbort;
        signal?.addEventListener('abort', abort, { once: true });
        const address = `https://t.me/s/${query.channel}?` + new URLSearchParams({ q: query.name, ...(query.before ? { before: query.before } : {}) });
        try {
          const result = await Promise.race([Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return read(address, duration, MAX_BODY, end, controller.signal);
          }), new Promise((_, reject) => {
            onReadAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', onReadAbort, { once: true });
          })]);
          signal?.throwIfAborted();
          if (now() >= end) throw new Error('公开频道搜索超时');
          const resultUrl = typeof result === 'string' ? address : result?.url || address, final = publicPage(resultUrl, [query.channel]);
          if (!final) throw new Error('公开频道跳转不可用');
          const html = typeof result === 'string' ? result : result?.html;
          if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BODY) throw new Error('公开频道响应不可用');
          const parsed = extractQuarkTelegramResults(html, { url: resultUrl, title, aliases, year, now: now(), channels: [query.channel] });
          for (const row of parsed.rows) mergeRow(rows, row);
          query.attempted = true; query.depth++;
          query.exhausted = !parsed.nextBefore || query.before !== undefined && Number(parsed.nextBefore) >= Number(query.before);
          if (!query.exhausted) query.before = parsed.nextBefore;
          if (parsed.rows.length && typeof onResults === 'function') onResults(snapshot());
        } catch (error) {
          signal?.throwIfAborted(); query.attempted = true; failed.add(query.channel);
          reason = /超时|timeout|timed out/i.test(error?.message || '') ? '公开频道搜索超时' : '公开频道暂时无法读取';
        } finally {
          clearTimeout(timeout); signal?.removeEventListener('abort', abort);
          controller.signal.removeEventListener('abort', onReadAbort);
        }
      };
      for (let requests = 0; requests < maximum && now() < end;) {
        signal?.throwIfAborted();
        const remaining = available(), rank = query => query.depth * names.length + query.index;
        const first = Math.min(...remaining.map(rank)), wave = remaining.filter(query => rank(query) === first).slice(0, Math.min(2, maximum - requests));
        if (!wave.length) break;
        requests += wave.length;
        await Promise.all(wave.map(fetchQuery));
      }
      signal?.throwIfAborted();
      pending = available().length > 0;
      const current = queries.filter(query => active.has(query.channel));
      progress = { totalChannels: active.size, attemptedChannels: new Set(current.filter(query => query.attempted).map(query => query.channel)).size, totalQueries: current.length, attemptedQueries: current.filter(query => query.attempted).length, failedChannels: [...failed].filter(channel => active.has(channel)).length };
      entry.queries = queries; entry.failed = [...failed]; entry.active = channels; entry.expires = now() + 120_000;
    } catch (error) {
      signal?.throwIfAborted();
      reason = '公开频道搜索超时';
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); release(); entry.users--;
    }
    const results = [...rows.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    if (reason) results.reason = reason;
    if (progress) { results.pending = pending; results.progress = progress; }
    return results;
  };
}

export const searchTelegramQuark = createQuarkTelegramSearch();
