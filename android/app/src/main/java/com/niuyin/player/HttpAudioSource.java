package com.niuyin.player;

import com.un4seen.bass.BASS;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;

/** Seekable, bounded-memory HTTP input. TLS and certificate checks use Android's network stack. */
final class HttpAudioSource implements BASS.BASS_FILEPROCS, Closeable {
    private final URL originalUrl;
    private final byte[] transfer = new byte[64 * 1024];
    private volatile HttpURLConnection connection;
    private volatile InputStream input;
    private volatile boolean closed;
    private long position;
    private long length;
    private volatile IOException failure;

    HttpAudioSource(String uri) throws IOException { originalUrl = new URL(uri); }

    void open() throws IOException { connect(0); }
    IOException failure() { return failure; }

    private void connect(long offset) throws IOException {
        disconnect();
        if (closed) throw new IOException("Playback cancelled");
        URL url = originalUrl;
        for (int redirects = 0; redirects <= 8; redirects++) {
            if (!"https".equals(url.getProtocol()) && !"http".equals(url.getProtocol())) throw new IOException("Unsupported audio URL");
            HttpURLConnection next = (HttpURLConnection) url.openConnection();
            connection = next;
            next.setConnectTimeout(15000);
            next.setReadTimeout(15000);
            next.setInstanceFollowRedirects(false);
            next.setRequestProperty("Accept-Encoding", "identity");
            next.setRequestProperty("User-Agent", "NiuYin/1.0 (Android; BASS)");
            next.setRequestProperty("Range", "bytes=" + offset + "-");
            if (closed) { next.disconnect(); throw new IOException("Playback cancelled"); }
            int code = next.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String location = next.getHeaderField("Location");
                next.disconnect();
                if (location == null) throw new IOException("Audio redirect has no destination");
                url = new URL(url, location);
                continue;
            }
            if (code != 200 && code != 206) throw new IOException("Audio HTTP " + code);
            String type = next.getContentType();
            if (type != null && (type.startsWith("text/") || type.contains("json"))) {
                throw new IOException("音乐接口未返回音频文件");
            }
            long contentLength;
            try { contentLength = Long.parseLong(next.getHeaderField("Content-Length")); }
            catch (NumberFormatException ignored) { contentLength = -1; }
            if (code == 206) {
                String range = next.getHeaderField("Content-Range");
                if (range == null || !range.startsWith("bytes " + offset + "-")) throw new IOException("Invalid audio range response");
                String total = range.substring(range.lastIndexOf('/') + 1);
                try { length = Long.parseLong(total); } catch (NumberFormatException ignored) { length = 0; }
            } else if (contentLength >= 0) {
                length = contentLength;
            }
            input = next.getInputStream();
            position = 0;
            if (code == 206) position = offset;
            else {
                // Some servers ignore Range. Retain correct seeking without buffering the whole song in RAM.
                while (position < offset) {
                    if (closed) throw new IOException("Playback cancelled");
                    int count = input.read(transfer, 0, (int) Math.min(transfer.length, offset - position));
                    if (count < 0) throw new IOException("Cannot seek beyond audio response");
                    position += count;
                }
            }
            return;
        }
        throw new IOException("Too many audio redirects");
    }

    @Override public long FILELENPROC(Object user) { return length; }
    @Override public void FILECLOSEPROC(Object user) { close(); }

    @Override public int FILEREADPROC(ByteBuffer buffer, int requested, Object user) {
        int total = 0;
        try {
            while (total < requested && !closed) {
                InputStream current = input;
                if (current == null) break;
                int read = current.read(transfer, 0, Math.min(transfer.length, requested - total));
                if (read < 0) {
                    if (length > 0 && position < length) throw new IOException("网络音频提前结束，请重试");
                    break;
                }
                buffer.put(transfer, 0, read);
                position += read;
                total += read;
            }
        } catch (IOException error) { if (!closed) failure = error; }
        return total;
    }

    @Override public boolean FILESEEKPROC(long offset, Object user) {
        if (closed || offset < 0 || (length > 0 && offset > length)) return false;
        if (offset == position) return true;
        if (length > 0 && offset == length) { disconnect(); position = offset; return true; }
        try { connect(offset); failure = null; return true; }
        catch (IOException error) { if (!closed) failure = error; return false; }
    }

    private void disconnect() {
        HttpURLConnection current = connection;
        connection = null;
        if (current != null) current.disconnect();
        InputStream previous = input;
        input = null;
        if (previous != null) {
            try { previous.close(); } catch (IOException ignored) {}
        }
    }

    @Override public void close() { closed = true; disconnect(); }
}
