import { request as networkRequest, readText, validateUrl } from './network.mjs';
import { importConfig, validateConfig } from './config.mjs';
import { repairImport } from './import-repair.mjs';

const META_KEY = 'source-maintenance-v1';
const PROBE_INTERVAL = 30 * 60 * 1000;
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
const emptyConfig = () => ({ sources: [], platforms: [], parsers: [], subscriptions: [] });

function errorText(error) { return String(error?.message || '请求失败').slice(0, 300); }

function validAppleCms(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Number(body.code) === 0) return false;
  const list = body.list;
  const classes = body.class;
  const validList = Array.isArray(list) && list.every(item => item && typeof item === 'object' && item.vod_id != null && typeof item.vod_name === 'string');
  const validClass = Array.isArray(classes) && classes.every(item => item && typeof item === 'object' && item.type_id != null && typeof item.type_name === 'string');
  return (validList || validClass) && (list === undefined || validList) && (classes === undefined || validClass);
}

export function createSourceMaintenance({ store, catalog, initialSources = [], request = networkRequest, now = Date.now, logger = console }) {
  let saved;
  try { saved = JSON.parse(store.meta(META_KEY) || '{}'); } catch { saved = {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const state = {
    lastProbe: Number(saved.lastProbe) || 0, lastUpdate: Number(saved.lastUpdate) || 0,
    sources: Object.assign(Object.create(null), saved.sources && typeof saved.sources === 'object' ? saved.sources : {}),
    subscriptions: Object.assign(Object.create(null), saved.subscriptions && typeof saved.subscriptions === 'object' ? saved.subscriptions : {}),
  };
  let probeJob = null;
  let updateJob = null;
  let probeTimer = null;
  let updateTimer = null;
  let started = false;
  let stopping = false;
  let activeRequests = 0;
  const waiting = [];
  const persist = () => store.setMeta(META_KEY, JSON.stringify(state));

  function status() {
    const config = store.config();
    const rows = (items, records, key) => items.map(item => {
      const previous = records[item.id];
      const current = previous?.[key] === item[key] ? previous : null;
      return {
        id: item.id, name: item.name, [key]: item[key],
        status: item.enabled === false ? 'disabled' : current?.status || 'unknown',
        latencyMs: current?.latencyMs ?? null, checkedAt: current?.checkedAt ?? 0, error: current?.error || '',
        ...(key === 'url' ? { added: current?.added || 0, updated: current?.updated || 0, skipped: current?.skipped || 0 } : {}),
      };
    });
    return structuredClone({ running: Boolean(probeJob || updateJob), lastProbe: state.lastProbe, lastUpdate: state.lastUpdate,
      sources: rows(config.sources, state.sources, 'api'), subscriptions: rows(config.subscriptions || [], state.subscriptions, 'url') });
  }

  async function jsonRequest(value, maxBytes, repair = false) {
    if (activeRequests >= 2) await new Promise(resolve => waiting.push(resolve));
    else activeRequests++;
    let response;
    let timer;
    let expired = false;
    try {
      if (stopping) throw new Error('服务正在停止，本次请求已取消');
      const url = validateUrl(value);
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; response?.destroy(); reject(new Error('请求超时（8 秒）')); }, 8000);
      });
      const result = (async () => {
        response = await request(url, { timeout: 8000, headers: { Accept: 'application/json' } });
        if (expired) { response.destroy(); throw new Error('请求超时（8 秒）'); }
        if (response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); throw new Error(`请求返回 HTTP ${response.statusCode}`); }
        const raw = await readText(response, maxBytes);
        return repair ? repairImport(raw).config : JSON.parse(raw);
      })();
      return await Promise.race([result, deadline]);
    } finally {
      clearTimeout(timer);
      const next = waiting.shift();
      if (next) next();
      else activeRequests--;
    }
  }

  async function checkApi(source) {
    const start = now();
    let error = '';
    try {
      const url = validateUrl(source.api);
      for (const key of ['ac', 'wd', 'ids', 't', 'pg']) url.searchParams.delete(key);
      url.searchParams.set('ac', 'list');
      if (!validAppleCms(await jsonRequest(url, 4 * 1024 * 1024))) throw new Error('接口未返回有效的 AppleCMS list / class');
    } catch (cause) { error = errorText(cause); }
    return { api: source.api, status: error ? 'error' : 'ok', latencyMs: Math.max(0, now() - start), checkedAt: now(), error };
  }

  async function runProbe() {
    const sources = store.config().sources.filter(source => source.enabled !== false);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, sources.length) }, async () => {
      while (cursor < sources.length && !stopping) {
        const source = sources[cursor++];
        state.sources[source.id] = await checkApi(source);
      }
    }));
    if (!stopping) state.lastProbe = now();
    persist();
  }

  async function runUpdate() {
    const subscriptions = (store.config().subscriptions || []).filter(item => item.enabled !== false);
    for (const subscription of subscriptions) {
      if (stopping) break;
      const start = now();
      let previous = state.subscriptions[subscription.id]?.url === subscription.url ? state.subscriptions[subscription.id] : null;
      const owned = Object.assign(Object.create(null), previous?.owned || {});
      if (subscription.id === 'builtin-presets' && previous?.initialized !== true) {
        // 初始源缺失也保留删除记忆；已有自定义 API 与基线不一致时不会被接管。
        for (const source of initialSources) if (!Object.hasOwn(owned, source.id)) owned[source.id] = source.api;
        previous = { ...previous, url: subscription.url, owned, initialized: true };
        state.subscriptions[subscription.id] = previous;
        persist();
      }
      let added = 0;
      let updated = 0;
      let skipped = 0;
      let error = '';
      try {
        const body = await jsonRequest(subscription.url, 1024 * 1024, true);
        if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'api_site') && !Array.isArray(body.sources)) throw new Error('订阅必须包含可识别的影视源 JSON');
        const remote = importConfig(validateConfig(emptyConfig()), body).sources;
        const snapshot = store.config();
        const activeSubscription = (snapshot.subscriptions || []).find(item => item.id === subscription.id);
        if (!activeSubscription || activeSubscription.enabled === false || activeSubscription.url !== subscription.url) throw new Error('订阅已变更或停用，本次结果未应用');
        const canonical = api => api.replace(/\/+$/, '');
        const pendingCandidates = remote.filter(source => {
          const current = snapshot.sources.find(item => item.id === source.id);
          if (Object.hasOwn(owned, source.id)) return current && current.enabled !== false && current.api === owned[source.id] && current.api !== source.api;
          return !current && !snapshot.sources.some(item => canonical(item.api) === canonical(source.api));
        });
        const cursor = Number(previous?.discoveryCursor) || 0;
        const candidates = Array.from({ length: Math.min(20, pendingCandidates.length) }, (_, index) => pendingCandidates[(cursor + index) % pendingCandidates.length]);
        const checked = new Map();
        let next = 0;
        // shortcut: 每次订阅更新最多验证20个新地址，后续更新继续发现，避免大订阅占满NAS。
        await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
          while (!stopping && next < candidates.length) {
            const source = candidates[next++];
            checked.set(source.id, await checkApi(source));
          }
        }));
        const latest = store.config();
        const currentSubscription = (latest.subscriptions || []).find(item => item.id === subscription.id);
        if (!currentSubscription || currentSubscription.enabled === false || currentSubscription.url !== subscription.url) throw new Error('订阅已变更或停用，本次结果未应用');
        const sources = latest.sources.map(source => ({ ...source }));
        for (const source of remote) {
          const current = sources.find(item => item.id === source.id);
          if (!Object.hasOwn(owned, source.id)) {
            if (current || sources.length >= 200 || sources.some(item => canonical(item.api) === canonical(source.api)) || checked.get(source.id)?.status !== 'ok') { skipped++; continue; }
            sources.push(source); owned[source.id] = source.api; added++;
            state.sources[source.id] = checked.get(source.id);
          } else if (!current || current.enabled === false || current.api !== owned[source.id]) {
            skipped++;
          } else if (current.api !== source.api) {
            if (checked.get(source.id)?.status !== 'ok') { skipped++; continue; }
            current.api = source.api; owned[source.id] = source.api; updated++;
            state.sources[source.id] = checked.get(source.id);
          }
        }
        store.setConfig(validateConfig({ ...latest, sources }));
        previous = { ...previous, discoveryCursor: pendingCandidates.length ? (cursor + candidates.length) % pendingCandidates.length : 0 };
      } catch (cause) { error = errorText(cause); }
      state.subscriptions[subscription.id] = {
        url: subscription.url, status: error ? 'error' : 'ok', latencyMs: Math.max(0, now() - start), checkedAt: now(), error,
        owned: error ? previous?.owned || {} : owned, initialized: previous?.initialized === true,
        discoveryCursor: previous?.discoveryCursor || 0,
        added: error ? 0 : added, updated: error ? 0 : updated, skipped,
      };
    }
    if (!stopping) state.lastUpdate = now();
    persist();
  }

  function probe() {
    if (stopping) return Promise.resolve(status());
    if (!probeJob) probeJob = runProbe().finally(() => { probeJob = null; }).then(status);
    return probeJob;
  }

  function update() {
    if (stopping) return Promise.resolve(status());
    if (!updateJob) updateJob = runUpdate().finally(() => { updateJob = null; }).then(status);
    return updateJob;
  }

  function schedule(kind) {
    if (!started) return;
    const probeMode = kind === 'probe';
    const interval = probeMode ? PROBE_INTERVAL : UPDATE_INTERVAL;
    const last = probeMode ? state.lastProbe : state.lastUpdate;
    const delay = last ? Math.max(0, Math.min(interval, last + interval - now())) : 0;
    const timer = setTimeout(async () => {
      try { await (probeMode ? probe() : update()); }
      catch (error) { logger.error?.(`影视源${probeMode ? '探测' : '订阅更新'}失败：${errorText(error)}`); }
      finally { schedule(kind); }
    }, delay);
    timer.unref?.();
    if (probeMode) probeTimer = timer;
    else updateTimer = timer;
  }

  function start() {
    if (started) return;
    started = true; stopping = false;
    schedule('probe'); schedule('update');
  }

  async function stop() {
    started = false; stopping = true;
    clearTimeout(probeTimer); clearTimeout(updateTimer);
    await Promise.allSettled([probeJob, updateJob].filter(Boolean));
  }

  return { status, probe, update, verify: checkApi, start, stop };
}
