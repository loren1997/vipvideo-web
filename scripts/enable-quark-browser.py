#!/usr/bin/env python3
"""Add the isolated browser to one existing VipVideo Compose file."""

import argparse
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def patch_config(config):
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
    services["quark-browser"] = {
        "image": image,
        "command": ["node", "browser-worker.mjs"],
        "restart": "unless-stopped",
        "init": True,
        "environment": {"PORT": "3020", "HOME": "/tmp"},
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


def update_file(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Compose 文件不存在或是符号链接，未修改。")
    original = path.read_bytes()
    current = compose_config(path)
    updated = patch_config(current)
    candidate = secure_file(path.parent, ".quark-browser-candidate-", (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode(), ".json")
    try:
        checked = compose_config(candidate, current["name"])
        existing = current["services"].get("quark-browser")
        if existing is not None and existing != checked["services"]["quark-browser"]:
            raise ValueError("已有 quark-browser 服务与本脚本配置不同，未覆盖。")
        retained = copy.deepcopy(checked)
        retained["services"].pop("quark-browser", None)
        expected = copy.deepcopy(current)
        expected["services"].pop("quark-browser", None)
        expected["services"]["web"].setdefault("environment", {})["QUARK_BROWSER_URL"] = "http://quark-browser:3020"
        if retained != expected:
            raise ValueError("配置检查发现原服务、项目名、网络或数据卷发生变化，未覆盖。")
        if checked == current:
            return "浏览器助手已配置，无需修改。"
        if path.read_bytes() != original:
            raise ValueError("Compose 文件在检查期间被修改，请重试；未覆盖。")
        backup = secure_file(path.parent, path.name + ".before-quark-browser-", original, ".bak")
        os.replace(candidate, path)
        return "已补充浏览器助手；原配置备份：" + backup.name
    finally:
        candidate.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", action="append", help="现用的单个 Compose 文件；默认按 Compose 文件优先顺序查找")
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
        print(update_file(Path(filename[0]).absolute()))
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
