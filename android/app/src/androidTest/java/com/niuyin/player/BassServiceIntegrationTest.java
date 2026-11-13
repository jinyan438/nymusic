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
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BassServiceIntegrationTest {
    @Test public void serviceAdvancesQueueAndControlsPlaybackWithoutJavascript() throws Exception {
        exerciseQueue(false);
    }

    @Test public void downloadedQueuePlaysWithoutContactingTheQqApiOrMediaServer() throws Exception {
        exerciseQueue(true);
    }

    private void exerciseQueue(boolean downloaded) throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(launch);
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        File file = BassAudioIntegrationTest.wav(context, 44100, 22050, true);
        String firstKey = "https://music-dl.sayqz.com/api/?source=qq&id=offline-first&type=url&br=flac";
        String secondKey = "https://music-dl.sayqz.com/api/?source=qq&id=offline-second&type=url&br=flac";
        File firstCached = CachedAudioFiles.forKey(context.getCacheDir(), firstKey);
        File secondCached = CachedAudioFiles.forKey(context.getCacheDir(), secondKey);
        if (downloaded) {
            firstCached.getParentFile().mkdirs();
            Files.copy(file.toPath(), firstCached.toPath(), StandardCopyOption.REPLACE_EXISTING);
            Files.copy(file.toPath(), secondCached.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
        AtomicReference<BassPlaybackService> service = new AtomicReference<>();
        AtomicReference<String> error = new AtomicReference<>();
        CountDownLatch connected = new CountDownLatch(1), loaded = new CountDownLatch(1), advanced = new CountDownLatch(1), secondReady = new CountDownLatch(1);
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
                if (event.equals("state") && state.optJSONObject("track") != null && state.optJSONObject("track").optString("trackId").equals("second")
                    && state.optDouble("duration") > 0 && !state.optBoolean("buffering")) secondReady.countDown();
                if (event.equals("playbackError")) { error.set(state.optString("message")); advanced.countDown(); secondReady.countDown(); }
            });
            JSObject first = new JSObject().put("source", downloaded ? "qq" : "local").put("trackId", "first").put("songName", "First");
            JSObject second = new JSObject().put("source", downloaded ? "qq" : "local").put("trackId", "second").put("songName", "Second");
            // These URLs fail if the decoder attempts either QQ resolution or streaming.
            String location = downloaded ? "http://127.0.0.1:1/never-request" : file.getPath();
            JSONArray firstKeys = new JSONArray().put(firstKey.replace("br=flac", "br=128k")).put(firstKey);
            JSONArray secondKeys = new JSONArray().put(secondKey.replace("br=flac", "br=128k")).put(secondKey);
            JSONArray queue = new JSONArray().put(new JSObject().put("uri", location).put("track", first).put("resolveQqMusicUrl", downloaded).put("cacheKeys", downloaded ? firstKeys : new JSONArray()))
                .put(new JSObject().put("uri", location).put("track", second).put("resolveQqMusicUrl", downloaded).put("cacheKeys", downloaded ? secondKeys : new JSONArray()));
            context.startForegroundService(intent);
            service.get().load(new JSObject().put("uri", location).put("track", first).put("queue", queue)
                .put("resolveQqMusicUrl", downloaded).put("cacheKeys", downloaded ? firstKeys : new JSONArray())
                .put("index", 0).put("mode", "order").put("clientId", "instrumentation"), new BassPlaybackService.Result() {
                    @Override public void resolve(JSObject state) { loaded.countDown(); }
                    @Override public void reject(String message) { error.set(message); loaded.countDown(); advanced.countDown(); }
                });
            assertTrue(loaded.await(15, TimeUnit.SECONDS)); assertNull(error.get());
            assertTrue("Background queue did not advance", advanced.await(10, TimeUnit.SECONDS)); assertNull(error.get());
            assertTrue("Second song did not start playing", secondReady.await(10, TimeUnit.SECONDS)); assertNull(error.get());
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
            if (downloaded) { firstCached.delete(); secondCached.delete(); }
        }
    }
}
