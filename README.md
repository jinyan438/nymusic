# 牛音播放器

基于 Capacitor 的 Android 音乐播放器，支持在线音乐、本地文件夹扫描、内嵌封面与歌词，以及 Hi-Res 音频信息。

Android 使用 BASS 原生解码和 AudioTrack 输出；网页预览使用 HTML Audio。界面、歌词和歌单通过统一的 `Playback` 接口控制播放。

本地扫描按需读取音频标签，最多同时处理 4 首歌曲。刷新时根据文件大小和修改时间复用未变化歌曲的信息。

## 开发

安装 Node.js、JDK 21 和 Android SDK（编译版本 35），然后运行：

```powershell
npm ci
powershell -NoProfile -File scripts/setup-bass.ps1
npx cap sync android
```

在 `android/local.properties` 中配置本机 Android SDK 路径，例如：

```properties
sdk.dir=D:/Android/SDK
```

网页源码位于 `www/`，Android 原生代码位于 `android/app/src/main/`。修改网页源码后，运行 `npx cap sync android` 同步到 Android 项目。

BASS SDK 从 Un4seen 官网下载，按 `scripts/bass-sdk.json` 中的 SHA-256 校验；缓存与安装目录不纳入版本控制。已有缓存时可用 `scripts/setup-bass.ps1 -Offline`。`build-apk.bat` 会自动准备 SDK。BASS 及附带扩展的原始说明随 APK 打包，个人非商业使用遵循 [Un4seen 授权](https://www.un4seen.com/bass.html#license)。

## 音频链路

`本地文件／HTTP → BASS Float32 解码 → 必要时 BASSmix sinc 重采样 → AudioTrack → 系统输出设备`

- 16/24bit 整数 PCM 的有效位在浮点解码中完整保留。不开启 EQ、增益、动态压缩、变速或应用音效。32bit 整数音源受 Float32 有效精度限制，不声明为原样输出。
- 普通混音输出使用系统流的原生采样率；需要转换时启用 64 点 sinc。USB 能力允许时匹配原始采样率。应用不能保证厂商 HAL 或蓝牙链路完全不再转换。
- Android 14+ 的 USB 设备若明确支持匹配采样率、声道和整数精度的 Bit-perfect mixer，自动申请并核验实际路由与 mixer 状态。仅对已知 16/24bit 无损整数音源启用；不支持或被撤销时自动回退。DSD 通过插件解码为 PCM，此版本不实现 DSD 直通或自定义 USB 驱动。
- 播放、网络读取、队列推进和供数在原生前台服务中进行。通知栏和耳机媒体按键支持播放、暂停、切歌和跳转。失去焦点时暂停，暂时失去焦点后恢复；拔掉耳机时暂停。
- 进度来自 AudioTrack 已呈现帧，不使用提前解码的位置。输出缓冲可随欠载增长。浏览器缓存歌曲按块复制到应用缓存后播放，避免传递不可用的 `blob:` 地址。

`Playback.plugin.getState()` 返回源格式、输出格式、重采样、实际路由、欠载计数和 Bit-perfect 状态。这里的输出格式描述 AudioTrack 配置；只有核验通过的 `bitPerfect: true` 才表示启用了系统提供的原样输出路径。物理 DAC 输出仍需真机验证。

当前仓库提供 Android 应用和网页预览；统一接口可供未来桌面端原生桥接复用，尚未包含 Windows/macOS 桌面打包工程。

## 构建

Windows 下运行 `build-apk.bat`，或执行：

```powershell
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

安装包输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 测试

```powershell
npm test
cd android
.\gradlew.bat :app:testDebugUnitTest
.\gradlew.bat :app:connectedDebugAndroidTest
```

设备测试验证官方 BASS 库的 24bit WAV/FLAC 逐采样精度、原生进度和播放控制、HTTP Range 回退、独立于 JavaScript 的队列推进，以及 Capacitor 到 BASS 的完整链路。测试 FLAC 为合成的 24bit/96kHz 双声道样本，无第三方音乐内容。模拟器无法验证真实 USB DAC、蓝牙编码和不同厂商的音频 HAL。

依赖、构建产物、签名密钥和本机配置不纳入版本控制。
