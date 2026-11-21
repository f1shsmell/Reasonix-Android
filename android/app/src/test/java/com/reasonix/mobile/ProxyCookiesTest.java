package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The folding that carries whichever jar holds the credential. Pure JVM: the
 * WebView jar reads as empty here, so these tests pin the merge and the one
 * spelling of a door, not a jar.
 */
public class ProxyCookiesTest {

    @Test
    public void jarsEachCarryWhatTheOtherLacks() {
        String merged = ProxyCookies.merge(Arrays.asList("a=1; b=2", "c=3"));
        assertEquals("a=1; b=2; c=3", merged);
    }

    @Test
    public void firstNameWinsAndTheRestStillRide() {
        String merged = ProxyCookies.merge(Arrays.asList("a=web; b=2", "a=mem; c=3"));
        assertEquals("a=web; b=2; c=3", merged);
    }

    @Test
    public void oneHeaderHoldingManyCookiesSplitsByName() {
        String merged = ProxyCookies.merge(Collections.singletonList("reasonix_device=abc; theme=dark"));
        assertEquals("reasonix_device=abc; theme=dark", merged);
    }

    @Test
    public void surroundingSpaceIsTrimmed() {
        String merged = ProxyCookies.merge(Arrays.asList("  a=1 ;  b = 2  "));
        assertEquals("a=1; b=2", merged);
    }

    @Test
    public void emptySourcesFoldToNothing() {
        assertEquals("", ProxyCookies.merge(new ArrayList<String>()));
        assertEquals("", ProxyCookies.merge(null));
        assertEquals("", ProxyCookies.merge(Arrays.asList("", (String) null)));
    }

    @Test
    public void piecesWithoutANameAreIgnored() {
        String merged = ProxyCookies.merge(Arrays.asList("garbage; =novalue; a=1"));
        assertEquals("a=1", merged);
    }

    @Test
    public void anEmptyValueStands() {
        String merged = ProxyCookies.merge(Collections.singletonList("reasonix_device="));
        assertEquals("reasonix_device=", merged);
    }

    @Test
    public void oneDoorHasOneSpellingWhateverPortItWasStoredUnder() {
        assertEquals("https://host/", ProxyCookies.cookieUrl("https://host"));
        assertEquals("https://host/", ProxyCookies.cookieUrl("https://host:443"));
        assertEquals("https://host/", ProxyCookies.cookieUrl("https://host/"));
        assertEquals("http://host/", ProxyCookies.cookieUrl("http://host:80"));
        assertEquals("http://10.0.0.5:10086/", ProxyCookies.cookieUrl("http://10.0.0.5:10086"));
        assertEquals("http://192.168.5.3:41234/", ProxyCookies.cookieUrl("http://192.168.5.3:41234/"));
    }

    @Test
    public void aDoorWithNoNameHasNoCookieUrl() {
        assertEquals("", ProxyCookies.cookieUrl(""));
        assertEquals("", ProxyCookies.cookieUrl(null));
        assertEquals("", ProxyCookies.cookieUrl("   "));
    }
}
