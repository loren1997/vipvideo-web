const regionNames = new Map();
const regions = ['zh-CN', 'zh-Hant', 'en'].map(locale => new Intl.DisplayNames(locale, { type: 'region', fallback: 'none' }));
const display = { CN: '中国大陆', HK: '中国香港', TW: '中国台湾', MO: '中国澳门' };
for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const last of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  const code = first + last, name = regions[0].of(code);
  if (!name || code === 'ZZ') continue;
  const canonical = display[code] || name;
  for (const alias of [code, canonical, ...regions.map(region => region.of(code))]) {
    if (alias) regionNames.set(alias.toLowerCase(), canonical);
  }
}
for (const [code, aliases] of Object.entries({
  CN: ['大陆', '大陸', '内地', '內地', '中国内地', '中國大陸', 'Mainland China', 'PRC'],
  HK: ['香港', 'Hong Kong'], TW: ['台湾', '臺灣', '台灣'], MO: ['澳门', '澳門', 'Macau', 'Macao'],
  US: ['美国', 'USA', 'U.S.', 'U.S.A.', 'United States of America'], GB: ['英国', 'UK', 'U.K.', 'Britain'],
  KR: ['韩国', '南韩', '南韓', 'Korea'], RU: ['俄国'], VN: ['Vietnam'],
})) for (const alias of aliases) regionNames.set(alias.toLowerCase(), regionNames.get(code.toLowerCase()));

export function validCountryFilter(value) {
  return typeof value === 'string' && (!value || regionNames.has(value.toLowerCase()));
}

export function normalizeCountries(value) {
  const names = new Set();
  for (const field of (Array.isArray(value) ? value : [value]).slice(0, 32)) {
    const raw = typeof field === 'string' ? field : field?.iso_3166_1 || field?.name;
    if (typeof raw !== 'string') continue;
    for (const token of raw.slice(0, 512).normalize('NFKC').toLowerCase().split(/[,;、/|]+/)) {
      const key = token.trim();
      if (regionNames.has(key)) names.add(regionNames.get(key));
      else for (const part of key.split(/\s+/)) if (regionNames.has(part)) names.add(regionNames.get(part));
    }
  }
  return [...names];
}

export function hasNetflixLabel(...fields) {
  return fields.some(field => (Array.isArray(field) ? field : [field]).slice(0, 64).some(item => {
    const label = typeof item === 'string' ? item : item?.provider_name || item?.name;
    return typeof label === 'string' && label.slice(0, 1024).normalize('NFKC').split(/[,;、/|]+/).some(tag =>
      /^(?:netflix|奈飞|奈飛|网飞|網飛)(?:\s*(?:originals?|原创|原創|出品|独家|獨家|电影|電影|剧集|劇集))?$/i.test(tag.trim()));
  }));
}
