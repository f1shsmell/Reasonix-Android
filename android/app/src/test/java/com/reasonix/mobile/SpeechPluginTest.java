package com.reasonix.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The on/off-device choice is a pure function of (SDK, installed pack), so
 * the API floor can be checked on the JVM without a Context or a recognizer.
 */
public class SpeechPluginTest {
    @Test
    public void belowTiramisuStaysOnTheSystemService() {
        // The reported device is Android 12 (31): even with an offline pack
        // present, the on-device APIs do not exist there.
        assertFalse(SpeechPlugin.useOnDevice(31, true));
        assertFalse(SpeechPlugin.useOnDevice(32, true));
        assertFalse(SpeechPlugin.useOnDevice(31, false));
    }

    @Test
    public void tiramisuAndAboveNeedsAnInstalledPack() {
        assertTrue(SpeechPlugin.useOnDevice(33, true));
        assertTrue(SpeechPlugin.useOnDevice(34, true));
        assertTrue(SpeechPlugin.useOnDevice(36, true));
        assertFalse(SpeechPlugin.useOnDevice(33, false));
        assertFalse(SpeechPlugin.useOnDevice(36, false));
    }

    @Test
    public void theFloorIsTheTiramisuConstant() {
        assertTrue(SpeechPlugin.ON_DEVICE_MIN_SDK >= 33);
        assertFalse(SpeechPlugin.useOnDevice(SpeechPlugin.ON_DEVICE_MIN_SDK - 1, true));
        assertTrue(SpeechPlugin.useOnDevice(SpeechPlugin.ON_DEVICE_MIN_SDK, true));
    }
}
