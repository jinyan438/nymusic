package com.niuyin.player;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioMixerAttributes;
import android.media.AudioTrack;
import android.os.Build;
import android.os.SystemClock;
import com.un4seen.bass.BASS;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Output negotiation is independent of the decoder. No EQ, gain, limiter or time stretching. */
final class NativeAudioOutput implements AutoCloseable {
    interface Cancelled { boolean get(); }
    final AudioTrack track;
    final int sampleRate;
    final int channels;
    final int encoding;
    final int sampleBytes;
    final boolean bitPerfectRequested;
    final boolean bitPerfectSupported;
    private final AudioManager manager;
    private final AudioAttributes attributes;
    private final Profile profile;
    private final AudioDeviceInfo initialRoute;
    private int lastUnderruns;

    private static final class Profile {
        int rate;
        int channels;
        int mask;
        int encoding;
        AudioMixerAttributes mixer;
        AudioDeviceInfo device;
        boolean exact;
        Profile(int rate, int channels, int encoding) {
            this.rate = rate; this.channels = channels; this.encoding = encoding; this.mask = channelMask(channels);
        }
    }

    static AudioAttributes musicAttributes() {
        AudioAttributes.Builder builder = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC);
        if (Build.VERSION.SDK_INT >= 32) builder.setSpatializationBehavior(AudioAttributes.SPATIALIZATION_BEHAVIOR_NEVER);
        return builder.build();
    }

    private NativeAudioOutput(AudioManager manager, AudioAttributes attributes, AudioTrack track,
                              Profile profile, AudioDeviceInfo route, boolean exactSupported) {
        this.manager = manager; this.attributes = attributes; this.track = track; this.profile = profile;
        this.initialRoute = route;
        sampleRate = track.getSampleRate(); channels = track.getChannelCount(); encoding = track.getAudioFormat();
        sampleBytes = bytesPerSample(encoding);
        bitPerfectRequested = profile.exact; bitPerfectSupported = exactSupported;
    }

    static NativeAudioOutput open(Context context, BASS.BASS_CHANNELINFO source, boolean lossless,
                                   boolean skipExact, Cancelled cancelled) throws IOException {
        AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        AudioAttributes attributes = musicAttributes();
        int nativeRate = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC);
        if (nativeRate <= 0) nativeRate = 48000;
        AudioDeviceInfo route = probeRoute(attributes, nativeRate, cancelled);
        List<Profile> candidates = new ArrayList<>();
        boolean exactSupported = false;
        if (Build.VERSION.SDK_INT >= 34 && isUsb(route)) {
            try {
                List<AudioMixerAttributes> mixers = manager.getSupportedMixerAttributes(route);
                for (AudioMixerAttributes mixer : mixers) {
                    AudioFormat format = mixer.getFormat();
                    if (format.getSampleRate() != source.freq || format.getChannelCount() != source.chans) continue;
                    int encoding = format.getEncoding();
                    boolean exact = mixer.getMixerBehavior() == AudioMixerAttributes.MIXER_BEHAVIOR_BIT_PERFECT;
                    boolean usableExact = lossless && integerBits(encoding) >= source.origres;
                    if (exact && usableExact) exactSupported = true;
                    if (exact && (!usableExact || skipExact)) continue;
                    if (!exact && encoding != AudioFormat.ENCODING_PCM_FLOAT && integerBits(encoding) < 24) continue;
                    Profile candidate = new Profile(source.freq, source.chans, encoding);
                    candidate.mask = format.getChannelMask();
                    if (candidate.mask == 0) candidate.mask = channelMask(source.chans);
                    candidate.mixer = mixer; candidate.device = route; candidate.exact = exact;
                    candidates.add(candidate);
                }
                Collections.sort(candidates, (left, right) -> Boolean.compare(right.exact, left.exact));
            } catch (RuntimeException ignored) { /* Some vendor HALs advertise no usable preferred mixer. */ }
        }
        int outputChannels = source.chans;
        if (source.chans > 2 && !supportsChannels(route, source.chans)) outputChannels = 2;
        // Use one deliberate sinc conversion to the system rate on ordinary mixed outputs.
        int ordinaryRate = isUsb(route) && supportsRate(route, source.freq) ? source.freq : nativeRate;
        candidates.add(new Profile(ordinaryRate, outputChannels, AudioFormat.ENCODING_PCM_FLOAT));
        candidates.add(new Profile(nativeRate, Math.min(2, source.chans), AudioFormat.ENCODING_PCM_FLOAT));
        candidates.add(new Profile(nativeRate, Math.min(2, source.chans), AudioFormat.ENCODING_PCM_16BIT));
        RuntimeException lastError = null;
        for (Profile profile : candidates) {
            if (cancelled.get()) throw new IOException("Playback cancelled");
            AudioTrack track = null;
            boolean preferred = false;
            try {
                if (profile.mixer != null && Build.VERSION.SDK_INT >= 34) {
                    preferred = manager.setPreferredMixerAttributes(attributes, profile.device, profile.mixer);
                    if (!preferred) continue;
                }
                track = buildTrack(attributes, profile);
                return new NativeAudioOutput(manager, attributes, track, profile, route, exactSupported);
            } catch (RuntimeException error) {
                lastError = error;
                if (track != null) track.release();
                if (preferred && Build.VERSION.SDK_INT >= 34) manager.clearPreferredMixerAttributes(attributes, profile.device);
            }
        }
        throw new IOException("无法打开音频输出设备", lastError);
    }

    private static AudioTrack buildTrack(AudioAttributes attributes, Profile profile) {
        int frameSize = profile.channels * bytesPerSample(profile.encoding);
        int minimum = AudioTrack.getMinBufferSize(profile.rate, profile.mask, profile.encoding);
        if (minimum <= 0) throw new IllegalArgumentException("Unsupported output format");
        // Allocate room to grow after an underrun; use about 333 ms initially.
        int capacity = Math.max(minimum * 2, profile.rate * frameSize * 3 / 4);
        AudioFormat format = new AudioFormat.Builder().setSampleRate(profile.rate)
            .setChannelMask(profile.mask).setEncoding(profile.encoding).build();
        AudioTrack track = new AudioTrack.Builder().setAudioAttributes(attributes).setAudioFormat(format)
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(capacity).build();
        if (track.getState() != AudioTrack.STATE_INITIALIZED) {
            track.release(); throw new IllegalArgumentException("AudioTrack initialization failed");
        }
        if (Build.VERSION.SDK_INT >= 24) track.setBufferSizeInFrames(Math.max(minimum / frameSize, profile.rate / 3));
        if (Build.VERSION.SDK_INT >= 31) track.setStartThresholdInFrames(1);
        track.setVolume(1f);
        return track;
    }

    // Probe the system's chosen route with silence instead of guessing from connected devices.
    private static AudioDeviceInfo probeRoute(AudioAttributes attributes, int rate, Cancelled cancelled) {
        AudioTrack probe = null;
        try {
            probe = buildTrack(attributes, new Profile(rate, 2, AudioFormat.ENCODING_PCM_FLOAT));
            ByteBuffer silence = ByteBuffer.allocateDirect(rate / 50 * 2 * 4);
            probe.write(silence, silence.remaining(), AudioTrack.WRITE_NON_BLOCKING);
            probe.play();
            for (int i = 0; i < 20 && !cancelled.get(); i++) {
                AudioDeviceInfo route = probe.getRoutedDevice();
                if (route != null) return route;
                SystemClock.sleep(5);
            }
        } catch (RuntimeException ignored) {
        } finally {
            if (probe != null) { try { probe.pause(); probe.flush(); } catch (RuntimeException ignored) {} probe.release(); }
        }
        return null;
    }

    boolean bitPerfectActive() {
        if (!bitPerfectRequested || Build.VERSION.SDK_INT < 34) return false;
        AudioDeviceInfo actual = track.getRoutedDevice();
        if (actual == null || actual.getId() != profile.device.getId()) return false;
        try { return profile.mixer.equals(manager.getPreferredMixerAttributes(attributes, actual)); }
        catch (RuntimeException ignored) { return false; }
    }

    AudioDeviceInfo route() {
        AudioDeviceInfo actual = track.getRoutedDevice();
        return actual != null ? actual : initialRoute;
    }

    boolean routeChanged() {
        AudioDeviceInfo actual = track.getRoutedDevice();
        return actual != null && initialRoute != null && actual.getId() != initialRoute.getId();
    }

    int underruns() { return Build.VERSION.SDK_INT >= 24 ? track.getUnderrunCount() : 0; }

    void adaptBuffer() {
        if (Build.VERSION.SDK_INT < 24) return;
        int count = underruns();
        if (count > lastUnderruns) {
            int capacity = track.getBufferCapacityInFrames();
            track.setBufferSizeInFrames(Math.min(capacity, track.getBufferSizeInFrames() * 3 / 2));
            lastUnderruns = count;
        }
    }

    @Override public void close() {
        try { track.pause(); track.flush(); } catch (RuntimeException ignored) {}
        track.release();
        if (profile.mixer != null && Build.VERSION.SDK_INT >= 34) {
            try {
                if (profile.mixer.equals(manager.getPreferredMixerAttributes(attributes, profile.device))) {
                    manager.clearPreferredMixerAttributes(attributes, profile.device);
                }
            } catch (RuntimeException ignored) {}
        }
    }

    static int bytesPerSample(int encoding) { return encoding == AudioFormat.ENCODING_PCM_16BIT ? 2 : encoding == AudioFormat.ENCODING_PCM_24BIT_PACKED ? 3 : 4; }
    static int integerBits(int encoding) { return encoding == AudioFormat.ENCODING_PCM_16BIT ? 16 : encoding == AudioFormat.ENCODING_PCM_24BIT_PACKED ? 24 : encoding == AudioFormat.ENCODING_PCM_32BIT ? 32 : 0; }
    static boolean isUsb(AudioDeviceInfo device) {
        return device != null && (device.getType() == AudioDeviceInfo.TYPE_USB_DEVICE
            || device.getType() == AudioDeviceInfo.TYPE_USB_ACCESSORY
            || (Build.VERSION.SDK_INT >= 26 && device.getType() == AudioDeviceInfo.TYPE_USB_HEADSET));
    }
    private static boolean supportsRate(AudioDeviceInfo device, int rate) {
        if (device == null) return false;
        for (int supported : device.getSampleRates()) if (supported == rate) return true;
        return false;
    }
    private static boolean supportsChannels(AudioDeviceInfo device, int channels) {
        if (device != null) for (int supported : device.getChannelCounts()) if (supported == channels) return true;
        return false;
    }
    static int channelMask(int channels) {
        switch (channels) {
            case 1: return AudioFormat.CHANNEL_OUT_MONO;
            case 2: return AudioFormat.CHANNEL_OUT_STEREO;
            case 3: return AudioFormat.CHANNEL_OUT_STEREO | AudioFormat.CHANNEL_OUT_FRONT_CENTER;
            case 4: return AudioFormat.CHANNEL_OUT_QUAD;
            case 5: return AudioFormat.CHANNEL_OUT_QUAD | AudioFormat.CHANNEL_OUT_FRONT_CENTER;
            case 6: return AudioFormat.CHANNEL_OUT_5POINT1;
            case 7: return AudioFormat.CHANNEL_OUT_5POINT1 | AudioFormat.CHANNEL_OUT_BACK_CENTER;
            case 8: return AudioFormat.CHANNEL_OUT_7POINT1_SURROUND;
            default: throw new IllegalArgumentException("Unsupported channel count");
        }
    }
}
