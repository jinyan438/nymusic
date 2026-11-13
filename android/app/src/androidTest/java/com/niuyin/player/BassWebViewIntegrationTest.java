package com.niuyin.player;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BassWebViewIntegrationTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    private String evaluate(WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(5, TimeUnit.SECONDS));
        Object value = new JSONTokener(result.get()).nextValue();
        return value == JSONObject.NULL ? "null" : value.toString();
    }

    @Test public void capacitorBridgePlaysThroughBassAndLeavesHtmlAudioIdle() throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        Activity activity = instrumentation.startActivitySync(intent);
        AtomicReference<WebView> holder = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> holder.set(((MainActivity) activity).getBridge().getWebView()));
        WebView view = holder.get();
        File file = BassAudioIntegrationTest.wav(instrumentation.getTargetContext(), 48000, 48000 * 4, true);
        try {
            long deadline = SystemClock.elapsedRealtime() + 15000;
            while (!evaluate(view, "typeof Playback !== 'undefined' && !!Playback.plugin").equals("true") && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
            assertEquals("true", evaluate(view, "Playback.isNative"));
            evaluate(view, "window.__bassResult = 'waiting'; Playback.load({uri:" + JSONObject.quote(file.getPath())
                + ",track:{source:'local',trackId:'bridge',songName:'Bridge'},queue:[]}).then(()=>window.__bassResult='ready').catch(e=>window.__bassResult=e.message); 'started'");
            deadline = SystemClock.elapsedRealtime() + 15000;
            String status;
            do { status = evaluate(view, "window.__bassResult"); if (!status.equals("waiting")) break; SystemClock.sleep(50); }
            while (SystemClock.elapsedRealtime() < deadline);
            assertEquals("ready", status);
            assertEquals("BASS", evaluate(view, "Playback.state.engine"));
            assertEquals("true", evaluate(view, "DOM.audioPlayer.paused && !DOM.audioPlayer.getAttribute('src')"));
            assertEquals("float32", evaluate(view, "Playback.state.decodedFormat"));
            evaluate(view, "Playback.pause(); 'paused'");
            deadline = SystemClock.elapsedRealtime() + 3000;
            while (!evaluate(view, "Playback.paused").equals("true") && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(25);
            assertEquals("true", evaluate(view, "Playback.paused"));
            evaluate(view, "Playback.seek(1); 'seeking'");
            SystemClock.sleep(500);
            double position = Double.parseDouble(evaluate(view, "Playback.currentTime"));
            assertEquals(1, position, 0.05);
        } finally {
            evaluate(view, "Playback.stop(); 'stopped'");
            instrumentation.runOnMainSync(activity::finish);
            file.delete();
        }
    }
}
