import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { setPriority as nodeSetPriority, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validateUrl } from './network.mjs';

const speeds = new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3]);
const inputFormats = { hls: 'hls', mp4: 'mov', mkv: 'matroska', webm: 'matroska', avi: 'avi', mpegts: 'mpegts' };
const assetName = /^(?:index\.m3u8|segment\d{6,12}\.ts)$/;
const failure = (message, status = 502, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status });
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const diagnostics = value => String(value).replace(/https?:\/\/[^\s'"<>]+/gi, '[媒体链接]').replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(-4096);
const notSeekable = () => Object.assign(failure('原文件暂不支持定位续播，请从头播放或换官方在线线路', 409), { code: 'TRANSCODE_INPUT_NOT_SEEKABLE' });
function matchingRange(status, header, start, end) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header('content-range') || ''));
  if (status !== 206 || !match) return false;
  const [first, last, size] = match.slice(1).map(Number), length = header('content-length');
  return [first, last, size].every(Number.isSafeInteger) && first === start && last >= first && size > last &&
    (end === undefined || last === Math.min(end, size - 1)) &&
    (length === undefined || length === null || /^\d+$/.test(String(length)) && Number(length) === last - first + 1);
}

export function createTranscoder({ media, spawn = nodeSpawn, setPriority = nodeSetPriority, platform = process.platform, env = process.env, now = Date.now, tmpRoot = tmpdir(), device = '/dev/dri/renderD128', startupTimeout = 20_000, probeTimeout = 3000, killTimeout = 1500, idleTimeout = 120_000, pollInterval = 50, logger = console } = {}) {
  const enabled = String(env.TRANSCODE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const preference = ['auto', 'software', 'vaapi'].includes(env.TRANSCODE_ACCEL) ? env.TRANSCODE_ACCEL : 'auto';
  const allowSoftware = String(env.TRANSCODE_ALLOW_SOFTWARE ?? 'true').toLowerCase() !== 'false';
  const executable = env.FFMPEG_PATH || 'ffmpeg';
  let current, available, availability, availabilityAttempt, closed = false, lastError;

  function runProcess(args, onStderr) {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let finish;
    const attempt = { child, done: false, error: null, code: null, stderr: '', promise: new Promise(done => { finish = done; }) };
    const settle = (code, error) => { if (attempt.done) return; attempt.done = true; attempt.code = code; attempt.error = error; finish(); };
    child.once('error', error => settle(null, error));
    child.once('exit', code => settle(code, null));
    child.stderr?.on('data', chunk => { attempt.stderr = (attempt.stderr + String(chunk)).slice(-16_384); onStderr?.(String(chunk)); });
    if (platform === 'linux' && Number.isInteger(child.pid) && child.pid > 0) {
      try { setPriority(child.pid, 19); }
      catch (error) { if (error.code !== 'ESRCH') logger.error('降低兼容播放进程优先级失败', diagnostics(error.message)); }
    }
    return attempt;
  }
  async function terminate(attempt) {
    if (!attempt || attempt.done) return;
    try { attempt.child.kill('SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') logger.error('停止兼容播放进程失败', diagnostics(error.message)); }
    let timer;
    await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, killTimeout); })]); clearTimeout(timer);
    if (!attempt.done) {
      try { attempt.child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') logger.error('结束兼容播放进程失败', diagnostics(error.message)); }
      await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, killTimeout); })]); clearTimeout(timer);
    }
  }
  async function installed() {
    if (available !== undefined) return available;
    if (!availability) availability = (async () => {
      let attempt, timer;
      try {
        attempt = availabilityAttempt = runProcess(['-version']);
        await Promise.race([attempt.promise, new Promise(done => { timer = setTimeout(done, probeTimeout); })]);
        available = attempt.done && !attempt.error && attempt.code === 0;
        if (!available) lastError = 'FFmpeg 不可用，请检查安装或 FFMPEG_PATH';
      } catch { available = false; lastError = 'FFmpeg 不可用，请检查安装或 FFMPEG_PATH'; }
      finally { clearTimeout(timer); await terminate(attempt); availabilityAttempt = undefined; }
      return available;
    })();
    return availability;
  }
  const valid = task => !closed && !task.stopped && current === task && (() => { try { return task.valid() === true; } catch { return false; } })();
  const assertValid = task => { if (!valid(task)) throw failure('播放会话或资源配置已变更，请重新打开影片', 409); };
  async function removeOutput(task) {
    if (!task.dir) return;
    const path = resolve(task.dir), root = resolve(tmpRoot);
    if (!path.startsWith(root + sep) || !path.split(sep).at(-1).startsWith('vipvideo-transcode-')) throw failure('兼容播放临时目录无效');
    await rm(path, { recursive: true, force: true });
  }
  async function cleanup(task) {
    if (task.cleaning) return task.cleaning;
    task.cleaning = (async () => {
      task.stopped = true; clearTimeout(task.idleTimer); task.probeController?.abort();
      await terminate(task.attempt);
      for (const socket of task.sockets || []) socket.destroy();
      if (task.bridge?.listening) await new Promise(done => task.bridge.close(done));
      await removeOutput(task);
      if (current === task) current = undefined;
    })().finally(() => { delete task.cleaning; });
    return task.cleaning;
  }
  function armIdle(task) {
    clearTimeout(task.idleTimer);
    task.idleTimer = setTimeout(() => { cleanup(task).catch(error => logger.error('清理兼容播放失败', diagnostics(error.message))); }, idleTimeout);
    task.idleTimer.unref?.();
  }
  function signedPath(value, origin, proxyPath = '/api/media') {
    const parsed = new URL(value, origin), token = parsed.searchParams.get('token');
    if (parsed.origin !== origin || parsed.pathname !== proxyPath || parsed.hash || [...parsed.searchParams].length !== 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token || '')) throw failure('媒体清单包含不安全的转发地址');
    let extension = 'ts';
    try {
      const data = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      const suffix = new URL(data.url).pathname.match(/\.(m3u8|mp4|m4s|ts|aac|vtt|key)$/i)?.[1]?.toLowerCase();
      extension = data.type === 'hls' ? 'm3u8' : ['mp4', 'mkv', 'webm', 'avi'].includes(data.type) ? data.type : suffix || 'ts';
    } catch { throw failure('媒体清单转发凭证无效'); }
    return `${origin}/api/media/asset.${extension}?token=${token}`;
  }
  function bridgeManifest(body, origin, proxyPath) {
    if (Buffer.byteLength(body) > 2 * 1024 * 1024 || !body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) throw failure('兼容播放收到无效媒体清单');
    return body.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return signedPath(trimmed, origin, proxyPath);
      return line.replace(/\bURI\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi, (_match, quoted, single, bare) => {
        if (single !== undefined || bare !== undefined) throw failure('媒体清单 URI 格式无效');
        return `URI="${signedPath(quoted, origin, proxyPath)}"`;
      });
    }).join('\n');
  }
  async function bridge(task) {
    const server = task.bridge = createServer(async (req, res) => {
      try {
        assertValid(task);
        const origin = task.origin, parsed = new URL(req.url, origin);
        if (!['GET', 'HEAD'].includes(req.method) || parsed.origin !== origin || req.headers.host !== new URL(origin).host || !/^\/api\/media\/asset\.(?:m3u8|mp4|mkv|webm|avi|m4s|ts|aac|vtt|key)$/.test(parsed.pathname) || [...parsed.searchParams].length !== 1 || !parsed.searchParams.get('token')) throw failure('转发请求无效', 403);
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => { if (String(name).toLowerCase() === 'location') throw failure('媒体转发禁止重定向'); return setHeader(name, value); };
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...args) => {
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
          if (task.position > 0 && task.type !== 'hls' && range && Number(range[1]) > 0 && [200, 206].includes(status) &&
              !matchingRange(status, name => res.getHeader(name), Number(range[1]), range[2] ? Number(range[2]) : undefined)) {
            task.inputError = notSeekable(); res.destroy(); return res;
          }
          return writeHead(status, ...args);
        };
        const end = res.end.bind(res);
        res.end = (body, encoding, callback) => {
          if (body && /mpegurl/i.test(String(res.getHeader('Content-Type') || ''))) {
            body = bridgeManifest(Buffer.isBuffer(body) ? body.toString('utf8') : String(body), origin, task.proxyPath);
            res.setHeader('Content-Length', Buffer.byteLength(body));
          }
          return end(body, encoding, callback);
        };
        await task.media.serve(req, res, parsed.searchParams.get('token'));
      } catch (error) {
        if (res.destroyed) return;
        if (!res.headersSent) { res.statusCode = error.status || 502; res.removeHeader('Content-Length'); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('兼容播放媒体转发失败'); }
        else res.destroy(error);
      }
    });
    task.sockets = new Set(); server.on('connection', socket => { task.sockets.add(socket); socket.once('close', () => task.sockets.delete(socket)); });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); }); });
    task.origin = `http://127.0.0.1:${server.address().port}`;
    return signedPath(task.playback.proxyUrl, task.origin, task.proxyPath);
  }
  async function checkResumeRange(task, deadline) {
    if (task.position === 0 || task.type === 'hls') return;
    const controller = task.probeController = new AbortController();
    const remaining = deadline - now();
    if (remaining <= 0) throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
    const startupLimited = remaining <= 8000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.min(8000, remaining));
    let response;
    try {
      response = await fetch(task.input, { headers: { Range: 'bytes=1-1' }, redirect: 'error', signal: controller.signal });
      assertValid(task);
      if (!matchingRange(response.status, name => response.headers.get(name), 1, 1)) {
        if ([200, 206, 416].includes(response.status)) throw task.inputError = notSeekable();
        throw failure('无法检查原文件的定位续播能力，请稍后重试或换官方在线线路');
      }
    } catch (error) {
      assertValid(task);
      if (task.inputError) throw task.inputError;
      if (timedOut && startupLimited || now() >= deadline) throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
      throw error.status ? error : failure('无法检查原文件的定位续播能力，请稍后重试或换官方在线线路', 502, error);
    } finally {
      clearTimeout(timer);
      if (response?.body) await response.body.cancel().catch(error => { if (!controller.signal.aborted) logger.error('结束续播检查失败', diagnostics(error.message)); });
      if (task.probeController === controller) delete task.probeController;
    }
  }
  function argumentsFor(task, acceleration) {
    const scale = "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
    return ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-threads', '1', '-filter_threads', '1',
      ...(acceleration === 'vaapi' ? ['-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi'] : []),
      '-protocol_whitelist', 'http,tcp,crypto', '-readrate', String(task.speed), ...(task.position > 0 ? ['-ss', String(task.position)] : []), '-f', inputFormats[task.type],
      ...(task.type === 'hls' ? ['-allowed_extensions', 'ALL'] : []), '-i', task.input,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', acceleration === 'vaapi' ? "scale_vaapi=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12" : `${scale},format=yuv420p`,
      '-c:v', acceleration === 'vaapi' ? 'h264_vaapi' : 'libx264', ...(acceleration === 'vaapi' ? ['-rc_mode', 'VBR', '-b:v', '2500k'] : ['-preset', 'veryfast', '-crf', '23']),
      '-maxrate', '3500k', '-bufsize', '7000k', '-r', '30', '-threads', '1', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '30', '-hls_flags', 'delete_segments+temp_file', '-hls_segment_filename', join(task.dir, 'segment%06d.ts'), join(task.dir, 'index.m3u8')];
  }
  async function ready(task, deadline) {
    while (now() < deadline) {
      assertValid(task);
      if (task.inputError) throw task.inputError;
      try {
        const body = await readFile(join(task.dir, 'index.m3u8'), 'utf8');
        const segments = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
        if (Buffer.byteLength(body) > 128 * 1024 || !body.startsWith('#EXTM3U') || segments.some(file => !/^segment\d{6,12}\.ts$/.test(file))) throw failure('兼容播放输出清单无效');
        if (segments.length && (await stat(join(task.dir, segments[0]))).size > 0) { task.produced = true; return; }
      } catch (error) { if (!['ENOENT'].includes(error.code)) throw error; }
      assertValid(task);
      if (task.inputError) throw task.inputError;
      if (task.attempt.done) throw failure('FFmpeg 未能启动兼容编码，请检查输入格式或硬件权限');
      await wait(Math.min(pollInterval, Math.max(1, deadline - now())));
    }
    throw failure('兼容播放启动超时，请切换线路或稍后重试', 504);
  }
  return {
    async status() { return { available: enabled && !closed ? await installed() : available === true, enabled: enabled && !closed, acceleration: preference, running: !!current && !current.stopped, ...(lastError ? { error: lastError } : {}) }; },
    async start({ episode, position = 0, speed = 1, owner, valid: isValid, mediaOverride, proxyPath = '/api/media' } = {}) {
      if (!enabled || closed) throw failure('兼容播放已关闭', 503);
      const selectedMedia = mediaOverride ?? media;
      if (!selectedMedia?.playback || !selectedMedia?.serve) throw failure('兼容播放需要签名媒体转发模块', 503);
      if (typeof owner !== 'string' || !owner || owner.length > 256 || typeof isValid !== 'function' || !Number.isFinite(position) || position < 0 || position > 604800 || !speeds.has(speed) || !Object.hasOwn(inputFormats, episode?.type) || typeof episode.url !== 'string' || episode.url.length > 8192 || !/^\/api\/[a-z0-9/_-]{1,120}$/.test(proxyPath)) throw failure('兼容播放参数无效', 400);
      const url = validateUrl(episode.url).href;
      if (current && !current.stopped && current.owner !== owner) throw failure('另一台设备正在使用兼容播放，请稍后再试', 409);
      const previous = current, task = { id: randomBytes(16).toString('hex'), owner, valid: isValid, position, speed, type: episode.type, duration: null, stopped: false, media: selectedMedia, proxyPath };
      current = task;
      try {
        if (previous) await cleanup(previous);
        assertValid(task); if (!await installed()) throw failure(lastError, 503); assertValid(task);
        task.playback = selectedMedia.playback({ lines: [{ episodes: [{ url, type: task.type }] }] }, 0, 0);
        task.dir = await mkdtemp(join(tmpRoot, 'vipvideo-transcode-')); assertValid(task);
        task.input = await bridge(task); assertValid(task);
        let acceleration = 'software';
        if (preference !== 'software') {
          try { await access(device, constants.R_OK | constants.W_OK); acceleration = 'vaapi'; }
          catch { if (preference === 'vaapi' || !allowSoftware) throw failure('GPU 不可访问，已停止兼容播放以避免软件编码，请检查核显映射与权限', 503); }
        }
        if (acceleration === 'software' && !allowSoftware) throw failure('软件兼容编码已关闭，请使用可用的核显或切换播放线路', 503);
        const deadline = now() + startupTimeout;
        await checkResumeRange(task, deadline); assertValid(task);
        for (;;) {
          assertValid(task);
          task.attempt = runProcess(argumentsFor(task, acceleration), text => {
            task.durationText = ((task.durationText || '') + text).slice(-2048);
            const match = task.durationText.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
            if (match) {
              const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
              if (Number(match[2]) < 60 && Number(match[3]) < 60 && Number.isFinite(duration) && duration <= 604800) task.duration = duration;
            }
          });
          try { await ready(task, deadline); break; }
          catch (error) {
            const files = await readdir(task.dir).catch(() => []);
            if (preference === 'vaapi' || !allowSoftware || acceleration !== 'vaapi' || files.some(file => /^segment\d{6,12}\.ts$/.test(file)) || !valid(task) || now() >= deadline) throw error;
            await terminate(task.attempt); await removeOutput(task); await mkdir(task.dir, { mode: 0o700 }); acceleration = 'software';
          }
        }
        assertValid(task); lastError = undefined; armIdle(task);
        return { id: task.id, url: `/api/transcode/${task.id}/index.m3u8`, type: 'hls', transcoded: true, startPosition: position, duration: task.duration, acceleration };
      } catch (error) {
        lastError = error.status ? error.message : '兼容播放启动失败，请检查 FFmpeg';
        if (task.attempt?.stderr) logger.error('兼容播放失败', diagnostics(task.attempt.stderr));
        await cleanup(task); throw error.status ? error : failure(lastError, 502);
      }
    },
    async serve(req, res, id, file) {
      const task = current;
      if (!task || task.id !== id || !/^[a-f0-9]{32}$/.test(id) || typeof file !== 'string' || !assetName.test(file)) throw failure('兼容播放资源不存在', 404);
      if (!valid(task)) { await cleanup(task); throw failure('播放会话或资源配置已变更', 409); }
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) throw failure('不支持的媒体请求方法', 400);
      const path = join(task.dir, file);
      let info;
      try { const canonical = await realpath(path); if (!canonical.startsWith(resolve(task.dir) + sep)) throw failure('媒体文件路径无效', 403); info = await stat(canonical); }
      catch (error) { if (error.code === 'ENOENT') throw failure('兼容播放分片尚未生成或已过期', 404); throw error; }
      if (!info.isFile()) throw failure('媒体文件无效', 403);
      assertValid(task); armIdle(task);
      let start = 0, end = info.size - 1;
      if (req.headers?.range && file !== 'index.m3u8') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) throw failure('Range 请求格式无效', 400);
        if (match[1]) { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
        else start = Math.max(0, info.size - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${info.size}`); res.end(); return; }
        end = Math.min(end, info.size - 1); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      } else res.statusCode = 200;
      res.setHeader('Content-Type', file === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      await pipeline(createReadStream(path, { start, end }), res);
    },
    async cancel(id, owner) { if (!current || current.id !== id) return false; if (current.owner !== owner) throw failure('只能停止当前设备发起的兼容播放', 403); await cleanup(current); return true; },
    async close() { closed = true; if (current) await cleanup(current); await terminate(availabilityAttempt); },
  };
}
