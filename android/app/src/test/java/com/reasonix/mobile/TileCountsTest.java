package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class TileCountsTest {
    @Test
    public void namesBothKindsOfWork() {
        assertEquals("2 待处理 · 1 运行中", TileCounts.subtitle(1, 2));
    }

    @Test
    public void namesTheOneKindThatExists() {
        assertEquals("3 待处理", TileCounts.subtitle(0, 3));
        assertEquals("2 运行中", TileCounts.subtitle(2, 0));
        assertEquals("打开 Reasonix", TileCounts.subtitle(0, 0));
    }
}
