# 牛音播放器

基于 Capacitor 的 Android 音乐播放器，支持在线音乐、本地文件夹扫描、内嵌封面与歌词，以及 Hi-Res 音频信息。

本地扫描按需读取音频标签，最多同时处理 4 首歌曲。刷新时根据文件大小和修改时间复用未变化歌曲的信息。

## 开发

安装 Node.js、JDK 21 和 Android SDK（编译版本 35），然后运行：

```powershell
npm ci
npx cap sync android
```

在 `android/local.properties` 中配置本机 Android SDK 路径，例如：

```properties
sdk.dir=D:/Android/SDK
```

网页源码位于 `www/`，Android 原生代码位于 `android/app/src/main/`。修改网页源码后，运行 `npx cap sync android` 同步到 Android 项目。

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
```

依赖、构建产物、签名密钥和本机配置不纳入版本控制。
