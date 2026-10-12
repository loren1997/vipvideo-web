# VipVideo Web 播放器

在原 [VipVideo](https://github.com/iodefog/VipVideo) 项目中新增 `web/` 应用，使用原生 JavaScript、Node.js 24、SQLite 与 HLS.js。中文界面适配电脑和手机，一个家庭密码共享收藏、记录和观看进度。原 iOS 项目及其说明仍在原位置；来源与版权见 [web/NOTICE.md](web/NOTICE.md)。

项目仓库：[loren1997/vipvideo-web](https://github.com/loren1997/vipvideo-web)。部署镜像：`ghcr.io/loren1997/vipvideo-web:latest`。

首页直接展示电影、电视剧和动漫海报，可按分类、影视源浏览及加载更多。点开影片会自动选择上次观看的剧集及进度，或第一集，优先使用 MP4/HLS 线路；播放失败会先尝试受限媒体转发，再尝试其他匹配源，仍可手动换源、选集。另支持聚合搜索、收藏、倍速、全屏、下一集和资源管理。内置爱坤、暴风和豪华三个抽样验证过的公开接口，保留上游 16 个视频平台、44 条解析线路。请求每源超时 8 秒、最多 3 个并发，个别源失败单独显示。第三方解析网页可尝试嵌入或在外部打开，只保存链接历史。

## NAS 直接部署镜像

本项目公开源码和镜像。部署前先查看 [镜像发布 Actions](https://github.com/loren1997/vipvideo-web/actions/workflows/docker-publish.yml) 的最新运行是否全部通过。发布工作流构建并检查 `linux/amd64` 和 `linux/arm64` 镜像；NAS 不需要下载源码或本地构建。

镜像发布且 GitHub Actions 通过后，只需 [下载 docker-compose.yml](https://raw.githubusercontent.com/loren1997/vipvideo-web/main/docker-compose.yml)，在 NAS 的 Compose 项目中编辑这个文件：

1. 将 `APP_PASSWORD: ""` 改为至少 16 位随机密码，保持引号；留空会拒绝启动。端口冲突时把 `"3000:3000"` 左边改为需要的主机端口。
2. 创建并启动项目，项目名称保持 `vipvideo-web`。文件已配置实际镜像地址，此部署不需要额外 `.env` 文件。

有终端的 NAS 可运行：

```sh
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail=100 web
```

本仓库镜像已公开，并通过匿名拉取验证，NAS 无需登录 GitHub。若自行 Fork 或新建发布仓库，首次发布的 GHCR 镜像包默认是私有；仓库所有者需在自己的镜像包设置中完成 **Change visibility → Public**，公开源码不会自动公开镜像。见 [GitHub 包可见性说明](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)。自行改为私有镜像时，NAS 需先登录 GHCR，使用有 `read:packages` 权限的 classic PAT，按 [GHCR 官方认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)配置；不要将 PAT 写入 Compose、镜像或仓库。

浏览器访问 `http://NAS的局域网IP:3000`，输入密码后即可浏览内置源的电影、电视剧和动漫，也可在设置页管理或导入其他影视源。需要 Docker Engine 和 Docker Compose v2；建议至少 1 GB 内存。应用不转码，媒体转发时带宽会经过部署主机。容器健康检查由镜像提供，使用非 root 用户运行，数据保存在命名卷中。

## 从源码本地构建

已有源码时使用单独的 [compose.yaml](compose.yaml)，明确指定 `-f compose.yaml`，与 NAS 镜像部署文件区分：

在项目根目录执行：

```sh
cp .env.example .env
```

Windows PowerShell 使用：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

编辑 `.env` 的 `APP_PASSWORD`，至少 8 个字符，建议使用至少 16 位随机密码。不要使用示例密码或把 `.env` 提交到版本库。之后执行：

```sh
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 web
```

浏览器访问 `http://部署主机的局域网IP:3000`，输入密码后即可浏览影片。`/health` 用于容器健康检查，不需要登录。Compose 默认在主机的 3000 端口监听；限制局域网访问可使用主机防火墙。已有端口冲突时，只把 Compose 的 `"3000:3000"` 左边改为所需主机端口。

容器使用 `node` 用户（UID/GID 1000），数据写入命名卷 `vipvideo_data`，实际卷名通常带 Compose 项目前缀。默认卷会继承镜像中 `/app/data` 的权限。若在 NAS 中改成绑定宿主目录，需事先让 UID/GID 1000 有读写权限；保留命名卷通常更省事。没有必要把常驻服务改成 root。

## 配置影视源与播放

首次启动已配置爱坤、暴风和豪华三个源。旧版本升级时，仅为没有影视源的旧配置初始化一次内置源；已有自定义配置保持不变。也可以在设置页点击“添加内置影视源”，按源标识合并；删除或停用源后不会在每次重启时强制恢复。

“三级”分类默认隐藏。在设置页勾选“显示‘三级’分类”并保存后，首页会增加该分类；取消后，分类、对应搜索结果、收藏和观看记录会隐藏，正在播放的相关内容停止并返回电影分类。记录仍保存在数据库中，重新开启可继续观看。开关是整个家庭共用的设置；其他设备正在播放的三级内置视频通过已有的 10 秒进度计时器同步，暂停的视频和第三方网页在重新可见、导航或收到隐藏响应时同步。

敏感内容依据源的分类树、类型、标签和更新信息中的“三级、限制级、成人、伦理、情色、R18、18禁”等明确标记识别，集中归入“三级”，不出现在普通电影、电视剧和动漫分类中。源缺少或错误标记时无法保证识别完整；该开关用于显示管理，不是独立的家长访问密码。

2026-10-13 抽样检查中，三个源均通过电影、电视剧及动漫的 JSON 列表与详情检查，并返回 HLS 播放线路：

| 源 | 接口 | 媒体抽样结果 |
| --- | --- | --- |
| 爱坤资源 | `https://ikunzyapi.com/api.php/provide/vod/from/ikm3u8/` | 主清单包含 1920×804 视频档位；无界面 Chrome 已解码 H.264/AAC 样例 |
| 暴风资源 | `https://bfzyapi.com/api.php/provide/vod` | HLS 清单及 MPEG-TS 分片可访问；清单未提供分辨率 |
| 豪华资源 | `https://hhzyapi.com/api.php/provide/vod` | HLS 清单、分片和公开的 16 字节 AES-128 密钥可访问；清单未提供分辨率 |

这是少量样例的实时检查，不能保证全部影片具有相同画质或始终可用。界面显示接口实际提供的类型和更新信息，不把“更新至第几集”等字段当成 1080p。源的排序、停用及更换仍可在设置页管理。

接口地址参考 [MoonTV 公开配置](https://github.com/Stardm0/MoonTV/blob/main/config.json)，格式兼容 [KatelyaTV 公开配置](https://github.com/katelya77/KatelyaTV/blob/main/config.json)。这些是第三方公开接口，项目不托管影片。若源的父分类接口不能聚合子分类，每页会查询前三个匹配子分类以控制延迟；其他影片仍可通过搜索查找。

若要添加其他源，准备 MoonTV/KatelyaTV 风格的 JSON，粘贴或导入，例如：

```json
{
  "api_site": {
    "my_source": {
      "name": "我的影视源",
      "api": "https://example.com/api.php/provide/vod/"
    }
  }
}
```

`example.com` 是格式占位符，需要换成你自己的可用 AppleCMS JSON 接口。`my_source` 是稳定的源标识；重复导入会校验并按标识合并。可以在设置页新增、编辑、排序、停用或删除源，并导出配置。上游 VipVideo 的平台和解析线路作为初始配置保留，可以同样管理；原有第三方地址可能失效，需要自行更新。

服务端仅请求公网 HTTP/HTTPS 地址。影视 API、媒体地址和重定向都会检查协议及目标 IP，拒绝内网、环回和其他非公网目标；局域网自建 AppleCMS API 不在支持范围内。搜索请求和受限媒体转发均使用该校验；转发地址仅由已配置源返回的播放详情或 HLS 清单生成，不能作为任意 URL 代理。媒体转发凭证有效期为 2 小时，长时间暂停后若转发失效，请重新打开影片播放页获取新凭证。

分类浏览和搜索中的同名、同年份、同类型影片会合并展示，同时保留源选项。点开影片后自动选集并尝试播放；浏览器限制有声自动播放时，点击播放器的播放按钮即可。MP4/HLS 优先直连，跨域失败时尝试受限媒体转发，再在同一影片的候选中自动换源；一轮最多尝试三个不同源，失败后提示手动选择。手动换源先匹配剧集名称，再匹配序号并保留当前进度，无法匹配时重新选择剧集。进度在播放中每 10 秒及暂停时保存，多个设备以服务端最后一次写入为准。

HLS 优先使用支持 MSE 的 HLS.js，浏览器不支持时再尝试原生 HLS。转发 HLS 清单时忽略合法的 Range 并返回完整重写后的清单；MP4 和分片仍保留 Range/206，防止部分清单破坏播放。

第三方解析页可能禁止 iframe、要求自行登录，或只能在外部打开。这类网页无法读取其内部视频时间，不支持精确续播；第三方源本身的可用性、编解码器和浏览器支持也会影响播放。

## 更新、备份与恢复

更新前先备份。NAS 镜像部署更新：

```sh
docker compose -f docker-compose.yml pull && \
docker compose -f docker-compose.yml up -d
```

源码构建则先更新当前目录的源文件，再运行 `docker compose -f compose.yaml up -d --build`。

容器重建会继续使用原数据卷。不要使用 `docker compose -f docker-compose.yml down -v`：`-v` 会删除该项目的命名卷。也不要在没有迁移数据的情况下更换 Compose 项目名称或卷名。

### 停机备份

SQLite 使用 WAL。为避免数据库、WAL 和 SHM 不一致，先停止服务，再复制**整个**数据目录；不要只在线复制 `app.sqlite`。

以下以 NAS 的 `docker-compose.yml` 为例；源码部署将命令中的文件名改为 `compose.yaml`。备份目录名应换成当次时间，且不能是已存在的目录：

Linux/NAS：

```sh
docker compose -f docker-compose.yml stop web && \
docker compose -f docker-compose.yml cp web:/app/data ./backup-20261013-120000 && \
docker compose -f docker-compose.yml start web
```

Windows PowerShell：

```powershell
docker compose -f docker-compose.yml stop web
if ($LASTEXITCODE -ne 0) { throw '停止失败，未执行备份，请查看 Docker 错误。' }
docker compose -f docker-compose.yml cp web:/app/data ./backup-20261013-120000
if ($LASTEXITCODE -ne 0) { throw '备份失败，服务保持停止；查明错误后可手动 start web 恢复原服务。' }
docker compose -f docker-compose.yml start web
if ($LASTEXITCODE -ne 0) { throw '备份已完成，但服务启动失败，请查看 Docker 错误。' }
```

检查备份目录包含 `app.sqlite`，存在的 `app.sqlite-wal`、`app.sqlite-shm` 也一并保留。`compose cp` 可复制停止但尚未删除的容器。不要在复制之前运行 `compose down`。如果复制失败，保留错误输出，失败产生的目录不能用于恢复；原数据没有修改，可通过 `docker compose -f docker-compose.yml start web` 恢复原服务。把备份目录和部署配置保存到安全位置；已填写密码的 Compose 或 `.env` 单独保管，不要上传到仓库。配置导出不包含收藏和观看记录。

### 从备份恢复

恢复会覆盖当前数据。先按上一节备份当前状态，再停止服务。下面的临时辅助容器校验备份包含 `app.sqlite`，清空原数据目录并完整复制，最后修正 UID/GID；服务始终以非 root 身份运行。

Linux/NAS 使用实际的绝对备份路径：

```sh
docker compose -f docker-compose.yml stop web && \
docker compose -f docker-compose.yml run --rm --no-deps --user 0 --entrypoint sh --volume /absolute/path/backup-20261013-120000:/restore:ro web -c 'test -f /restore/app.sqlite && find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /restore/. /app/data/ && chown -R 1000:1000 /app/data' && \
docker compose -f docker-compose.yml start web
```

Windows PowerShell 对应命令：

```powershell
$backupPath = (Resolve-Path -LiteralPath './backup-20261013-120000' -ErrorAction Stop).Path
docker compose -f docker-compose.yml stop web
if ($LASTEXITCODE -ne 0) { throw '停止失败，未执行恢复，请查看 Docker 错误。' }
docker compose -f docker-compose.yml run --rm --no-deps --user 0 --entrypoint sh --volume "${backupPath}:/restore:ro" web -c 'test -f /restore/app.sqlite && find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /restore/. /app/data/ && chown -R 1000:1000 /app/data'
if ($LASTEXITCODE -ne 0) { throw '恢复失败，服务保持停止；请查看错误并从完整备份重新恢复。' }
docker compose -f docker-compose.yml start web
if ($LASTEXITCODE -ne 0) { throw '恢复已完成，但服务启动失败，请查看 Docker 错误。' }
```

只有辅助命令成功退出后再启动；失败时保留备份和错误，修正问题后重新恢复。打开应用确认收藏和进度正常。备份来自新版时，恢复应用也使用相同或更新版本，避免旧代码读新数据库。

## 本地开发与可选 HTTPS

目标运行版本为 Node.js 24。在 `web/` 目录执行 `npm ci`、`npm test`；有可用浏览器时再执行 `npm run test:browser`。本地默认数据目录为 `web/data`；PowerShell 可这样启动：

```powershell
Set-Location web
npm ci
npm test
npm run test:browser
$env:APP_PASSWORD = '替换为你的家庭访问密码'
$env:DATA_DIR = Join-Path (Get-Location).Path 'data'
npm start
```

浏览器验收使用开发依赖 Playwright 1.62.1，自动查找已安装的 Chrome/Edge 或 Playwright Chromium，无界面运行。可设置 `BROWSER_EXECUTABLE` 指定浏览器可执行文件；PowerShell 例如 `$env:BROWSER_EXECUTABLE = 'C:/实际路径/chrome.exe'`。没有可用浏览器时，可自行执行 `npx playwright install chromium`；本次开发没有安装浏览器。Docker 使用 `npm ci --omit=dev`，不包含 Playwright 或浏览器。

开发命令在已有终端中运行，不会自动打开浏览器窗口；后台运行遵循主机现有的静默进程约定。退出服务会关闭数据库。环境变量：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `APP_PASSWORD` | 家庭访问密码，至少 8 个字符；缺失或过短时拒绝启动 | 必填 |
| `PORT` | Node 监听端口 | `3000` |
| `DATA_DIR` | SQLite 与持久数据目录 | 本地 `web/data`，Docker `/app/data` |
| `COOKIE_SECURE` | 会话 Cookie 只通过 HTTPS 发送 | `false` |

默认用于家庭局域网。若部署到 HTTPS 反向代理后，将 NAS Compose 中的 `COOKIE_SECURE` 改为 `"true"`（源码部署修改 `.env`），保留原始 `Host` 请求头并通过 HTTPS 访问；同时限制外部直接访问容器 HTTP 端口。`true` 时不能通过普通 HTTP 登录。代理需要支持媒体流、Range 请求及较长响应，不要给转发媒体加小响应大小限制。

如需在已有 Docker Buildx 环境生成双平台交付归档，可执行：

```sh
docker buildx build --platform linux/amd64,linux/arm64 --tag vipvideo-web:local --output type=oci,dest=vipvideo-web.oci.tar .
```

日常 NAS 使用发布后的镜像和 `docker-compose.yml`；仅源码构建使用 `docker compose -f compose.yaml up -d --build`。

## GitHub Actions 镜像发布

`.github/workflows/docker-publish.yml` 在 `main` 推送、`v*` 标签推送或手动触发时运行。使用 Node.js 24 安装依赖并运行模块/接口测试，再构建双平台镜像，以仓库路径的小写形式推送到 GHCR 的唯一 CI 标签。全部运行检查成功后才为同一个多平台 digest 更新 `latest`，标签触发时也更新小写版本标签。构建或运行检查失败不会更新 `latest` 或版本标签；新任务会取消同一仓库尚未完成的旧发布，避免旧构建晚完成覆盖新发布。

发布使用仓库自动提供的 `GITHUB_TOKEN`，只授予读取代码和写入 Packages 的权限，不需要额外发布密钥。工作流按本次构建的 digest 顺序拉取并运行 amd64、arm64 容器，验证健康接口、未登录限制和登录；arm64 通过 QEMU 实际运行。amd64 还写入样例收藏/进度并重建容器，确认会话及数据在同一卷保留。随后使用实际 NAS Compose 文件的临时副本启动独立项目，确认 Docker 健康状态为 `healthy`，并按本文流程停机备份、修改进度、恢复，再确认原会话、收藏和进度恢复。临时副本仅替换待验收镜像、样例密码和本机端口绑定，结束后清理测试项目及测试卷。只用临时样例密码和空影视源，不请求第三方媒体。

首次部署前，确认 [发布工作流](https://github.com/loren1997/vipvideo-web/actions/workflows/docker-publish.yml) 已成功完成双平台运行检查。本仓库镜像已可匿名拉取；自行 Fork 的发布仓库仍需配置自己的包可见性。工作流不修改 GitHub 包可见性，也不保存家庭访问密码。

## 验证与已知范围

本机使用 Node.js 24.21.0 和 26.3.0 运行模块/接口测试，覆盖配置、分类分页、搜索/详情解析、源超时与并发、认证、SQLite 数据、三级分类开关与缓存、媒体转发、Range 与地址防护。Node.js 24.21.0 便携运行时使用官方下载站点的 Windows 二进制 ZIP，并通过官方 SHA256 校验。

无界面 Chrome 验收使用固定样例与静音媒体检查手机和电脑布局、分类分页、搜索后自动选集、源失败后切换、收藏续播、跨会话同步及 10 秒保存进度。三级分类使用中性的“限制级样例”检查显示、隐藏、记录保留及跨设备开关，不访问真实敏感影片。另抽样检查爱坤实际 H.264/AAC HLS 视频，验证直连和受限媒体转发均能解码并推进播放时间。

Dockerfile 以 Node.js 24 为目标。本机未安装 Docker，双平台镜像在 GitHub Actions 中构建并运行：amd64 与 arm64 检查登录和接口，amd64 还检查容器重建后的会话、收藏和进度；arm64 通过 QEMU 运行。工作流同时验收实际 NAS Compose 文件的启动、Docker 健康状态与停机备份恢复。公开 `latest` 的匿名拉取及两种架构清单已验证。未在实际 NAS 硬件上验收，部署后请检查 `docker compose -f docker-compose.yml ps` 的健康状态，并在你的网络中验证第三方影视源。

没有增加多用户、直播频道管理、下载、弹幕或转码。
