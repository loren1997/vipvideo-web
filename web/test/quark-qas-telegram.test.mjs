import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createQuarkQasTelegramSearch } from '../lib/quark-qas-telegram.mjs';

const tokenFile = '/run/secrets/qas-telegram-token';
const token = 'a'.repeat(64);
const share = 'https://pan.quark.cn/s/example001';

function fixture(result, code = 200, secret = token) {
  const calls = [];
  const adapter = createQuarkQasTelegramSearch({ tokenFile, now: () => 10000,
    readToken: async path => { assert.equal(path, tokenFile); return secret; },
    request: (url, options, respond) => {
      const outgoing = new EventEmitter();
      outgoing.end = body => {
        calls.push({ url, options, body: JSON.parse(body) });
        respond(Object.assign(Readable.from([JSON.stringify(result)]), { statusCode: code, headers: {} }));
      };
      return outgoing;
    },
  });
  return { adapter, calls };
}

test('QAS search sends one bounded direct request to the archived search endpoint and drops private message fields', async () => {
  const f = fixture({ success: true, partial: true, data: { scope: 'archived', authorized: true }, results: [
    { source_type: 'telegram_web', title: ' 示例电影 ', url: share, datetime: 1700000000, source_url: 'private', content: 'private' },
    { source_type: 'other', title: '其他来源', url: share },
  ] });
  const rows = await f.adapter(' 示例电影 ', { deadline: 20000 });
  assert.deepEqual([...rows], [{ name: '示例电影', url: share, publishedAt: 1700000000 }]);
  assert.match(rows.reason, /部分/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://telegram-web:8765/search');
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(f.calls[0].options.agent, false);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer ' + token);
  assert.deepEqual(f.calls[0].body, { query: '示例电影', limit: 20, timeout: 9 });
});

test('QAS search rejects invalid credentials, redirects and non-archive results', async () => {
  assert.equal(createQuarkQasTelegramSearch({ tokenFile: '' }), undefined);
  const invalid = fixture({}, 200, 'bad-token');
  assert.match((await invalid.adapter('示例')).reason, /认证文件无效/);
  assert.equal(invalid.calls.length, 0);
  const redirect = fixture({ location: 'https://external.example' }, 302);
  assert.equal((await redirect.adapter('示例')).length, 0);
  assert.equal(redirect.calls.length, 1);
  const foreign = fixture({ success: true, data: { scope: 'unrestricted', authorized: true } });
  assert.match((await foreign.adapter('示例')).reason, /格式不正确/);
  const loggedOut = fixture({ success: false, data: { scope: 'archived', authorized: false }, code: 'AUTH_REQUIRED' });
  assert.match((await loggedOut.adapter('示例')).reason, /重新登录/);
});
