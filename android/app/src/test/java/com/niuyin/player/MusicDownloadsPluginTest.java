package com.niuyin.player;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class MusicDownloadsPluginTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void validatesNamesWithoutAllowingTraversal() {
        assertTrue(MusicDownloadsPlugin.validName("歌曲 - 歌手.flac"));
        for (String name : new String[] { "", "..", "../music.flac", "dir/music.mp3", "dir\\music.mp3", "bad\0name" }) {
            assertFalse(MusicDownloadsPlugin.validName(name));
        }
        assertFalse(MusicDownloadsPlugin.validName(new String(new char[100]).replace('\0', '歌')));
    }

    @Test public void onlyReadsNonEmptyFilesInsideTheAppCache() throws Exception {
        File cache = folder.newFolder("cache");
        File audio = new File(cache, "audio.part");
        try (FileOutputStream output = new FileOutputStream(audio)) { output.write(new byte[] { 1, 2, 3 }); }
        assertEquals(audio.getCanonicalFile(), MusicDownloadsPlugin.sourceInCache(cache, audio.toURI().toString()));
        File outside = folder.newFile("outside.flac");
        try { MusicDownloadsPlugin.sourceInCache(cache, outside.toURI().toString()); fail("Outside cache accepted"); }
        catch (IOException expected) {}
        File empty = new File(cache, "empty.part"); assertTrue(empty.createNewFile());
        try { MusicDownloadsPlugin.sourceInCache(cache, empty.toURI().toString()); fail("Empty audio accepted"); }
        catch (IOException expected) {}
        try { MusicDownloadsPlugin.sourceInCache(cache, "content://unselected/audio"); fail("Arbitrary URI accepted"); }
        catch (IOException expected) {}
    }

    @Test public void copiesAudioExactlyInBoundedBlocks() throws Exception {
        byte[] source = new byte[250001];
        for (int i = 0; i < source.length; i++) source[i] = (byte) (i % 251);
        ByteArrayOutputStream output = new ByteArrayOutputStream() {
            @Override public synchronized void write(byte[] bytes, int offset, int count) {
                assertTrue(count <= 64 * 1024); super.write(bytes, offset, count);
            }
        };
        assertEquals(source.length, MusicDownloadsPlugin.copy(new ByteArrayInputStream(source), output));
        assertArrayEquals(source, output.toByteArray());
    }

    @Test public void propagatesWriteFailureAndCancellation() throws Exception {
        OutputStream failed = new OutputStream() { @Override public void write(int value) throws IOException { throw new IOException("Disk full"); } };
        try { MusicDownloadsPlugin.copy(new ByteArrayInputStream(new byte[] { 1 }), failed); fail("Write error ignored"); }
        catch (IOException expected) { assertEquals("Disk full", expected.getMessage()); }
        try {
            Thread.currentThread().interrupt();
            MusicDownloadsPlugin.copy(new ByteArrayInputStream(new byte[] { 1 }), new ByteArrayOutputStream());
            fail("Cancellation ignored");
        } catch (IOException expected) { assertEquals("Save cancelled", expected.getMessage()); }
        finally { Thread.interrupted(); }
    }
}
