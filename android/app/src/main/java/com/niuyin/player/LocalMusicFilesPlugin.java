package com.niuyin.player;

import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LocalMusicFiles")
public class LocalMusicFilesPlugin extends Plugin {
    private final ExecutorService readers = Executors.newFixedThreadPool(4);

    @PluginMethod
    public void readRange(PluginCall call) {
        String path = call.getString("path");
        Long offset = parseOffset(call.getData().opt("offset"));
        Integer length = call.getInt("length");
        if (path == null || offset == null || offset < 0 || length == null || length < 0 || length > 256 * 1024) {
            call.reject("Invalid file range");
            return;
        }
        readers.execute(() -> {
            try {
                byte[] bytes = new byte[length];
                Uri uri = Uri.parse(path);
                if ("content".equals(uri.getScheme())) {
                    try (AssetFileDescriptor descriptor = getContext().getContentResolver().openAssetFileDescriptor(uri, "r")) {
                        if (descriptor == null) throw new IOException("Cannot open audio file");
                        try (InputStream stream = descriptor.createInputStream()) {
                            long skipped = 0;
                            while (skipped < offset) {
                                long count = stream.skip(offset - skipped);
                                if (count == 0) {
                                    if (stream.read() == -1) throw new IOException("Unexpected end of audio file");
                                    count = 1;
                                }
                                skipped += count;
                            }
                            int read = 0;
                            while (read < length) {
                                int count = stream.read(bytes, read, length - read);
                                if (count <= 0) throw new IOException("Unexpected end of audio file");
                                read += count;
                            }
                        }
                    }
                } else {
                    String filePath = "file".equals(uri.getScheme()) ? uri.getPath() : path;
                    bytes = readFileRange(filePath, offset, length);
                }
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Cannot read audio tags", error);
            }
        });
    }

    // JSON 将较小的整数表示为 Integer，较大的偏移量表示为 Long。
    static Long parseOffset(Object value) {
        if (!(value instanceof Number)) return null;
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9007199254740991L || number != Math.rint(number)) return null;
        return ((Number) value).longValue();
    }

    static byte[] readFileRange(String path, long offset, int length) throws IOException {
        byte[] bytes = new byte[length];
        try (RandomAccessFile file = new RandomAccessFile(path, "r")) {
            file.seek(offset);
            file.readFully(bytes);
        }
        return bytes;
    }

    @Override
    protected void handleOnDestroy() {
        readers.shutdownNow();
        super.handleOnDestroy();
    }
}
