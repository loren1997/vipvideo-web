import { isIP } from 'node:net';
import { validateUrl, isPublicAddress } from './network.mjs';

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
  const raw = text(value, label, 4096, !allowEmpty);
  if (!raw && allowEmpty) return '';
  const url = validateUrl(raw.replaceAll('{url}', 'placeholder'));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw badRequest(`${label}不能使用内网地址`);
  return raw;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('配置必须是 JSON 对象');
  const result = {};
  for (const kind of ['sources', 'platforms', 'parsers']) {
    const entries = input[kind];
    if (!Array.isArray(entries) || entries.length > 200) throw badRequest(`${kind}必须是数组，且不超过 200 项`);
    const ids = new Set();
    result[kind] = entries.map((entry) => {
      if (!entry || typeof entry !== 'object') throw badRequest('配置项格式不正确');
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw badRequest('启用状态必须是布尔值');
      const id = text(entry.id, '标识');
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

export function importConfig(current, input) {
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
  const merged = {};
  for (const kind of ['sources', 'platforms', 'parsers']) {
    const rows = new Map(current[kind].map((row) => [row.id, row]));
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
  }
  return row;
}
