import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const updater = new URL('../../scripts/enable-quark-browser.py', import.meta.url);
const candidates = process.platform === 'win32'
  ? ['D:/codex插件/tools/python/cpython-3.12.15-windows-x86_64-none/python.exe', 'python', 'python3']
  : ['python3', 'python'];
const python = candidates.find(value => spawnSync(value, ['--version'], { windowsHide: true, encoding: 'utf8' }).status === 0);

test('the deployment updater preserves credentials, GPU devices, volumes and other services, backs up atomically and is idempotent', { skip: !existsSync(updater) ? 'Deployment helper is outside the runtime image' : !python && 'Python 3 is required for the optional NAS update helper' }, () => {
  const result = spawnSync(python, ['-c', String.raw`
import contextlib, copy, io, json, os, pathlib, re, runpy, stat, sys, tempfile
namespace = runpy.run_path(sys.argv[1])
secret = 'keep-$notset-' + '$' + '{HOME}-$$-secret'
def escape_compose(value):
  if isinstance(value, str): return value.replace('$', '$$')
  if isinstance(value, list): return [escape_compose(item) for item in value]
  if isinstance(value, dict): return {key: escape_compose(item) for key, item in value.items()}
  return value
original = {"name": "family-existing-project", "services": {
  "web": {"image": "ghcr.io/loren1997/vipvideo-web:latest", "environment": {"APP_PASSWORD": secret, "TRANSCODE_ACCEL": "vaapi"},
          "devices": [{"source": "/dev/dri", "target": "/dev/dri", "permissions": "rwm"}], "group_add": ["109"],
          "volumes": [{"type": "volume", "source": "family_data", "target": "/app/data"}], "networks": {"family": {"aliases": ["player"]}},
          "labels": {"custom": "keep-" + "$" + "{HOME}-$notset-$$"}},
  "pansou": {"image": "example/pansou@sha256:" + "a" * 64, "environment": {"CUSTOM": "keep"}},
  "plex": {"image": "example/plex", "devices": ["/dev/dri:/dev/dri"]}},
  "volumes": {"family_data": {"name": "actual-existing-data"}}, "networks": {"family": {"name": "existing-family-network"}}}
with tempfile.TemporaryDirectory() as directory:
  path = pathlib.Path(directory) / "docker-compose.yml"
  canonical = escape_compose(original)
  before = (json.dumps(canonical) + "\n").encode()
  path.write_bytes(before)
  def interpolate(value):
    if isinstance(value, str):
      return re.sub(r'\$\$|\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)', lambda match: '$' if match[0] == '$$' else os.environ.get(match[1] or match[2], ''), value)
    if isinstance(value, list): return [interpolate(item) for item in value]
    if isinstance(value, dict): return {key: interpolate(item) for key, item in value.items()}
    return value
  def config(file, project=None):
    assert project is None or project == original["name"]
    return escape_compose(interpolate(json.loads(file.read_text())))
  namespace["update_file"].__globals__["compose_config"] = config
  namespace["main"].__globals__["compose_config"] = config
  namespace["main"].__globals__["update_file"] = namespace["update_file"]
  sys.argv = [str(sys.argv[1]), "--file", str(path)]
  os.environ.pop("COMPOSE_FILE", None)
  output = io.StringIO()
  with contextlib.redirect_stdout(output): namespace["main"]()
  assert secret not in output.getvalue()
  after = config(path)
  assert after["name"] == original["name"]
  assert after["volumes"] == original["volumes"] and after["networks"] == original["networks"]
  assert after["services"]["pansou"] == original["services"]["pansou"]
  assert after["services"]["plex"] == original["services"]["plex"]
  expected_web = copy.deepcopy(canonical["services"]["web"])
  expected_web["environment"]["QUARK_BROWSER_URL"] = "http://quark-browser:3020"
  assert after["services"]["web"] == expected_web
  runtime = interpolate(json.loads(path.read_text()))
  assert runtime["services"]["web"]["environment"]["APP_PASSWORD"] == secret
  assert runtime["services"]["web"]["labels"] == original["services"]["web"]["labels"]
  worker = after["services"]["quark-browser"]
  assert worker["networks"] == {"family": None}, "web's IP/aliases must not be copied to the worker"
  assert worker["read_only"] is True and worker["init"] is True
  assert worker["environment"] == {"PORT": "3020", "HOME": "/tmp"}
  proxied = copy.deepcopy(original)
  proxied["services"]["web"]["environment"]["QUARK_SEARCH_PROXY"] = "http://192.168.1.10:7890"
  proxied_worker = namespace["patch_config"](proxied)["services"]["quark-browser"]
  assert proxied_worker["environment"] == {"PORT": "3020", "HOME": "/tmp", "QUARK_SEARCH_PROXY": "http://192.168.1.10:7890"}
  assert not any(key in worker for key in ["ports", "volumes", "devices", "privileged"])
  assert worker["cpus"] == .5 and worker["pids_limit"] == 256
  assert any(value.startswith("/app/data:") for value in worker["tmpfs"])
  backups = list(path.parent.glob("*.bak"))
  assert len(backups) == 1 and backups[0].read_bytes() == before
  if os.name != "nt": assert stat.S_IMODE(path.stat().st_mode) == stat.S_IMODE(backups[0].stat().st_mode) == 0o600
  written = path.read_bytes()
  with contextlib.redirect_stdout(output): namespace["main"]()
  assert path.read_bytes() == written and len(list(path.parent.glob("*.bak"))) == 1
  assert secret not in output.getvalue()
  danmaku_path = path.parent / "docker-danmaku.json"
  danmaku_path.write_bytes(before)
  message = namespace["update_file"](danmaku_path, danmaku=True)
  enriched = config(danmaku_path)
  token = enriched["services"]["web"]["environment"]["DANMAKU_API_TOKEN"]
  assert re.fullmatch(r"[A-Za-z0-9_-]{32}", token)
  assert token not in message and secret not in message
  assert enriched["services"]["pansou"] == original["services"]["pansou"]
  assert enriched["services"]["plex"] == original["services"]["plex"]
  assert enriched["volumes"] == original["volumes"] and enriched["networks"] == original["networks"]
  expected_danmaku_web = copy.deepcopy(expected_web)
  expected_danmaku_web["environment"].update({"DANMAKU_API_URL": "http://danmaku:9321", "DANMAKU_API_TOKEN": token})
  assert enriched["services"]["web"] == expected_danmaku_web
  helper = enriched["services"]["danmaku"]
  assert helper["environment"]["TOKEN"] == token
  assert helper["environment"]["SOURCE_ORDER"] == "tencent,iqiyi,youku,imgo,bilibili"
  assert helper["environment"]["YOUKU_CONCURRENCY"] == "2" and helper["environment"]["DANMU_LIMIT"] == "5"
  assert helper["environment"]["SEARCH_CACHE_MINUTES"] == "5"
  assert helper["environment"]["OTHER_SERVER"] == "http://127.0.0.1:9321/disabled"
  assert helper["networks"] == {"family": None}
  assert helper["read_only"] and helper["cpus"] == .5 and helper["mem_limit"] == "512m"
  assert not any(key in helper for key in ("ports", "devices", "privileged", "volumes"))
  enriched_bytes = danmaku_path.read_bytes()
  namespace["update_file"](danmaku_path, danmaku=True)
  assert danmaku_path.read_bytes() == enriched_bytes, "random token must remain stable on a repeated update"
  enriched["services"]["danmaku"]["ports"] = ["9321:9321"]
  danmaku_path.write_text(json.dumps(enriched))
  conflict_danmaku = danmaku_path.read_bytes()
  try: namespace["update_file"](danmaku_path, danmaku=True)
  except ValueError: pass
  else: raise AssertionError("custom danmaku service must not be overwritten")
  assert danmaku_path.read_bytes() == conflict_danmaku
  after["services"]["quark-browser"]["ports"] = ["3020:3020"]
  path.write_text(json.dumps(after))
  conflict = path.read_bytes()
  try: namespace["update_file"](path)
  except ValueError: pass
  else: raise AssertionError("custom browser service must not be overwritten")
  assert path.read_bytes() == conflict
  after["services"]["web"]["image"] = "ghcr.io/loren1997/vipvideo-web-other:latest"
  try: namespace["patch_config"](after)
  except ValueError: pass
  else: raise AssertionError("unrelated image must be refused")
  previous = pathlib.Path.cwd()
  try:
    os.chdir(directory)
    (path.parent / 'compose.override.yml').write_text('services: {}')
    sys.argv = ['enable-quark-browser.py']
    with contextlib.redirect_stderr(io.StringIO()):
      try: namespace["main"]()
      except SystemExit as error: assert error.code == 2
      else: raise AssertionError('implicit override must be refused')
    assert path.read_bytes() == conflict
  finally: os.chdir(previous)
print("preservation, private backup, conflict rejection and idempotence passed")
`, fileURLToPath(updater)], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes('keep-$notset-${HOME}-$$-secret'), false);
  assert.match(result.stdout, /preservation.*idempotence passed/);
});

test('every supplied Compose deploys an isolated browser from the same candidate image without changing the workflow', { skip: !existsSync(new URL('../../compose.yaml', import.meta.url)) && 'Deployment files are outside the runtime image' }, () => {
  for (const filename of ['compose.yaml', 'docker-compose.yml', 'docker-compose.nas.yml']) {
    const source = readFileSync(new URL('../../' + filename, import.meta.url), 'utf8');
    assert.match(source, /x-browser-image: &browser-image\r?\n  image: "\$\{CI_IMAGE:-/);
    assert.equal((source.match(/^    image:/gm) || []).length, filename === 'docker-compose.nas.yml' ? 3 : 2);
    const browser = source.split('  quark-browser:')[1].split(/^  [\w-]+:/m)[0];
    assert.match(browser, /<<: \*browser-image/);
    assert.match(browser, /HOME: \/tmp/);
    assert.match(browser, /\/app\/data:size=16m,uid=1000,gid=1000,mode=0700/);
    assert.doesNotMatch(browser, /APP_PASSWORD|^    (?:ports|volumes|devices|depends_on):/m);
    assert.match(source, /QUARK_BROWSER_URL: http:\/\/quark-browser:3020/);
    assert.match(source, /DANMAKU_API_URL: http:\/\/danmaku:9321/);
    const danmaku = source.split('  danmaku:')[1].split(/^  [\w-]+:/m)[0];
    assert.match(danmaku, /image: logvar\/danmu-api@sha256:[a-f0-9]{64}/);
    assert.match(danmaku, /read_only: true/); assert.match(danmaku, /mem_limit: 512m/); assert.match(danmaku, /cpus: 0\.5/);
    assert.doesNotMatch(danmaku, /^    (?:ports|volumes|devices|privileged):/m);
    assert.match(danmaku, /SOURCE_ORDER: tencent,iqiyi,youku,imgo,bilibili/);
    assert.match(danmaku, /YOUKU_CONCURRENCY: "2"/); assert.match(danmaku, /DANMU_LIMIT: "5"/);
    assert.match(danmaku, /SEARCH_CACHE_MINUTES: "5"/);
    assert.match(danmaku, /OTHER_SERVER: http:\/\/127\.0\.0\.1:9321\/disabled/);
    assert.equal((source.match(/^\s+QUARK_SEARCH_PROXY:/gm) || []).length, 2);
  }
  assert.ok(existsSync(updater));
});
