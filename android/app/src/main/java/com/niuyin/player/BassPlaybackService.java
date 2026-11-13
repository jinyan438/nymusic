package com.niuyin.player;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import java.util.Iterator;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import org.json.JSONArray;
import org.json.JSONObject;

public final class BassPlaybackService extends Service implements BassAudioEngine.Listener {
    static final String ACTION_START = "com.niuyin.player.audio.START";
    private static final String ACTION_PLAY = "com.niuyin.player.audio.PLAY";
    private static final String ACTION_PAUSE = "com.niuyin.player.audio.PAUSE";
    private static final String ACTION_NEXT = "com.niuyin.player.audio.NEXT";
    private static final String ACTION_PREVIOUS = "com.niuyin.player.audio.PREVIOUS";
    private static final String ACTION_STOP = "com.niuyin.player.audio.STOP";
    private static final String CHANNEL = "music_playback";
    private static final int NOTIFICATION = 42;
    interface Observer { void onEvent(String event, JSObject data); }
    interface Result { void resolve(JSObject data); void reject(String message); }
    final class LocalBinder extends Binder { BassPlaybackService service() { return BassPlaybackService.this; } }
    private final IBinder binder = new LocalBinder();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Observer> observers = new CopyOnWriteArraySet<>();
    private final Random random = new Random();
    private BassAudioEngine engine;
    private AudioManager audio;
    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private AudioFocusRequest focusRequest;
    private boolean focusHeld;
    private boolean resumeOnFocus;
    private boolean foreground;
    private boolean ready;
    private boolean requestedPaused = true;
    private long version;
    private long wakeAcquired;
    private JSONArray queue = new JSONArray();
    private JSONObject track;
    private String uri;
    private String clientId = "";
    private String mode = "order";
    private int index = -1;
    private JSObject audioState = idleState();
    private Result pendingLoad;
    private Boolean lastNotificationPaused;

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) pause(null); }
    };
    private final AudioDeviceCallback devices = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] added) { engine.reconfigure(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) { engine.reconfigure(); }
    };
    private final AudioManager.OnAudioFocusChangeListener focus = change -> main.post(() -> {
        if (change == AudioManager.AUDIOFOCUS_GAIN) {
            focusHeld = true;
            if (resumeOnFocus) { resumeOnFocus = false; play(null); }
        } else {
            boolean resume = change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK;
            boolean wasPlaying = !requestedPaused;
            pauseNow();
            resumeOnFocus = resume && wasPlaying;
            if (change == AudioManager.AUDIOFOCUS_LOSS) { focusHeld = false; abandonFocus(); }
        }
    });

    @Override public void onCreate() {
        super.onCreate();
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        engine = new BassAudioEngine(this, this);
        wakeLock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NiuYin:BassPlayback");
        wakeLock.setReferenceCounted(false);
        session = new MediaSession(this, "NiuYin BASS");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { play(null); }
            @Override public void onPause() { pause(null); }
            @Override public void onStop() { stop(null); }
            @Override public void onSkipToNext() { skip(false, null); }
            @Override public void onSkipToPrevious() { skip(true, null); }
            @Override public void onSeekTo(long position) { seek(position / 1000.0, null); }
        }, main);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(noisy, filter);
        audio.registerAudioDeviceCallback(devices, main);
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) ensureForeground();
        else if (ACTION_PLAY.equals(action)) play(null);
        else if (ACTION_PAUSE.equals(action)) pause(null);
        else if (ACTION_NEXT.equals(action)) skip(false, null);
        else if (ACTION_PREVIOUS.equals(action)) skip(true, null);
        else if (ACTION_STOP.equals(action)) stop(null);
        return START_NOT_STICKY;
    }

    void addObserver(Observer observer) { observers.add(observer); }
    void removeObserver(Observer observer) { observers.remove(observer); }
    void getState(Result result) { main.post(() -> result.resolve(state())); }

    void load(JSObject request, Result result) {
        main.post(() -> {
            String location = request.optString("uri");
            if (location.isEmpty() || location.startsWith("blob:")) { result.reject("BASS 需要本地路径或 HTTP 音频地址"); return; }
            queue = request.optJSONArray("queue");
            if (queue == null) queue = new JSONArray();
            index = request.optInt("index", -1);
            mode = validMode(request.optString("mode"));
            clientId = request.optString("clientId");
            beginLoad(location, request.optJSONObject("track"), result, false);
        });
    }

    private void beginLoad(String location, JSONObject metadata, Result result, boolean notifyTrack) {
        if (pendingLoad != null) pendingLoad.reject("Playback cancelled");
        pendingLoad = result;
        uri = location; track = metadata; ready = false; resumeOnFocus = false;
        requestedPaused = false;
        version++;
        try {
            ensureForeground();
            if (!requestFocus()) throw new IllegalStateException("暂时无法取得音频焦点，请稍后重试");
            audioState = idleState(); audioState.put("buffering", true); audioState.put("paused", false);
            session.setActive(true);
            keepAwake(true);
            lastNotificationPaused = null;
            publish();
            if (notifyTrack) emit("track", state());
            engine.load(version, location);
        } catch (RuntimeException error) { fail(error.getMessage()); }
    }

    void play(Result result) {
        main.post(() -> {
            resumeOnFocus = false;
            if (uri == null) { if (result != null) result.reject("请先选择一首歌曲"); return; }
            if (!ready) { beginLoad(uri, track, result, false); return; }
            try {
                ensureForeground();
                if (!requestFocus()) throw new IllegalStateException("暂时无法取得音频焦点");
                engine.play();
                requestedPaused = false;
                audioState = copy(audioState); audioState.put("paused", false);
                keepAwake(true); publish(); resolve(result);
            } catch (RuntimeException error) { if (result != null) result.reject(error.getMessage()); }
        });
    }

    void pause(Result result) {
        main.post(() -> {
            resumeOnFocus = false;
            pauseNow(); resolve(result);
        });
    }

    private void pauseNow() {
        requestedPaused = true;
        engine.pause();
        audioState = copy(audioState); audioState.put("paused", true);
        keepAwake(false); publish();
    }

    void seek(double position, Result result) {
        main.post(() -> {
            if (!Double.isFinite(position) || position < 0 || uri == null || !ready) {
                if (result != null) result.reject("无效的播放进度"); return;
            }
            double duration = audioState.optDouble("duration", 0);
            double target = duration > 0 ? Math.min(position, duration) : position;
            engine.seek(target);
            audioState = copy(audioState); audioState.put("position", target); audioState.put("buffering", true);
            publish(); resolve(result);
        });
    }

    void skip(boolean previous, Result result) {
        main.post(() -> {
            int next = QueueNavigator.next(index, queue.length(), mode, previous, random);
            if (next < 0) { resolve(result); return; }
            JSONObject entry = queue.optJSONObject(next);
            if (entry == null || entry.optString("uri").isEmpty()) { if (result != null) result.reject("播放列表条目无效"); return; }
            index = next;
            beginLoad(entry.optString("uri"), entry.optJSONObject("track"), result, true);
        });
    }

    void setMode(String value, Result result) { main.post(() -> { mode = validMode(value); resolve(result); }); }

    void stop(Result result) {
        main.post(() -> {
            version++;
            if (pendingLoad != null) { pendingLoad.reject("Playback cancelled"); pendingLoad = null; }
            engine.stop(); ready = false; resumeOnFocus = false;
            requestedPaused = true;
            audioState = idleState();
            keepAwake(false); abandonFocus();
            session.setActive(false); publish();
            if (foreground) { stopForeground(true); foreground = false; }
            stopSelf(); resolve(result);
        });
    }

    @Override public void onState(long id, JSObject value) {
        main.post(() -> {
            if (id != version) return;
            audioState = copy(value); audioState.put("paused", requestedPaused);
            keepAwake(!requestedPaused);
            publish();
        });
    }

    @Override public void onReady(long id) {
        main.post(() -> {
            if (id != version) return;
            ready = true;
            if (pendingLoad != null) { pendingLoad.resolve(state()); pendingLoad = null; }
        });
    }

    @Override public void onEnded(long id) {
        main.post(() -> {
            if (id != version) return;
            ready = false;
            if ("repeat".equals(mode) && (index < 0 || queue.length() == 0)) beginLoad(uri, track, null, false);
            else if (queue.length() > 0) skip(false, null);
            else {
                requestedPaused = true;
                audioState = copy(audioState); audioState.put("paused", true); audioState.put("buffering", false);
                keepAwake(false); abandonFocus(); publish();
            }
        });
    }

    @Override public void onError(long id, Exception error) { main.post(() -> { if (id == version) fail(error.getMessage()); }); }

    private void fail(String message) {
        version++; engine.stop(); ready = false;
        requestedPaused = true;
        audioState = copy(audioState); audioState.put("paused", true); audioState.put("buffering", false);
        keepAwake(false); abandonFocus();
        JSObject error = state(); error.put("message", message == null ? "播放失败" : message);
        if (pendingLoad != null) { pendingLoad.reject(error.optString("message")); pendingLoad = null; }
        else emit("playbackError", error);
        publish();
        if (foreground) { stopForeground(true); foreground = false; }
        stopSelf();
    }

    private boolean requestFocus() {
        if (focusHeld) return true;
        int result;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(NativeAudioOutput.musicAttributes()).setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(focus, main).build();
            result = audio.requestAudioFocus(focusRequest);
        } else result = audio.requestAudioFocus(focus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return focusHeld;
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audio.abandonAudioFocusRequest(focusRequest);
        else audio.abandonAudioFocus(focus);
        focusHeld = false;
    }

    private void keepAwake(boolean playing) {
        if (playing && (!wakeLock.isHeld() || SystemClock.elapsedRealtime() - wakeAcquired > 30 * 60 * 1000)) {
            wakeLock.acquire(60 * 60 * 1000L); wakeAcquired = SystemClock.elapsedRealtime();
        } else if (!playing && wakeLock.isHeld()) wakeLock.release();
    }

    private void ensureForeground() {
        if (foreground) return;
        Notification notification = notification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION, notification);
        foreground = true;
    }

    private Notification notification() {
        boolean paused = audioState.optBoolean("paused", true);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return builder.setSmallIcon(R.drawable.ic_music_note).setContentTitle(track == null ? "牛音播放器" : track.optString("songName", "牛音播放器"))
            .setContentText(track == null ? "" : track.optString("artist"))
            .setContentIntent(content).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(!paused).setDeleteIntent(action(ACTION_STOP, 5))
            .addAction(android.R.drawable.ic_media_previous, "上一首", action(ACTION_PREVIOUS, 1))
            .addAction(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause, paused ? "播放" : "暂停", action(paused ? ACTION_PLAY : ACTION_PAUSE, 2))
            .addAction(android.R.drawable.ic_media_next, "下一首", action(ACTION_NEXT, 3))
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2)).build();
    }

    private PendingIntent action(String value, int request) {
        return PendingIntent.getService(this, request, new Intent(this, BassPlaybackService.class).setAction(value), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // Android 13 exempts notifications associated with a media session from POST_NOTIFICATIONS.
    @SuppressLint("NotificationPermission")
    private void publish() {
        boolean paused = audioState.optBoolean("paused", true);
        boolean buffering = audioState.optBoolean("buffering", false);
        long duration = (long) (audioState.optDouble("duration", 0) * 1000);
        session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, track == null ? "" : track.optString("songName"))
            .putString(MediaMetadata.METADATA_KEY_ARTIST, track == null ? "" : track.optString("artist"))
            .putLong(MediaMetadata.METADATA_KEY_DURATION, duration).build());
        session.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
            .setState(paused ? PlaybackState.STATE_PAUSED : buffering ? PlaybackState.STATE_BUFFERING : PlaybackState.STATE_PLAYING,
                (long) (audioState.optDouble("position", 0) * 1000), paused ? 0f : 1f, SystemClock.elapsedRealtime()).build());
        if (foreground && (lastNotificationPaused == null || lastNotificationPaused != paused)) {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION, notification());
            lastNotificationPaused = paused;
        }
        emit("state", state());
    }

    private JSObject state() {
        JSObject result = copy(audioState);
        result.put("clientId", clientId); result.put("track", track); result.put("index", index);
        result.put("trackId", track == null ? "" : track.optString("source") + ":" + track.optString("trackId"));
        result.put("mode", mode);
        return result;
    }
    private void emit(String event, JSObject data) { for (Observer observer : observers) observer.onEvent(event, data); }
    private void resolve(Result result) { if (result != null) result.resolve(state()); }
    private static JSObject idleState() {
        JSObject state = new JSObject(); state.put("engine", "BASS"); state.put("paused", true);
        state.put("buffering", false); state.put("position", 0); state.put("duration", 0); state.put("bitPerfect", false);
        return state;
    }
    private static String validMode(String mode) { return "random".equals(mode) || "repeat".equals(mode) ? mode : "order"; }
    private static JSObject copy(JSONObject source) {
        JSObject result = new JSObject();
        for (Iterator<String> keys = source.keys(); keys.hasNext();) { String key = keys.next(); result.put(key, source.opt(key)); }
        return result;
    }

    @Override public void onDestroy() {
        version++;
        if (pendingLoad != null) pendingLoad.reject("Playback service stopped");
        observers.clear(); audio.unregisterAudioDeviceCallback(devices); unregisterReceiver(noisy);
        engine.close(); keepAwake(false); abandonFocus(); session.release();
        super.onDestroy();
    }
}
