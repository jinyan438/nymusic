@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo    牛音播放器 APK 一键打包工具
echo ========================================
echo.

echo [1/4] 校验 BASS SDK...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-bass.ps1"
if %errorlevel% neq 0 (
    echo 错误: BASS SDK 准备失败！
    pause
    exit /b 1
)
echo [2/4] 同步 Web 资源到 Android 项目...
call npx cap sync android
if %errorlevel% neq 0 (
    echo 错误: 同步失败！
    pause
    exit /b 1
)
echo.

echo [3/4] 编译 APK...
cd android
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (
    echo 错误: 编译失败！
    cd ..
    pause
    exit /b 1
)
cd ..
echo.

echo [4/4] 复制 APK 到根目录...
copy /Y "android\app\build\outputs\apk\debug\app-debug.apk" "牛音播放器.apk" >nul
echo.

echo ========================================
echo    打包完成！
echo    APK 文件: 牛音播放器.apk
echo ========================================
pause
