import { createHash } from 'node:crypto';
import { validateUrl } from './network.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });

export function repairAddress(input) {
  if (typeof input !== 'string' || input.length > 4096) throw invalid('地址格式不正确');
  let value = input.trim();
  const fence = /^```(?:url|text|plaintext)?\s*\n([\s\S]*?)\n?```$/i.exec(value);
  if (fence) value = fence[1].trim();
  const markdown = /^\[[^\]]*\]\(([^\s)]+)\)$/.exec(value);
  if (markdown) value = markdown[1];
  value = value.replace(/^`+|`+$/g, '').replace(/^<(.*)>$/, '$1').replace(/^(["'])(.*)\1$/, '$2');
  value = value.replace(/^(https?)\\?[:：]\\?\/\\?\//i, '$1://').replace(/&amp;/gi, '&');
  if (value.startsWith('//')) value = 'https:' + value;
  else if (/^(?:[a-z\d-]+\.)+[a-z\d-]+(?::\d+)?(?:[/?#]|$)/i.test(value)) value = 'https://' + value;
  const parsed = validateUrl(value.replaceAll('{url}', 'placeholder'));
  if (parsed.hostname === 'github.com') {
    const match = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/(?:blob|raw)\/([^?#]+)([?#][\s\S]*)?$/i.exec(value);
    if (match) value = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}${match[4] || ''}`;
  }
  validateUrl(value.replaceAll('{url}', 'placeholder'));
  return value;
}

function jsonWithoutComments(value) {
  let output = '', quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === '/' && value[index + 1] === '/') {
      while (index + 1 < value.length && !/[\r\n]/.test(value[index + 1])) index++;
      output += ' ';
    } else if (char === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) throw invalid('JSON 注释没有结束');
      index = end + 1; output += ' ';
    } else output += char;
  }
  let cleaned = ''; quoted = false; escaped = false;
  for (let index = 0; index < output.length; index++) {
    const char = output[index];
    if (quoted) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cleaned += char; }
    else if (char === ',') {
      let next = index + 1;
      while (next < output.length && /\s/.test(output[next])) next++;
      if (output[next] !== '}' && output[next] !== ']') cleaned += char;
    } else cleaned += char;
  }
  return cleaned;
}

export function repairImport(input) {
  const warnings = [];
  if (typeof input === 'string') {
    if (input.length > 1024 * 1024) throw invalid('导入内容不能超过 1 MB');
    const raw = input.trim().replace(/^```(?:jsonc?)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
    try { input = JSON.parse(raw); }
    catch {
      try { input = JSON.parse(jsonWithoutComments(raw)); warnings.push('已移除 JSON 注释或尾逗号'); }
      catch { throw invalid('导入内容不是有效 JSON'); }
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('导入内容必须是 JSON 对象');
  const entry = (row, id) => {
    if (typeof row === 'string') row = { name: id, api: row };
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('影视源配置项格式不正确');
    const api = repairAddress(row.api ?? row.url ?? row.baseUrl);
    const name = row.name ?? row.title ?? id;
    if (typeof name !== 'string') throw invalid('影视源名称格式不正确');
    if ((row.api ?? row.url ?? row.baseUrl) !== api) warnings.push(`${name}：已修正地址格式`);
    return { ...row, name, api };
  };
  const identifier = row => row.id ?? row.key ?? ('import-' + createHash('sha256').update(String(row.api ?? row.url ?? row.baseUrl)).digest('hex').slice(0, 16));
  const uniqueMap = rows => {
    const ids = new Set();
    for (const [id] of rows) {
      if (ids.has(String(id))) throw invalid('影视源标识重复，未导入以避免覆盖');
      ids.add(String(id));
    }
    return Object.fromEntries(rows);
  };
  let config = { ...input };
  if (Object.hasOwn(input, 'api_site')) {
    const entries = input.api_site;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) && !entries.length) throw invalid('api_site 格式不正确');
    if (Array.isArray(entries)) {
      if (entries.length > 200 || entries.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw invalid('api_site 必须是最多 200 项的对象数组');
      config.api_site = uniqueMap(entries.map(row => { const id = identifier(row); return [id, entry(row, id)]; }));
      warnings.push('已将 api_site 数组转换为按标识索引的对象');
    } else config.api_site = Object.fromEntries(Object.entries(entries).map(([id, row]) => [id, entry(row, id)]));
  } else if (Object.hasOwn(input, 'sites')) {
    if (!Array.isArray(input.sites) || input.sites.length > 200) throw invalid('sites 必须是最多 200 项的数组');
    const rows = [];
    for (const row of input.sites) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('sites 配置项格式不正确');
      if (![undefined, 1, '1'].includes(row.type) || typeof row.api !== 'string' || /^csp_|\.jar(?:$|\?)/i.test(row.api)) {
        warnings.push(`${String(row.name || row.key || '未知项').slice(0, 100)}：未导入不兼容的 XML、脚本或爬虫接口`); continue;
      }
      const id = identifier(row); rows.push([id, entry(row, id)]);
    }
    if (input.sites.length && !rows.length) throw invalid('没有可转换的 AppleCMS JSON 接口，脚本和 XML 接口不兼容');
    config = { api_site: uniqueMap(rows) };
    warnings.push('已将兼容的 sites 接口转换为 api_site');
  } else if (Object.hasOwn(input, 'sources') && Array.isArray(input.sources) && input.platforms === undefined && input.parsers === undefined) {
    if (input.sources.length > 200) throw invalid('sources 不能超过 200 项');
    config = { ...input, platforms: [], parsers: [], sources: input.sources.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('sources 配置项格式不正确');
      const id = identifier(row); return { ...entry(row, id), id };
    }) };
    warnings.push('已补全影视源配置所需的空平台与解析线路字段');
  }
  return { config, warnings: warnings.slice(0, 200) };
}
