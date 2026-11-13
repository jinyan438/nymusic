package com.niuyin.player;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.un4seen.bass.BASS;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class BassAudioIntegrationTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private static final int[] PATTERN = { -8388608, -8388607, -4097, -1, 0, 1, 4097, 8388606, 8388607 };

    private File wav(int rate, int frames) throws Exception {
        return wav(context, rate, frames, false);
    }

    static File wav(Context context, int rate, int frames, boolean quiet) throws Exception {
        ByteBuffer bytes = ByteBuffer.allocate(44 + frames * 2 * 3).order(ByteOrder.LITTLE_ENDIAN);
        bytes.put(new byte[] {'R','I','F','F'}).putInt(bytes.capacity() - 8).put(new byte[] {'W','A','V','E','f','m','t',' '});
        bytes.putInt(16).putShort((short) 1).putShort((short) 2).putInt(rate).putInt(rate * 6).putShort((short) 6).putShort((short) 24);
        bytes.put(new byte[] {'d','a','t','a'}).putInt(frames * 6);
        for (int i = 0; i < frames * 2; i++) {
            int sample = PATTERN[i % PATTERN.length] / (quiet ? 128 : 1);
            bytes.put((byte) sample).put((byte) (sample >> 8)).put((byte) (sample >> 16));
        }
        File file = File.createTempFile("bass-24bit-", ".wav", context.getCacheDir());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes.array()); }
        return file;
    }

    @Test public void officialBassLibrariesDecode24BitPcmWithoutLosingLowestBits() throws Exception {
        File file = wav(96000, 4096);
        try (BassDecoder decoder = new BassDecoder()) {
            decoder.open(context, file.getPath());
            assertEquals(96000, decoder.info.freq); assertEquals(24, decoder.info.origres); assertEquals(2, decoder.info.chans);
            assertTrue(decoder.isLosslessInteger());
            ByteBuffer decoded = ByteBuffer.allocateDirect(4096 * 2 * 4).order(ByteOrder.LITTLE_ENDIAN);
            int read = BASS.BASS_ChannelGetData(decoder.handle, decoded, decoded.capacity());
            assertTrue(read > 0);
            decoded.position(0);
            for (int i = 0; i < read / 4; i++) assertEquals(PATTERN[i % PATTERN.length] / 8388608f, decoded.getFloat(), 0f);
        } finally { assertTrue(file.delete()); }
    }

    @Test public void officialFlacPluginPreservesAll24Bits() throws Exception {
        File file = File.createTempFile("bass-24bit-", ".flac", context.getCacheDir());
        try (java.io.InputStream input = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open("pcm24-96000.flac");
             FileOutputStream output = new FileOutputStream(file)) {
            byte[] bytes = new byte[8192]; int read;
            while ((read = input.read(bytes)) != -1) output.write(bytes, 0, read);
        }
        try (BassDecoder decoder = new BassDecoder()) {
            decoder.open(context, file.getPath());
            assertEquals(96000, decoder.info.freq); assertEquals(24, decoder.info.origres);
            assertEquals(0x10900, decoder.info.ctype);
            ByteBuffer decoded = ByteBuffer.allocateDirect(4096 * 2 * 4).order(ByteOrder.LITTLE_ENDIAN);
            int read = BASS.BASS_ChannelGetData(decoder.handle, decoded, decoded.capacity());
            assertTrue(read > 0); decoded.position(0);
            for (int i = 0; i < read / 4; i++) assertEquals(PATTERN[i % PATTERN.length] / 8388608f, decoded.getFloat(), 0f);
        } finally { assertTrue(file.delete()); }
    }

    @Test public void contentUriRemainsReadableAfterItsDescriptorIsClosed() throws Exception {
        File file = wav(96000, 4096);
        android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        try (BassDecoder decoder = new BassDecoder()) {
            decoder.open(context, uri.toString());
            assertEquals(24, decoder.info.origres);
            ByteBuffer decoded = ByteBuffer.allocateDirect(4096).order(ByteOrder.LITTLE_ENDIAN);
            int read = BASS.BASS_ChannelGetData(decoder.handle, decoded, decoded.capacity());
            assertTrue(read > 0); decoded.position(0);
            for (int i = 0; i < read / 4; i++) assertEquals(PATTERN[i % PATTERN.length] / 8388608f, decoded.getFloat(), 0f);
        } finally { file.delete(); }
    }

    @Test public void nativeOutputClockPauseSeekAndEndWorkWithoutWebView() throws Exception {
        File file = wav(context, 44100, 44100 * 2, true);
        CountDownLatch ready = new CountDownLatch(1);
        CountDownLatch ended = new CountDownLatch(1);
        AtomicReference<JSObject> state = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        BassAudioEngine engine = new BassAudioEngine(context, new BassAudioEngine.Listener() {
            @Override public void onState(long id, JSObject value) { state.set(value); }
            @Override public void onReady(long id) { ready.countDown(); }
            @Override public void onEnded(long id) { ended.countDown(); }
            @Override public void onError(long id, Exception error) { failure.set(error); ready.countDown(); ended.countDown(); }
        });
        try {
            engine.load(1, file.getPath());
            assertTrue("BASS output did not initialize", ready.await(15, TimeUnit.SECONDS));
            if (failure.get() != null) throw failure.get();
            long deadline = SystemClock.elapsedRealtime() + 8000;
            while ((state.get() == null || state.get().optDouble("position") < 0.2) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(25);
            assertTrue(state.get().optDouble("position") >= 0.2);
            assertEquals("float32", state.get().optString("decodedFormat"));
            assertTrue(state.get().optInt("outputSampleRate") > 0);
            engine.pause();
            SystemClock.sleep(350);
            assertTrue(state.get().optBoolean("paused"));
            double paused = state.get().optDouble("position");
            SystemClock.sleep(350);
            assertEquals(paused, state.get().optDouble("position"), 0.03);
            engine.seek(1.5);
            SystemClock.sleep(500);
            assertEquals(1.5, state.get().optDouble("position"), 0.03);
            engine.play();
            assertTrue("BASS output never drained at EOF", ended.await(8, TimeUnit.SECONDS));
            if (failure.get() != null) throw failure.get();
        } finally { engine.close(); file.delete(); }
    }
}
