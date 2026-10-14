import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createQuarkChromiumLauncher } from '../lib/quark-chromium-launcher.mjs';

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

test('Windows stays headless and never starts a virtual display', async () => {
  let actual;
  const launch = createQuarkChromiumLauncher({ platform: 'win32', spawn: () => assert.fail('No raw process on Windows'), managedLaunch: async value => { actual = value; return {}; } });
  await launch({ ...options(), headless: false });
  assert.equal(actual.headless, true);
  assert.deepEqual(actual.args, safeArgs);
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
