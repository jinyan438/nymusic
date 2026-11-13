package com.niuyin.player;

import static org.junit.Assert.*;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BassServiceIntegrationTest {
    @Test public void serviceAdvancesQueueAndControlsPlaybackWithoutJavascript() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(launch);
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        File file = BassAudioIntegrationTest.wav(context, 44100, 22050, true);
        AtomicReference<BassPlaybackService> service = new AtomicReference<>();
        AtomicReference<String> error = new AtomicReference<>();
        CountDownLatch connected = new CountDownLatch(1), loaded = new CountDownLatch(1), advanced = new CountDownLatch(1);
        ServiceConnection connection = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                service.set(((BassPlaybackService.LocalBinder) binder).service()); connected.countDown();
            }
            @Override public void onServiceDisconnected(ComponentName name) {}
        };
        Intent intent = new Intent(context, BassPlaybackService.class).setAction(BassPlaybackService.ACTION_START);
        boolean bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
        try {
            assertTrue(bound); assertTrue(connected.await(10, TimeUnit.SECONDS));
            service.get().addObserver((event, state) -> {
                if (event.equals("track") && state.optJSONObject("track").optString("trackId").equals("second")) advanced.countDown();
                if (event.equals("playbackError")) { error.set(state.optString("message")); advanced.countDown(); }
            });
            JSObject first = new JSObject().put("source", "local").put("trackId", "first").put("songName", "First");
            JSObject second = new JSObject().put("source", "local").put("trackId", "second").put("songName", "Second");
            JSONArray queue = new JSONArray().put(new JSObject().put("uri", file.getPath()).put("track", first))
                .put(new JSObject().put("uri", file.getPath()).put("track", second));
            context.startForegroundService(intent);
            service.get().load(new JSObject().put("uri", file.getPath()).put("track", first).put("queue", queue)
                .put("index", 0).put("mode", "order").put("clientId", "instrumentation"), new BassPlaybackService.Result() {
                    @Override public void resolve(JSObject state) { loaded.countDown(); }
                    @Override public void reject(String message) { error.set(message); loaded.countDown(); advanced.countDown(); }
                });
            assertTrue(loaded.await(15, TimeUnit.SECONDS)); assertNull(error.get());
            assertTrue("Background queue did not advance", advanced.await(10, TimeUnit.SECONDS)); assertNull(error.get());
            CountDownLatch paused = new CountDownLatch(1);
            service.get().pause(new BassPlaybackService.Result() {
                @Override public void resolve(JSObject state) { assertTrue(state.optBoolean("paused")); paused.countDown(); }
                @Override public void reject(String message) { error.set(message); paused.countDown(); }
            });
            assertTrue(paused.await(3, TimeUnit.SECONDS)); assertNull(error.get());
        } finally {
            if (service.get() != null) {
                CountDownLatch stopped = new CountDownLatch(1);
                service.get().stop(new BassPlaybackService.Result() {
                    @Override public void resolve(JSObject state) { stopped.countDown(); }
                    @Override public void reject(String message) { stopped.countDown(); }
                });
                stopped.await(3, TimeUnit.SECONDS);
            }
            if (bound) context.unbindService(connection);
            file.delete();
        }
    }
}
