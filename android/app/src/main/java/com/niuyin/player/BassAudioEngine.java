package com.niuyin.player;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Process;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.un4seen.bass.BASS;
import com.un4seen.bass.BASSmix;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** One audio worker owns all decoder handles. UI and notification commands never decode audio. */
final class BassAudioEngine implements AutoCloseable {
    interface Listener {
        void onState(long id, JSObject state);
        void onReady(long id);
        void onEnded(long id);
        void onError(long id, Exception error);
    }
    private final Context context;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService cancellation = Executors.newSingleThreadExecutor();
    private volatile Session current;

    BassAudioEngine(Context context, Listener listener) { this.context = context.getApplicationContext(); this.listener = listener; }

    void load(long id, String uri) {
        load(id, uri, false, null);
    }
    void load(long id, String uri, boolean resolveQqMusicUrl, JSONObject requestHeaders) {
        load(id, uri, resolveQqMusicUrl, requestHeaders, null);
    }
    void load(long id, String uri, boolean resolveQqMusicUrl, JSONObject requestHeaders, String[] cacheKeys) {
        stop();
        Session session = new Session(id, uri, resolveQqMusicUrl, requestHeaders, cacheKeys);
        current = session;
        worker.execute(session);
    }
    void play() {
        Session session = current;
        if (session != null) { session.playing = true; session.wake(); }
    }
    void pause() {
        Session session = current;
        if (session != null) {
            session.playing = false;
            NativeAudioOutput output = session.output;
            if (output != null) try { output.track.pause(); } catch (RuntimeException ignored) {}
            session.wake();
        }
    }
    void seek(double seconds) {
        Session session = current;
        if (session != null) { session.seek.set(seconds); session.wake(); }
    }
    void reconfigure() {
        Session session = current;
        if (session != null) { session.reconfigure = true; session.wake(); }
    }
    void stop() {
        Session previous = current;
        current = null;
        if (previous != null) {
            previous.cancelled = true;
            previous.wake();
            cancellation.execute(previous.decoder::cancel);
            NativeAudioOutput output = previous.output;
            if (output != null) try { output.track.pause(); output.track.flush(); } catch (RuntimeException ignored) {}
        }
    }
    @Override public void close() { stop(); worker.shutdown(); cancellation.shutdown(); }

    private final class Session implements Runnable {
        final long id;
        final String uri;
        final boolean resolveQqMusicUrl;
        final JSONObject requestHeaders;
        final String[] cacheKeys;
        final BassDecoder decoder = new BassDecoder();
        final Object wakeup = new Object();
        final AtomicReference<Double> seek = new AtomicReference<>();
        volatile NativeAudioOutput output;
        volatile boolean playing = true;
        volatile boolean cancelled;
        volatile boolean reconfigure;
        int mixer;
        int readHandle;
        long writtenFrames;
        PcmCodec.FrameClock clock = new PcmCodec.FrameClock();
        double baseSeconds;
        boolean started;
        boolean eof;
        boolean skipExact;
        ByteBuffer decoded;
        ByteBuffer packed;
        ByteBuffer pending;
        Random dither;
        long lastState;
        long startedAt;

        Session(long id, String uri, boolean resolveQqMusicUrl, JSONObject requestHeaders, String[] cacheKeys) {
            this.id = id; this.uri = uri; this.resolveQqMusicUrl = resolveQqMusicUrl; this.requestHeaders = requestHeaders;
            this.cacheKeys = cacheKeys;
        }
        void wake() { synchronized (wakeup) { wakeup.notifyAll(); } }
        void waitBriefly(int milliseconds) throws InterruptedException { synchronized (wakeup) { if (!cancelled) wakeup.wait(milliseconds); } }

        @Override public void run() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
            try {
                if (cancelled) return;
                decoder.open(context, uri, resolveQqMusicUrl, requestHeaders, cacheKeys);
                if (cancelled) return;
                configureOutput(0);
                if (cancelled) return;
                publish(true);
                listener.onReady(id);
                while (!cancelled) {
                    Double requestedSeek = seek.getAndSet(null);
                    if (requestedSeek != null) performSeek(requestedSeek);
                    if (reconfigure) {
                        reconfigure = false;
                        double position = position();
                        releaseOutput();
                        seekSource(position);
                        configureOutput(position);
                    }
                    if (!playing) {
                        if (output.track.getPlayState() == AudioTrack.PLAYSTATE_PLAYING) output.track.pause();
                        publish(false); waitBriefly(40); continue;
                    }
                    if (started && output.track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) output.track.play();
                    if (pending == null && !eof) read();
                    if (pending != null) {
                        int bytes = output.track.write(pending, pending.remaining(), AudioTrack.WRITE_NON_BLOCKING);
                        if (bytes == AudioTrack.ERROR_DEAD_OBJECT) {
                            reconfigure = true; continue;
                        }
                        if (bytes < 0) throw new IOException("音频写入失败 (AudioTrack " + bytes + ")");
                        writtenFrames += bytes / (output.sampleBytes * output.channels);
                        if (!pending.hasRemaining()) pending = null;
                        if (bytes == 0) waitBriefly(8);
                    }
                    int prebufferFrames = Math.min(output.track.getBufferSizeInFrames() / 2, output.sampleRate / 5);
                    if (!started && (writtenFrames >= prebufferFrames || eof)) {
                        output.track.play(); started = true; startedAt = SystemClock.elapsedRealtime();
                        publish(true);
                    }
                    if (started && eof && pending == null) {
                        if (presentedFrames() >= writtenFrames) {
                            publish(true);
                            listener.onEnded(id);
                            return;
                        }
                        waitBriefly(8);
                    }
                    if (started) {
                        output.adaptBuffer();
                        if (output.routeChanged()) reconfigure = true;
                        // A granted preference is not sufficient: verify the active route and mixer too.
                        if (output.bitPerfectRequested && SystemClock.elapsedRealtime() - startedAt > 500 && !output.bitPerfectActive()) {
                            skipExact = true; reconfigure = true;
                        }
                    }
                    publish(false);
                }
            } catch (Exception | LinkageError error) {
                if (!cancelled) listener.onError(id, error instanceof Exception ? (Exception) error : new IOException("BASS 原生库加载失败", error));
            } finally {
                releaseOutput();
                decoder.close();
                Thread.interrupted();
            }
        }

        private void configureOutput(double position) throws IOException {
            output = NativeAudioOutput.open(context, decoder.info, decoder.isLosslessInteger(), skipExact, () -> cancelled);
            BASS.BASS_CHANNELINFO source = decoder.info;
            readHandle = decoder.handle;
            if (output.sampleRate != source.freq || output.channels != source.chans) {
                mixer = BASSmix.BASS_Mixer_StreamCreate(output.sampleRate, output.channels,
                    BASS.BASS_SAMPLE_FLOAT | BASS.BASS_STREAM_DECODE | BASSmix.BASS_MIXER_END);
                if (mixer == 0) throw BassDecoder.error("创建重采样器");
                int flags = BASSmix.BASS_MIXER_CHAN_NORAMPIN | BASSmix.BASS_MIXER_CHAN_NORAMP;
                if (output.channels < source.chans) flags |= BASSmix.BASS_MIXER_CHAN_DOWNMIX;
                if (!BASSmix.BASS_Mixer_StreamAddChannel(mixer, decoder.handle, flags)) throw BassDecoder.error("连接解码器");
                readHandle = mixer;
            }
            int samples = Math.max(256, output.sampleRate / 50) * output.channels;
            decoded = ByteBuffer.allocateDirect(samples * 4).order(ByteOrder.LITTLE_ENDIAN);
            packed = ByteBuffer.allocateDirect(samples * output.sampleBytes).order(ByteOrder.LITTLE_ENDIAN);
            // Dither only when a device forces reduction to 16-bit; never on bit-perfect output.
            int originalBits = source.origres & 0xffff;
            dither = output.encoding == AudioFormat.ENCODING_PCM_16BIT && !output.bitPerfectRequested
                && (originalBits != 16 || mixer != 0) ? new Random() : null;
            pending = null; eof = false; writtenFrames = 0; started = false;
            clock = new PcmCodec.FrameClock(); baseSeconds = position;
        }

        private void read() throws Exception {
            decoded.clear();
            int read = BASS.BASS_ChannelGetData(readHandle, decoded, decoded.capacity());
            if (cancelled) return;
            if (decoder.network != null && decoder.network.failure() != null) throw decoder.network.failure();
            if (read < 0) {
                int error = BASS.BASS_ErrorGetCode();
                if (error != BASS.BASS_ERROR_ENDED) throw new IOException("音频解码失败 (BASS " + error + ")");
                eof = true; return;
            }
            if (read == 0) { waitBriefly(10); return; }
            if (read % (output.channels * 4) != 0) throw new IOException("音频解码帧不完整");
            decoded.position(0).limit(read);
            if (output.encoding == AudioFormat.ENCODING_PCM_FLOAT) pending = decoded;
            else {
                PcmCodec.pack(decoded, packed, read / 4, NativeAudioOutput.integerBits(output.encoding), dither);
                pending = packed;
            }
        }

        private void performSeek(double seconds) throws IOException {
            double target = Math.max(0, decoder.duration > 0 ? Math.min(seconds, decoder.duration) : seconds);
            output.track.pause(); output.track.flush();
            if (mixer != 0) { BASS.BASS_StreamFree(mixer); mixer = 0; }
            seekSource(target);
            // Rebuilding also clears sinc history and the native playback clock.
            releaseOutput();
            configureOutput(target);
            publish(true);
        }

        private void seekSource(double seconds) throws IOException {
            long bytes = BASS.BASS_ChannelSeconds2Bytes(decoder.handle, seconds);
            if (!BASS.BASS_ChannelSetPosition(decoder.handle, bytes, BASS.BASS_POS_BYTE)) throw BassDecoder.error("跳转播放进度");
        }

        private long presentedFrames() { return Math.min(writtenFrames, clock.frames(output.track.getPlaybackHeadPosition())); }
        private double position() { return baseSeconds + presentedFrames() / (double) output.sampleRate; }

        private void publish(boolean force) {
            if (cancelled || output == null) return;
            long now = SystemClock.elapsedRealtime();
            if (!force && now - lastState < 250) return;
            lastState = now;
            AudioDeviceInfo route = output.route();
            double position = position();
            if (decoder.duration > 0) position = Math.min(position, decoder.duration);
            JSObject state = new JSObject();
            state.put("engine", "BASS");
            state.put("bassVersion", Integer.toHexString(BASS.BASS_GetVersion()));
            state.put("paused", !playing);
            state.put("buffering", !started || (!eof && pending == null && writtenFrames - presentedFrames() < output.sampleRate / 100));
            state.put("position", position);
            state.put("duration", decoder.duration);
            state.put("sourceSampleRate", decoder.info.freq);
            state.put("sourceBits", decoder.info.origres & 0xffff);
            state.put("sourceChannels", decoder.info.chans);
            state.put("decodedFormat", "float32");
            state.put("outputSampleRate", output.sampleRate);
            state.put("outputChannels", output.channels);
            state.put("outputEncoding", output.encoding);
            state.put("outputFormat", output.encoding == AudioFormat.ENCODING_PCM_FLOAT ? "float32" : "pcm" + NativeAudioOutput.integerBits(output.encoding));
            state.put("resampling", output.sampleRate != decoder.info.freq);
            state.put("srcQuality", "64-point sinc");
            state.put("bitPerfectSupported", output.bitPerfectSupported);
            state.put("bitPerfect", output.bitPerfectActive());
            state.put("underruns", output.underruns());
            state.put("bufferMilliseconds", output.track.getBufferSizeInFrames() * 1000 / output.sampleRate);
            state.put("route", route == null ? "系统默认" : route.getProductName().toString());
            state.put("routeType", route == null ? 0 : route.getType());
            listener.onState(id, state);
        }

        private void releaseOutput() {
            if (mixer != 0) { BASS.BASS_StreamFree(mixer); mixer = 0; }
            NativeAudioOutput previous = output;
            output = null;
            if (previous != null) previous.close();
        }
    }
}
