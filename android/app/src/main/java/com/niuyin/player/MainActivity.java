package com.niuyin.player;

import android.os.Bundle;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalMusicFilesPlugin.class);
        registerPlugin(MusicDownloadsPlugin.class);
        registerPlugin(BassAudioPlugin.class);
        super.onCreate(savedInstanceState);
        
        // 设置全屏沉浸模式，防止滑动时系统栏导致的抖动
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            // 隐藏系统栏
            controller.hide(WindowInsetsCompat.Type.systemBars());
            // 设置为 BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE，滑动时临时显示但不会改变布局
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
        
        // 防止布局随系统栏变化而调整
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
        
        // 设置120Hz高刷新率
        setHighRefreshRate();
        
        // 禁用 WebView 过度滚动效果（拉伸变形）
        WebView webView = getBridge().getWebView();
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
    
    private void setHighRefreshRate() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            // Android 11+ 使用新API
            Display display = getDisplay();
            if (display != null) {
                Display.Mode[] modes = display.getSupportedModes();
                Display.Mode highestMode = null;
                float highestRefreshRate = 0;
                
                for (Display.Mode mode : modes) {
                    if (mode.getRefreshRate() > highestRefreshRate) {
                        highestRefreshRate = mode.getRefreshRate();
                        highestMode = mode;
                    }
                }
                
                if (highestMode != null) {
                    WindowManager.LayoutParams params = getWindow().getAttributes();
                    params.preferredDisplayModeId = highestMode.getModeId();
                    getWindow().setAttributes(params);
                }
            }
        } else if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            // Android 6-10
            Display display = getWindowManager().getDefaultDisplay();
            Display.Mode[] modes = display.getSupportedModes();
            Display.Mode highestMode = null;
            float highestRefreshRate = 0;
            
            for (Display.Mode mode : modes) {
                if (mode.getRefreshRate() > highestRefreshRate) {
                    highestRefreshRate = mode.getRefreshRate();
                    highestMode = mode;
                }
            }
            
            if (highestMode != null) {
                WindowManager.LayoutParams params = getWindow().getAttributes();
                params.preferredDisplayModeId = highestMode.getModeId();
                getWindow().setAttributes(params);
            }
        }
    }
}
