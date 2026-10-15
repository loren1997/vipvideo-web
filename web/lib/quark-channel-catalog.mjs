import { DEFAULT_QUARK_TELEGRAM_CHANNELS, inspectQuarkTelegramChannel } from './quark-telegram-search.mjs';

const SOURCE = 'https://raw.githubusercontent.com/fish2018/pansou/main/docker-compose.yml';
const KEY = 'quark.public.channel.catalog.v1', DAY = 86400000, MAX_BYTES = 64 * 1024, MAX_CHANNELS = 128;
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9_]{4,31}$/i.test(name);
// These public pages had departed from the film catalogue when checked on 2026-10-15.
const EXCLUDED = new Set(['dianyingshare', 'mcph02', 'kaipanshare', 'dzsgx']);
const allowed = name => validName(name) && !EXCLUDED.has(name.toLowerCase());
const retryDelay = failures => Math.min(DAY, 300000 * 2 ** Math.min(8, failures - 1));

function directory(html) {
  const lines = html.replace(/\r\n/g, '\n').match(/^[\t ]*-[\t ]*CHANNELS=.*$/gm) || [];
  const match = lines.length === 1 && /^[\t ]*-[\t ]*CHANNELS=([a-z0-9_,]+)[\t ]*$/i.exec(lines[0]);
  if (!match) throw new Error('频道目录格式无效');
  const names = match[1].split(',');
  if (!names.length || names.length > MAX_CHANNELS || names.some(name => !validName(name))) throw new Error('频道目录格式无效');
  return [...new Map(names.filter(allowed).map(name => [name.toLowerCase(), name])).values()];
}

function content(value, address, maxBytes) {
  const html = typeof value === 'string' ? value : value?.html;
  const finalUrl = typeof value === 'string' ? address : value?.url;
  if (typeof html !== 'string' || Buffer.byteLength(html) > maxBytes || finalUrl !== address) throw new Error('频道读取地址或大小无效');
  return html;
}

export function createQuarkChannelCatalog({ store, now = Date.now } = {}) {
  const start = now();
  const fresh = name => ({ name, active: true, failures: 0, checked: 0, due: start + DAY, reason: '' });
  let state = { version: 1, updated: 0, refresh: 0, cursor: 0, error: '', entries: DEFAULT_QUARK_TELEGRAM_CHANNELS.filter(allowed).map(fresh) };
  const saved = store?.meta(KEY);
  if (typeof saved === 'string' && saved) {
    try {
      if (Buffer.byteLength(saved) > MAX_BYTES) throw new Error('频道元数据过大');
      const loaded = JSON.parse(saved);
      if (loaded.version !== 1 || !Array.isArray(loaded.entries) || loaded.entries.length > MAX_CHANNELS) throw new Error('频道元数据无效');
      const seen = new Set(), entries = [];
      for (const entry of loaded.entries) {
        if (!entry || !allowed(entry.name) || seen.has(entry.name.toLowerCase()) || typeof entry.active !== 'boolean'
          || !Number.isInteger(entry.failures) || entry.failures < 0 || entry.failures > 9
          || !Number.isFinite(entry.checked) || entry.checked < 0 || !Number.isFinite(entry.due) || entry.due < 0
          || !['', 'unreadable', 'no-quark', 'request-failed'].includes(entry.reason)) throw new Error('频道元数据无效');
        seen.add(entry.name.toLowerCase());
        entries.push({ name: entry.name, active: entry.active, failures: entry.failures, checked: Math.min(start, entry.checked), due: Math.min(start + DAY, entry.due), reason: entry.reason });
      }
      for (const name of DEFAULT_QUARK_TELEGRAM_CHANNELS) if (allowed(name) && !seen.has(name.toLowerCase()) && entries.length < MAX_CHANNELS) entries.push(fresh(name));
      state = { version: 1, updated: Number.isFinite(loaded.updated) ? Math.max(0, Math.min(start, loaded.updated)) : 0,
        refresh: Number.isFinite(loaded.refresh) ? Math.max(0, Math.min(start + DAY, loaded.refresh)) : 0,
        cursor: Number.isInteger(loaded.cursor) && loaded.cursor >= 0 ? loaded.cursor % Math.max(1, entries.length) : 0,
        error: ['', 'directory-failed'].includes(loaded.error) ? loaded.error : '', entries };
    } catch { state.error = 'metadata-invalid'; }
  }

  let running = false;
  const active = () => state.entries.filter(entry => entry.active).map(entry => entry.name);
  function persist() {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('频道元数据超出大小限制');
    store?.setMeta(KEY, text);
  }
  function status() {
    return { active: active().length, candidates: state.entries.length, updatedAt: state.updated, nextRefreshAt: state.refresh,
      reason: state.error, sources: state.entries.map(entry => ({ channel: entry.name, active: entry.active, reason: entry.reason, nextCheckAt: entry.due })) };
  }

  async function resolve({ read, deadline = now() + 6000, signal } = {}) {
    signal?.throwIfAborted();
    const end = Math.min(deadline, now() + 6000);
    if (running || typeof read !== 'function' || !Number.isFinite(end) || now() >= end) return active();
    running = true;
    let dirty = false;
    const check = () => { signal?.throwIfAborted(); if (now() >= end) throw Object.assign(new Error('频道检测超时'), { name: 'TimeoutError' }); };
    const fetchText = async (url, maxBytes) => {
      check();
      const result = await read(url, Math.max(1, Math.min(3000, end - now())), maxBytes, end, signal);
      check();
      return content(result, url, maxBytes);
    };
    try {
      if (now() >= state.refresh) {
        let names;
        try { names = directory(await fetchText(SOURCE, MAX_BYTES)); }
        catch (error) {
          signal?.throwIfAborted();
          state.error = 'directory-failed'; state.refresh = now() + 300000; dirty = true;
        }
        if (names) {
          const previous = new Map(state.entries.map(entry => [entry.name.toLowerCase(), entry]));
          const ordered = [...DEFAULT_QUARK_TELEGRAM_CHANNELS, ...state.entries.filter(entry => entry.active).map(entry => entry.name), ...names];
          const unique = [...new Map(ordered.filter(allowed).map(name => [name.toLowerCase(), name])).values()].slice(0, MAX_CHANNELS);
          state.entries = unique.map(name => previous.get(name.toLowerCase()) || { name, active: false, failures: 0, checked: 0, due: 0, reason: '' });
          state.cursor %= Math.max(1, state.entries.length);
          state.updated = now(); state.refresh = now() + DAY; state.error = ''; dirty = true;
        }
      }

      for (let count = 0; count < 2 && now() < end; count++) {
        let index = -1;
        for (let offset = 0; offset < state.entries.length; offset++) {
          const next = (state.cursor + offset) % state.entries.length;
          if (state.entries[next].due <= now()) { index = next; break; }
        }
        if (index < 0) break;
        const entry = state.entries[index], url = 'https://t.me/s/' + entry.name;
        let result;
        try {
          const html = await fetchText(url, 512 * 1024);
          result = inspectQuarkTelegramChannel(html, { url, channel: entry.name });
        } catch (error) {
          signal?.throwIfAborted();
          if (now() >= end) break;
          result = null;
        }
        check();
        const readable = !!result?.readable, healthy = readable && result.hasQuarkLinks;
        entry.active = !!(healthy || readable && entry.active); entry.checked = now();
        entry.failures = readable ? 0 : Math.min(9, entry.failures + 1);
        entry.reason = healthy ? '' : result ? result.readable ? 'no-quark' : 'unreadable' : 'request-failed';
        entry.due = now() + (healthy || entry.reason === 'no-quark' ? DAY : entry.reason === 'unreadable' ? 21600000 : retryDelay(entry.failures));
        state.cursor = (index + 1) % state.entries.length;
        dirty = true;
      }
      return active();
    } finally {
      running = false;
      if (dirty) persist();
    }
  }
  return { resolve, status };
}
