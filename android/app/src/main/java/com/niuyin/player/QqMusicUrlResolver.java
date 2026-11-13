package com.niuyin.player;

import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Resolves QQ vkeys on the audio worker, including notification/lock-screen queue changes. */
final class QqMusicUrlResolver implements AutoCloseable {
    private volatile HttpURLConnection connection;
    private volatile boolean cancelled;

    String resolve(String endpoint, JSONObject headers) throws IOException {
        try {
            Uri uri = Uri.parse(endpoint);
            JSONObject request = new JSONObject(uri.getQueryParameter("data"));
            JSONObject params = request.getJSONObject("req_0").getJSONObject("param");
            String mid = params.getJSONArray("songmid").getString(0);
            // 收藏和离线缓存仍保留旧歌曲 ID；在线请求使用 QQ 的 MID。
            if (mid.matches("\\d+")) {
                JSONObject infoRequest = new JSONObject().put("comm", new JSONObject().put("ct", 24).put("cv", 0))
                    .put("songinfo", new JSONObject().put("module", "music.pf_song_detail_svr").put("method", "get_song_detail_yqq")
                        .put("param", new JSONObject().put("song_type", 0).put("song_mid", "").put("song_id", Long.parseLong(mid))));
                String infoUrl = uri.buildUpon().clearQuery().appendQueryParameter("format", "json")
                    .appendQueryParameter("data", infoRequest.toString()).build().toString();
                JSONObject info = checked(readJson(infoUrl, headers)).getJSONObject("songinfo");
                JSONObject song = checked(info).getJSONObject("data").getJSONObject("track_info");
                mid = song.getString("mid");
                String filename = params.getJSONArray("filename").getString(0);
                JSONObject file = song.optJSONObject("file");
                String mediaId = file == null ? mid : file.optString("media_mid", mid);
                if (mediaId.isEmpty()) mediaId = mid;
                params.put("songmid", new JSONArray().put(mid));
                params.put("filename", new JSONArray().put(filename.substring(0, 4) + mid + mediaId + filename.substring(filename.lastIndexOf('.'))));
                Uri.Builder builder = uri.buildUpon().clearQuery();
                for (String key : uri.getQueryParameterNames()) builder.appendQueryParameter(key, "data".equals(key) ? request.toString() : uri.getQueryParameter(key));
                endpoint = builder.build().toString();
            }
            return playbackUrl(readJson(endpoint, headers), mid);
        } catch (JSONException | IllegalArgumentException error) {
            throw new IOException("QQ 音乐返回了无效播放数据", error);
        }
    }

    static String playbackUrl(JSONObject response, String mid) throws IOException, JSONException {
        JSONObject data = checked(checked(response).getJSONObject("req_0")).getJSONObject("data");
        JSONArray songs = data.getJSONArray("midurlinfo");
        String path = "";
        for (int i = 0; i < songs.length(); i++) {
            JSONObject song = songs.getJSONObject(i);
            if (mid.equals(song.optString("songmid"))) { path = song.optString("purl"); break; }
        }
        JSONArray domains = data.getJSONArray("sip");
        String domain = domains.optString(0);
        for (int i = 0; i < domains.length(); i++) {
            String candidate = domains.getString(i);
            if (!candidate.startsWith("http://ws")) { domain = candidate; break; }
        }
        if (path.isEmpty() || domain.isEmpty()) throw new IOException("QQ 音乐未提供该音质的播放地址，请切换音质或重新扫码登录");
        URL url = new URL(new URL(domain), path);
        if (!"https".equals(url.getProtocol()) && !"http".equals(url.getProtocol())) throw new IOException("无效的 QQ 播放地址");
        return url.toString();
    }

    private static JSONObject checked(JSONObject response) throws IOException {
        if (response.has("code") && response.optInt("code", -1) != 0) throw new IOException("QQ 音乐接口错误（" + response.optInt("code") + "）");
        return response;
    }

    private JSONObject readJson(String location, JSONObject headers) throws IOException, JSONException {
        if (cancelled) throw new IOException("Playback cancelled");
        HttpURLConnection next = (HttpURLConnection) new URL(location).openConnection();
        connection = next;
        try {
            next.setConnectTimeout(15000); next.setReadTimeout(15000); next.setInstanceFollowRedirects(false);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) { String key = keys.next(); next.setRequestProperty(key, headers.getString(key)); }
            }
            if (cancelled) throw new IOException("Playback cancelled");
            if (next.getResponseCode() != 200) throw new IOException("QQ 音乐 HTTP " + next.getResponseCode());
            try (InputStream input = next.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (cancelled) throw new IOException("Playback cancelled");
                    if (output.size() + count > 2 * 1024 * 1024) throw new IOException("QQ 音乐响应过大");
                    output.write(buffer, 0, count);
                }
                return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally { next.disconnect(); if (connection == next) connection = null; }
    }

    @Override public void close() { cancelled = true; HttpURLConnection active = connection; if (active != null) active.disconnect(); }
}
