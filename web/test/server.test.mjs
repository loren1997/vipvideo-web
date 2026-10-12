import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const empty = { sources: [], platforms: [], parsers: [] };
const detail = { key: 'film', source: 'demo', id: '1', title: '测试影片', year: '2025', type: 'movie', poster: '', description: '简介',
  lines: [{ name: '线路', episodes: [{ name: '正片', url: 'https://media.example/video.m3u8?token=abc', type: 'hls' }] }] };
const catalog = { async search() { return { groups: [{ ...detail, items: [{ source: 'demo', id: '1' }] }], failedSources: [] }; },
  async detail() { return detail; } };

async function running(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-test-'));
  const app = createApp({ password: 'test-password', dataDir, initialConfig: empty, catalog, ...options });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = (path, body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {}) => fetch(base + path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async () => {
    const response = await call('/api/auth/login', { password: 'test-password' });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { app, call, login, dataDir, base };
}

test('authentication protects all data and proxy endpoints; logout revokes cookie', async (t) => {
  const { call, login } = await running(t);
  for (const path of ['/api/config', '/api/search?q=film', '/api/detail?source=demo&id=1', '/api/state', '/api/media?token=anything']) {
    assert.equal((await call(path)).status, 401);
  }
  assert.equal((await call('/health')).status, 200);
  assert.deepEqual(await (await call('/api/auth')).json(), { authenticated: false });
  const response = await call('/api/auth/login', { password: 'test-password' });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.doesNotMatch(header, /test-password/);
  const cookie = await login();
  assert.equal((await call('/api/config', undefined, cookie)).status, 200);
  assert.equal((await call('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await call('/api/config', undefined, cookie)).status, 401);
});

test('bad login is rate limited and foreign origins cannot mutate', async (t) => {
  const { call, login } = await running(t);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/login', { password: 'bad' })).status, 401);
  assert.equal((await call('/api/auth/login', { password: 'test-password' })).status, 429);
  // Login from another fresh instance avoids relying on the limiter's clock.
  const second = await running(t);
  const cookie = await second.login();
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await second.call('/api/config', empty, cookie, 'PUT')).status, 200);
});

test('config import is atomic; collections sync and last saved position wins', async (t) => {
  const { call, login } = await running(t);
  const cookie = await login();
  const valid = { config: { api_site: { demo: { name: '示例', api: 'https://example.com/api' } } } };
  assert.equal((await call('/api/config/import', valid, cookie)).status, 200);
  assert.equal((await call('/api/config/import', { config: { api_site: { demo: { name: '坏源', api: 'file:///secret' } } } }, cookie)).status, 400);
  assert.equal((await (await call('/api/config', undefined, cookie)).json()).sources[0].name, '示例');
  assert.equal((await call('/api/favorites', detail, cookie)).status, 200);
  assert.equal((await call('/api/history', { ...detail, position: 90, duration: 100 }, cookie)).status, 200);
  assert.equal((await call('/api/history', { ...detail, position: 20, duration: 100 }, cookie)).status, 200);
  let state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.favorites.length, 1); assert.equal(state.history[0].position, 20);
  assert.equal((await call('/api/history', { key: 'link:https://example.org/', title: '解析网页', url: 'https://example.org/', mode: 'parser' }, cookie)).status, 200);
  assert.equal((await call('/api/history?key=film', undefined, cookie, 'DELETE')).status, 200);
  state = await (await call('/api/state', undefined, cookie)).json();
  assert.equal(state.history.length, 1); assert.equal(state.history[0].mode, 'parser');
});

test('SQLite survives close/reopen; changed password revokes previous sessions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'vipvideo-persist-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = createApp({ password: 'original-password', dataDir, initialConfig: empty });
  first.store.save('history', { key: 'film', title: '持久化', position: 40 });
  first.store.setConfig({ ...empty, sources: [{ id: 'demo', name: '示例', api: 'https://example.com', enabled: true }] });
  first.store.session('old-token', Date.now() + 60_000);
  await first.close();
  const reopened = createApp({ password: 'original-password', dataDir, initialConfig: empty });
  assert.equal(reopened.store.list('history')[0].position, 40);
  assert.equal(reopened.store.config().sources[0].id, 'demo');
  assert.equal(reopened.store.authenticated('old-token'), true);
  await reopened.close();
  const rotated = createApp({ password: 'changed-password', dataDir, initialConfig: empty });
  assert.equal(rotated.store.authenticated('old-token'), false);
  assert.equal(rotated.store.list('history').length, 1);
  await rotated.close();
});

test('playback accepts only an episode selection, not a free proxy URL', async (t) => {
  const { call, login } = await running(t);
  const cookie = await login();
  const response = await call('/api/playback?source=demo&id=1&line=0&episode=0', undefined, cookie);
  assert.equal(response.status, 200);
  assert.match((await response.json()).proxyUrl, /^\/api\/media\?token=/);
  assert.equal((await call('/api/playback?source=demo&id=1&line=-1', undefined, cookie)).status, 400);
  assert.equal((await call('/api/media?url=https://example.com', undefined, cookie)).status, 403);
});
