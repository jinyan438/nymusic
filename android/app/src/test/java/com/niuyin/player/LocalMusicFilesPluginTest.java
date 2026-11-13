package com.niuyin.player;

import static org.junit.Assert.*;

import java.io.EOFException;
import java.io.File;
import java.io.RandomAccessFile;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class LocalMusicFilesPluginTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void acceptsIntegerAndLongJsonOffsets() {
        assertEquals(Long.valueOf(0), LocalMusicFilesPlugin.parseOffset(0));
        assertEquals(Long.valueOf(65536), LocalMusicFilesPlugin.parseOffset(65536));
        assertEquals(Long.valueOf(5L * 1024 * 1024 * 1024), LocalMusicFilesPlugin.parseOffset(5L * 1024 * 1024 * 1024));
        assertNull(LocalMusicFilesPlugin.parseOffset(-1));
        assertNull(LocalMusicFilesPlugin.parseOffset(1.5));
        assertNull(LocalMusicFilesPlugin.parseOffset("0"));
        assertNull(LocalMusicFilesPlugin.parseOffset(Double.NaN));
        assertNull(LocalMusicFilesPlugin.parseOffset(Double.POSITIVE_INFINITY));
    }

    @Test
    public void readsOnlyRequestedBytes() throws Exception {
        File file = folder.newFile();
        try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
            output.write(new byte[] { 1, 2, 3, 4, 5 });
        }
        assertArrayEquals(new byte[] { 2, 3 }, LocalMusicFilesPlugin.readFileRange(file.getPath(), 1, 2));
        assertArrayEquals(new byte[] {}, LocalMusicFilesPlugin.readFileRange(file.getPath(), 5, 0));
    }

    @Test(expected = EOFException.class)
    public void rejectsTruncatedRanges() throws Exception {
        File file = folder.newFile();
        LocalMusicFilesPlugin.readFileRange(file.getPath(), 0, 1);
    }
}
