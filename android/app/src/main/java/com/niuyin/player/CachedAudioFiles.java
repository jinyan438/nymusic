package com.niuyin.player;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Shares CacheStorage-keyed native files with the WebView without transferring audio on each play. */
final class CachedAudioFiles {
    static File forKey(File cache, String key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder name = new StringBuilder();
            for (byte value : digest) {
                name.append(Character.forDigit((value & 255) >> 4, 16));
                name.append(Character.forDigit(value & 15, 16));
            }
            return new File(new File(cache, "bass-playback"), name + ".audio");
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    static File find(File cache, String[] keys) {
        if (keys == null) return null;
        for (String key : keys) {
            if (key == null || key.isEmpty()) continue;
            File file = forKey(cache, key);
            if (file.isFile() && file.canRead() && file.length() > 0) return file;
        }
        return null;
    }
}
