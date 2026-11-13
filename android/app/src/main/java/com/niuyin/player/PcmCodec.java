package com.niuyin.player;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Random;

/** Float decoding preserves every value of 16/24-bit integer PCM. Packing adds no gain. */
final class PcmCodec {
    private PcmCodec() {}

    static void pack(ByteBuffer floats, ByteBuffer target, int samples, int bits, Random dither) {
        floats.order(ByteOrder.LITTLE_ENDIAN);
        target.clear();
        target.order(ByteOrder.LITTLE_ENDIAN);
        double scale = Math.scalb(1.0, bits - 1);
        long minimum = -(1L << (bits - 1));
        long maximum = (1L << (bits - 1)) - 1;
        for (int i = 0; i < samples; i++) {
            float value = floats.getFloat();
            double scaled = Float.isFinite(value) ? value * scale : 0;
            if (dither != null) scaled += dither.nextDouble() - dither.nextDouble();
            long integer = Math.max(minimum, Math.min(maximum, Math.round(scaled)));
            for (int byteIndex = 0; byteIndex < bits / 8; byteIndex++) target.put((byte) (integer >> (byteIndex * 8)));
        }
        target.flip();
    }

    static boolean losslessInteger(int channelType, int originalBits) {
        if (originalBits != 16 && originalBits != 24) return false;
        return channelType == 0x50001 || channelType == 0x10006 || channelType == 0x10900
            || channelType == 0x10901 || channelType == 0x10e00 || channelType == 0x10500 || channelType == 0x10700;
    }

    static final class FrameClock {
        private long previous;
        private long wraps;
        long frames(int playbackHead) {
            long current = playbackHead & 0xffffffffL;
            if (current < previous && previous - current > 0x80000000L) wraps += 1L << 32;
            previous = current;
            return wraps + current;
        }
    }
}
