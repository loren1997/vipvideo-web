import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createTranscoder, supportsDolbyMapping } from '../lib/transcode.mjs';
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
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough(); child.signals = []; children.push(child);
    if (options.pid !== undefined) child.pid = options.pid;
    child.exit = code => { if (child.finished) return; child.finished = true; child.emit('exit', code); child.emit('close', code); };
    child.kill = signal => { child.signals.push(signal); if (!options.ignoreKill || signal === 'SIGKILL') queueMicrotask(() => child.exit(0)); return true; };
    setImmediate(async () => {
      try {
        if (args[0] === '-version') {
          if (options.missing) child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
          else if (!options.hungVersion) child.exit(0);
          return;
        }
        if (args.includes('-show_entries')) {
          if (options.colorProbeDelay) await new Promise(done => setTimeout(done, options.colorProbeDelay));
          if (child.finished) return;
          if (options.inspect) await options.inspect({ child, args, input: args[args.indexOf('-i') + 1] });
          if (child.finished) return;
          if (!options.hungColorProbe) { child.stdout.write(options.colorProbeBody ?? JSON.stringify(options.colorProbe ?? { streams: [{ color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }], frames: [{ color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }] })); child.exit(0); }
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
    const dolby = args.some(value => value.includes('apply_dolbyvision=1'));
    if (dolby) await writeFile(join(dir, 'segment000001.ts'), Buffer.alloc(752, 0x47));
    await writeFile(args.at(-1), manifest + (dolby ? '#EXTINF:2,\nsegment000001.ts\n' : ''));
  }
  const service = createTranscoder({ media, spawn, tmpRoot: root, device, env: { TRANSCODE_ACCEL: 'software', ...options.env }, startupTimeout: 1000, pollInterval: 5, killTimeout: 10, probeTimeout: 30, idleTimeout: 5000, logger: { error: (...args) => logs.push(args.join(' ')) }, ...options.di });
  return { service, root, calls, requests, logs, children, async close() {
    await service.close(); const target = resolve(root), base = resolve(tmpdir());
    assert.ok(target.startsWith(base + sep) && target.split(sep).at(-1).startsWith('vipvideo-transcode-test-'));
    await rm(root, { recursive: true, force: true });
  } };
}
const start = (service, overrides = {}) => service.start({ episode, position: 0, speed: 1, owner: 'device-a', valid: () => true, ...overrides });
const dolbyProbe = (profile = 5, compatibility = 0) => ({
  streams: [{ codec_name: 'hevc', pix_fmt: 'yuv420p10le', side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: profile, dv_bl_signal_compatibility_id: compatibility, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 }] }],
  frames: [{ pix_fmt: 'yuv420p10le', side_data_list: [{ side_data_type: 'Dolby Vision RPU Data' }] }],
});

// These tests exercise the real signed HTTP bridge and cancellation. Decoder
// correctness is separately checked with the public P5 sample and real FFprobe.
function probeRangeMedia(mode = 'valid', size = 4 * 1024 * 1024 + 17) {
  const calls = [], streams = [];
  const media = createMedia({ secret: Buffer.alloc(32, 19), request: async (target, options) => {
    calls.push(options.headers.range);
    const match = /^bytes=(\d+)-(\d*)$/.exec(options.headers.range || 'bytes=0-');
    const first = Number(match[1]), last = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1), length = last - first + 1;
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(length), 'content-range': `bytes ${first}-${last}/${mode === 'changed-total' && calls.length > 1 ? size + 1 : size}` };
    if (mode === 'mismatch') headers['content-range'] = `bytes ${first + 1}-${last}/${size}`;
    if (mode === 'missing-length') delete headers['content-length'];
    if (mode === 'bad-length') headers['content-length'] = String(length + 1);
    let response;
    if (mode === 'stalled') { response = new PassThrough(); response.write(Buffer.alloc(1)); }
    else response = Readable.from([Buffer.alloc(mode === 'overlong' ? length + 1 : mode === 'short' ? length - 1 : length)]);
    streams.push(response);
    return Object.assign(response, { statusCode: mode === 'ignored' ? 200 : 206, headers, finalUrl: String(target) });
  } });
  return { media, calls, streams, setMode: value => { mode = value; } };
}
const rawDolby = { url: 'https://movies.example/original.mkv', type: 'mkv', colorSpace: 'dolby-vision' };

test('Dolby color inspection uses two MiB ranges and its encoder uses separate eight MiB windows', async () => {
  const source = probeRangeMedia();
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000, startupTimeout: 5000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      assert.equal(response.status, 206);
      assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024);
    },
    run: async ({ input, args, write }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      assert.ok(Number(response.headers.get('content-length')) > 2 * 1024 * 1024);
      assert.ok(Number(response.headers.get('content-length')) <= 8 * 1024 * 1024);
      assert.equal(args[args.indexOf('-reconnect') + 1], '1');
      assert.ok(args.indexOf('-reconnect') < args.indexOf('-i'));
      assert.equal(args.includes('-reconnect_at_eof'), false);
      await response.arrayBuffer(); await write();
    },
  });
  try {
    const proof = await f.service.inspectColor({ episode: rawDolby, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 5500 });
    assert.equal(proof.rpuSeen, true);
    await start(f.service, { episode: rawDolby });
    assert.deepEqual(source.calls, ['bytes=0-2097151', 'bytes=0-2097151', 'bytes=0-8388607']);
  } finally { await f.close(); }
});

test('Dolby encoder windows can exceed both probe lifetime quotas without enlarging each HTTP read', async () => {
  const source = probeRangeMedia('valid', 32 * 1024 * 1024);
  let bytes = 0;
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { startupTimeout: 6000, probeTimeout: 3000 },
    run: async ({ input, write }) => {
      for (let index = 0; index < 18; index++) {
        const response = await fetch(input, { headers: { Range: 'bytes=0-0' } }); bytes += (await response.arrayBuffer()).byteLength;
      }
      for (let index = 0; index < 3; index++) {
        const response = await fetch(input, { headers: { Range: `bytes=${index * 8 * 1024 * 1024}-` } });
        const body = await response.arrayBuffer(); assert.equal(body.byteLength, 8 * 1024 * 1024); bytes += body.byteLength;
      }
      await write();
    },
  });
  try {
    await start(f.service, { episode: rawDolby });
    assert.ok(bytes > 16 * 1024 * 1024);
    assert.equal(source.calls.length, 21);
    assert.equal(source.calls.at(-1), 'bytes=16777216-25165823');
  } finally { await f.close(); }
});

test('an invalid Dolby encoder response stops an already-started process instead of reconnecting forever', { timeout: 5000 }, async () => {
  const source = probeRangeMedia();
  let trigger, stopped;
  const failSource = new Promise(done => { trigger = done; }), processStopped = new Promise(done => { stopped = done; });
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    run: async ({ child, input, write }) => {
      child.once('close', stopped); await write(); await failSource;
      source.setMode('ignored');
      try { const response = await fetch(input, { headers: { Range: 'bytes=0-' } }); await response.arrayBuffer(); } catch { /* The real HTTP peer is deliberately closed by the guard. */ }
    },
  });
  try {
    await start(f.service, { episode: rawDolby }); trigger(); await processStopped;
    const state = await f.service.status();
    assert.equal(state.running, false);
    assert.match(state.error, /媒体范围响应无效/);
    assert.ok(f.children.at(-1).signals.includes('SIGTERM'));
    assert.equal(source.calls.length, 1);
  } finally { trigger(); await f.close(); }
});

test('Dolby HTTP color probes reject ignored ranges, missing lengths and mismatched totals without encoding', async () => {
  for (const mode of ['ignored', 'mismatch', 'missing-length', 'bad-length', 'overlong', 'short', 'changed-total']) {
    const source = probeRangeMedia(mode);
    const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
      inspect: async ({ input }) => {
        for (let index = 0; index < (mode === 'changed-total' ? 2 : 1); index++) {
          const response = await fetch(input, { headers: { Range: 'bytes=0-0' } }); await response.arrayBuffer();
        }
      },
    });
    try {
      await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true }), error => error.status === 502 && error.code === 'QUARK_COLOR_PROBE_READ_FAILED' && error.colorProbe.colorSpace === 'unknown');
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.ok(source.streams.every(stream => stream.destroyed));
    } finally { await f.close(); }
  }
});

test('one Dolby probe shares its sixteen MiB and sixteen HTTP request limits across all seeks', async () => {
  for (const [range, accepted] of [['bytes=0-', 8], ['bytes=0-0', 16]]) {
    const source = probeRangeMedia();
    const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 5500 },
      inspect: async ({ input }) => {
        for (let index = 0; index <= accepted; index++) {
          const response = await fetch(input, { headers: { Range: range } }); await response.arrayBuffer();
        }
      },
    });
    try {
      await assert.rejects(f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true, timeout: 5500 }), error => error.status === 502);
      assert.equal(source.calls.length, accepted, 'the rejected request never reaches the underlying account media transport');
    } finally { await f.close(); }
  }
});

test('aborting a Dolby probe closes its live HTTP body immediately', async () => {
  const source = probeRangeMedia('stalled'), controller = new AbortController();
  let received;
  const firstByte = new Promise(done => { received = done; });
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      await response.body.getReader().read(); received();
    },
  });
  try {
    const pending = f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => !controller.signal.aborted, signal: controller.signal });
    await firstByte; controller.abort();
    await assert.rejects(pending);
    assert.ok(source.streams.every(stream => stream.destroyed));
  } finally { await f.close(); }
});

test('a color-probe client can close its finite response early without creating a range error', async () => {
  const source = probeRangeMedia('stalled');
  const f = await fixture({ media: source.media, colorProbe: dolbyProbe(), di: { probeTimeout: 3000 },
    inspect: async ({ input }) => {
      const response = await fetch(input, { headers: { Range: 'bytes=0-' } });
      const reader = response.body.getReader(); await reader.read(); await reader.cancel();
    },
  });
  try {
    const proof = await f.service.inspectColor({ episode: rawDolby, owner: 'probe', valid: () => true });
    assert.equal(proof.rpuSeen, true);
    assert.ok(source.streams.every(stream => stream.destroyed));
  } finally { await f.close(); }
});

test('ordinary unknown color inspection still accepts a small non-range HTTP200 video', async () => {
  const source = probeRangeMedia('ignored');
  const color = { codec_name: 'h264', pix_fmt: 'yuv420p' };
  const f = await fixture({ media: source.media, colorProbe: { streams: [color], frames: [color] }, di: { probeTimeout: 3000 },
    inspect: async ({ input }) => { const response = await fetch(input); assert.equal(response.status, 200); await response.arrayBuffer(); },
  });
  try {
    const proof = await f.service.inspectColor({ episode: { ...rawDolby, colorSpace: 'unknown' }, owner: 'probe', valid: () => true });
    assert.equal(proof.colorSpace, 'browser-default');
    assert.deepEqual(source.calls, [undefined]);
  } finally { await f.close(); }
});

test('color inspection verifies an unmarked signed source without encoding or disturbing an active SDR encoder', async () => {
  const color = { codec_name: 'h264', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  const f = await fixture({ colorProbe: { streams: [color], frames: [color] } });
  try {
    const playing = await start(f.service, { episode: { ...episode, colorSpace: 'sdr' } });
    const encoder = f.children.at(-1), before = f.calls.length;
    const proof = await f.service.inspectColor({ episode, owner: 'color-check', valid: () => true });
    assert.deepEqual(proof, { codec: 'h264', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', colorSpace: 'sdr' });
    assert.equal(f.calls.length, before + 1); assert.ok(f.calls.at(-1).args.includes('-show_entries'));
    assert.match(f.calls.at(-1).args[f.calls.at(-1).args.indexOf('-i') + 1], /^http:\/\/127\.0\.0\.1:/);
    assert.equal(f.children.at(-1).finished, true); assert.deepEqual(encoder.signals, []);
    assert.equal((await f.service.status()).running, true); assert.equal(await f.service.cancel(playing.id, 'device-a'), true);
  } finally { await f.close(); }
});

test('color inspection reports real DV metadata for alternate selection but never starts a DV encoder', async () => {
  const color = { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 5, dv_bl_signal_compatibility_id: 0, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 }] };
  const f = await fixture({ colorProbe: { streams: [color], frames: [{ ...color, side_data_list: [{ side_data_type: 'Dolby Vision RPU Data' }] }] } });
  try {
    const proof = await f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, owner: 'color-check', valid: () => true });
    assert.equal(proof.colorSpace, 'dolby-vision'); assert.equal(proof.dolbyVisionProfile, 5);
    assert.equal(proof.dolbyVisionCompatibilityId, 0); assert.equal(proof.rpuPresent, true); assert.equal(proof.blPresent, true); assert.equal(proof.elPresent, false); assert.equal(proof.rpuSeen, true);
    assert.equal(proof.pixFmt, 'yuv420p10le'); assert.equal(proof.bitDepth, 10);
    assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.includes('-show_entries'));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('decoded unmarked 8-bit AVC uses a separate browser default without claiming SDR or encoding', async () => {
  for (const pix_fmt of ['yuv420p', 'yuvj420p', 'nv12']) {
    const color = { codec_name: 'h264', pix_fmt, bits_per_raw_sample: 'N/A' };
    const f = await fixture({ colorProbe: { streams: [color], frames: [{ pix_fmt }] } });
    try {
      const proof = await f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace: 'unknown', owner: 'color-check', valid: () => true });
      assert.equal(proof.colorSpace, 'browser-default'); assert.equal(proof.pixFmt, pix_fmt); assert.equal(proof.bitDepth, 8); assert.equal(proof.transfer, '');
      assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.includes('-show_entries')); assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
    } finally { await f.close(); }
  }
});

test('Dolby AVC tags and configuration flags never qualify as browser defaults or prove an actual decoded RPU', async () => {
  const config = { side_data_type: 'DOVI configuration record', dv_profile: 8, dv_bl_signal_compatibility_id: 1, rpu_present_flag: 1, bl_present_flag: 1, el_present_flag: 0 };
  for (const metadata of [{ side_data_list: [config] }, { codec_tag_string: 'dvav' }, { codec_tag_string: 'dva1' }]) {
    const f = await fixture({ colorProbe: { streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p', ...metadata }], frames: [{ pix_fmt: 'yuv420p' }] } });
    try {
      const proof = await f.service.inspectColor({ episode, owner: 'color-check', valid: () => true });
      assert.equal(proof.colorSpace, 'dolby-vision'); assert.equal(proof.rpuSeen, false);
      if (metadata.side_data_list) { assert.equal(proof.rpuPresent, true); assert.equal(proof.dolbyVisionCompatibilityId, 1); }
    } finally { await f.close(); }
  }
});

test('missing tags never erase source HDR risk, 10-bit or HEVC uncertainty, contradictory depth or HDR side data', async () => {
  const plain = { codec_name: 'h264', pix_fmt: 'yuv420p' };
  const cases = [
    ...['dolby-vision', 'hdr', 'pq', 'hlg'].map(sourceColorSpace => ({ sourceColorSpace, stream: plain, frame: plain })),
    { stream: { ...plain, pix_fmt: 'yuv420p10le' }, frame: { pix_fmt: 'yuv420p10le' } },
    { stream: { ...plain, pix_fmt: 'yuv420p10le' }, frame: { pix_fmt: 'yuv420p' } },
    { stream: plain, frame: { pix_fmt: 'yuv420p10le' } },
    { stream: { codec_name: 'h264', bits_per_raw_sample: '8' }, frame: {} },
    { stream: { ...plain, codec_name: 'hevc' }, frame: plain },
    { stream: { ...plain, bits_per_raw_sample: '10' }, frame: plain },
    { stream: plain, frame: { ...plain, color_primaries: 'bt2020' } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'Mastering display metadata' }] } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'Content light level metadata' }] } },
    { stream: plain, frame: { ...plain, side_data_list: [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] } },
    { stream: plain, frame: null },
  ];
  for (const row of cases) {
    const f = await fixture({ colorProbe: { streams: [row.stream], frames: row.frame ? [row.frame] : [] } });
    try {
      await assert.rejects(f.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace: row.sourceColorSpace || 'unknown', owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED');
      assert.equal(f.calls.some(call => call.args.includes('-c:v')), false);
    } finally { await f.close(); }
  }
  const f = await fixture({ colorProbe: { streams: [plain], frames: [plain] } });
  try { await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), /无法确认.*色彩/); }
  finally { await f.close(); }
});

test('a browser-default compatibility source preserves the ordinary pipeline without another probe or color remapping', async () => {
  const f = await fixture();
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'browser-default' } });
    assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /tonemap|zscale|-color_trc|-color_primaries|-colorspace/);
  } finally { await f.close(); }
});

test('a transfer tag alone cannot certify SDR with conflicting frame metadata, wide-gamut tags or HDR side data', async () => {
  const sdr = { codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  for (const [stream, frame] of [
    [{ ...sdr, color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }, sdr],
    [{ ...sdr, color_space: 'smpte170m' }, sdr],
    [{ ...sdr, color_primaries: 'bt2020' }, { ...sdr, color_primaries: 'bt2020' }],
    [{ ...sdr, color_space: 'bt2020nc' }, { ...sdr, color_space: 'bt2020nc' }],
    [sdr, { ...sdr, side_data_list: [{ side_data_type: 'Mastering display metadata' }] }],
  ]) {
    const f = await fixture({ colorProbe: { streams: [stream], frames: [frame] } });
    try { await assert.rejects(f.service.inspectColor({ episode, owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED'); }
    finally { await f.close(); }
  }
});

test('source DV or HDR requires a complete consistent SDR triplet while ordinary unmarked AVC still uses browser defaults', async () => {
  const sdr = { codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709' };
  for (const sourceColorSpace of ['dolby-vision', 'hdr', 'pq', 'hlg']) {
    for (const partial of [{ color_transfer: 'bt709' }, { color_transfer: 'bt709', color_primaries: 'bt709' }, { color_transfer: 'bt709', color_space: 'bt709' }]) {
      const f = await fixture({ colorProbe: { streams: [{ codec_name: 'h264', pix_fmt: 'yuv420p', ...partial }], frames: [partial] } });
      try { await assert.rejects(f.service.inspectColor({ episode, sourceColorSpace, owner: 'color-check', valid: () => true }), error => error.code === 'QUARK_COLOR_UNCONFIRMED'); }
      finally { await f.close(); }
    }
    const f = await fixture({ colorProbe: { streams: [sdr], frames: [sdr] } });
    try { assert.equal((await f.service.inspectColor({ episode, sourceColorSpace, owner: 'color-check', valid: () => true })).colorSpace, 'sdr'); }
    finally { await f.close(); }
  }
});

test('aborting a signed color inspection stops its process and leaves no encoding or input bridge alive', async () => {
  const f = await fixture({ hungColorProbe: true }); const controller = new AbortController();
  try {
    const pending = f.service.inspectColor({ episode, owner: 'color-check', valid: () => !controller.signal.aborted, signal: controller.signal });
    while (!f.calls.length) await new Promise(done => setTimeout(done, 1));
    controller.abort(); await assert.rejects(pending);
    assert.ok(f.children[0].signals.includes('SIGTERM')); assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('ordinary SDR playback keeps the existing path without a color probe or tone mapping', async () => {
  const f = await fixture();
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'sdr' } });
    assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 0);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /tonemap|zscale|-color_trc/);
    assert.equal(f.calls.find(call => call.args.includes('-c:v')).args.includes('-reconnect'), false);
  } finally { await f.close(); }
});

test('confirmed PQ and HLG alternatives from a known Dolby source tone-map in linear light to BT709 SDR', async () => {
  for (const [hint, transfer, sideData] of [['pq', 'smpte2084'], ['hlg', 'arib-std-b67'], ['unknown', 'smpte2084'], ['hdr', 'smpte2084', [{ side_data_type: 'HDR Vivid Dynamic Metadata' }]]]) {
    const color = { color_transfer: transfer, color_primaries: 'bt2020', color_space: 'bt2020nc' };
    const f = await fixture({ colorProbe: { streams: [color], frames: [{ ...color, side_data_list: sideData || [] }] } });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: hint, sourceColorSpace: 'dolby-vision' } });
      assert.equal(result.acceleration, 'software');
      const probe = f.calls.find(call => call.args.includes('-show_entries')), encoder = f.calls.find(call => call.args.includes('-c:v'));
      assert.equal(probe.command, 'ffprobe'); assert.equal(probe.options.stdio[1], 'pipe');
      assert.ok(probe.args[probe.args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
      assert.equal(probe.args[probe.args.indexOf('-read_intervals') + 1], '%+#1');
      assert.equal(probe.args[probe.args.indexOf('-probesize') + 1], '1048576');
      const filter = encoder.args[encoder.args.indexOf('-vf') + 1];
      assert.match(filter, /min\(1280,iw\).*min\(720,ih\)/);
      assert.match(filter, /zscale=transfer=linear.*format=gbrpf32le.*tonemap=.*zscale=transfer=bt709/);
      assert.match(filter, /sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA/);
      assert.equal(encoder.args[encoder.args.indexOf('-color_trc') + 1], 'bt709');
      assert.equal(encoder.args[encoder.args.indexOf('-color_primaries') + 1], 'bt709');
      assert.equal(encoder.args[encoder.args.indexOf('-colorspace') + 1], 'bt709');
      assert.ok(!encoder.args.some(value => value.includes('movies.example') || value.includes('access=neutral')));
    } finally { await f.close(); }
  }
});

test('ordinary HDR Vivid, PQ, HLG and unknown MP4 or MKV compatibility never probes or calibrates color', async () => {
  for (const type of ['mp4', 'mkv']) for (const colorSpace of [undefined, 'unknown', 'hdr', 'pq', 'hlg']) {
    const f = await fixture({ hungColorProbe: true });
    try {
      await start(f.service, { episode: { url: `https://movies.example/2026.HDR.Vivid.${type}`, type, colorSpace, sourceColorSpace: colorSpace ?? 'unknown' } });
      assert.equal(f.calls.filter(call => call.args.includes('-show_entries')).length, 0);
      const args = f.calls.find(call => call.args.includes('-c:v')).args;
      assert.doesNotMatch(args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace|sidedata=/);
      assert.equal(args[args.indexOf('-f') + 1], type === 'mp4' ? 'mov' : 'matroska');
      assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    } finally { await f.close(); }
  }
});

test('an explicitly converted SDR stream from a Dolby source keeps ordinary codec compatibility without calibration', async () => {
  const f = await fixture({ hungColorProbe: true });
  try {
    await start(f.service, { episode: { ...episode, colorSpace: 'sdr', sourceColorSpace: 'dolby-vision' } });
    assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
    assert.doesNotMatch(f.calls.find(call => call.args.includes('-c:v')).args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace/);
  } finally { await f.close(); }
});

test('a Dolby hint without original RPU cannot fall through to ordinary PQ conversion', async () => {
  const direct = await fixture();
  try {
    await assert.rejects(start(direct.service, { episode: { ...episode, colorSpace: 'dolby-vision' } }), /杜比 RPU.*SDR/);
    assert.equal(direct.calls.filter(call => call.args.includes('-c:v')).length, 0);
  } finally { await direct.close(); }
  const color = { color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' };
  for (const location of ['stream', 'frame']) {
    const metadata = [{ side_data_type: location === 'stream' ? 'DOVI configuration record' : 'Dolby Vision RPU Data', dv_profile: 5, dv_bl_signal_compatibility_id: 0 }];
    const f = await fixture({ colorProbe: { streams: [{ ...color, ...(location === 'stream' ? { side_data_list: metadata } : {}) }], frames: [{ ...color, ...(location === 'frame' ? { side_data_list: metadata } : {}) }] } });
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), /杜比视界.*SDR/);
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('only decoded single-layer Profile 5 or 8.1 RPU is eligible for Dolby mapping', () => {
  const proof = { codec: 'hevc', dolbyVisionProfile: 5, dolbyVisionCompatibilityId: 0, rpuPresent: true, rpuSeen: true, blPresent: true, elPresent: false };
  assert.equal(supportsDolbyMapping(proof), true);
  assert.equal(supportsDolbyMapping({ ...proof, dolbyVisionProfile: 8, dolbyVisionCompatibilityId: 1 }), true);
  for (const change of [{ codec: 'h264' }, { dolbyVisionProfile: 7 }, { dolbyVisionCompatibilityId: 1 }, { rpuPresent: false }, { rpuSeen: false }, { blPresent: false }, { elPresent: true }, { elPresent: undefined }]) assert.equal(supportsDolbyMapping({ ...proof, ...change }), false);
  assert.equal(supportsDolbyMapping(undefined), false);
});

test('supported original Dolby RPU uses libplacebo and BT709 output in both existing encoding modes', async () => {
  for (const [profile, compatibility] of [[5, 0], [8, 1]]) for (const gpu of [false, true]) {
    const f = await fixture({ gpu, colorProbe: dolbyProbe(profile, compatibility), env: { TRANSCODE_ACCEL: gpu ? 'vaapi' : 'software', TRANSCODE_ALLOW_SOFTWARE: gpu ? 'false' : 'true' } });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      assert.equal(result.acceleration, gpu ? 'vaapi' : 'software');
      const args = f.calls.find(call => call.args.includes('-c:v')).args, filter = args[args.indexOf('-vf') + 1];
      assert.equal(args.includes('-reconnect'), false, 'HLS keeps its existing protocol behavior');
      assert.match(filter, /libplacebo=.*apply_dolbyvision=1.*colorspace=bt709.*color_primaries=bt709.*color_trc=bt709/);
      assert.match(filter, /force_original_aspect_ratio=decrease:force_divisible_by=2/);
      assert.doesNotMatch(filter, /zscale|tonemap=tonemap/);
      assert.equal(args[args.indexOf('-color_primaries') + 1], 'bt709');
      assert.equal(args[args.indexOf('-threads') + 1], gpu ? '1' : '4', 'only software Dolby decode uses four threads');
      assert.equal(args[args.lastIndexOf('-threads') + 1], '1', 'encoding remains bounded to one thread');
      assert.equal(args[args.indexOf('-filter_threads') + 1], '1');
      if (gpu) {
        assert.match(args[args.indexOf('-init_hw_device') + 1], /^vaapi=va:/);
        assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi');
        assert.match(filter, /^hwmap=derive_device=vulkan,format=vulkan/);
        assert.match(filter, /hwdownload,format=yuv420p,format=nv12,hwupload$/);
        assert.ok(args.includes('h264_vaapi')); assert.ok(!args.includes('libx264'));
      } else {
        assert.equal(args[args.indexOf('-init_hw_device') + 1], 'vulkan=vk:0');
        assert.match(filter, /^hwupload,libplacebo=/);
        assert.ok(args.includes('libx264'));
      }
    } finally { await f.close(); }
  }
});

test('Dolby startup waits for two distinct listed segments that both exist and are nonempty', async () => {
  for (const gpu of [false, true]) {
    let outputPath, outputReady;
    const created = new Promise(done => { outputReady = done; });
    const f = await fixture({ gpu, colorProbe: dolbyProbe(), env: { TRANSCODE_ACCEL: gpu ? 'vaapi' : 'software' }, run: async ({ args }) => {
      outputPath = args.at(-1);
      await writeFile(join(outputPath, '..', 'segment000000.ts'), Buffer.alloc(188));
      await writeFile(outputPath, manifest);
      outputReady();
    } });
    try {
      let settled = false;
      const playback = start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      playback.then(() => { settled = true; }, () => { settled = true; });
      await created;
      const first = join(outputPath, '..', 'segment000000.ts'), second = join(outputPath, '..', 'segment000001.ts');
      const pending = async message => { await new Promise(done => setTimeout(done, 20)); assert.equal(settled, false, message); };
      const publish = async body => { await writeFile(outputPath + '.tmp', body); await rename(outputPath + '.tmp', outputPath); };
      await pending('one open segment does not provide the Dolby startup buffer');
      await writeFile(second, Buffer.alloc(188));
      await pending('an unlisted file does not count toward the buffer');
      await publish(manifest + '#EXTINF:2,\nsegment000000.ts\n');
      await pending('a duplicate segment does not provide a second segment');
      await writeFile(first, Buffer.alloc(0));
      await publish(manifest + '#EXTINF:2,\nsegment000001.ts\n');
      await pending('the first listed segment must also be nonempty');
      await writeFile(second, Buffer.alloc(0)); await writeFile(first, Buffer.alloc(188));
      await pending('an empty second segment is not ready');
      await rm(second);
      await pending('a missing second segment is not ready');
      await writeFile(second, Buffer.alloc(188));
      assert.equal((await playback).acceleration, gpu ? 'vaapi' : 'software');
    } finally { await f.close(); }
  }
});

test('a short completed Dolby output may start with one segment only when its exact ENDLIST is present', async () => {
  for (const { body, empty, second, ended } of [
    { body: manifest },
    { body: manifest + '#EXT-X-ENDLIST-DRAFT\n' },
    { body: '#EXTM3U\n#EXT-X-ENDLIST\n' },
    { body: manifest + '#EXT-X-ENDLIST\n', empty: true },
    { body: manifest + '#EXTINF:2,\nsegment000001.ts\n#EXT-X-ENDLIST\n', second: true },
    { body: manifest + '#EXT-X-ENDLIST\n', ended: true },
  ]) {
    const f = await fixture({ colorProbe: dolbyProbe(), run: async ({ child, args }) => {
      await writeFile(join(args.at(-1), '..', 'segment000000.ts'), Buffer.alloc(empty ? 0 : 188));
      if (second) await writeFile(join(args.at(-1), '..', 'segment000001.ts'), Buffer.alloc(0));
      await writeFile(args.at(-1), body); child.exit(0);
    } });
    try {
      const playback = start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } });
      if (ended) assert.equal((await playback).acceleration, 'software');
      else await assert.rejects(playback, statusError(503));
    } finally { await f.close(); }
  }
});

test('Dolby Vulkan failure in strict hardware mode reports capability failure without CPU fallback', async () => {
  const f = await fixture({ gpu: true, colorProbe: dolbyProbe(), env: { TRANSCODE_ACCEL: 'vaapi', TRANSCODE_ALLOW_SOFTWARE: 'false' }, run: async ({ child }) => { child.stderr.write('Vulkan unsupported https://private.example/video?token=hidden'); child.exit(1); } });
  try {
    await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'dolby-vision' } }), error => error.status === 503 && /libplacebo.*Vulkan/.test(error.message));
    assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 1);
    assert.equal(f.calls.some(call => call.args.includes('libx264')), false);
    assert.equal(f.logs.join('\n').includes('private.example'), false);
    assert.deepEqual(await readdir(f.root), ['gpu']);
  } finally { await f.close(); }
});

test('bounded Dolby and HDR probes can finish after three seconds while ordinary probes keep their shorter deadline', async () => {
  const dolby = await fixture({ colorProbe: dolbyProbe(), colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
  try {
    const proof = await dolby.service.inspectColor({ episode: { ...episode, colorSpace: 'dolby-vision' }, sourceColorSpace: 'dolby-vision', owner: 'probe', valid: () => true, timeout: 5500 });
    assert.equal(supportsDolbyMapping(proof), true);
    assert.equal(dolby.calls.some(call => call.args.includes('-c:v')), false);
  } finally { await dolby.close(); }
  for (const sourceColorSpace of ['hdr', 'pq', 'hlg']) {
    const color = { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: sourceColorSpace === 'hlg' ? 'arib-std-b67' : 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' };
    const hdr = await fixture({ colorProbe: { streams: [color], frames: [color] }, colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
    try {
      const proof = await hdr.service.inspectColor({ episode: { ...episode, colorSpace: 'unknown' }, sourceColorSpace, owner: 'probe', valid: () => true, timeout: 6000 });
      assert.equal(proof.colorSpace, sourceColorSpace === 'hlg' ? 'hlg' : 'pq');
      assert.ok(hdr.children.every(child => child.finished));
    } finally { await hdr.close(); }
  }
  const ordinary = await fixture({ colorProbeDelay: 3150, di: { probeTimeout: 6000 } });
  try {
    await assert.rejects(ordinary.service.inspectColor({ episode, owner: 'probe', valid: () => true, timeout: 5500 }), error => error.status === 504 && error.code === 'QUARK_COLOR_PROBE_TIMEOUT');
    assert.ok(ordinary.children.every(child => child.finished));
    assert.deepEqual(await readdir(ordinary.root), []);
  } finally { await ordinary.close(); }
});

test('unknown, malformed, oversized and timed-out color probes stop safely before encoding', async () => {
  for (const option of [{ colorProbe: { streams: [{}], frames: [{}] } }, { colorProbe: { streams: [{ color_transfer: 'smpte2084' }], frames: [] } }, { colorProbeBody: '{malformed' }, { colorProbeBody: 'x'.repeat(65537) }, { hungColorProbe: true }]) {
    const f = await fixture(option);
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), error => error.status === (option.hungColorProbe ? 504 : 409) && (option.hungColorProbe ? error.code === 'QUARK_COLOR_PROBE_TIMEOUT' : /无法确认.*色彩/.test(error.message)) && !error.message.includes('movies.example'));
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
      assert.ok(f.children.every(child => child.finished));
    } finally { await f.close(); }
  }
});

test('HDR alternatives from Dolby sources honor GPU-only and disabled-software settings', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env });
    try {
      await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'dolby-vision' } }), error => error.status === 503 && /软件色调映射/.test(error.message));
      assert.equal(f.calls.filter(call => call.args.includes('-c:v')).length, 0);
    } finally { await f.close(); }
  }
});

test('ordinary HDR compatibility keeps hardware encoding instead of forcing software color mapping', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env, hungColorProbe: true });
    try {
      const result = await start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'hdr' } });
      assert.equal(result.acceleration, 'vaapi'); assert.equal(f.calls.some(call => call.args.includes('-show_entries')), false);
      const args = f.calls.find(call => call.args.includes('-c:v')).args;
      assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
      assert.doesNotMatch(args.join(' '), /tonemap|zscale|libplacebo|-color_trc|-color_primaries|-colorspace/);
    } finally { await f.close(); }
  }
});

test('a build without HDR filters reports the missing capability instead of claiming converted playback', async () => {
  const f = await fixture({ run: async ({ child }) => { child.stderr.write("No such filter: 'zscale'\n"); child.exit(1); } });
  try {
    await assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'pq', sourceColorSpace: 'dolby-vision' } }), error => error.status === 503 && /缺少 HDR 色调映射支持/.test(error.message));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('closing during a color probe kills its owned process and leaves no bridge or output directory', async () => {
  const f = await fixture({ hungColorProbe: true, di: { probeTimeout: 1000 } });
  try {
    const pending = assert.rejects(start(f.service, { episode: { ...episode, colorSpace: 'hdr', sourceColorSpace: 'dolby-vision' } }), statusError(409));
    for (let index = 0; index < 30 && !f.calls.some(call => call.args.includes('-show_entries')); index++) await new Promise(done => setTimeout(done, 2));
    assert.ok(f.calls.some(call => call.args.includes('-show_entries')));
    await f.service.close(); await pending;
    assert.ok(f.children.every(child => child.finished));
    assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('cloud media override stays inside signed bridge and MKV uses the Matroska demuxer', async () => {
  const f = await fixture({ run: async ({ input, write }) => {
    const response = await fetch(input); assert.equal(response.status, 200); assert.equal(await response.text(), 'cloud-video'); await write();
  } });
  let upstreamCalls = 0;
  const cloudMedia = createMedia({ proxyPath: '/api/quark/media/test-lease', request: async () => {
    upstreamCalls++; return Object.assign(Readable.from([Buffer.from('cloud-video')]), { statusCode: 200, headers: { 'content-type': 'video/x-matroska' } });
  } });
  try {
    await start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, mediaOverride: cloudMedia, proxyPath: '/api/quark/media/test-lease' });
    const args = f.calls.find(call => call.args.includes('-i'))?.args;
    assert.equal(args[args.indexOf('-f') + 1], 'matroska');
    assert.ok(upstreamCalls > 0);
    assert.ok(args[args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
    assert.ok(!args.some(arg => arg.includes('cloud.quark.cn')));
  } finally { await f.close(); }
});

test('cloud AVI and transport-stream files use fixed demuxers through the signed bridge', async () => {
  for (const type of ['avi', 'mpegts']) {
    const f = await fixture({ run: async ({ input, write }) => { assert.equal((await fetch(input)).status, 200); await write(); } });
    const cloudMedia = createMedia({ proxyPath: '/api/quark/media/test-lease', request: async () => Object.assign(Readable.from([Buffer.from('video')]), { statusCode: 200, headers: { 'content-type': 'application/octet-stream' } }) });
    try {
      await start(f.service, { episode: { type, url: 'https://cloud.quark.cn/file.bin' }, mediaOverride: cloudMedia, proxyPath: '/api/quark/media/test-lease' });
      const args = f.calls.find(call => call.args.includes('-i')).args;
      assert.equal(args[args.indexOf('-f') + 1], type);
      assert.ok(args[args.indexOf('-i') + 1].startsWith('http://127.0.0.1:'));
    } finally { await f.close(); }
  }
});

test('raw-file resume rejects ignored, mismatched and malformed Range responses before encoding', async () => {
  for (const reply of [
    { statusCode: 200, headers: { 'content-length': '1', 'accept-ranges': 'bytes' } },
    { statusCode: 206, headers: { 'content-length': '1', 'content-range': 'bytes 0-0/1000' } },
    { statusCode: 206, headers: { 'content-length': '2', 'content-range': 'bytes 1-1/1000' } },
    { statusCode: 206, headers: { 'content-length': '1', 'content-range': 'bytes 1-1/1' } },
  ]) {
    const requests = [], media = createMedia({ request: async (_url, options) => {
      requests.push(options);
      return Object.assign(Readable.from([Buffer.from('v')]), { ...reply, headers: { 'content-type': 'video/x-matroska', ...reply.headers } });
    } });
    const f = await fixture({ media });
    try {
      await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
        error => error.status === 409 && error.code === 'TRANSCODE_INPUT_NOT_SEEKABLE' && /从头播放|官方在线线路/.test(error.message));
      assert.equal(requests.length, 1); assert.equal(requests[0].headers.range, 'bytes=1-1');
      assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('raw-file resume accepts a genuine nonzero byte range and shares the startup deadline', async () => {
  const requests = [], media = createMedia({ request: async (_url, options) => {
    requests.push(options);
    return Object.assign(Readable.from([Buffer.from('v')]), { statusCode: 206,
      headers: { 'content-type': 'video/x-matroska', 'content-length': '1', 'content-range': 'bytes 1-1/1000' } });
  } });
  const f = await fixture({ media });
  try {
    const result = await start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 });
    assert.equal(result.startPosition, 281); assert.equal(requests.length, 1); assert.equal(requests[0].headers.range, 'bytes=1-1');
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 1);
  } finally { await f.close(); }
});

test('from-start raw files and HLS resume do not require byte-range support', async () => {
  for (const input of [{ type: 'mkv', position: 0 }, { type: 'hls', position: 281 }]) {
    const f = await fixture();
    try {
      assert.equal((await start(f.service, { episode: { type: input.type, url }, position: input.position })).startPosition, input.position);
      assert.equal(f.requests.length, 0);
      const args = f.calls.find(call => call.args.includes('-i')).args;
      assert.equal(args.includes('-ss'), input.position > 0);
      assert.equal(args.includes('-reconnect'), false);
    }
    finally { await f.close(); }
  }
});

test('a source that stops honoring Range after the probe keeps the actionable resume error', async () => {
  let requests = 0;
  const media = createMedia({ request: async (_url, options) => {
    requests++;
    return Object.assign(Readable.from([Buffer.from('v')]), { statusCode: requests === 1 ? 206 : 200,
      headers: { 'content-type': 'video/x-matroska', 'content-length': '1', ...(requests === 1 ? { 'content-range': 'bytes 1-1/1000' } : {}) } });
  } });
  const f = await fixture({ media, run: async ({ input }) => { try { await fetch(input, { headers: { Range: 'bytes=500-' } }); } catch {} } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.code === 'TRANSCODE_INPUT_NOT_SEEKABLE');
    assert.equal(requests, 2); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('closing during a pending resume probe cancels it without leaking resources or replacing 409', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const media = createMedia({ request: async (_url, options) => {
    entered();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media });
  try {
    const pending = start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }).catch(error => error);
    await started;
    await Promise.all([f.service.close(), f.service.close()]);
    assert.equal((await pending).status, 409);
    assert.deepEqual(await readdir(f.root), []); assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
  } finally { await f.close(); }
});

test('a hung resume probe uses the existing startup deadline and never launches an encoder', async () => {
  const media = createMedia({ request: async (_url, options) => {
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media, di: { startupTimeout: 40 } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }), statusError(504));
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('a startup-limited resume probe remains a timeout when its timer fires just before the wall-clock deadline', async () => {
  let clock = 1000;
  const media = createMedia({ request: async (_url, options) => {
    clock = 1039;
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const f = await fixture({ media, di: { startupTimeout: 40, now: () => clock } });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.status === 504 && /启动超时/.test(error.message));
    assert.equal(clock, 1039); assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

test('a resume probe upstream failure before the startup deadline remains a check error', async () => {
  const media = createMedia({ request: async () => { throw new Error('fixture upstream unavailable'); } });
  const f = await fixture({ media });
  try {
    await assert.rejects(start(f.service, { episode: { type: 'mkv', url: 'https://cloud.quark.cn/file.mkv' }, position: 281 }),
      error => error.status === 502 && /无法检查原文件/.test(error.message));
    assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0); assert.deepEqual(await readdir(f.root), []);
  } finally { await f.close(); }
});

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

test('software output uses a private bridge, bounded HLS window, one thread and unmodified playback timestamps', async () => {
  const f = await fixture({ env: { FFMPEG_PATH: 'custom-ffmpeg' }, run: async ({ child, args, write }) => { child.stderr.write('Duration: 00:01:'); child.stderr.write('30.50, start: 0\n'); await write(); } });
  try {
    const result = await start(f.service, { position: 12.5, speed: 1.5 });
    assert.equal(result.duration, 90.5); assert.equal(result.startPosition, 12.5); assert.equal(result.acceleration, 'software'); assert.equal(result.transcoded, true); assert.match(result.url, /^\/api\/transcode\/[a-f0-9]{32}\/index\.m3u8$/);
    const { command, args } = f.calls[1]; assert.equal(command, 'custom-ffmpeg'); assert.equal(args[args.indexOf('-readrate') + 1], '1.5'); assert.equal(args[args.indexOf('-ss') + 1], '12.5'); assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp,crypto'); assert.match(args[args.indexOf('-i') + 1], /^http:\/\/127\.0\.0\.1:\d+\/api\/media\/asset\.m3u8\?token=/); assert.equal(args.includes(url), false);
    assert.equal(args[args.indexOf('-hls_time') + 1], '2'); assert.equal(args[args.indexOf('-hls_list_size') + 1], '30'); assert.equal(args[args.indexOf('-hls_flags') + 1], 'delete_segments+temp_file'); assert.ok(args.includes('libx264')); assert.ok(args.includes('aac')); assert.equal(args.includes('-atempo'), false); assert.equal(args.some(value => value.includes('setpts')), false); assert.equal((await f.service.status()).running, true);
    assert.equal(args[args.indexOf('-r') + 1], '30'); assert.equal(args[args.indexOf('-maxrate') + 1], '3500k'); assert.equal(args[args.indexOf('-bufsize') + 1], '7000k');
    assert.ok(args.every((value, index) => !['-threads', '-filter_threads'].includes(value) || args[index + 1] === '1'));
  } finally { await f.close(); }
});

test('duration survives a large stderr chunk and a duration split across chunks before retained-tail truncation', async () => {
  for (const chunks of [
    ['Duration: 02:10:00.50, start: 0\n' + 'codec diagnostics\n'.repeat(400)],
    ['codec diagnostics\n'.repeat(200) + 'Dura', 'tion: 02:10:00.50, start: 0\n' + 'codec diagnostics\n'.repeat(400)],
  ]) {
    const f = await fixture({ run: async ({ child, write }) => { for (const chunk of chunks) child.stderr.write(chunk); await write(); } });
    try { assert.equal((await start(f.service)).duration, 7800.5); }
    finally { await f.close(); }
  }
});

test('duration does not invent a value for unavailable, invalid or excessive input metadata', async () => {
  for (const value of ['N/A', '00:60:01', '00:01:60.50', '168:00:01', '9'.repeat(400) + ':00:00']) {
    const f = await fixture({ run: async ({ child, write }) => { child.stderr.write(`Duration: ${value}, start: 0\n` + 'codec diagnostics\n'.repeat(400)); await write(); } });
    try { assert.equal((await start(f.service)).duration, null); }
    finally { await f.close(); }
  }
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
    for (const overrides of [{ episode: { url: 'http://127.0.0.1/a.mp4', type: 'mp4' } }, { episode: { url: 'file:///tmp/a.mp4', type: 'mp4' } }, { episode: { url, type: 'page' } }, { episode: { ...episode, sourceColorSpace: 'invalid' } }, { episode: { ...episode, sourceColorSpace: 'browser-default' } }, { episode: { ...episode, sourceColorSpace: {} } }, { speed: 4 }, { position: -1 }, { position: Infinity }, { owner: '' }, { valid: null }]) await assert.rejects(start(f.service, overrides));
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
  const hardware = await fixture({ gpu: true, env: { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'true' }, run: async ({ child, args, write }) => { if (args.includes('h264_vaapi')) { child.stderr.write('hardware rejected https://secret.example/video?token=hidden'); child.exit(1); } else await write(); } });
  try { const result = await start(hardware.service); assert.equal(result.acceleration, 'software'); assert.equal(hardware.calls.length, 3); assert.ok(hardware.calls[1].args.includes('h264_vaapi')); assert.ok(hardware.calls[2].args.includes('libx264')); }
  finally { await hardware.close(); }
});

test('strict VAAPI and the Plex protection setting never select software for missing GPUs', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }, { TRANSCODE_ACCEL: 'software', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ env });
    try {
      await assert.rejects(start(f.service), statusError(503));
      assert.equal(f.calls.filter(call => call.args.includes('-i')).length, 0);
      assert.deepEqual(await readdir(f.root), []);
    } finally { await f.close(); }
  }
});

test('strict VAAPI and the Plex protection setting preserve hardware errors without CPU fallback', async () => {
  for (const env of [{ TRANSCODE_ACCEL: 'vaapi', TRANSCODE_ALLOW_SOFTWARE: 'true' }, { TRANSCODE_ACCEL: 'auto', TRANSCODE_ALLOW_SOFTWARE: 'false' }]) {
    const f = await fixture({ gpu: true, env, run: async ({ child }) => { child.stderr.write('hardware rejected https://secret.example/video?token=hidden'); child.exit(1); } });
    try {
      await assert.rejects(start(f.service), statusError(502));
      const encoders = f.calls.filter(call => call.args.includes('-i'));
      assert.equal(encoders.length, 1); assert.ok(encoders[0].args.includes('h264_vaapi'));
      assert.equal(f.logs.join('\n').includes('secret.example'), false);
      assert.deepEqual(await readdir(f.root), ['gpu']);
    } finally { await f.close(); }
  }
});

test('Linux children run at low priority while Windows launches stay hidden without Unix priority changes', async () => {
  for (const platform of ['linux', 'win32']) {
    const priorities = [], f = await fixture({ pid: 123456, di: { platform, setPriority: (pid, priority) => priorities.push([pid, priority]) } });
    try {
      await start(f.service);
      assert.deepEqual(priorities, platform === 'linux' ? [[123456, 19], [123456, 19]] : []);
      assert.ok(f.calls.every(call => call.options.windowsHide));
    } finally { await f.close(); }
  }
});

test('priority adjustment failures retain playback and sanitize diagnostic links', async () => {
  const f = await fixture({ pid: 123456, di: { platform: 'linux', setPriority() { throw new Error('denied https://secret.example/video?token=hidden'); } } });
  try {
    assert.equal((await start(f.service)).acceleration, 'software');
    assert.equal(f.logs.length, 2); assert.equal(f.logs.join('\n').includes('secret.example'), false);
  } finally { await f.close(); }
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
