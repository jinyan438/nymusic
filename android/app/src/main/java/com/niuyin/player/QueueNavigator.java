package com.niuyin.player;

import java.util.Random;

final class QueueNavigator {
    private QueueNavigator() {}
    static int next(int current, int size, String mode, boolean previous, Random random) {
        if (size == 0) return -1;
        if (current < 0 || current >= size) return 0;
        if ("random".equals(mode) && size > 1) {
            int candidate = random.nextInt(size - 1);
            return candidate >= current ? candidate + 1 : candidate;
        }
        if ("repeat".equals(mode) && !previous) return current;
        return (current + (previous ? size - 1 : 1)) % size;
    }
}
