package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The engine choice, the network-error test and the error to report after a
 * failed fallback are pure functions, so the whole branch matrix is checked
 * on the JVM without a Context or a real recognizer.
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

    @Test
    public void onlineIsTheDefaultEvenWhenAnOfflinePackExists() {
        // An offline pack must not silently replace the (usually better)
        // online engine on a normal network.
        assertFalse(SpeechPlugin.startOnDevice(true, true));
        assertFalse(SpeechPlugin.startOnDevice(true, false));
        // Only a phone with no default service starts on the offline engine.
        assertTrue(SpeechPlugin.startOnDevice(false, true));
        assertFalse(SpeechPlugin.startOnDevice(false, false));
    }

    @Test
    public void onlyAnOnlineStartCanFallBack() {
        assertTrue(SpeechPlugin.canFallback(true, true));
        assertFalse(SpeechPlugin.canFallback(true, false));
        // Already offline: there is nothing to fall back from.
        assertFalse(SpeechPlugin.canFallback(false, true));
        assertFalse(SpeechPlugin.canFallback(false, false));
    }

    @Test
    public void onlyErrorNetworkTriggersTheFallback() {
        assertTrue(SpeechPlugin.isNetworkError(2)); // ERROR_NETWORK
        assertFalse(SpeechPlugin.isNetworkError(1)); // NETWORK_TIMEOUT -> "没听清"
        assertFalse(SpeechPlugin.isNetworkError(7)); // NO_MATCH
        assertFalse(SpeechPlugin.isNetworkError(9)); // INSUFFICIENT_PERMISSIONS
    }

    @Test
    public void aFailedOfflineRetryStillReportsTheVpnProblem() {
        int network = 2;
        // An offline pack that lacks zh-CN, or one that still cannot reach
        // its own endpoint, must not hide the real trigger behind a vague
        // "语音输入出了问题" or a misleading language error.
        assertEquals(network, SpeechPlugin.reportAfterFallback(network, 12));
        assertEquals(network, SpeechPlugin.reportAfterFallback(network, 13));
        assertEquals(network, SpeechPlugin.reportAfterFallback(network, 2));
        // A genuinely new outcome after the retry is kept as-is.
        assertEquals(6, SpeechPlugin.reportAfterFallback(network, 6)); // SPEECH_TIMEOUT
        assertEquals(7, SpeechPlugin.reportAfterFallback(network, 7)); // NO_MATCH
        // Without a fallback the original error is simply passed through.
        assertEquals(7, SpeechPlugin.reportAfterFallback(0, 7));
    }
}
