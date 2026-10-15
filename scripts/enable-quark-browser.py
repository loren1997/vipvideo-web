#!/usr/bin/env python3
"""Add the isolated browser to one existing VipVideo Compose file."""

import argparse
import copy
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile


def patch_config(config, danmaku=False):
    updated = copy.deepcopy(config)
    services = updated.get("services", {})
    web = services.get("web", {})
    image = web.get("image", "")
    if not isinstance(updated.get("name"), str) or not updated["name"].strip():
        raise ValueError("现有配置缺少项目 name，未修改。")
    if not isinstance(image, str) or not re.fullmatch(
        r"(?:ghcr\.io/loren1997/vipvideo-web(?::[A-Za-z0-9_][A-Za-z0-9_.-]*|@sha256:[a-fA-F0-9]{64})|vipvideo-web:local)", image
    ):
        raise ValueError("web.image 不是本项目的镜像，未修改。")
    if web.get("network_mode"):
        raise ValueError("此脚本需要 web 使用 Compose 网络，未修改 network_mode。")
    environment = web.setdefault("environment", {})
    if not isinstance(environment, dict):
        raise ValueError("Docker 返回的 web.environment 格式无效，未修改。")
    address = "http://quark-browser:3020"
    if environment.get("QUARK_BROWSER_URL") not in (None, "", address):
        raise ValueError("已有其他 QUARK_BROWSER_URL，未覆盖。")
    environment["QUARK_BROWSER_URL"] = address
    worker_environment = {"PORT": "3020", "HOME": "/tmp"}
    if "QUARK_SEARCH_PROXY" in environment:
        worker_environment["QUARK_SEARCH_PROXY"] = environment["QUARK_SEARCH_PROXY"]
    services["quark-browser"] = {
        "image": image,
        "command": ["node", "browser-worker.mjs"],
        "restart": "unless-stopped",
        "init": True,
        "environment": worker_environment,
        "networks": {name: None for name in web.get("networks", {"default": None})},
        "read_only": True,
        "tmpfs": ["/tmp:size=192m,mode=1777", "/app/data:size=16m,uid=1000,gid=1000,mode=0700"],
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "cpus": 0.5,
        "cpu_shares": 128,
        "mem_limit": "512m",
        "memswap_limit": "512m",
        "pids_limit": 256,
    }
    if danmaku:
        address = "http://danmaku:9321"
        if environment.get("DANMAKU_API_URL") not in (None, "", address):
            raise ValueError("已有其他 DANMAKU_API_URL，未覆盖。")
        token = environment.get("DANMAKU_API_TOKEN") or secrets.token_urlsafe(24)
        if not isinstance(token, str) or not re.fullmatch(r"[\w-]{8,128}", token, re.ASCII):
            raise ValueError("已有弹幕服务令牌格式无效，未修改。")
        environment.update({"DANMAKU_API_URL": address, "DANMAKU_API_TOKEN": token})
        services["danmaku"] = {
            "image": "logvar/danmu-api@sha256:7c6c80e6e51d0a77aaa8745a1cbaf95fe333118697d3fdaaabc5ca3bc24e5529",
            "restart": "unless-stopped",
            "init": True,
            "environment": {"TOKEN": token, "SOURCE_ORDER": "tencent,iqiyi,youku,imgo,bilibili", "RATE_LIMIT_MAX_REQUESTS": "0", "OTHER_SERVER": "http://127.0.0.1:9321/disabled", "YOUKU_CONCURRENCY": "2", "DANMU_LIMIT": "5", "SEARCH_CACHE_MINUTES": "5"},
            "networks": {name: None for name in web.get("networks", {"default": None})},
            "read_only": True,
            "tmpfs": ["/tmp:size=32m,mode=1777", "/app/.cache:size=96m,mode=1777", "/app/config:size=2m,mode=1777"],
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "cpus": 0.5,
            "cpu_shares": 128,
            "mem_limit": "512m",
            "memswap_limit": "512m",
            "pids_limit": 128,
            "healthcheck": {
                "test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:9321/'+process.env.TOKEN+'/api/v2/search/anime?keyword=',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok)throw Error();const j=await r.json();if(j.success!==true||!Array.isArray(j.animes))throw Error()}).catch(()=>process.exit(1))"],
                "interval": "30s", "timeout": "5s", "retries": 3, "start_period": "30s",
            },
        }
    return updated


def secure_file(directory, prefix, content, suffix):
    descriptor, filename = tempfile.mkstemp(dir=directory, prefix=prefix, suffix=suffix)
    with os.fdopen(descriptor, "wb") as stream:
        os.chmod(filename, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return Path(filename)


def compose_config(path, project=None):
    command = ["docker", "compose", "--project-directory", str(path.parent), "-f", str(path)]
    if project:
        command += ["-p", project]
    try:
        result = subprocess.run(command + ["config", "--format", "json"], capture_output=True, text=True, timeout=30,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except subprocess.TimeoutExpired as error:
        output = error.stderr or b"docker compose config exceeded 30 seconds\n"
        log = secure_file(path.parent, ".quark-browser-error-", output.encode() if isinstance(output, str) else output, ".log")
        raise ValueError("Docker 配置检查超过 30 秒，未修改；错误已保存在权限 0600 的 " + log.name) from None
    if result.returncode:
        log = secure_file(path.parent, ".quark-browser-error-", result.stderr.encode(), ".log")
        raise ValueError("Docker 配置检查失败，未修改；错误已保存在权限 0600 的 " + log.name)
    return json.loads(result.stdout)


def update_file(path, danmaku=False):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Compose 文件不存在或是符号链接，未修改。")
    original = path.read_bytes()
    current = compose_config(path)
    updated = patch_config(current, danmaku=danmaku)
    candidate = secure_file(path.parent, ".quark-browser-candidate-", (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode(), ".json")
    try:
        checked = compose_config(candidate, current["name"])
        helpers = ["quark-browser", *(["danmaku"] if danmaku else [])]
        for name in helpers:
            existing = current["services"].get(name)
            if existing is not None and existing != checked["services"][name]:
                raise ValueError("已有 " + name + " 服务与本脚本配置不同，未覆盖。")
        retained = copy.deepcopy(checked)
        expected = copy.deepcopy(current)
        for name in helpers:
            retained["services"].pop(name, None)
            expected["services"].pop(name, None)
        expected["services"]["web"].setdefault("environment", {})["QUARK_BROWSER_URL"] = "http://quark-browser:3020"
        if danmaku:
            for key in ("DANMAKU_API_URL", "DANMAKU_API_TOKEN"):
                expected["services"]["web"]["environment"][key] = updated["services"]["web"]["environment"][key]
        if retained != expected:
            raise ValueError("配置检查发现原服务、项目名、网络或数据卷发生变化，未覆盖。")
        if checked == current:
            return "播放助手已配置，无需修改。"
        if path.read_bytes() != original:
            raise ValueError("Compose 文件在检查期间被修改，请重试；未覆盖。")
        backup = secure_file(path.parent, path.name + ".before-quark-browser-", original, ".bak")
        os.replace(candidate, path)
        return "已补充播放助手；原配置备份：" + backup.name
    finally:
        candidate.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", action="append", help="现用的单个 Compose 文件；默认按 Compose 文件优先顺序查找")
    parser.add_argument("--danmaku", action="store_true", help="同时加入内部多平台弹幕服务，自动生成独立令牌")
    args = parser.parse_args()
    configured = [value for value in os.environ.get("COMPOSE_FILE", "").split(os.environ.get("COMPOSE_PATH_SEPARATOR", os.pathsep)) if value]
    if len(args.file or []) > 1 or len(configured) > 1:
        parser.error("仅支持单文件；保留现有 GPU 等 overlay，先手动合并并校验，不能省略正在使用的文件。")
    if not args.file and any(Path(name).is_file() for name in ("compose.override.yml", "compose.override.yaml", "docker-compose.override.yml", "docker-compose.override.yaml")):
        parser.error("发现自动加载的 override 文件；先保留全部配置并手动合并，不能忽略核显等附加设置。")
    filename = (args.file or configured or [name for name in ("compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml") if Path(name).is_file()])
    if not filename:
        parser.error("未找到 Compose 文件，请使用 --file 指定现用文件。")
    try:
        print(update_file(Path(filename[0]).absolute(), danmaku=args.danmaku))
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
