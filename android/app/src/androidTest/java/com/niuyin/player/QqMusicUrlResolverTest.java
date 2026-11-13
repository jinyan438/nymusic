package com.niuyin.player;

import static org.junit.Assert.*;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class QqMusicUrlResolverTest {
    private static final class QqServer implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        final Thread worker;
        volatile String cookie;
        volatile String referer;
        volatile int details;
        volatile int vkeys;
        volatile int audioRequests;
        volatile Exception failure;
        final boolean playable;
        final byte[] audio;

        QqServer(boolean playable, byte[] audio) throws Exception {
            this.playable = playable; this.audio = audio;
            worker = new Thread(() -> {
                while (!socket.isClosed()) try (Socket client = socket.accept()) {
                    BufferedReader input = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    String first = input.readLine();
                    String line;
                    String requestCookie = null, requestReferer = null;
                    while ((line = input.readLine()) != null && !line.isEmpty()) {
                        if (line.toLowerCase().startsWith("cookie:")) requestCookie = line.substring(7).trim();
                        if (line.toLowerCase().startsWith("referer:")) requestReferer = line.substring(8).trim();
                    }
                    Uri uri = Uri.parse("http://localhost" + first.split(" ")[1]);
                    byte[] body;
                    String contentType;
                    if ("/track.wav".equals(uri.getPath())) {
                        audioRequests++; body = audio; contentType = "audio/wav";
                    } else {
                        cookie = requestCookie; referer = requestReferer;
                        JSONObject data = new JSONObject(uri.getQueryParameter("data"));
                        JSONObject response;
                        if (data.has("songinfo")) {
                            details++;
                            response = new JSONObject().put("code", 0).put("songinfo", new JSONObject().put("code", 0).put("data",
                                new JSONObject().put("track_info", new JSONObject().put("mid", "song-mid").put("file", new JSONObject().put("media_mid", "media-mid")))));
                        } else {
                            vkeys++;
                            JSONObject params = data.getJSONObject("req_0").getJSONObject("param");
                            if (!"song-mid".equals(params.getJSONArray("songmid").getString(0))) throw new IOException("MID not resolved");
                            if (!"M500song-midmedia-mid.mp3".equals(params.getJSONArray("filename").getString(0))) throw new IOException("Media MID not retained");
                            response = new JSONObject().put("code", 0).put("req_0", new JSONObject().put("code", 0).put("data", new JSONObject()
                                .put("sip", new JSONArray().put(base() + "/"))
                                .put("midurlinfo", new JSONArray().put(new JSONObject().put("songmid", "song-mid").put("purl", playable ? "track.wav" : "")))));
                        }
                        body = response.toString().getBytes(StandardCharsets.UTF_8); contentType = "application/json";
                    }
                    String header = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
                    client.getOutputStream().write(header.getBytes(StandardCharsets.US_ASCII));
                    client.getOutputStream().write(body); client.getOutputStream().flush();
                } catch (Exception error) { if (!socket.isClosed()) failure = error; }
            }, "test-qq-music");
            worker.start();
        }
        String base() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        String endpoint(String mid) throws Exception {
            JSONObject params = new JSONObject().put("songmid", new JSONArray().put(mid))
                .put("filename", new JSONArray().put("M500" + mid + ("song-mid".equals(mid) ? "media-mid" : mid) + ".mp3"));
            return base() + "/musicu.fcg?data=" + Uri.encode(new JSONObject().put("req_0", new JSONObject().put("param", params)).toString());
        }
        @Override public void close() throws Exception { socket.close(); worker.join(1000); }
    }

    @Test public void decodesResolvedAudioWithoutAWebView() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = BassAudioIntegrationTest.wav(context, 96000, 4096, true);
        byte[] audio;
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            audio = output.toByteArray();
        }
        try (QqServer server = new QqServer(true, audio); BassDecoder decoder = new BassDecoder()) {
            decoder.open(context, server.endpoint("song-mid"), true, new JSONObject().put("Cookie", "uin=123").put("Referer", "https://y.qq.com/"));
            assertEquals(96000, decoder.info.freq); assertEquals(24, decoder.info.origres);
            assertEquals(1, server.vkeys); assertTrue(server.audioRequests > 0);
            assertEquals("uin=123", server.cookie); assertEquals("https://y.qq.com/", server.referer);
            assertNull(server.failure);
        } finally { file.delete(); }
    }

    @Test public void resolvesOldNumericIdsOnTheAudioWorker() throws Exception {
        try (QqServer server = new QqServer(true, new byte[0]); QqMusicUrlResolver resolver = new QqMusicUrlResolver()) {
            assertEquals(server.base() + "/track.wav", resolver.resolve(server.endpoint("1234"), null));
            assertEquals(1, server.details); assertEquals(1, server.vkeys); assertNull(server.failure);
        }
    }

    @Test public void rejectsUnavailableQualityAndCancelledRequests() throws Exception {
        try (QqServer server = new QqServer(false, new byte[0]); QqMusicUrlResolver resolver = new QqMusicUrlResolver()) {
            try { resolver.resolve(server.endpoint("song-mid"), null); fail("Empty purl accepted"); }
            catch (IOException expected) { assertTrue(expected.getMessage().contains("切换音质")); }
            assertEquals(0, server.audioRequests);
            resolver.close();
            try { resolver.resolve(server.endpoint("song-mid"), null); fail("Cancelled request accepted"); }
            catch (IOException expected) { assertEquals("Playback cancelled", expected.getMessage()); }
        }
    }
}
