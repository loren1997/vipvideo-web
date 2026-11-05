import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createQuarkChromiumLauncher } from '../lib/quark-chromium-launcher.mjs';
import { createQuarkBrowser } from '../lib/quark-browser.mjs';
import { chromium } from 'playwright-core';

const safeArgs = ['--mute-audio', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND', '--js-flags=--max-old-space-size=128'];
const options = () => ({ executablePath: '/synthetic/chromium', headless: true, timeout: 2500, args: [...safeArgs] });
const endpoint = port => `ws://127.0.0.1:${port}/devtools/browser/11111111-2222-3333-4444-555555555555`;

function fixture({ message = endpoint(31337), connectImpl, mode = 'ready', reapDelay = 0, output = 'stderr', interleave = false } = {}) {
  const children = [], connections = [], signals = [], calls = [], protocol = [];
  let disconnected = false;
  const browser = {
    isConnected: () => !disconnected,
    async close() { disconnected = true; },
    async newBrowserCDPSession() { return { send: async method => { protocol.push(method); } }; },
  };
  const launch = createQuarkChromiumLauncher({
    platform: 'linux', xvfbRun: () => '/synthetic/xvfb-run', reservePort: async () => 31337,
    spawn(command, args, configuration) {
      const child = Object.assign(new EventEmitter(), { pid: 500000 + children.length, stdout: new PassThrough(), stderr: new PassThrough(), reaped: false });
      children.push(child); calls.push({ command, args, configuration });
      setImmediate(() => {
        if (mode === 'ready') {
          child[output].write('Xvfb fixture diagnostic\nDevTools listening on ');
          if (interleave) child[output === 'stdout' ? 'stderr' : 'stdout'].write('Other stream diagnostic\n');
          child[output].write(message + '\n');
        } else if (mode === 'oversized') {
          child[output].write('x'.repeat(65537));
        } else if (mode === 'occupied') {
          child.stderr.write('bind failed: Address already in use\n');
          child.emit('exit', 1); child.reaped = true; child.emit('close', 1);
        }
      });
      return child;
    },
    killGroup(pid, signal) {
      signals.push({ pid, signal });
      const child = children.find(value => value.pid === pid);
      if (!child.reaped) setTimeout(() => { if (!child.reaped) { child.reaped = true; child.emit('exit', 0); child.emit('close', 0); } }, reapDelay);
    },
    async connect(address, configuration) { connections.push({ address, configuration }); return connectImpl ? connectImpl(address, browser) : browser; },
  });
  const profile = () => calls.at(-1)?.args.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  return { launch, browser, calls, connections, signals, protocol, children, profile, disconnected: () => disconnected };
}

test('Windows cancellation reaps its owned process before releasing a disconnected browser and the render queue', async () => {
  let actual, entered, releaseClientClose, releaseServerClose, disconnected = false, reaped = false, killed = 0;
  const contextEntered = new Promise(resolve => { entered = resolve; });
  const clientClose = new Promise(resolve => { releaseClientClose = resolve; });
  const serverClose = new Promise(resolve => { releaseServerClose = resolve; });
  const child = Object.assign(new EventEmitter(), { pid: 700001, exitCode: null, signalCode: null });
  const browser = {
    version: () => '1.0', isConnected: () => !disconnected,
    newBrowserCDPSession: async () => ({ send: async method => { assert.equal(method, 'Browser.close'); disconnected = true; } }),
    newContext: () => { disconnected = true; entered(); return new Promise(() => {}); },
    close: () => { disconnected = true; return clientClose; },
  };
  const launch = createQuarkChromiumLauncher({ platform: 'win32', spawn: () => assert.fail('No raw Chromium process on Windows'),
    managedLaunch: async () => browser,
    launchServer: async value => { actual = value; return { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:31337/owned-browser', close: () => { disconnected = true; return serverClose; } }; },
    connectServer: async () => browser,
    killTree: async pid => {
      assert.equal(pid, child.pid); assert.equal(disconnected, true); assert.equal(reaped, false); killed++;
      await new Promise(resolve => setTimeout(resolve, 20));
      reaped = true; child.exitCode = 0; child.emit('close', 0); releaseServerClose();
    },
  });
  const renderer = createQuarkBrowser({ executablePath: 'synthetic-browser', launch });
  const controller = new AbortController(), pending = renderer.render('https://public.example/', { signal: controller.signal });
  const outcome = pending.then(() => 'unexpected success', error => error.message);
  try {
    await contextEntered; controller.abort(new Error('cancel owned Windows renderer'));
    assert.equal(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('close still pending'), 1500))]), 'cancel owned Windows renderer');
    assert.equal(reaped, true); assert.equal(killed, 1);
    assert.equal(actual.headless, true); assert.equal(actual.host, '127.0.0.1'); assert.ok(safeArgs.every(value => actual.args.includes(value)));
    const next = createQuarkBrowser({ executablePath: 'synthetic-browser', launch: async () => { throw new Error('next queue job started'); } });
    try { await assert.rejects(next.render('https://public.example/'), error => error.cause?.message === 'next queue job started'); }
    finally { await next.close(); }
  } finally { releaseClientClose(); releaseServerClose(); await outcome; await renderer.close(); }
});

test('Windows kills the owned tree before Chrome can exit and orphan a crashpad process holding its pipes', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 700005, exitCode: null, signalCode: null });
  let parentExited = false, helperReaped = false, disconnected = false, gracefulCalls = 0;
  const browser = { isConnected: () => !disconnected, close: async () => { disconnected = true; }, newBrowserCDPSession: async () => ({ send: async () => {
    gracefulCalls++; parentExited = true; disconnected = true; child.exitCode = 0; child.emit('exit', 0);
    // A crashpad helper inherited the pipes, so ChildProcess.close never follows this exit.
  } }) };
  const launch = createQuarkChromiumLauncher({ platform: 'win32', launchServer: async () => ({ process: () => child, wsEndpoint: () => 'ws://127.0.0.1:31337/crashpad', close: async () => { assert.equal(helperReaped, true); } }),
    connectServer: async () => browser, killTree: async pid => {
      assert.equal(pid, child.pid);
      if (parentExited) throw new Error('The parent PID is gone while crashpad still holds its pipes');
      parentExited = true; helperReaped = true; child.exitCode = 0; child.emit('close', 0);
    },
  });
  const instance = await launch(options()); await instance.close();
  assert.equal(helperReaped, true); assert.equal(gracefulCalls, 0); assert.equal(disconnected, true);
});

test('Windows expired deadlines refuse startup before launching any process', async () => {
  const launch = createQuarkChromiumLauncher({ platform: 'win32', launchServer: () => assert.fail('Expired launch must not start Chromium') });
  await assert.rejects(launch(options(), { deadline: Date.now() - 1 }), { name: 'TimeoutError', code: 'CHROMIUM_START_TIMEOUT' });
});

test('Windows cancelled startup cleans a late server before connecting and reserves its cleanup time', async () => {
  const controller = new AbortController(), deadline = Date.now() + 1000;
  const child = Object.assign(new EventEmitter(), { pid: 700002, exitCode: null, signalCode: null });
  let actual, cleaned = false, killed = false;
  const launch = createQuarkChromiumLauncher({ platform: 'win32',
    launchServer: async value => {
      actual = value; controller.abort(new Error('cancel during Windows startup'));
      await new Promise(resolve => setTimeout(resolve, 20));
      return { process: () => child, wsEndpoint: () => 'ws://127.0.0.1:31337/late', close: async () => { assert.equal(killed, true); cleaned = true; } };
    },
    connectServer: () => assert.fail('Cancelled startup cannot connect'),
    killTree: async pid => { assert.equal(pid, child.pid); killed = true; child.exitCode = 0; child.emit('close', 0); },
  });
  await assert.rejects(launch(options(), { signal: controller.signal, deadline }), /cancel during Windows startup/);
  assert.ok(actual.timeout <= 750); assert.equal(cleaned, true); assert.equal(child.exitCode, 0);
});

test('Windows startup that returns after its deadline still has a bounded reserve to reap its owned process', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const controller = new AbortController(), child = Object.assign(new EventEmitter(), { pid: 700004, exitCode: null, signalCode: null });
  let cleaned = false;
  const launch = createQuarkChromiumLauncher({ platform: 'win32', launchServer: async () => {
    controller.abort(new Error('cancel overdue Windows startup')); t.mock.timers.tick(2000);
    return { process: () => child, close: async () => { cleaned = true; } };
  }, connectServer: () => assert.fail('An overdue cancelled startup cannot connect'), killTree: async (pid, milliseconds) => {
    assert.equal(pid, child.pid); assert.ok(milliseconds >= 1000 && milliseconds <= 1500);
    child.exitCode = 0; child.emit('close', 0);
  } });
  await assert.rejects(launch(options(), { signal: controller.signal, deadline: 11000 }), /cancel overdue Windows startup/);
  assert.equal(cleaned, true); assert.equal(child.exitCode, 0);
});

test('Windows cleanup failures are reported instead of treating disconnect or an unreturned close as process cleanup', async () => {
  for (const [mode, code] of [['close-reject', 'CHROMIUM_CLOSE_FAILED'], ['close-hang', 'CHROMIUM_CLEANUP_TIMEOUT'], ['kill-reject', 'CHROMIUM_CHILD_KILL_FAILED'], ['unreaped', 'CHROMIUM_CHILD_NOT_REAPED']]) {
    const child = Object.assign(new EventEmitter(), { pid: 700003, exitCode: null, signalCode: null });
    let closeCalled = false;
    const browser = { isConnected: () => false, close: async () => {} };
    const launch = createQuarkChromiumLauncher({ platform: 'win32',
      launchServer: async () => ({ process: () => child, wsEndpoint: () => 'ws://127.0.0.1:31337/failure', close: async () => {
        assert.equal(child.exitCode, 0, 'SDK cleanup cannot kill a live process through an unhidden shell'); closeCalled = true;
        if (mode === 'close-reject') throw new Error('profile cleanup failed');
        return new Promise(() => {});
      } }),
      connectServer: async () => browser,
      killTree: async () => {
        if (mode === 'kill-reject') throw new Error('hidden kill failed');
        if (mode !== 'unreaped') { child.exitCode = 0; child.emit('close', 0); }
      },
    });
    const instance = await launch(options(), { deadline: Date.now() + 90 });
    await assert.rejects(instance.close(), { code });
    assert.equal(closeCalled, mode.startsWith('close-'));
    assert.equal(child.exitCode === 0, mode.startsWith('close-'));
  }
});

test('Linux reports missing Xvfb and refuses conflicting network or automation flags before spawning', async () => {
  const missing = createQuarkChromiumLauncher({ platform: 'linux', xvfbRun: () => undefined, spawn: () => assert.fail('Unavailable launch must not spawn') });
  await assert.rejects(missing(options()), { code: 'CHROMIUM_XVFB_UNAVAILABLE', quarkPoolReason: 'browserUnavailable' });
  const value = fixture();
  for (const args of [[], [...safeArgs, '--remote-debugging-pipe'], [...safeArgs, '--enable-automation'], [...safeArgs, '--disable-blink-features=AutomationControlled'], [...safeArgs, '--proxy-server=http://different-proxy.example'], [...safeArgs, '--ignore-certificate-errors']]) await assert.rejects(value.launch({ ...options(), args }), { code: 'CHROMIUM_LAUNCH_ARGUMENT_CONFLICT' });
  assert.equal(value.calls.length, 0);
});

test('only the owned process endpoint is attached, with a private display/profile and no startup tab', async () => {
  const value = fixture({ reapDelay: 25 });
  const browser = await value.launch(options());
  const { command, args, configuration } = value.calls[0];
  const profile = value.profile();
  assert.equal(command, '/synthetic/xvfb-run');
  assert.deepEqual(args.slice(0, 6), ['-a', '-f', path.join(profile, 'Xauthority'), '-s', '-screen 0 1280x900x24 -nolisten tcp', '/synthetic/chromium']);
  assert.ok(safeArgs.every(argument => args.includes(argument)));
  assert.ok(args.includes('--no-startup-window'));
  assert.ok(args.includes('--remote-debugging-port=31337'));
  assert.ok(!args.includes('about:blank'));
  assert.ok(!args.some(argument => /^--(?:headless|enable-automation|remote-debugging-pipe)/.test(argument)));
  assert.deepEqual(configuration.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(configuration.detached, true);
  assert.equal(configuration.windowsHide, true);
  assert.ok(existsSync(profile));
  assert.equal(value.connections[0].address, endpoint(31337));
  await Promise.all([browser.close(), browser.close()]);
  assert.deepEqual(value.protocol, ['Browser.close']);
  assert.ok(value.disconnected());
  assert.ok(value.children.every(child => child.reaped));
  assert.ok(value.signals.some(row => row.signal === 'SIGTERM'));
  assert.ok(value.signals.some(row => row.signal === 'SIGKILL'));
  assert.ok(!existsSync(profile));
});

test('foreign or malformed CDP endpoints never attach and their child/profile are cleaned', async () => {
  for (const output of ['stdout', 'stderr']) {
    for (const message of [endpoint(31338), endpoint(31337).replace('127.0.0.1', '192.168.1.1'), endpoint(31337).replace('/devtools/browser/', '/devtools/page/')]) {
      const value = fixture({ message, output });
      await assert.rejects(value.launch(options()), { code: 'CHROMIUM_CDP_ENDPOINT_INVALID' });
      assert.equal(value.connections.length, 0);
      assert.ok(value.children[0].reaped);
      assert.ok(!existsSync(value.profile()));
    }
  }
});

test('Ubuntu redirected stdout and stderr keep separate buffers when endpoint fragments interleave', async () => {
  for (const output of ['stdout', 'stderr']) {
    const value = fixture({ output, interleave: true });
    const browser = await value.launch(options());
    assert.equal(value.connections[0].address, endpoint(31337));
    await browser.close();
    assert.ok(value.children[0].reaped);
    assert.ok(!existsSync(value.profile()));
  }
});

test('either owned output stream rejects oversized unterminated lines and reaps its child', async () => {
  for (const output of ['stdout', 'stderr']) {
    const value = fixture({ output, mode: 'oversized' });
    await assert.rejects(value.launch(options()), { code: `CHROMIUM_${output.toUpperCase()}_TOO_LARGE` });
    assert.equal(value.connections.length, 0);
    assert.ok(value.children[0].reaped);
    assert.ok(!existsSync(value.profile()));
  }
});

test('a port collision fails without probing or attaching the existing service', async () => {
  const value = fixture({ mode: 'occupied' });
  await assert.rejects(value.launch(options()), error => error.code === 'CHROMIUM_EXITED_BEFORE_CDP' && /Address already in use/.test(error.chromiumStderr));
  assert.equal(value.connections.length, 0);
  assert.ok(!existsSync(value.profile()));
});

test('cancelled startup waits for its child to be reaped and removes its profile', async () => {
  const value = fixture({ mode: 'silent', reapDelay: 30 }), controller = new AbortController();
  const launching = value.launch(options(), { signal: controller.signal });
  const rejected = assert.rejects(launching, /cancel startup/);
  while (!value.calls.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel startup'));
  await rejected;
  assert.equal(value.connections.length, 0);
  assert.ok(value.children[0].reaped);
  assert.ok(!existsSync(value.profile()));
});

test('cancelling a CDP connection closes a late connection and releases the child', async () => {
  const controller = new AbortController();
  let resolveConnection;
  const value = fixture({ connectImpl: () => { controller.abort(new Error('cancel CDP')); return new Promise(resolve => { resolveConnection = resolve; }); } });
  await assert.rejects(value.launch(options(), { signal: controller.signal }), /cancel CDP/);
  resolveConnection(value.browser);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(value.disconnected());
  assert.ok(value.children[0].reaped);
  assert.ok(!existsSync(value.profile()));
});

test('a startup deadline includes process termination and profile cleanup', async () => {
  const value = fixture({ mode: 'silent' }), started = Date.now();
  await assert.rejects(value.launch({ ...options(), timeout: 800 }, { deadline: Date.now() + 800 }), { name: 'TimeoutError' });
  assert.ok(Date.now() - started < 1200);
  assert.ok(value.children[0].reaped);
  assert.ok(!existsSync(value.profile()));
});

const linuxExecutablePath = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(candidate => existsSync(candidate));
const windowsExecutablePath = [process.env.CHROMIUM_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(candidate => candidate && existsSync(candidate));
test('real Windows cancellation reaps the owned Chromium and the next renderer job still completes', { skip: process.platform !== 'win32' || !windowsExecutablePath, timeout: 15000 }, async () => {
  const children = [], profiles = [];
  let entered, stall = true;
  const requestStarted = new Promise(resolve => { entered = resolve; });
  const launch = createQuarkChromiumLauncher({ launchServer: async value => {
    const server = await chromium.launchServer(value), child = server.process(); children.push(child);
    profiles.push(child.spawnargs.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length));
    return server;
  } });
  const renderer = createQuarkBrowser({ executablePath: windowsExecutablePath, launch, safeRequest: async (url, { signal }) => {
    assert.equal(new URL(url).hostname, 'public.example');
    if (!stall) return Object.assign(Readable.from(['<main>公开读取恢复正常</main>']), { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    entered();
    return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); });
  } });
  const controller = new AbortController();
  const cancelled = assert.rejects(renderer.render('https://public.example/stalled', { signal: controller.signal, deadline: Date.now() + 8000 }), /cancel real owned Chromium/);
  try {
    await requestStarted; controller.abort(new Error('cancel real owned Chromium')); await cancelled;
    assert.equal(children.length, 1); assert.throws(() => process.kill(children[0].pid, 0), { code: 'ESRCH' });
    stall = false;
    const page = await renderer.render('https://public.example/ready', { deadline: Date.now() + 6000 });
    assert.match(page.text, /公开读取恢复正常/);
  } finally { controller.abort(); await renderer.close(); }
  assert.equal(children.length, 2);
  for (const child of children) { assert.ok(child.exitCode !== null || child.signalCode !== null); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); }
  for (const profile of profiles) { assert.ok(profile); assert.equal(existsSync(profile), false); }
});
const realLinux = process.platform === 'linux' && linuxExecutablePath && existsSync('/usr/bin/xvfb-run');
test('real isolated Linux Chromium starts without tabs, keeps webdriver unchanged and reaps Xvfb', { skip: !realLinux, timeout: 25000 }, async t => {
  let child, profile;
  const launch = createQuarkChromiumLauncher({ spawn(command, args, configuration) { profile = args.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length); child = spawn(command, args, configuration); return child; } });
  let browser;
  try { browser = await launch({ ...options(), executablePath: linuxExecutablePath, timeout: 20000 }); }
  catch (error) { t.diagnostic(JSON.stringify({ executablePath: linuxExecutablePath, chromiumStderr: error.chromiumStderr || '', chromiumStdout: error.chromiumStdout || '' })); throw error; }
  try {
    assert.equal(browser.contexts().flatMap(context => context.pages()).length, 0);
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    assert.equal(page.url(), 'about:blank');
    assert.deepEqual(await page.evaluate(() => ({ webdriver: navigator.webdriver, headingCount: document.querySelectorAll('h3').length })), { webdriver: false, headingCount: 0 });
  } finally { await browser.close(); }
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(!existsSync(profile));
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
});
