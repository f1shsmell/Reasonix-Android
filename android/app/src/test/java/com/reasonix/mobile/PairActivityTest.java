package com.reasonix.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * A pairing is judged by a new credential, not by any credential. These pin
 * the judgement itself: the stale cookie a phone that paired once still holds
 * must never read as a success.
 */
public class PairActivityTest {

    @Test
    public void aFirstPairingIsANewCredential() {
        assertTrue(PairActivity.isNewCredential("", "cred-1"));
    }

    @Test
    public void theOldCopyIsNotANewCredential() {
        // The regression this judgement exists for: the very first poll found
        // the thirty-day-old cookie and called the pairing done.
        assertFalse(PairActivity.isNewCredential("cred-1", "cred-1"));
    }

    @Test
    public void aChangedValueIsANewCredential() {
        assertTrue(PairActivity.isNewCredential("cred-1", "cred-2"));
    }

    @Test
    public void anEmptyJarIsNothing() {
        assertFalse(PairActivity.isNewCredential("cred-1", ""));
        assertFalse(PairActivity.isNewCredential("", ""));
    }
}
