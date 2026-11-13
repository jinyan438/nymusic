package com.niuyin.player;

import static org.junit.Assert.*;
import java.util.Random;
import org.junit.Test;

public class QueueNavigatorTest {
    @Test public void orderAndRepeatPreserveExistingQueueBehavior() {
        Random random = new Random(1);
        assertEquals(-1, QueueNavigator.next(0, 0, "order", false, random));
        assertEquals(0, QueueNavigator.next(-1, 3, "order", false, random));
        assertEquals(0, QueueNavigator.next(2, 3, "order", false, random));
        assertEquals(2, QueueNavigator.next(0, 3, "order", true, random));
        assertEquals(1, QueueNavigator.next(1, 3, "repeat", false, random));
    }
    @Test public void shuffleNeverImmediatelyRepeatsWhenAlternativesExist() {
        Random random = new Random(42);
        for (int size = 2; size < 20; size++) for (int current = 0; current < size; current++) {
            int next = QueueNavigator.next(current, size, "random", false, random);
            assertTrue(next >= 0 && next < size); assertNotEquals(current, next);
        }
        assertEquals(0, QueueNavigator.next(0, 1, "random", false, random));
    }
}
