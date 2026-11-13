package com.niuyin.player;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import com.un4seen.bass.BASS;
import java.io.File;
import java.io.IOException;

final class BassDecoder implements AutoCloseable {
    private static boolean initialized;
    private static final String[] PLUGINS = { "bassflac", "bassalac", "bassopus", "bassape", "basswv", "bassdsd" };
    final BASS.BASS_CHANNELINFO info = new BASS.BASS_CHANNELINFO();
    volatile HttpAudioSource network;
    volatile boolean cancelled;
    int handle;
    double duration;

    static synchronized void initialize(Context context) throws IOException {
        if (initialized) return;
        if (!BASS.BASS_Init(0, 48000, 0)) throw error("初始化 BASS");
        try {
            BASS.BASS_SetConfig(BASS.BASS_CONFIG_SRC, 4); // 64-point sinc when conversion is necessary.
            BASS.BASS_SetConfig(BASS.BASS_CONFIG_FLOAT, 1);
            BASS.BASS_SetConfig(BASS.BASS_CONFIG_ASYNCFILE_BUFFER, 1024 * 1024);
            BASS.BASS_SetConfig(BASS.BASS_CONFIG_VIDEO, 0);
            for (String plugin : PLUGINS) {
                String path = new File(context.getApplicationInfo().nativeLibraryDir, "lib" + plugin + ".so").getPath();
                if (BASS.BASS_PluginLoad(path, 0) == 0) throw error("加载 " + plugin);
            }
            initialized = true;
        } finally {
            if (!initialized) { BASS.BASS_PluginFree(0); BASS.BASS_Free(); }
        }
    }

    void open(Context context, String location) throws IOException {
        initialize(context);
        int flags = BASS.BASS_STREAM_DECODE | BASS.BASS_SAMPLE_FLOAT | BASS.BASS_ASYNCFILE;
        Uri uri = Uri.parse(location);
        if ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) {
            network = new HttpAudioSource(location);
            if (cancelled) throw new IOException("Playback cancelled");
            network.open();
            int system = network.FILELENPROC(null) > 0 ? BASS.STREAMFILE_NOBUFFER : BASS.STREAMFILE_BUFFER;
            handle = BASS.BASS_StreamCreateFileUser(system, flags, network, network);
        } else if ("content".equals(uri.getScheme())) {
            try (AssetFileDescriptor file = context.getContentResolver().openAssetFileDescriptor(uri, "r")) {
                if (file == null) throw new IOException("无法打开本地音频");
                handle = BASS.BASS_StreamCreateFile(file.getParcelFileDescriptor(), file.getStartOffset(), Math.max(0, file.getLength()), flags);
            }
        } else {
            String path = "file".equals(uri.getScheme()) ? uri.getPath() : location;
            if (uri.getScheme() != null && !"file".equals(uri.getScheme())) throw new IOException("Unsupported audio location");
            handle = BASS.BASS_StreamCreateFile(path, 0, 0, flags);
        }
        if (handle == 0) {
            if (network != null && network.failure() != null) throw network.failure();
            throw error("打开音频");
        }
        if (!BASS.BASS_ChannelGetInfo(handle, info)) throw error("读取音频格式");
        if (info.chans < 1 || info.chans > 8 || info.freq < 1000) throw new IOException("不支持的音频声道或采样率");
        BASS.BASS_ChannelSetAttribute(handle, BASS.BASS_ATTRIB_SRC, 4);
        long bytes = BASS.BASS_ChannelGetLength(handle, BASS.BASS_POS_BYTE);
        duration = bytes >= 0 ? BASS.BASS_ChannelBytes2Seconds(handle, bytes) : 0;
    }

    void cancel() { cancelled = true; if (network != null) network.close(); }
    boolean isLosslessInteger() { return PcmCodec.losslessInteger(info.ctype, info.origres); }
    static IOException error(String operation) { return new IOException(operation + "失败 (BASS " + BASS.BASS_ErrorGetCode() + ")"); }
    @Override public void close() {
        cancel();
        if (handle != 0) { BASS.BASS_StreamFree(handle); handle = 0; }
    }
}
