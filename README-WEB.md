# VipVideo Web 播放器

在原 [VipVideo](https://github.com/iodefog/VipVideo) 项目中新增 `web/` 应用，使用原生 JavaScript、Node.js 24、SQLite 与 HLS.js。中文界面适配电脑和手机，一个家庭密码共享收藏、记录和观看进度。原 iOS 项目及其说明仍在原位置；来源与版权见 [web/NOTICE.md](web/NOTICE.md)。

项目仓库：[loren1997/vipvideo-web](https://github.com/loren1997/vipvideo-web)。部署镜像：`ghcr.io/loren1997/vipvideo-web:latest`。

首页直接展示电影、电视剧、动漫和综艺 / 电视节目海报，另有电视直播入口，可按分类、影视源浏览及加载更多。点开影片自动选择上次观看的剧集和进度，或第一集；播放失败会先尝试受限媒体转发，再尝试匹配源，也可手动换源、选集。支持聚合搜索、收藏、快进快退、倍速、跳片头片尾、自动下一集、弹幕和资源维护。内置爱坤、暴风和豪华三个抽样验证过的公开接口，保留上游 16 个视频平台、44 条解析线路。搜索每源超时 8 秒、最多 3 个并发，个别源失败单独显示。第三方解析网页可尝试嵌入或在外部打开，只保存链接历史。

影视浏览新增喜剧、惊悚、恐怖、动作、爱情、科幻、悬疑、犯罪等类型和 1900 年以来的上映年份筛选，电影、电视剧、动漫均可使用。每个源按自身分类 ID 查询，缺少细分类时按 `vod_class` / 类型名称匹配；源没有相应标签时不会根据影片标题猜类型。年份向源传递 `year`，再校验返回数据，防止老接口忽略参数后混入其他年份。源的父类不聚合时会读取全部匹配子类，仍共用最多 3 个请求并发。

“上映时间（已加载）”采用源提供且日期有效的 `vod_pubdate`，多地上映日期取最早一日，缺失或仅有年份的日期排在最后；“年份（已加载）”按影片年份排序，加载更多后重新排序已加载影片。采集接口按资源更新时间分页，因此这两种排序适用于已加载的结果，并非整个远端片库。缺少完整日期时不会将 `vod_time` 更新时间伪装成上映日期。固定样例覆盖源忽略年份参数、不同源分类 ID、影视 / 动漫类型标签、受限动画分类隐藏及非法筛选参数。

浏览与搜索先显示已返回的来源结果，其余来源在后台补齐；浏览结果复用 3 分钟，搜索结果复用 30 秒，播放详情优先处理。电影首屏前 6 张海报优先加载，其余海报与频道标志使用懒加载及异步解码，图片失败时显示影片或频道名称。HLS.js 在首次播放 HLS 时通过同源地址加载，普通首页与 MP4 播放无需先下载该组件。同一加载任务会共享，避免重复请求。

HTML、JavaScript、CSS 和 SVG 静态资源支持 gzip、ETag / Last-Modified 校验及 `304` 响应，刷新时可复用未变化的资源。登录后的配置、记录与媒体接口保持原有缓存限制。实际首屏与播放时间仍受设备、第三方海报、影视接口和网络影响。

服务端定期发现并验证公开的影视 / 直播订阅，更新已知订阅中的可用接口。播放器换源选项及直播频道只展示近期探测通过的线路，真实加载或解码失败后移除失败项。影视接口可访问、少量媒体探测通过和设备实际能解码是不同检查，第三方内容仍可能随时失效。

Android 手机与 Android TV 使用同一安装包，连接局域网 NAS 或你已有的外网地址。下载与连接步骤见 [README-ANDROID.md](README-ANDROID.md)。

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

浏览器访问 `http://NAS的局域网IP:3000`，输入密码后即可浏览内置源的电影、电视剧和动漫，也可在设置页管理或导入其他影视源。需要 Docker Engine 和 Docker Compose v2；建议至少 1 GB 内存。镜像包含 FFmpeg，兼容播放和媒体转发会使用部署主机的带宽，软件转码还会使用 CPU。容器健康检查由镜像提供，使用非 root 用户运行，数据保存在命名卷中。

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

## 兼容播放与 Intel 核显

播放器先尝试直连、受限媒体转发和同影片换源；仍无法播放时会尝试“兼容播放”，也可手动点击该按钮。服务端把当前剧集转为浏览器常见的 H.264/AAC HLS，最多 720p，并保留原影片进度。兼容播放每台服务器同时只运行一个任务；其他设备占用时会提示。没有请求达 120 秒后回收任务与临时分片，收藏、进度和配置仍保存在数据卷。

默认 `TRANSCODE_ACCEL=auto`：有权限读写 `/dev/dri/renderD128` 时先尝试 VAAPI，启动阶段初始化或编码失败后改用 CPU；没有设备时直接使用 CPU。软件编码限制为两条线程，解码和滤镜也限制并发；实际 CPU 消耗仍取决于输入编码、分辨率和倍速，高码率或高分辨率输入可能无法实时处理。arm64 镜像提供软件模式，未安装 x86 Intel 驱动。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TRANSCODE_ENABLED` | `true` | `false` 关闭兼容播放 |
| `TRANSCODE_ACCEL` | `auto` | `auto` 自动选择，`software` 强制 CPU，`vaapi` 尝试 Intel VAAPI |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg 可执行文件路径 |
| `RENDER_GID` | 留空 | 仅 GPU Compose 配置使用；填写 Ubuntu render 设备的数字 GID |

从源码部署时在 `.env` 设置前三项。直接镜像部署时可在 `docker-compose.yml` 的 `environment` 修改前三项；默认配置无需 GPU，也能启动。

### PVE → Ubuntu Docker 的 i3-8100T

[Intel 处理器规格](https://www.intel.com/content/www/us/en/products/sku/129944/intel-core-i38100t-processor-6m-cache-3-10-ghz/specifications.html)列出 i3-8100T 的 UHD 630 和 Quick Sync。[Intel iHD 驱动](https://github.com/intel/media-driver#supported-platforms)支持 Coffee Lake；amd64 镜像安装 [Debian 的完整 iHD 驱动](https://packages.debian.org/bookworm/intel-media-va-driver-non-free)，包含编码使用的媒体着色器。GPU 可用性还取决于虚拟机的设备直通、内核、驱动和权限，Plex 可硬解并不保证本容器已获得相同权限。

在运行 Docker 的 Ubuntu 虚拟机内检查设备和 GID：

```sh
ls -l /dev/dri/renderD128
stat -c '%g' /dev/dri/renderD128
```

Ubuntu 内没有该设备时，先检查现有 PVE 核显直通和 Ubuntu 的 i915 驱动；在设备就绪前可继续使用软件模式。下载与 `docker-compose.yml` 同目录的 [compose.gpu.yaml](https://raw.githubusercontent.com/loren1997/vipvideo-web/main/compose.gpu.yaml)，在该目录创建或编辑 `.env`，加入 `RENDER_GID=上一步输出的数字`。保留已有密码与其他环境变量。

```sh
docker compose -f docker-compose.yml -f compose.gpu.yaml up -d
docker compose -f docker-compose.yml -f compose.gpu.yaml ps
```

从源码部署时把上面命令的 `docker-compose.yml` 换成 `compose.yaml`，首次启动加入 `--build`。GPU 配置仅映射 `/dev/dri` 并补充数字组；服务继续以 `node` 用户运行。无需 `privileged`、root 或放宽设备为所有人可写。升级和重启时继续使用相同的两个 `-f` 文件。

可在容器内运行两秒合成画面检查硬件编码；命令无窗口、无音频，也不生成影片文件：

```sh
docker compose -f docker-compose.yml -f compose.gpu.yaml exec -T web \
  ffmpeg -nostdin -hide_banner -loglevel warning -filter_threads 2 \
  -init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va \
  -f lavfi -i testsrc2=size=1280x720:rate=25 -t 2 \
  -vf format=nv12,hwupload -c:v h264_vaapi -f null -
```

命令失败时保留错误输出，检查 GID、设备权限和 iHD 驱动；应用的 `auto` 模式仍会回退软件转码。播放时会显示当前兼容模式。

跳转或修改倍速会重新建立兼容流。FFmpeg 的 `readrate` 只控制输入读取节奏，输出时间戳保持原速度，由浏览器完成倍速播放；直播兼容播放固定为 1 倍且不提供跳转。临时 HLS 只保留约一分钟的滑动窗口，长时间暂停后恢复或跳到窗口外需重新建立任务。第三方解析网页、DRM 内容和无法读取的源不支持兼容转码。

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

粘贴地址时可自动补全缺少的 `https://`（含域名加端口），识别 `//` 开头、Markdown 链接、引号和代码块，修正 `https\://`、中文冒号和 HTML `&amp;`，将 GitHub 文件的 `blob` / `raw` 页面转换为原始文件地址。原有查询参数及解析线路的 `{url}` 占位符会保留。配置导入支持 JSONC 注释和尾逗号、`api_site` 对象中的 URL 字符串或 `url` / `baseUrl` 别名、非空 `api_site` 数组及只含 `sources` 的配置；TVBox `sites` 中的 type 1 直连 JSON 接口可转换，脚本、爬虫和 XML 接口会跳过并显示提示，全部不兼容时拒绝导入。重复标识和格式错误仍会报错；自动修复不放宽内网、凭据或危险协议的限制。

服务端仅请求公网 HTTP/HTTPS 地址。影视 API、媒体地址和重定向都会检查协议及目标 IP，拒绝内网、环回和其他非公网目标；局域网自建 AppleCMS API 不在支持范围内。搜索请求和受限媒体转发均使用该校验；转发地址仅由已配置源返回的播放详情或 HLS 清单生成，不能作为任意 URL 代理。媒体转发凭证有效期为 2 小时，长时间暂停后若转发失效，请重新打开影片播放页获取新凭证。

分类浏览和搜索中的同名、同年份、同类型影片会合并展示，同时保留源选项。点开影片后自动选集并尝试播放；浏览器限制有声自动播放时，点击播放器的播放按钮即可。MP4/HLS 优先直连，跨域失败时尝试受限媒体转发，再在同一影片的候选中自动换源；一轮最多尝试三个不同源，失败后提示手动选择。手动换源先匹配剧集名称，再匹配序号并保留当前进度，无法匹配时重新选择剧集。进度在播放中每 10 秒及暂停时保存，多个设备以服务端最后一次写入为准。

播放前会探测当前剧集；换源和线路按钮在对应剧集探测通过后显示，等待中的候选会提示正在验证。HLS 检查有限层级的清单、首个分片、初始化片段和所需 AES-128 密钥，MP4 检查响应类型或读取有限字节；每次探测总时限 8 秒、最多 2 个并发，不下载整部影片。成功结果缓存 5 分钟，失败结果缓存 1 分钟，播放器真实成功或失败会更新状态。探测不运行设备编解码器，也不遍历整片分片；后续令牌过期、分片缺失或设备不支持编码时，失败线路仍会移除并尝试其他来源。

HLS 优先使用支持 MSE 的 HLS.js，浏览器不支持时再尝试原生 HLS。转发 HLS 清单时忽略合法的 Range 并返回完整重写后的清单；MP4 和分片仍保留 Range/206，防止部分清单破坏播放。

播放器提供前后 10 秒、0.5–3 倍速及按影片保存的片头 / 片尾秒数。片头和片尾默认均为 0，避免误跳内容；范围为 0–600 秒。片头每集仅自动跳一次，并优先保留较晚的续播位置。开启“自动下一集”后，在片尾阈值或播放结束时切换下一集；没有下一集时停止。倍速、跳过时长及开关由家庭共用，保存在 SQLite。直播没有跳片头片尾、选集、弹幕或点播进度。

## 广告跳过与夸克网盘

播放器可以开启广告跳过，读取完整点播 HLS 中明确、闭合的 CUE / SCTE 广告标记，或手动标记当前线路与当前剧集的广告起止时间。默认关闭；更换源、剧集或夸克画质版本不会沿用其他版本的区间。只有断点标签、没有结束位置、直播、外部插播资产和无法校准时间的标记都会跳过处理。视频画面中已压制的广告、水印或制作标志不能无损擦除；可以跳过确认的时间段。该功能不下载、重写或转码整个影片。

夸克资源发现、当前单集转存、服务端凭证保存、网页播放及观看完成后的定期清理见 [夸克网盘配置说明](README-QUARK.md)。可选 [compose.quark.yaml](compose.quark.yaml) 增加固定内网 PanSou 搜索伴随服务，不修改原来的密码、数据卷或核显配置。未配置账号时不自动转存；没有唯一匹配的年份 / 季 / 集时要求选单个文件。观看完的文件默认保留 7 天，清理需在设置中启用，仅处理本应用专用目录中登记的文件。

## 源自动维护与电视直播

连续 3 次失败且持续至少 1 小时的影视源会自动隔离，从浏览、搜索和播放候选中隐藏，原设置保留；隔离后按 30 分钟至 6 小时退避重试，恢复成功会重新展示。手动检测可以立即重试。公开订阅的 403 会区分接口限流与访问被拒绝，429 / GitHub 配额按 Retry-After 或配额重置时间等待；404 会有界检查同仓库实际默认分支和配置文件，找到有效公开路径才替换。无法访问的仓库或需要验证码的服务会保留失败原因，不绕过访问权限。

服务端每 30 分钟检测启用的影视接口，每 6 小时更新启用的影视源 JSON 订阅。接口探测读取 AppleCMS 的 `list` / `class`，验证接口响应，不检查全部影片。设置页可以立即探测、立即更新、立即发现新订阅并查看失败原因。内置订阅读取本仓库 [source-presets.json](web/source-presets.json)，也可手动新增可信的公开配置订阅。

每 15 分钟进行一轮有界的公开订阅发现：读取 [subscription-presets.json 订阅目录](web/subscription-presets.json)、MoonTV / KatelyaTV 配置与少量 forks，结合 GitHub 一般公开仓库搜索和 Bing RSS 公开网页搜索；最多读取两页结果中的显式配置链接，不执行网页脚本、不递归抓站。本轮最多 24 次目录 / 搜索 / 配置请求、20 个候选、2 个并发，最多新增 4 个订阅，每类订阅上限 20 个。未知候选轮换检查，游标存入 SQLite，重启后继续，避免前面的失效地址挡住后续候选。限流、超时、需要验证或格式不兼容的结果会跳过并保留原因。它能拓展已知项目之外的候选，不能保证发现全网所有源或持续找到可用地址。

影视订阅按不超过 200 项的窗口校验后，抽查最多 3 个接口，至少一个接口及其样例影片媒体均通过验证才自动加入；直播列表抽查最多 3 条线路，至少一条通过有限媒体探测才自动加入。目录中的 LunaTV-config、vbskycn 和 TVBox 公开直播汇总来自不同项目，经过配置解析及少量接口 / 媒体抽样；订阅被加入不代表其全部影片或频道可播放。

大订阅按窗口继续检查（最多 2000 个候选），每个订阅每轮轮换验证最多 20 个新增或变更的 API，只有接口及样例媒体探测都通过的地址才加入或替换；已配置影视源上限仍是 200，后续更新继续处理剩余候选。它维护自己引入的源；已有的自定义接口不会被接管，用户修改的名称、接口、停用与删除选择会保留，远端移除的源也不会强制删除。订阅或候选验证失败时保留旧配置，合并前重新读取设置，避免覆盖更新期间的修改。已删除、停用或改址的自动发现订阅不会再次强制添加。手动配置导入仍按标识合并，可以用于明确替换接口。升级时初始化订阅和直播配置一次，之后删除不会在每次启动时重新添加。

电视直播默认订阅本仓库 [live-presets.m3u](web/live-presets.m3u) 的精选线路、[IPTV-org 中国频道列表](https://github.com/iptv-org/iptv/blob/master/streams/cn.m3u)、[vbskycn IPv4 中文直播](https://github.com/vbskycn/iptv/blob/master/tv/iptv4.m3u) 和 [TVBox 公开直播汇总](https://github.com/JianghaoPi/my-tvbox-sources/blob/main/output/live.m3u)，提供央视、卫视、地方新闻、体育、少儿等候选。设置页可新增、修改、排序、停用或删除 M3U / M3U8 频道列表。升级只追加未配置过的两个新增默认源；同标识、同地址、已停用或明确删除的配置不会被覆盖，删后重启也不会重新添加。

打开直播页先读取内存或 SQLite 中最近获取的列表，显示已验证频道及后台探测进度，新可用频道逐步加入；首次部署从镜像内的精选清单开始，不预设线路验证成功。服务端每 10 分钟单次共享刷新 M3U 列表，按频道标识合并备用线路并分类。每批轮换探测最多 20 条线路，完整清单 / 密钥 / 分片检查共用最多 2 个并发，每条总时限 8 秒；仍有未知或到期线路时，上一批结束 5 秒后继续下一批，全部新鲜时每 60 秒检查到期任务。成功线路 30 分钟后重查，失败线路 10 分钟后重试，保留最长 6 小时的状态供队列使用；这不是持续可用或所有频道立即覆盖的保证。

最近列表及页面最多保留 5,000 个去重频道，健康状态最多保留 40,000 个当前列表中的线路地址，SQLite 频道缓存使用约 24 MiB 的存储预算。订阅临时离线时，使用同一源地址在最近 24 小时内成功获取的列表，并显示失败 / 过期提示；重启后仍可使用，地址变更、停用或删除后不再回退旧配置。标准央视名称可跨来源合并备用线路，保留已有频道标识；其他频道只作有限合并，不代表完整覆盖全网频道。

直播按卫视、地方、央视、体育、少儿等频道类别公平轮换探测，失效首线路的备用也会轮换验证，避免大量央视地址占住队列。多档 HLS 会在同一总时限内验证较高清晰度并有界回退；独立音轨和临时会话地址保留原始 master，避免丢音轨或缓存临时签名。海报与线路选择显示清单声明或首片 H.264 SPS 确认的分辨率，未确认的画质标为未知，名称含 HD 不代表已确认高清。默认优先已验证且分辨率较高的线路，网络不足时仍允许播放器降低档位。

2026-10-13 的公开候选抽样确认安徽、河北、东方、北京、浙江卫视部分线路的 H.264 码流为 1920×1080，湖南卫视和东方卫视国际版部分线路为 1280×720。研究来源包括 [IPTV-org](https://github.com/iptv-org/iptv/blob/master/streams/cn.m3u) 和 [Guovin 的公开订阅](https://guovin.github.io/iptv-api/result.m3u)，精选清单只保存原始入口，不固化临时重定向和会话签名；升级镜像后可补入已启用内置订阅的旧缓存，无需删除数据。这些候选仍需在你的 NAS 网络下探测通过才显示。公开订阅里也有大量 403、404、超时或无法确认分辨率的地址，添加更多地址不能保证更多高清频道。

频道使用带名称的海报卡片，标志加载失败时显示本地电视封面。点击海报会自动尝试播放，浏览器拦截有声自动播放时点击视频播放键继续；离开页面会停止播放器和对应兼容任务。探测期间页面每 1–3 秒同步，批次间也会继续等待；全部检查后每 30 秒轻量同步新增频道和失败状态，离页停止。列表及线路按钮只显示状态正常且未过期的项目；没有频道时先等待后台验证，也可手动刷新继续下一批。频道播放器保留稳定的线路序号，先直连，再尝试受限转发及已验证备用线路，也可手动选择。播放器成功解码或线路失败会更新状态，失败线路立即从选项中移除；没有剩余正常线路的频道也暂时隐藏。

公开清单可能包含无效、受地域限制或静态视频链接；静态 MP4 不作为实时直播覆盖的抽样证据。列表可读取只代表订阅可用，有限媒体探测只代表抽查的清单、密钥及分片可读取，不能保证全部分片、高清画质或设备解码正常，也不依据频道名称中的“HD”推断实际分辨率。地域限制、临时令牌、编码及第三方更新仍可能造成失败；自动维护能发现失败并取得订阅的新地址，无法保证永不失效。仅支持公网 HTTP(S) HLS / MP4，不支持内网组播、UDP / RTSP、DRM 或节目单 EPG。

## 无凭证评分与弹幕

评分优先使用影视源明确提供的 `vod_douban_score`，标注“影视源提供，未独立验证”，不会将通用 `vod_score` 当成豆瓣评分，也不会显示 0.0 为有效评分。源提供豆瓣条目 ID 时，可校验豆瓣公开条目的 JSON-LD；条目暂不可达时，尝试按该 ID 与标题匹配 [豆瓣公开电影列表](https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&sort=recommend&page_limit=50&page_start=0) 或电视剧列表。不会只凭片名猜测同名影片。未匹配、限流或无数据时显示暂无评分。成功结果缓存 24 小时，失败结果 5 分钟后可重试。按本次选择，仅接入无需凭证的评分，没有使用 TMDB 官方凭证接口；无法保证所有影片都有评分。

家庭弹幕按影片与剧集保存到 SQLite，其他设备在播放中每 20 秒同步，暂停后停止轮询。文字最多 200 字，每集最多保存 5000 条，同屏最多显示 12 条；关闭弹幕后隐藏发送入口与覆盖层。

外部弹幕支持 B 站官方公开 CID XML 与 BV 视频链接。在播放器“绑定本集外部弹幕”中填写对应同一影片、同一集的视频链接；多分 P 链接明确加 `?p=编号`，并可设置 -600 到 600 秒偏移。绑定按集保存，也可清除。外部读取失败时仍保留家庭弹幕，家庭发送内容不会上传到 B 站。公开弹幕缓存 5 分钟；不绕过登录或验证码，不自动猜测全站影片对应关系。Dandanplay 官方服务需要应用凭证，本次未使用第三方借用密钥接入。

第三方解析页可能禁止 iframe、要求自行登录，或只能在外部打开。这类网页无法读取其内部视频时间，不支持精确续播；第三方源本身的可用性、编解码器和浏览器支持也会影响播放。

## 更新、备份与恢复

长期运行建议保持固定的 Compose 项目名称和命名卷，每次升级前备份，并按使用频率将完整备份存到 NAS 以外的位置；至少实际演练一次恢复。用 `docker compose -f docker-compose.yml ps` 查看容器健康状态，异常时查看 `logs --tail=100 web` 和设置页的探测时间 / 失败原因。Docker 的 `healthy` 代表应用正常响应，不代表所有第三方源正常。影视源自动维护与容器 / APK 升级是独立的，镜像和客户端版本需要主动更新。

更新前先备份并记录当前镜像。NAS 镜像部署更新：

```sh
docker compose -f docker-compose.yml pull && \
docker compose -f docker-compose.yml up -d
```

源码构建则先更新当前目录的源文件，再运行 `docker compose -f compose.yaml up -d --build`。

容器重建会继续使用原数据卷。不要使用 `docker compose -f docker-compose.yml down -v`：`-v` 会删除该项目的命名卷。也不要在没有迁移数据的情况下更换 Compose 项目名称或卷名。

### 固定镜像与回滚

`latest` 随通过 CI 的版本更新；希望长期保持当前版本时，在 `docker-compose.yml` 中将 `image` 改成该次通过检查的唯一 `ci-运行ID-尝试次数-提交SHA` 标签，或更明确的 `ghcr.io/loren1997/vipvideo-web@sha256:完整digest`。使用实际的完整值，版本标签仅在对应 `v*` 标签发布时存在。发布 Actions 会先推送唯一 CI 标签，全部容器与 Compose 检查成功后才更新 `latest`；仅看到构建成功或 CI 标签存在，不代表整轮验收通过。

已在运行时，可在升级前读取当前容器对应的镜像 digest 并与同次数据备份一起保存：

```sh
container_id=$(docker compose -f docker-compose.yml ps -q web)
image_id=$(docker inspect --format '{{.Image}}' "$container_id")
docker image inspect "$image_id" --format '{{json .RepoDigests}}'
```

选择输出中本仓库的完整 `ghcr.io/loren1997/vipvideo-web@sha256:…` 地址填入 `image`。回滚时，先备份当前状态，再改成此前保存的镜像地址并成功执行 `docker compose -f docker-compose.yml pull`；数据库若已随新版发生变化，应按下面的停机恢复流程恢复与旧镜像同时保存的数据，将恢复流程最后的 `start web` 改为 `docker compose -f docker-compose.yml up -d`，以选定镜像重建服务。复制和权限修正必须成功后才执行这一步。不要直接让旧代码读取新版数据库。固定 digest 后，执行 `pull` 仍会取得同一版本；升级需要主动替换 `image`。

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

发布使用仓库自动提供的 `GITHUB_TOKEN`，只授予读取代码和写入 Packages 的权限，不需要额外发布密钥。工作流按本次构建的 digest 顺序拉取并运行 amd64、arm64 容器，验证健康接口、未登录限制和登录；arm64 通过 QEMU 实际运行。两种架构还在容器内生成短合成 MPEG-4/AC3 MP4 与 MPEG-2/AC3 加密 HLS，经过实际媒体代理和转码服务，再用 FFprobe 检查输出 H.264/AAC 与跳转后的时长，并实际解码输出、验证停止清理；测试源仅保存在容器 `/tmp`，不修改生产公网地址校验。amd64 还写入样例收藏/进度并重建容器，确认会话及数据在同一卷保留。随后使用实际 NAS Compose 文件的临时副本启动独立项目，确认 Docker 健康状态为 `healthy`，并按本文流程停机备份、修改进度、恢复，再确认原会话、收藏和进度恢复。临时副本仅替换待验收镜像、样例密码和本机端口绑定，结束后清理测试项目及测试卷。只使用临时样例密码与测试卷，验收断言不依赖第三方源成功；启动后的自动维护可能在后台探测默认接口及直播清单，不保存媒体文件。

首次部署前，确认 [发布工作流](https://github.com/loren1997/vipvideo-web/actions/workflows/docker-publish.yml) 已成功完成双平台运行检查。本仓库镜像已可匿名拉取；自行 Fork 的发布仓库仍需配置自己的包可见性。工作流不修改 GitHub 包可见性，也不保存家庭访问密码。

## 验证与已知范围

本轮广告与夸克更新已通过 Node.js 24 下 352 项模块 / 接口测试及 39 组完整无界面浏览器流程（另有 AVI / TS 与云盘原生解码失败自动兼容等专项），覆盖明确 HLS 广告标记、安全导入窗口、源隔离恢复、账号加密、当前单集匹配与转存去重、停止任务排空、完成进度与过期清理，以及 Cookie / SSRF / 注销期间竞态。容器流水线还检查双架构 MP4、AES-128 HLS、MKV、AVI 与 MPEG-TS 兼容播放，以及可选 PanSou 助手的 Compose 合并和健康状态。真实夸克账号、会员速度和 NAS 硬件解码需部署后验证。

2026-10-13 的类型筛选与高清直播更新已通过 Node.js 24 下 269 项模块 / 接口测试及 33 组无界面浏览器流程，另有年份说明、同片后到元数据补全和 H.264 高清起始层专项。覆盖类型 / 年份校验、上映排序、旧直播缓存升级、分类公平探测、高清分支卡住后回退、纯音频变体排除、临时会话 / 音轨保留，以及此前的搜索、选集、换源、收藏、续播和手机布局。浏览器使用固定媒体样例；真实卫视画质另经受限清单 / 首片 SPS 抽样确认。这些结果不等同于你的 NAS 和电视真机测试。

本机使用 Node.js 24.21.0 和 26.3.0 运行模块/接口测试，覆盖配置、分类分页、搜索/详情解析、源超时与并发、认证、SQLite 数据、三级分类开关与缓存、媒体转发、Range 与地址防护，并补验订阅合并保护、直播定期更新及离线缓存、无凭证评分、播放偏好、家庭与外部弹幕。Node.js 24.21.0 便携运行时使用官方下载站点的 Windows 二进制 ZIP，并通过官方 SHA256 校验。

新增导入修复使用本地固定样例检查地址格式、查询参数、JSONC、兼容配置转换、重复标识及安全拒绝；媒体可播放性使用固定响应检查主清单、密钥、初始化片段、首个分片、限量 Range、超时与缓存，不在单元测试中下载真实影片。公开订阅目录的解析数量及有限抽样用于筛选候选，不作为全订阅可用率或画质保证。

无界面 Chrome 验收使用固定样例与静音媒体检查手机和电脑布局、分类分页、搜索后自动选集、源失败后切换、收藏续播、跨会话同步及 10 秒保存进度。三级分类使用中性的“限制级样例”检查显示、隐藏、记录保留及跨设备开关，不访问真实敏感影片。另抽样检查爱坤实际 H.264/AAC HLS 视频，验证直连和受限媒体转发均能解码并推进播放时间。

Dockerfile 以 Node.js 24 为目标。本机未安装 Docker，双平台镜像在 GitHub Actions 中构建并运行：amd64 与 arm64 检查登录和接口，amd64 还检查容器重建后的会话、收藏和进度；arm64 通过 QEMU 运行。工作流同时验收实际 NAS Compose 文件的启动、Docker 健康状态与停机备份恢复。公开 `latest` 的匿名拉取及两种架构清单已验证。未在实际 NAS 硬件上验收，部署后请检查 `docker compose -f docker-compose.yml ps` 的健康状态，并在你的网络中验证第三方影视源。

没有增加多用户、下载或穿透服务部署。转码服务的容器内合成媒体检查由 CI 执行；PVE/Ubuntu 的 UHD 630 VAAPI、长影片负载和真实 NAS 上的多人使用尚未验收。安卓客户端由 CI 编译及 Lint，再由维护者本地签名并验签；实际手机 / 电视的遥控、硬件解码和外网切换仍需真机验证。
