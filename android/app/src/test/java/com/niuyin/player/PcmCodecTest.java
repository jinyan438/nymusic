package com.niuyin.player;

import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;
import org.junit.Test;

public class PcmCodecTest {
    @Test public void twentyFourBitPcmSurvivesFloatDecodingAndPackingExactly() {
        Random random = new Random(42);
        for (int i = 0; i < 10000; i++) {
            int original = i == 0 ? -8388608 : i == 1 ? 8388607 : random.nextInt(16777216) - 8388608;
            ByteBuffer floats = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
            floats.putFloat(original / 8388608f).flip();
            ByteBuffer packed = ByteBuffer.allocate(3);
            PcmCodec.pack(floats, packed, 1, 24, null);
            int restored = (packed.get() & 255) | ((packed.get() & 255) << 8) | (packed.get() << 16);
            assertEquals(original, restored);
        }
    }
    @Test public void sixteenBitPcmCanBePaddedToThirtyTwoBitsWithoutChangingAmplitude() {
        ByteBuffer floats = ByteBuffer.allocate(5 * 4).order(ByteOrder.LITTLE_ENDIAN);
        int[] values = { -32768, -123, 0, 123, 32767 };
        for (int value : values) floats.putFloat(value / 32768f);
        floats.flip();
        ByteBuffer packed = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN);
        PcmCodec.pack(floats, packed, values.length, 32, null);
        for (int value : values) assertEquals(value << 16, packed.getInt());
    }
    @Test public void integerFallbackClampsOutOfRangeAndNonFiniteInput() {
        ByteBuffer floats = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN);
        floats.putFloat(-2).putFloat(2).putFloat(Float.NaN).putFloat(Float.POSITIVE_INFINITY).flip();
        ByteBuffer packed = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN);
        PcmCodec.pack(floats, packed, 4, 16, null);
        assertEquals(-32768, packed.getShort()); assertEquals(32767, packed.getShort());
        assertEquals(0, packed.getShort()); assertEquals(0, packed.getShort());
    }
    @Test public void bitPerfectEligibilityExcludesLossyDsdAndThirtyTwoBitIntegerSources() {
        assertTrue(PcmCodec.losslessInteger(0x10900, 24));
        assertTrue(PcmCodec.losslessInteger(0x50001, 16));
        assertFalse(PcmCodec.losslessInteger(0x10005, 16));
        assertFalse(PcmCodec.losslessInteger(0x11700, 1));
        assertFalse(PcmCodec.losslessInteger(0x50001, 32));
        assertFalse(PcmCodec.losslessInteger(0x50003, 0x10020));
    }
    @Test public void playbackClockHandlesUnsignedWrapOnLongRunningPlayback() {
        PcmCodec.FrameClock clock = new PcmCodec.FrameClock();
        assertEquals(2147483647L, clock.frames(0x7fffffff));
        assertEquals(4294967294L, clock.frames(0xfffffffe));
        assertEquals(4294967298L, clock.frames(2));
    }
}
