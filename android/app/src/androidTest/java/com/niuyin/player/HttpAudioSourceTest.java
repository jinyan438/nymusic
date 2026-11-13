package com.niuyin.player;

import static org.junit.Assert.*;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.un4seen.bass.BASS;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class HttpAudioSourceTest {
    private static final class AudioServer implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        final byte[] data;
        final Thread worker;
        AudioServer(boolean ranges) throws Exception {
            this(ranges, pattern());
        }
        private static byte[] pattern() {
            byte[] data = new byte[256 * 1024];
            for (int i = 0; i < data.length; i++) data[i] = (byte) (i % 251);
            return data;
        }
        AudioServer(boolean ranges, byte[] contents) throws Exception {
            data = contents;
            worker = new Thread(() -> {
                while (!socket.isClosed()) try (Socket client = socket.accept()) {
                    BufferedReader request = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII));
                    String line = request.readLine();
                    int offset = 0;
                    while ((line = request.readLine()) != null && !line.isEmpty()) {
                        if (ranges && line.toLowerCase().startsWith("range: bytes=")) offset = Integer.parseInt(line.substring(line.indexOf('=') + 1, line.indexOf('-')));
                    }
                    String header = "HTTP/1.1 " + (ranges ? "206 Partial Content" : "200 OK") + "\r\nContent-Type: audio/wav\r\nContent-Length: " + (data.length - offset)
                        + (ranges ? "\r\nContent-Range: bytes " + offset + "-" + (data.length - 1) + "/" + data.length : "") + "\r\nConnection: close\r\n\r\n";
                    OutputStream output = client.getOutputStream();
                    output.write(header.getBytes(StandardCharsets.US_ASCII)); output.write(data, offset, data.length - offset); output.flush();
                } catch (Exception ignored) {}
            }, "test-audio-http");
            worker.start();
        }
        String url() { return "http://127.0.0.1:" + socket.getLocalPort() + "/music.wav"; }
        @Override public void close() throws Exception { socket.close(); worker.join(1000); }
    }

    private void verifySeek(boolean ranges) throws Exception {
        try (AudioServer server = new AudioServer(ranges); HttpAudioSource source = new HttpAudioSource(server.url())) {
            source.open();
            assertEquals(server.data.length, source.FILELENPROC(null));
            ByteBuffer bytes = ByteBuffer.allocateDirect(1024);
            assertEquals(1024, source.FILEREADPROC(bytes, 1024, null));
            bytes.flip();
            for (int i = 0; i < 1024; i++) assertEquals(server.data[i], bytes.get());
            assertTrue(source.FILESEEKPROC(200001, null));
            bytes.clear();
            assertEquals(1024, source.FILEREADPROC(bytes, 1024, null));
            bytes.flip();
            for (int i = 0; i < 1024; i++) assertEquals(server.data[200001 + i], bytes.get());
            assertNull(source.failure());
        }
    }
    @Test public void rangeRequestsRetainSampleBytesAcrossSeeks() throws Exception { verifySeek(true); }
    @Test public void serversIgnoringRangeStillSeekCorrectly() throws Exception { verifySeek(false); }

    @Test public void bassActuallyDecodesThroughTheJavaHttpCallbacks() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = BassAudioIntegrationTest.wav(context, 96000, 4096, true);
        byte[] contents = new byte[(int) file.length()];
        try (java.io.DataInputStream input = new java.io.DataInputStream(new FileInputStream(file))) { input.readFully(contents); }
        try (AudioServer server = new AudioServer(true, contents); BassDecoder decoder = new BassDecoder()) {
            decoder.open(context, server.url());
            assertEquals(96000, decoder.info.freq); assertEquals(24, decoder.info.origres);
            ByteBuffer bytes = ByteBuffer.allocateDirect(4096).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            int read = BASS.BASS_ChannelGetData(decoder.handle, bytes, bytes.capacity());
            assertTrue(read > 0); bytes.position(0);
            for (int i = 0; i < read / 4; i++) {
                int offset = 44 + i * 3;
                int sample = (contents[offset] & 255) | ((contents[offset + 1] & 255) << 8) | (contents[offset + 2] << 16);
                assertEquals(sample / 8388608f, bytes.getFloat(), 0f);
            }
        } finally { file.delete(); }
    }
}
