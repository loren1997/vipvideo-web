import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createTranscoder } from '../lib/transcode.mjs';
import { createMedia } from '../lib/media.mjs';

const url = 'https://movies.example/feature.m3u8?access=neutral';
const episode = { url, type: 'hls' };
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment000000.ts\n';
const inputManifest = '#EXTM3U\n#EXTINF:2,\nsegment.ts?token=neutral\n#EXT-X-ENDLIST\n';
const statusError = status => error => error.status === status;
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vipvideo-transcode-test-'));
  const device = options.gpu ? join(root, 'gpu') : options.device || join(root, 'missing-gpu');
  if (options.gpu) await writeFile(device, 'device');
  const calls = [], requests = [], logs = [], children = [];
  const files = options.files || new Map([[url, [inputManifest, 'application/vnd.apple.mpegurl']], ['https://movies.example/segment.ts?token=neutral', [Buffer.alloc(752, 0x47), 'video/mp2t']]]);
  const media = options.media || createMedia({ secret: Buffer.alloc(32, 7), request: async (target, requestOptions) => {
    requests.push({ url: String(target), ...requestOptions });
    const [body, contentType] = files.get(String(target)) || ['not found', 'text/plain'];
    return Object.assign(Readable.from([body]), { statusCode: files.has(String(target)) ? 200 : 404, headers: { 'content-type': contentType }, finalUrl: String(target) });
  } });
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.windowsHide, true);
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.signals = []; children.push(child);
    child.exit = code => { if (child.finished) return; child.finished = true; child.emit('exit', code); };
    child.kill = signal => { child.signals.push(signal); if (!options.ignoreKill || signal === 'SIGKILL') queueMicrotask(() => child.exit(0)); return true; };
    setImmediate(async () => {
      try {
        if (args[0] === '-version') {
          if (options.missing) child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
          else if (!options.hungVersion) child.exit(0);
          return;
        }
        if (options.run) { await options.run({ child, args, write: () => output(args), input: args[args.indexOf('-i') + 1] }); return; }
        await output(args);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  async function output(args) {
    const dir = join(args.at(-1), '..');
    await writeFile(join(dir, 'segment000000.ts'), Buffer.alloc(752, 0x47));
    await writeFile(args.at(-1), manifest);
  }
  const service = createTranscoder({ media, spawn, tmpRoot: root, device, env: { TRANSCODE_ACCEL: 'software', ...options.env }, startupTimeout: 1000, pollInterval: 5, killTimeout: 10, probeTimeout: 30, idleTimeout: 5000, logger: { error: (...args) => logs.push(args.join(' ')) }, ...options.di });
  return { service, root, calls, requests, logs, children, async close() {
    await service.close(); const target = resolve(root), base = resolve(tmpdir());
    assert.ok(target.startsWith(base + sep) && target.split(sep).at(-1).startsWith('vipvideo-transcode-test-'));
    await rm(root, { recursive: true, force: true });
  } };
}
const start = (service, overrides = {}) => service.start({ episode, position: 0, speed: 1, owner: 'device-a', valid: () => true, ...overrides });
async function assetServer(service, id) {
  const server = createServer(async (req, res) => {
    try { await service.serve(req, res, id, decodeURIComponent(req.url.slice(1))); }
    catch (error) { if (!res.headersSent) { res.statusCode = error.status || 500; res.end(error.message); } else res.destroy(error); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

test('factory and unused close have no FFmpeg or HTTP side effects and allow media fixture without serve', async () => {
  let calls = 0;
  const service = createTranscoder({ media: { playback() {} }, spawn() { calls++; } });
  await service.close(); assert.equal(calls, 0);
});

test('lazy availability is shared, disabled mode never starts a process, and missing binary reports a friendly error', async () => {
  const f = await fixture();
  try { assert.equal(f.calls.length, 0); const [a, b] = await Promise.all([f.service.status(), f.service.status()]); assert.equal(a.available, true); assert.deepEqual(a, b); assert.equal(f.calls.length, 1); }
  finally { await f.close(); }
  const disabled = await fixture({ env: { TRANSCODE_ENABLED: 'false' } });
  try { assert.equal((await disabled.service.status()).enabled, false); await assert.rejects(start(disabled.service), statusError(503)); assert.equal(disabled.calls.length, 0); }
  finally { await disabled.close(); }
  const missing = await fixture({ missing: true });
  try { const result = await missing.service.status(); assert.equal(result.available, false); assert.match(result.error, /FFmpeg/); await assert.rejects(start(missing.service), statusError(503)); assert.equal(missing.calls.length, 1); }
  finally { await missing.close(); }
});

test('software output uses a private bridge, bounded HLS window, two threads and unmodified playback timestamps', async () => {
  const f = await fixture({ env: { FFMPEG_PATH: 'custom-ffmpeg' }, run: async ({ child, args, write }) => { child.stderr.write('Duration: 00:01:'); child.stderr.write('30.50, start: 0\n'); await write(); } });
  try {
    const result = await start(f.service, { position: 12.5, speed: 1.5 });
    assert.equal(result.duration, 90.5); assert.equal(result.startPosition, 12.5); assert.equal(result.acceleration, 'software'); assert.equal(result.transcoded, true); assert.match(result.url, /^\/api\/transcode\/[a-f0-9]{32}\/index\.m3u8$/);
    const { command, args } = f.calls[1]; assert.equal(command, 'custom-ffmpeg'); assert.equal(args[args.indexOf('-readrate') + 1], '1.5'); assert.equal(args[args.indexOf('-ss') + 1], '12.5'); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp,crypto'); assert.match(args[args.indexOf('-i') + 1], /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/asset\.m3u8\?token=/); assert.equal(args.includes(url), false);
    assert.equal(args[args.indexOf('-hls_time') + 1], '2'); assert.equal(args[args.indexOf('-hls_list_size') + 1], '30'); assert.equal(args[args.indexOf('-hls_flags') + 1], 'delete_segments+temp_file'); assert.ok(args.includes('libx264')); assert.ok(args.includes('aac')); assert.equal(args.includes('-atempo'), false); assert.equal(args.some(value => value.includes('setpts')), false); assert.equal((await f.service.status()).running, true);
    assert.equal(args[args.indexOf('-r') + 1], '30'); assert.equal(args[args.indexOf('-maxrate') + 1], '3500k'); assert.equal(args[args.indexOf('-bufsize') + 1], '7000k');
  } finally { await f.close(); }
});

test('bridge rewrites master, AES key, map and segment links to its own origin and forwards only signed media requests', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nsub/child.m3u8\n';
  const child = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nchunk.m4s?auth=a%24b\n';
  const files = new Map([[url, [master, 'application/vnd.apple.mpegurl']], ['https://movies.example/sub/child.m3u8', [child, 'application/vnd.apple.mpegurl']], ['https://cdn.example/key', [Buffer.alloc(16), 'application/octet-stream']], ['https://movies.example/sub/init.mp4', [Buffer.alloc(10), 'video/mp4']], ['https://movies.example/sub/chunk.m4s?auth=a%24b', [Buffer.alloc(10), 'video/mp4']]]);
  let bridgeOrigin;
  const f = await fixture({ files, run: async ({ input, write }) => {
    bridgeOrigin = new URL(input).origin;
    const masterText = await (await fetch(input)).text(); const childUrl = masterText.split('\n').find(line => line && !line.startsWith('#'));
    assert.equal(new URL(childUrl).origin, bridgeOrigin); assert.match(new URL(childUrl).pathname, /\.m3u8$/);
    const text = await (await fetch(childUrl)).text(); const assets = [...text.matchAll(/URI="([^"]+)"/g)].map(value => value[1]).concat(text.split('\n').filter(line => line && !line.startsWith('#')));
    for (const target of assets) { assert.equal(new URL(target).origin, bridgeOrigin); assert.equal((await fetch(target)).status, 200); }
    assert.match(text, /asset\.mp4\?token=/); assert.match(text, /asset\.m4s\?token=/); await write();
  } });
  try {
    await start(f.service); assert.equal(f.requests.length, 5);
    for (const suffix of ['/api/media?url=https://other.example/movie.mp4', '/arbitrary', '/api/media/asset.ts?token=invalid&url=https://other.example']) assert.equal((await fetch(bridgeOrigin + suffix)).status, 403);
    assert.equal(f.requests.length, 5);
  } finally { await f.close(); }
  await assert.rejects(fetch(bridgeOrigin + '/arbitrary'));
});

test('unsafe or unquoted manifest links and upstream Location headers cannot escape the bridge', async () => {
  for (const body of ['#EXTM3U\nhttps://attacker.example/segment.ts\n', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=http://127.0.0.1/private\n']) {
    let status;
    const real = createMedia({ secret: Buffer.alloc(32), request() {} });
    const media = { playback: (...args) => real.playback(...args), async serve(_req, res) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(body); } };
    const f = await fixture({ media, run: async ({ input, write }) => { status = (await fetch(input)).status; await write(); } });
    try { await start(f.service); assert.equal(status, 502); } finally { await f.close(); }
  }
  const real = createMedia({ secret: Buffer.alloc(32), request() {} }); let status;
  const f = await fixture({ media: { playback: (...args) => real.playback(...args), async serve(_req, res) { res.setHeader('Location', 'https://attacker.example/'); res.end(); } }, run: async ({ input, write }) => { const response = await fetch(input, { redirect: 'manual' }); status = response.status; assert.equal(response.headers.get('location'), null); await write(); } });
  try { await start(f.service); assert.equal(status, 502); } finally { await f.close(); }
});

test('private inputs, unsupported formats, invalid speed/position/owner and stale validity never spawn FFmpeg', async () => {
  const f = await fixture();
  try {
    for (const overrides of [{ episode: { url: 'http://127.0.0.1/a.mp4', type: 'mp4' } }, { episode: { url: 'file:///tmp/a.mp4', type: 'mp4' } }, { episode: { url, type: 'page' } }, { speed: 4 }, { position: -1 }, { position: Infinity }, { owner: '' }, { valid: null }]) await assert.rejects(start(f.service, overrides));
    await assert.rejects(start(f.service, { valid: () => false }), statusError(409)); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('single-task ownership rejects other devices and a same-device seek stops and removes the previous task', async () => {
  const f = await fixture();
  try {
    const first = await start(f.service); const firstDir = join(f.calls[1].args.at(-1), '..');
    await assert.rejects(start(f.service, { owner: 'device-b' }), statusError(409)); await assert.rejects(f.service.cancel(first.id, 'device-b'), statusError(403));
    const second = await start(f.service, { position: 45 }); assert.notEqual(first.id, second.id); assert.equal(second.startPosition, 45); assert.ok(f.children[1].signals.includes('SIGTERM')); await assert.rejects(readFile(join(firstDir, 'index.m3u8')));
    assert.equal(await f.service.cancel(first.id, 'device-a'), false); assert.equal(await f.service.cancel(second.id, 'device-a'), true); assert.equal((await f.service.status()).running, false); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('hardware failure before its first segment falls back once to software within the startup deadline', async () => {
  const hardware = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto' }, run: async ({ child, args, write }) => { if (args.includes('h264_vaapi')) { child.stderr.write('hardware rejected https://secret.example/video?token=hidden'); child.exit(1); } else await write(); } });
  try { const result = await start(hardware.service); assert.equal(result.acceleration, 'software'); assert.equal(hardware.calls.length, 3); assert.ok(hardware.calls[1].args.includes('h264_vaapi')); assert.ok(hardware.calls[2].args.includes('libx264')); }
  finally { await hardware.close(); }
});

test('VAAPI uses hardware frames and bounded VBR while an absent device selects software directly', async () => {
  const hardware = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto' } });
  try {
    assert.equal((await start(hardware.service)).acceleration, 'vaapi');
    const args = hardware.calls[1].args;
    assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi'); assert.equal(args[args.indexOf('-hwaccel_output_format') + 1], 'vaapi'); assert.match(args[args.indexOf('-vf') + 1], /^scale_vaapi=.*format=nv12$/); assert.equal(args[args.indexOf('-rc_mode') + 1], 'VBR'); assert.equal(args.includes('-qp'), false); assert.equal(args.includes('-crf'), false); assert.equal(args.includes('-preset'), false);
  } finally { await hardware.close(); }
  const software = await fixture({ env: { TRANSCODE_ACCEL: 'auto' } });
  try { assert.equal((await start(software.service)).acceleration, 'software'); assert.equal(software.calls.length, 2); assert.equal(software.calls[1].args.includes('-hwaccel'), false); }
  finally { await software.close(); }
});

test('a hardware attempt that has already produced a segment never restarts encoding with software', async () => {
  const f = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto' }, run: async ({ child, args }) => { await writeFile(join(args.at(-1), '..', 'segment000000.ts'), Buffer.alloc(188)); child.exit(1); } });
  try { await assert.rejects(start(f.service), statusError(502)); assert.equal(f.calls.length, 2); assert.deepEqual(await readdir(f.root), ['gpu']); }
  finally { await f.close(); }
});

test('overlapping same-owner starts supersede safely while a different pending owner is rejected', async () => {
  const f = await fixture();
  try {
    const first = start(f.service).then(() => 'unexpected success', error => error);
    const second = start(f.service, { position: 10 });
    await assert.rejects(start(f.service, { owner: 'device-b' }), statusError(409));
    assert.equal((await first).status, 409); assert.equal((await second).startPosition, 10);
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 1);
  } finally { await f.close(); }
});

test('closing or invalidating a task during startup rejects it and removes late-acquired resources', async () => {
  for (const close of [false, true]) {
    let good = true; const f = await fixture({ run: async () => {}, di: { startupTimeout: 100 } });
    try {
      const pending = start(f.service, { valid: () => good }).then(() => 'unexpected success', error => error);
      while (f.calls.length < 2) await new Promise(done => setTimeout(done, 2));
      if (close) await f.service.close(); else good = false;
      assert.equal((await pending).status, 409); assert.deepEqual(await readdir(f.root), []); assert.ok(f.children[1].signals.includes('SIGTERM'));
    } finally { await f.close(); }
  }
});

test('a hung availability probe is terminated and cached as unavailable', async () => {
  const f = await fixture({ hungVersion: true, ignoreKill: true, di: { probeTimeout: 10, killTimeout: 5 } });
  try { assert.equal((await f.service.status()).available, false); assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']); assert.equal((await f.service.status()).available, false); assert.equal(f.calls.length, 1); }
  finally { await f.close(); }
});

test('startup timeout kills the process, removes private files and sanitizes diagnostics', async () => {
  const f = await fixture({ run: async ({ child }) => child.stderr.write('Could not read https://secret.example/video?token=hidden\n'), di: { startupTimeout: 25 } });
  try { await assert.rejects(start(f.service), statusError(504)); assert.ok(f.children[1].signals.includes('SIGTERM')); assert.deepEqual(await readdir(f.root), []); assert.ok(f.logs.length); assert.equal(f.logs.join('\n').includes('secret.example'), false); assert.equal((await f.service.status()).running, false); }
  finally { await f.close(); }
});

test('SIGKILL bounds shutdown if SIGTERM is ignored and idle readers are cleaned up', async () => {
  const f = await fixture({ ignoreKill: true, di: { idleTimeout: 25, killTimeout: 10 } });
  try { await start(f.service); await new Promise(done => setTimeout(done, 80)); assert.ok(f.children[1].signals.includes('SIGTERM')); assert.ok(f.children[1].signals.includes('SIGKILL')); assert.equal((await f.service.status()).running, false); assert.deepEqual(await readdir(f.root), []); }
  finally { await f.close(); }
});

test('asset serving validates identity and paths, supports segment ranges and closes a newly invalid session', async () => {
  const f = await fixture(); let app, good = true;
  try {
    const result = await start(f.service, { valid: () => good }); app = await assetServer(f.service, result.id);
    const manifestResponse = await fetch(app.origin + '/index.m3u8'); assert.equal(manifestResponse.status, 200); assert.match(manifestResponse.headers.get('content-type'), /mpegurl/); assert.equal(await manifestResponse.text(), manifest);
    const ranged = await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'bytes=0-9' } }); assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), 'bytes 0-9/752'); assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'bytes=9999-' } })).status, 416);
    assert.equal((await fetch(app.origin + '/segment000000.ts', { headers: { Range: 'items=1-2' } })).status, 400);
    assert.equal((await fetch(app.origin + '/%2e%2e%2fsecret')).status, 404);
    assert.equal((await fetch(app.origin + '/index.m3u8', { method: 'POST' })).status, 400);
    good = false; assert.equal((await fetch(app.origin + '/index.m3u8')).status, 409); assert.deepEqual(await readdir(f.root), []);
  } finally { await app?.close(); await f.close(); }
});

test('MP4 input forces the mov demuxer and compatibility assets do not expose stale task IDs', async () => {
  const f = await fixture(); let app;
  try { const result = await start(f.service, { episode: { url: 'https://movies.example/a.mp4?token=x', type: 'mp4' } }); assert.equal(f.calls[1].args[f.calls[1].args.indexOf('-f') + 1], 'mov'); assert.match(f.calls[1].args[f.calls[1].args.indexOf('-i') + 1], /asset\.mp4\?token=/); await f.service.cancel(result.id, 'device-a'); app = await assetServer(f.service, result.id); assert.equal((await fetch(app.origin + '/index.m3u8')).status, 404); }
  finally { await app?.close(); await f.close(); }
});
