# 夸克搜索与播放

夸克功能可按影片标题和年份搜索公开分享元数据，再选择一个视频文件转存、播放。默认使用公开网页搜索；可选 PanSou 助手增加搜索渠道。搜索结果不代表链接仍有效，也不保证涵盖全部资源。

搜索不需要夸克 Cookie。Cookie 具有访问账号网盘的高权限，访问自己的网盘、转存和获取播放地址时，只在受保护的应用设置页填写自己的 Cookie 并启用夸克功能；请勿将 Cookie 写进 Compose、环境变量或聊天。凭证仅在服务端加密保存，设置页只返回凭证配置状态，普通配置导出不包含凭证。

## 可选搜索助手

在现有 `docker-compose.yml` 所在目录下载附加文件：

```sh
curl -fL -o compose.quark.yaml https://raw.githubusercontent.com/loren1997/vipvideo-web/main/compose.quark.yaml
docker compose -f docker-compose.yml -f compose.quark.yaml up -d
```

Ubuntu Docker 已启用 Intel GPU 的部署继续使用原 GPU 文件：

```sh
docker compose -f docker-compose.yml -f compose.gpu.yaml -f compose.quark.yaml up -d
```

后续 `pull`、`up`、`ps` 均使用同一组 `-f` 参数。附加文件合并到现有 `web` 服务，保留原文件中的 `APP_PASSWORD`、端口、数据卷和 GPU 配置。

助手只在容器网络监听 `8888`，不发布 NAS 主机端口；应用访问固定 `http://pansou:8888/api/search`。如果设置页保存了其他公网搜索 API，请清空该设置以使用助手；未启用助手且未配置公网 API 时，继续使用网页搜索。不要将 Cookie 发送给搜索服务。

```sh
docker compose -f docker-compose.yml -f compose.quark.yaml ps
docker compose -f docker-compose.yml -f compose.quark.yaml exec -T pansou wget -qO- http://127.0.0.1:8888/api/health
```

使用 GPU 文件时，上述检查命令也加入 `-f compose.gpu.yaml`。健康检查仅证明助手运行，搜索仍依赖外部网站的可达性。

## 资源与隐私

附加文件使用[官方 PanSou API 镜像](https://github.com/fish2018/pansou)，固定摘要 `sha256:d371fe5caa87794414dd54cda063fcfc456d5013e18b65dbf1f6ca17f6299492`；2026-10-13 匿名核验包含 `linux/amd64` 和 `linux/arm64`，对应上游源码提交 `221665fb2c9279f22af4684ea2d8c0c331eac1cc`。

只启用 `pansearch`、`quark4k`、`quarktv` 三个影视网盘插件与一个影视频道 `Quark_Movies`。按[官方参数说明](https://github.com/fish2018/pansou/blob/main/README.md)限制并发为 2、插件超时为 6 秒、缓存为 32 MiB，并限制容器使用 0.5 CPU / 384 MiB 内存。缓存放在临时内存目录，重启后可重新生成；助手不挂载应用数据卷，不接触夸克账号。

应用搜索传输仅为固定助手地址开放内部 HTTP；其他地址继续检查公网 DNS、协议和重定向。搜索头不携带 Cookie、Authorization 或 API 密钥，每次请求连同正文最多 8 秒，响应最多 2 MiB。

## 自动转存与清理

初始状态关闭夸克功能、自动转存和自动清理。按需要在设置页启用。自动转存只处理当前选中的一个视频，默认每日最多 10 次、合计 20 GiB，单文件最多 100 GiB，同时受你设置的每日总额度限制（默认 20 GiB）；不会将搜索结果或整个分享目录全部转存。实际容量和播放速度受你的网盘空间、会员权益、平台接口及网络条件影响。

自动清理默认保留 7 天，可调整为 1–365 天或关闭。只有确认已观看完成的、本应用转存登记的视频才进入清理范围；距最近观看或活动满保留期限，且没有活跃播放租约后，每天检查一次，每轮最多清理 5 个；容器重启后按上次检查时间继续，到期不会重新等待整天。未看完的视频及你原有的网盘文件不会被这项清理删除。删除后只移除该文件对应的回收站条目，以实际释放网盘容量，不清空其他回收站文件。

凭证使用 AES-256-GCM 加密保存在 SQLite 中，加密密钥为数据卷里的 `/app/data/quark.key`。备份、恢复或迁移时同时保留整个数据卷中的 SQLite 文件和该密钥；仅恢复数据库将无法解密原凭证。密钥与数据库同处一个数据卷，应按原部署说明保护和备份该卷。

## 已验证的范围

本轮验证了官方镜像的公开摘要与双架构信息、搜索传输的安全边界和固定样例。当前开发机没有 Docker 和真实夸克账户；Docker 流水线检查助手容器启动与健康状态，真实账号转存、会员权益或播放速度需要部署后验证，不保证转存成功、会员速度或特定画质；不会绕过验证码、会员限制或限速。

PanSou 为独立服务，本项目没有复制其实现。上游版权为 fish2018，许可见[官方 MIT LICENSE](https://github.com/fish2018/pansou/blob/main/LICENSE)，使用说明见[项目 README](https://github.com/fish2018/pansou/blob/main/README.md)。公开搜索结果不意味着获得影视内容授权，请使用自己有权访问和观看的资源。
