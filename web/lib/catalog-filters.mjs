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

const languageAliases = new Map(Object.entries({
  zh: ['cn', 'cmn', 'yue', 'zho', 'chi', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-mo', 'zh-sg', 'zh-hans', 'zh-hant',
    '中文', '华语', '華語', '汉语', '漢語', '国语', '國語', '普通话', '普通話', '汉语普通话', '漢語普通話',
    '粤语', '粵語', '广东话', '廣東話', '广州话', '廣州話', 'chinese', 'mandarin', 'cantonese', 'mandarin chinese', 'cantonese chinese'],
  en: ['eng', '英语', '英語', '英文', 'english'],
  ja: ['jpn', '日语', '日語', '日文', 'japanese'],
  ko: ['kor', '韩语', '韓語', '韩文', '韓文', '朝鲜语', '朝鮮語', 'korean'],
  fr: ['fra', 'fre', '法语', '法語', '法文', 'french'],
  de: ['deu', 'ger', '德语', '德語', '德文', 'german'],
  es: ['spa', '西班牙语', '西班牙語', 'spanish'],
  it: ['ita', '意大利语', '意大利語', '義大利語', 'italian'],
  pt: ['por', '葡萄牙语', '葡萄牙語', 'portuguese'],
  ru: ['rus', '俄语', '俄語', '俄文', 'russian'],
  ar: ['ara', '阿拉伯语', '阿拉伯語', 'arabic'],
  hi: ['hin', '印地语', '印地語', 'hindi'],
  th: ['tha', '泰语', '泰語', '泰文', 'thai'],
  vi: ['vie', '越南语', '越南語', 'vietnamese'],
  id: ['ind', '印度尼西亚语', '印度尼西亞語', '印尼语', '印尼語', 'indonesian'],
  ms: ['msa', 'may', '马来语', '馬來語', 'malay'],
  tr: ['tur', '土耳其语', '土耳其語', 'turkish'],
  fa: ['fas', 'per', '波斯语', '波斯語', 'persian'],
  he: ['heb', '希伯来语', '希伯來語', 'hebrew'],
  nl: ['nld', 'dut', '荷兰语', '荷蘭語', 'dutch'],
  sv: ['swe', '瑞典语', '瑞典語', 'swedish'],
  da: ['dan', '丹麦语', '丹麥語', 'danish'],
  no: ['nor', '挪威语', '挪威語', 'norwegian'],
  fi: ['fin', '芬兰语', '芬蘭語', 'finnish'],
  pl: ['pol', '波兰语', '波蘭語', 'polish'],
  uk: ['ukr', '乌克兰语', '烏克蘭語', 'ukrainian'],
}).flatMap(([code, aliases]) => aliases.map(alias => [alias, code])));
const unknownLanguages = new Set(['all', 'und', 'mul', 'mis', 'zxx', 'unk', 'xx', 'zz']);

export function catalogLanguage(value) {
  if (typeof value !== 'string' || value.length > 80) return '';
  const label = value.normalize('NFKC').trim().toLowerCase();
  return languageAliases.get(label) || (/^[a-z]{2,3}$/.test(label) && !unknownLanguages.has(label) ? label : '');
}

export function hasNetflixLabel(...fields) {
  return fields.some(field => (Array.isArray(field) ? field : [field]).slice(0, 64).some(item => {
    const label = typeof item === 'string' ? item : item?.provider_name || item?.name;
    return typeof label === 'string' && label.slice(0, 1024).normalize('NFKC').split(/[,;、/|]+/).some(tag =>
      /^(?:netflix|奈飞|奈飛|网飞|網飛)(?:\s*(?:originals?|原创|原創|出品|独家|獨家|电影|電影|剧集|劇集))?$/i.test(tag.trim()));
  }));
}
