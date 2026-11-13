package com.niuyin.player;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "BassAudio")
public final class BassAudioPlugin extends Plugin {
    private volatile BassPlaybackService service;
    private boolean bound;
    private boolean observing = true;
    private final List<PluginCall> waiting = new ArrayList<>();
    private final BassPlaybackService.Observer observer = (event, data) -> notifyListeners(event, data);
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((BassPlaybackService.LocalBinder) binder).service();
            if (observing) service.addObserver(observer);
            for (PluginCall call : waiting) service.getState(result(call));
            waiting.clear();
        }
        @Override public void onServiceDisconnected(ComponentName name) { service = null; }
        @Override public void onNullBinding(ComponentName name) { rejectWaiting(); }
        @Override public void onBindingDied(ComponentName name) { rejectWaiting(); }
    };

    @PluginMethod public void initialize(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (service != null) { service.getState(result(call)); return; }
            waiting.add(call);
            if (!bound) {
                bound = getContext().bindService(new Intent(getContext(), BassPlaybackService.class), connection, Context.BIND_AUTO_CREATE);
                if (!bound) rejectWaiting();
            }
        });
    }
    private void rejectWaiting() { for (PluginCall call : waiting) call.reject("无法连接 BASS 播放服务"); waiting.clear(); }
    private boolean connected(PluginCall call) { if (service != null) return true; call.reject("BASS 播放服务尚未就绪"); return false; }
    private BassPlaybackService.Result result(PluginCall call) {
        return new BassPlaybackService.Result() {
            @Override public void resolve(com.getcapacitor.JSObject data) { call.resolve(data); }
            @Override public void reject(String message) { call.reject(message); }
        };
    }
    @PluginMethod public void load(PluginCall call) {
        if (!connected(call)) return;
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), BassPlaybackService.class).setAction(BassPlaybackService.ACTION_START));
            service.load(call.getData(), result(call));
        } catch (RuntimeException error) { call.reject("无法启动后台播放服务", error); }
    }
    @PluginMethod public void play(PluginCall call) { if (connected(call)) service.play(result(call)); }
    @PluginMethod public void pause(PluginCall call) { if (connected(call)) service.pause(result(call)); }
    @PluginMethod public void stop(PluginCall call) { if (connected(call)) service.stop(result(call)); }
    @PluginMethod public void seek(PluginCall call) {
        Double position = call.getDouble("position");
        if (position == null || !Double.isFinite(position)) { call.reject("无效的播放进度"); return; }
        if (connected(call)) service.seek(position, result(call));
    }
    @PluginMethod public void next(PluginCall call) { if (connected(call)) service.skip(false, result(call)); }
    @PluginMethod public void previous(PluginCall call) { if (connected(call)) service.skip(true, result(call)); }
    @PluginMethod public void setMode(PluginCall call) { if (connected(call)) service.setMode(call.getString("mode", "order"), result(call)); }
    @PluginMethod public void getState(PluginCall call) { if (connected(call)) service.getState(result(call)); }

    @Override protected void handleOnPause() {
        observing = false;
        if (service != null) service.removeObserver(observer);
        super.handleOnPause();
    }
    @Override protected void handleOnResume() {
        observing = true;
        if (service != null) {
            service.addObserver(observer);
            service.getState(new BassPlaybackService.Result() {
                @Override public void resolve(com.getcapacitor.JSObject state) {
                    observer.onEvent("state", state);
                    if (state.optJSONObject("track") != null) observer.onEvent("track", state);
                }
                @Override public void reject(String message) {}
            });
        }
        super.handleOnResume();
    }

    @Override protected void handleOnDestroy() {
        if (service != null) service.removeObserver(observer);
        if (bound) { getContext().unbindService(connection); bound = false; }
        service = null; rejectWaiting();
        super.handleOnDestroy();
    }
}
