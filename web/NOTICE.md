# 来源与许可证

本项目在 [iodefog/VipVideo](https://github.com/iodefog/VipVideo) 固定提交
`cbdbc19942814150caea34e5ee15ad4acf32d631` 的基础上新增独立 Web 应用。
上游以该提交的源码归档引入，保留原有文件、版权与根目录 `LICENSE`，未引入 Git 历史。
VipVideo 使用 MIT 许可证，原版权归雾颂所有（2018）。Docker 镜像包含原许可证。

[MoonTV](https://github.com/Stardm0/MoonTV) 与
[KatelyaTV](https://github.com/katelya77/KatelyaTV) 用于参考聚合搜索、选集、换源、续播交互及
AppleCMS `api_site` 配置格式；本 Web 应用未复制这两个项目的实现代码。
其许可分别可查阅 [MoonTV LICENSE](https://github.com/Stardm0/MoonTV/blob/main/LICENSE) 和
[KatelyaTV LICENSE](https://github.com/katelya77/KatelyaTV/blob/main/LICENSE)。

Web 播放器使用 [HLS.js](https://github.com/video-dev/hls.js)，按 Apache-2.0 许可证分发。
安装后的 `node_modules/hls.js/LICENSE` 随依赖和 Docker 镜像保留，包含该库及衍生实现的版权声明。
完整许可见 [HLS.js LICENSE](https://github.com/video-dev/hls.js/blob/master/LICENSE)。

Docker 兼容播放使用 Debian 分发的 [FFmpeg](https://ffmpeg.org/legal.html)，包含 GPL 编码器；
不将 FFmpeg 的许可证改为本项目的 MIT。相关版权及许可保留在镜像的
`/usr/share/doc/ffmpeg/copyright`、`/usr/share/doc/libx264-164/copyright` 等 Debian 包目录中。
对应 Debian 源码、版本与打包补丁可查阅 [FFmpeg 源码包](https://sources.debian.org/src/ffmpeg/)、
[x264 源码包](https://sources.debian.org/src/x264/) 及各依赖包的源码页面。
镜像内可用 `dpkg-query -W ffmpeg libx264-164` 查询所装版本；Intel VAAPI 驱动的许可同样随 Debian 包保留。
