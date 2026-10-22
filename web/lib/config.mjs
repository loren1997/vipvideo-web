import { isIP } from 'node:net';
import { validateUrl, isPublicAddress } from './network.mjs';
import { repairAddress, repairImport } from './import-repair.mjs';

export function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function text(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw badRequest(`${label}格式不正确`);
  }
  return value.trim();
}

function address(value, label, allowEmpty = false) {
  const original = text(value, label, 4096, !allowEmpty);
  if (!original && allowEmpty) return '';
  const raw = repairAddress(original);
  const url = validateUrl(raw.replaceAll('{url}', 'placeholder'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw badRequest(`${label}不能使用内网地址`);
  return raw;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('配置必须是 JSON 对象');
  if (input.showAdult !== undefined && typeof input.showAdult !== 'boolean') throw badRequest('三级分类显示设置必须是布尔值');
  const result = { showAdult: input.showAdult === true };
  for (const kind of ['sources', 'platforms', 'parsers', 'subscriptions', 'liveSources']) {
    const optional = kind === 'subscriptions' || kind === 'liveSources';
    const entries = input[kind] === undefined ? (optional ? [] : undefined) : input[kind];
    const limit = optional ? 20 : 200;
    if (!Array.isArray(entries) || entries.length > limit) throw badRequest(`${kind}必须是数组，且不超过 ${limit} 项`);
    const ids = new Set();
    result[kind] = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') throw badRequest('配置项格式不正确');
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw badRequest('启用状态必须是布尔值');
      const id = text(entry.id, '标识');
      if (['__proto__', 'constructor', 'prototype'].includes(id)) throw badRequest('标识不能使用保留名称');
      if (ids.has(id)) throw badRequest(`重复标识：${id}`);
      ids.add(id);
      const row = { id, name: text(entry.name, '名称'), enabled: entry.enabled !== false };
      if (kind === 'sources') row.api = address(entry.api, '资源 API');
      else row.url = address(entry.url, '地址', kind === 'parsers');
      if (kind === 'platforms') row.category = text(entry.category ?? 'video', '分类', 100);
      return row;
    });
  }
  return result;
}

export function validatePlayerPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('播放偏好格式不正确');
  const row = { key: text(input.key, '影片标识', 8192) };
  for (const field of ['introSeconds', 'outroSeconds']) {
    const value = input[field] === undefined ? 0 : input[field];
    if (!Number.isInteger(value) || value < 0 || value > 600) throw badRequest('片头片尾秒数必须为 0–600 的整数');
    row[field] = value;
  }
  for (const field of ['autoNext', 'danmakuEnabled']) {
    const value = input[field] === undefined ? true : input[field];
    if (typeof value !== 'boolean') throw badRequest('播放开关必须是布尔值');
    row[field] = value;
  }
  row.danmakuRows = input.danmakuRows === undefined ? 1 : input.danmakuRows;
  if (!Number.isInteger(row.danmakuRows) || row.danmakuRows < 1 || row.danmakuRows > 10) throw badRequest('弹幕行数必须为 1–10 的整数');
  row.skipAds = input.skipAds === undefined ? false : input.skipAds;
  if (typeof row.skipAds !== 'boolean') throw badRequest('广告跳过开关必须是布尔值');
  const ranges = input.adRanges === undefined ? [] : input.adRanges;
  if (!Array.isArray(ranges) || ranges.length > 20) throw badRequest('广告时段必须是数组，且不超过 20 个');
  row.adRanges = ranges.map(range => {
    if (!range || typeof range !== 'object' || Array.isArray(range)) throw badRequest('广告时段格式不正确');
    const scope = text(range.scope, '广告版本和剧集标识', 4096);
    const { start, end } = range;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 86400 || end <= start || end - start > 600) throw badRequest('广告时段必须为有效秒数，每段不超过 600 秒');
    return { scope, start, end };
  });
  row.speed = input.speed === undefined ? 1 : input.speed;
  if (![0.5, 0.75, 1, 1.25, 1.5, 2, 3].includes(row.speed)) throw badRequest('播放速度不受支持');
  return row;
}

export function importConfig(current, input) {
  input = repairImport(input).config;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('导入内容必须是 JSON 对象');
  let incoming;
  if (Object.hasOwn(input, 'api_site')) {
    if (!input.api_site || typeof input.api_site !== 'object' || Array.isArray(input.api_site)) throw badRequest('api_site 格式不正确');
    incoming = {
      platforms: [], parsers: [],
      sources: Object.entries(input.api_site).map(([id, row]) => ({ ...row, id, enabled: true })),
    };
  } else if (Object.hasOwn(input, 'platformlist') || Object.hasOwn(input, 'list')) {
    if ((input.platformlist !== undefined && !Array.isArray(input.platformlist)) || (input.list !== undefined && !Array.isArray(input.list))) {
      throw badRequest('VipVideo 平台和线路配置必须是数组');
    }
    incoming = {
      sources: [],
      platforms: (input.platformlist ?? []).map((row, i) => ({ ...row, id: `vip-platform-${i}` })),
      parsers: (input.list ?? []).map((row, i) => ({ ...row, id: `vip-parser-${i}` })),
    };
  } else incoming = input;
  const validated = validateConfig(incoming);
  const merged = { showAdult: Object.hasOwn(incoming, 'showAdult') ? validated.showAdult : current.showAdult === true };
  for (const kind of ['sources', 'platforms', 'parsers', 'subscriptions', 'liveSources']) {
    const rows = new Map((current[kind] ?? []).map((row) => [row.id, row]));
    for (const row of validated[kind]) rows.set(row.id, row);
    merged[kind] = [...rows.values()];
  }
  return validateConfig(merged);
}

export function validateRecord(input, history = false) {
  if (!input || typeof input !== 'object') throw badRequest('记录格式不正确');
  const row = {
    key: text(input.key, '影片标识', 8192),
    title: text(input.title, '影片名称', 500),
    source: text(input.source ?? '', '资源标识', 200, false),
    id: text(String(input.id ?? ''), '影片 ID', 200, false),
    year: text(String(input.year ?? ''), '年份', 30, false),
    type: ['movie', 'series', 'link'].includes(input.type) ? input.type : 'link',
    poster: input.poster ? address(input.poster, '海报') : '',
  };
  if (input.category !== undefined) {
    if (!['movie', 'tv', 'anime', 'adult', 'variety'].includes(input.category)) throw badRequest('影片分类格式不正确');
    row.category = input.category;
  }
  if (input.url) row.url = address(input.url, '播放链接');
  if (history) {
    row.mode = input.mode === 'parser' ? 'parser' : 'direct';
    for (const field of ['line', 'episode', 'position', 'duration']) {
      const number = input[field] ?? 0;
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1e9) throw badRequest('播放进度格式不正确');
      if ((field === 'line' || field === 'episode') && !Number.isInteger(number)) throw badRequest('集数必须是整数');
      row[field] = number;
    }
    if (row.duration > 0) row.position = Math.min(row.position, row.duration);
    if (input.parser) row.parser = text(input.parser, '解析线路', 200);
    if (input.episodeName) row.episodeName = text(input.episodeName, '剧集名称', 200);
    if (input.quarkAsset !== undefined) {
      if (row.source !== 'quark-library' || typeof input.quarkAsset !== 'string' || !/^[a-f0-9]{32}$/.test(input.quarkAsset)) throw badRequest('夸克观看记录标识无效');
      row.quarkAsset = input.quarkAsset;
    }
  }
  return row;
}
