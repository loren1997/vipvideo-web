# Android 手机 / 电视客户端

这是 VIPVideo Web 的轻量原生 Java WebView 客户端。它连接你已经部署的 NAS 服务器，网页功能和家庭数据仍由服务器提供。没有广告 SDK、原生 JavaScript 桥或内置影视库。

## 下载和安装

- 正式 APK：[VIPVideo-Web.apk](https://github.com/loren1997/vipvideo-web/releases/download/android-latest/VIPVideo-Web.apk)。首次下载前查看 [Android 构建](https://github.com/loren1997/vipvideo-web/actions/workflows/android-build.yml) 是否已成功发布。
- 校验文件：[VIPVideo-Web.apk.sha256](https://github.com/loren1997/vipvideo-web/releases/download/android-latest/VIPVideo-Web.apk.sha256)。手机与电视共用同一 APK，无需按 CPU 架构选择。
- 要求 Android 6.0 / API23 及以上，建议使用仍可更新系统 WebView 的设备。APK 不包含服务器，NAS 部署步骤见 [README-WEB.md](README-WEB.md)。

手机：下载 APK，按系统提示允许当前浏览器或文件管理器安装未知应用，再打开 APK 安装。电视：通过你使用的电视文件管理器或局域网传输工具拷入 APK，允许该工具安装未知应用后安装；应用会出现在支持 Leanback 的电视启动器中。部分厂商系统可能需要从“全部应用”进入。

同一签名的正式 APK 可以覆盖升级，地址和登录 Cookie 会保留。debug 仅供开发测试；debug 与正式包签名不同，切换时可能需要卸载旧测试包，再安装正式包。地址设置会随卸载清除，NAS 收藏和观看记录仍在服务器上。

## 首次连接和地址切换

首次启动填写两个地址：

| 字段 | 示例 | 用途 |
| --- | --- | --- |
| 家庭局域网地址（必填） | `http://192.168.1.20:3000` | 手机 / 电视与 NAS 在同一家庭网络时使用 |
| 外网地址（可选） | `https://video.example.com` | 离家后通过你已有的 HTTPS 反向代理、VPN 或穿透服务连接 |

填写服务器根地址，不附带密码、查询参数或 `#` 页面片段。外网优先使用 HTTPS，并使用有效证书；应用不会忽略证书错误。默认允许 HTTP 是为了访问家庭局域网服务器。

点击“保存并连接”后，应用在后台检查局域网 `/health`，最多等待约 1.8 秒；失败后再检查外网。两个地址都不可用时显示“重试连接”和“修改地址”。网页打开后输入你在 NAS 配置的 `APP_PASSWORD`。客户端不单独保存该密码，登录由网页的会话 Cookie 维持。

顶部“重连”重新优先检查局域网；“地址”可以选择优先局域网、只使用外网或修改地址。局域网和外网通常是不同网页域名，首次切换可能需要各登录一次，收藏与进度仍来自同一服务器。返回应用不会主动换地址或打断当前页面，可在网络变化后手动重连。

外网地址由你已有的访问服务提供；此项目不创建或部署穿透服务。NAS 服务端应保留 `Host`，通过 HTTPS 访问时可设置 `COOKIE_SECURE=true`，见 Web 部署文档。仅通过家庭 HTTP 地址使用时保持默认 `false`。

## 手机与遥控器操作

手机使用触屏操作。电视自动横屏，方向键移动网页按钮焦点，确认键执行按钮；单行输入框内左右键保留文本编辑，上下键可离开输入框。遥控器菜单键可打开地址菜单。电视首次填写地址可使用设备自带的屏幕键盘。

返回键先退出播放器全屏，再返回网页上一页，最后退出应用。切到后台会暂停内置音视频。播放保持用户点击要求；如果系统 WebView 拦截首次播放，点击网页“开始播放”即可。第三方播放页仍受其嵌入政策和设备 WebView 兼容性影响，可用“外部打开”交给系统浏览器。

## 更新 WebView 与兼容性

内置播放器依赖设备的 Android System WebView / Chrome。黑屏、M3U8 无法播放或全屏异常时，先通过设备应用商店更新 WebView 与 Chrome，再重新启动应用。播放器会先尝试直连、受限媒体转发和换源，仍失败时可自动或手动使用“兼容播放”，由 NAS 转为最高 720p 的 H.264/AAC HLS；APK 本身不执行转码。服务端每次只允许一个兼容任务，自动选择可用的 Intel VAAPI，失败后使用 CPU；核显部署见 [Web 部署说明](README-WEB.md#兼容播放与-intel-核显)。

兼容播放的跳转或倍速变更会重建视频流并继续保存原影片进度，直播固定 1 倍。长时间暂停后可能需要重新启动兼容播放。厂商停止更新的老电视、缺少 WebView 的系统和第三方源限制仍可能影响播放；兼容模式不绕过网站证书或 DRM。真实手机、电视和 NAS 硬件组合仍需在你的设备上验证。

## 构建与签名

构建固定使用 AGP8.13.2、Gradle8.13、JDK17、Android SDK35 / Build Tools35.0.0，兼容关系见 [Android 官方说明](https://developer.android.com/build/releases/agp-8-13-0-release-notes)。运行时没有第三方 SDK，仅使用 Android 系统 API。应用 ID 为 `io.github.loren1997.vipvideoweb`。

本地开发安装 JDK17、Gradle8.13 和 Android SDK35 后，在 `android/` 执行：

```sh
gradle --no-daemon --max-workers=2 :app:assembleDebug :app:lintDebug
```

配置 SDK 时使用本机 `ANDROID_HOME` 或被忽略的 `android/local.properties`。项目未提交二进制 Gradle Wrapper，CI 通过 [官方 Gradle Action](https://github.com/gradle/actions/tree/main/setup-gradle) 获取固定版本。

CI 总会构建 debug APK、执行纯 Java 地址策略样例及 Android Lint。本项目采用维护者本地签名发布正式 APK，长期私钥和口令保留在维护者控制的位置。本次不把发布密钥上传到 GitHub。

没有远端签名 Secrets 时，Actions 提供 `android-debug` 测试包、`vipvideo-android-unsigned` 未签名正式包，以及来自官方 SDK35 Build Tools 的 `vipvideo-android-signing-tool`。未签名包通过 `zipalign` 检查，由维护者下载到本机后使用同一发布密钥签名、验签并发布。未签名包和 debug 包不会覆盖公开的正式 APK。

如果维护者自行选择配置下列四个签名 Secrets，CI 也支持远端签名：密钥仅在临时目录解码，构建后使用 `apksigner` 验签、生成 SHA256，成功才更新固定 `android-latest` Release；签名构建或验签失败不会替换已发布 APK。密钥配置属于维护者的选择，默认本地签名不需要这些 Secrets。

仓库维护者在 **Settings → Secrets and variables → Actions** 配置以下四个 Secrets：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 发布密钥库文件的 Base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 发布密钥别名，例如 `vipvideo-web` |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

密钥由仓库维护者保管，不得提交密钥库、密码或私钥到 Git。保持同一发布密钥才能让用户覆盖升级，备份密钥库和密码至你控制的安全位置。

Android TV 声明及 WebView 行为依据 [Android TV 官方文档](https://developer.android.com/training/tv/get-started/create)、[WebSettings](https://developer.android.com/reference/android/webkit/WebSettings)、[WebChromeClient](https://developer.android.com/reference/android/webkit/WebChromeClient)。原项目许可及来源声明继续见根目录 `LICENSE` 和 [web/NOTICE.md](web/NOTICE.md)。

本机未安装 Android SDK；APK 编译、Lint 和未签名包对齐检查以 Actions 日志为准。默认发布策略的签名与验签在维护者本机完成，正式发布提供 SHA256 校验文件。手机与电视的真机遥控、硬件解码和外网切换仍需在设备上验证。
