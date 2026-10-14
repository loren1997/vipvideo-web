import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import { chromium } from 'playwright-core';

export const chromiumCleanupBudget = (deadline, now = Date.now()) => Math.min(1500, Math.max(0, (deadline - now) / 4));
const failure = (code, cause) => Object.assign(new Error('动态网页浏览器无法启动', cause ? { cause } : undefined), { code, status: 503, quarkPoolReason: 'browserUnavailable' });
const timeoutFailure = () => Object.assign(failure('CHROMIUM_START_TIMEOUT'), { name: 'TimeoutError' });
const timeout = (promise, milliseconds, fallback) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, milliseconds)); })]).finally(() => clearTimeout(timer));
};

async function availablePort(signal) {
  const server = net.createServer();
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true, signal }, resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
  } finally { signal?.removeEventListener('abort', abort); }
}

function browserEndpoint(value, port) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw failure('CHROMIUM_CDP_ENDPOINT_INVALID'); }
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(port) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/devtools\/browser\/[a-f0-9-]{16,}$/i.test(endpoint.pathname)) throw failure('CHROMIUM_CDP_ENDPOINT_INVALID');
  return endpoint.href;
}

export function createQuarkChromiumLauncher({ platform = process.platform, spawn = spawnProcess, reservePort = availablePort,
  xvfbRun = () => ['/usr/bin/xvfb-run', '/bin/xvfb-run'].find(existsSync),
  connect = (endpoint, options) => chromium.connectOverCDP(endpoint, options), managedLaunch = options => chromium.launch(options),
  killGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  return async function launch(options, { signal, deadline = Date.now() + (options.timeout || 25000) } = {}) {
    signal?.throwIfAborted();
    if (platform !== 'linux') return managedLaunch({ ...options, headless: true });
    const wrapper = xvfbRun();
    if (!wrapper) throw failure('CHROMIUM_XVFB_UNAVAILABLE');
    const args = options.args || [];
    const required = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND'];
    if (!required.every(value => args.includes(value)) || args.some(value => /^--(?:headless|remote-debugging-(?:pipe|port|address)|enable-automation|user-data-dir|no-proxy-server|proxy-auto-detect|proxy-pac-url|ignore-certificate-errors|allow-insecure-localhost)(?:=|$)/.test(value) || /AutomationControlled/.test(value) || required.some(expected => value.startsWith(expected.split('=')[0] + '=') && value !== expected))) throw failure('CHROMIUM_LAUNCH_ARGUMENT_CONFLICT');
    const workDeadline = Math.min(Date.now() + (options.timeout || 25000), deadline - chromiumCleanupBudget(deadline));
    if (Date.now() >= workDeadline) throw timeoutFailure();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(timeoutFailure()), Math.max(0, workDeadline - Date.now()));
    let profile, child, browser, disconnect, connecting, closing, reaped = false, stderr = '';
    let resolveReaped;
    const closed = new Promise(resolve => { resolveReaped = resolve; });
    const stopGroup = mode => {
      if (!child?.pid) return;
      try { killGroup(child.pid, mode); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const cleanup = () => closing ||= (async () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const end = Math.min(deadline, Date.now() + 1500), left = () => Math.max(0, end - Date.now());
      try {
        if (browser?.isConnected() && disconnect) {
          const session = await timeout(browser.newBrowserCDPSession().catch(() => null), Math.min(200, left() / 4), null);
          if (session) await timeout(session.send('Browser.close').catch(() => {}), Math.min(250, left() / 4));
          await timeout(disconnect().catch(() => {}), Math.min(150, left() / 4));
        }
        if (child && !reaped) await timeout(closed, Math.min(250, left() / 4));
        stopGroup('SIGTERM');
        if (child && !reaped) await timeout(closed, Math.min(250, left() / 3));
        stopGroup('SIGKILL');
        if (child && !reaped) await timeout(closed, left());
        if (child && !reaped) throw Object.assign(failure('CHROMIUM_CHILD_NOT_REAPED'), { quarkPoolReason: 'browserFailed', status: 502 });
      } finally {
        if (profile && (!child || reaped)) {
          const absolute = path.resolve(profile), prefix = path.join(path.resolve(tmpdir()), 'vipvideo-quark-chromium-');
          if (!absolute.startsWith(prefix)) throw failure('CHROMIUM_PROFILE_SCOPE_INVALID');
          await rm(absolute, { recursive: true, force: true });
        }
      }
    })();
    // The launch promise/returned close also await this task, preserving cleanup errors.
    const abortCleanup = () => { if (child) cleanup().catch(() => {}); };
    controller.signal.addEventListener('abort', abortCleanup);
    try {
      const port = await reservePort(controller.signal);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('CHROMIUM_CDP_PORT_INVALID');
      controller.signal.throwIfAborted();
      profile = await mkdtemp(path.join(tmpdir(), 'vipvideo-quark-chromium-'));
      controller.signal.throwIfAborted();
      const rawArgs = [...args, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-background-networking', '--no-startup-window'];
      child = spawn(wrapper, ['-a', '-f', path.join(profile, 'Xauthority'), '-s', '-screen 0 1280x900x24 -nolisten tcp', options.executablePath, ...rawArgs], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const endpoint = new Promise((resolve, reject) => {
        let pending = '';
        child.once('error', error => reject(failure('CHROMIUM_PROCESS_START_FAILED', error)));
        child.once('exit', () => reject(failure('CHROMIUM_EXITED_BEFORE_CDP')));
        child.stderr.on('data', chunk => {
          pending += chunk.toString();
          if (pending.length > 65536) { reject(failure('CHROMIUM_STDERR_TOO_LARGE')); pending = ''; return; }
          const lines = pending.split(/\r?\n/); pending = lines.pop();
          for (const line of lines) {
            const match = /^DevTools listening on (\S+)\s*$/.exec(line);
            if (match) { try { resolve(browserEndpoint(match[1], port)); } catch (error) { reject(error); } }
            else stderr = (stderr + line + '\n').slice(-32768);
          }
        });
      });
      child.once('close', () => { reaped = true; resolveReaped(); });
      const aborted = new Promise((_, reject) => { const rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, { once: true }); if (controller.signal.aborted) rejectAbort(); });
      const address = await Promise.race([endpoint, aborted]);
      controller.signal.throwIfAborted();
      connecting = connect(address, { timeout: Math.max(1, workDeadline - Date.now()) });
      connecting.then(value => { if (controller.signal.aborted) value.close().catch(() => {}); }).catch(() => {});
      browser = await Promise.race([connecting, aborted]);
      disconnect = browser.close.bind(browser);
      browser.close = cleanup;
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      return browser;
    } catch (error) {
      await cleanup();
      if (stderr) error.chromiumStderr = stderr;
      throw error;
    }
  };
}

export const launchQuarkChromium = createQuarkChromiumLauncher();
