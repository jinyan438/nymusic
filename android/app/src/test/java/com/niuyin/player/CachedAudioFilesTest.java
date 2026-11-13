package com.niuyin.player;

import static org.junit.Assert.*;
import java.io.File;
import java.io.FileOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class CachedAudioFilesTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private File write(File cache, String key) throws Exception {
        File file = CachedAudioFiles.forKey(cache, key);
        file.getParentFile().mkdirs();
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(new byte[] { 1, 2, 3 }); }
        return file;
    }

    @Test public void filenamesMatchTheWebViewSha256AndCannotEscapeTheCache() throws Exception {
        File cache = folder.newFolder();
        assertEquals(new File(cache, "bass-playback/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.audio"), CachedAudioFiles.forKey(cache, "abc"));
        File unsafe = CachedAudioFiles.forKey(cache, "../../secret");
        assertEquals(new File(cache, "bass-playback").getCanonicalFile(), unsafe.getCanonicalFile().getParentFile());
    }

    @Test public void preferredQualityWinsAndOtherDownloadedQualitiesWorkOffline() throws Exception {
        File cache = folder.newFolder();
        File flac = write(cache, "flac");
        assertEquals(flac, CachedAudioFiles.find(cache, new String[] { "flac24bit", "flac", "320k" }));
        File hires = write(cache, "flac24bit");
        assertEquals(hires, CachedAudioFiles.find(cache, new String[] { "flac24bit", "flac" }));
        assertEquals(flac, CachedAudioFiles.find(cache, new String[] { "flac", "flac24bit" }));
    }

    @Test public void missingEmptyAndPartialFilesAreNeverUsed() throws Exception {
        File cache = folder.newFolder();
        File empty = CachedAudioFiles.forKey(cache, "empty"); empty.getParentFile().mkdirs(); assertTrue(empty.createNewFile());
        File partial = new File(CachedAudioFiles.forKey(cache, "partial").getPath() + ".part");
        try (FileOutputStream output = new FileOutputStream(partial)) { output.write(1); }
        assertNull(CachedAudioFiles.find(cache, new String[] { "missing", "empty", "partial" }));
        assertNull(CachedAudioFiles.find(cache, null));
    }
}
