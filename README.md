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

## QQ 音乐

QQ 接口已按 [Rain120/qq-music-api](https://github.com/Rain120/qq-music-api) 的请求逻辑整合到当前工程，覆盖搜索、歌单、排行榜、封面、歌词和播放地址。Android 通过 CapacitorHttp 直接请求 QQ 音乐，后台播放服务在切歌时获取新的播放地址，无需部署其他项目。来源授权保存在 `www/third-party/qq-music-api.LICENSE`，随应用打包。

网页预览使用当前项目自带的入口：

```powershell
npm start
```

打开 `http://localhost:8080`。同一进程提供页面与 QQ 请求代理，处理浏览器的跨域和 Referer 限制。直接双击 HTML 或使用其他静态服务器时，QQ 网络请求不可用。

在设置里点击「QQ音乐 → 扫码登录」，使用手机 QQ 扫描二维码并确认授权。应用自动完成 QQ 音乐授权并在当前设备保存登录状态，无需手动复制 Cookie。二维码过期后可刷新；关闭窗口会停止轮询，重新登录会在成功后替换账号。已保存的旧 Cookie 仍可读取。扫码流程参考 [sansenjian/qq-music-api](https://github.com/sansenjian/qq-music-api)（Rain120 的 fork），同样直接整合在当前工程中。

登录同时兼容 QQ 的普通与 `ssl.ptlogin2.graph.qq.com` 成功回调，并从响应头或 QQ 音乐返回的 `musicid` / `musickey` 获取凭证。授权失败时显示具体步骤；失败或取消不会替换已有账号。

未登录、登录失效、会员权限不足、地区或版权限制可能导致播放地址为空，此时会提示切换音质或重新扫码登录。QQ 的 `128k`、`320k` 分别映射为 `128`、`320`；该接口没有独立的 24bit 参数，选择 `Hi-Res 24bit` 时按 FLAC 请求，实际位深以音频信息为准。

旧收藏中的数字歌曲 ID 会在请求时转换为 QQ MID；已下载歌曲继续使用原有缓存键。网易云仍使用原接口，聚合搜索与榜单在其中一个音源失败时显示另一音源的结果。

## 下载目录

在「设置 → 下载目录」中打开系统文件夹选择器，选择保存位置。尚未设置时，首次下载也会提示选择文件夹。Android 使用文档树 URI 保存长期写入授权，重启应用后继续使用；取消选择保留原目录，授权失效后会重新打开选择器。Android 系统不允许选取的目录，可改选其中的子文件夹或 Music 下的文件夹。

下载会将 `歌曲名 - 歌手.扩展名` 写入选定目录，并保留应用离线缓存。文件内容保持原音频字节，已有同名文件不会被覆盖。旧版仅存在缓存中的歌曲，可以点击歌曲的「导出」保存到该目录。清除歌曲缓存不会删除目录中的音乐文件。

导出扩展名和 MIME 类型以实际音频文件头为准，不依赖接口的 `Content-Type`。选择「无损 FLAC」或「Hi-Res 24bit」时，如果实际返回 OGG、MP3 等其他格式，会提示格式不符并取消保存。旧缓存中被错误标记为 OGG 的原生 FLAC 音频，重新导出后会使用 `.flac` 扩展名；已有目录文件不会自动改名。

播放优先读取已下载音频：先使用所选播放音质的缓存，缺少时使用已有缓存中最高的音质。Android 下载时同时准备原生播放文件，重复播放与后台切歌直接读取文件，不再重复转存整首音频或获取 QQ 播放地址。旧版缓存首次播放时会补建原生文件，后续直接复用；系统回收原生缓存后可以从应用音频缓存补建。封面、歌词和音频独立加载。清除歌曲缓存时会一并清除原生播放缓存，下载目录中的文件仍保留。

Font Awesome 6.4.0 与 Poppins 字体已随应用打包，启动界面不再等待外部字体或图标站点。原始授权说明位于 `www/third-party/fontawesome.LICENSE.txt`、`www/third-party/poppins.OFL.txt`。

网页预览可在支持 File System Access API 的浏览器中选择目录并记住目录句柄；浏览器要求时需重新授予写入权限。

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
