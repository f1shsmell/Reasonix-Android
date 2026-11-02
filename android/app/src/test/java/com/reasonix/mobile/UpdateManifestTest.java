package com.reasonix.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpdateManifestTest {
    private static final String MANIFEST =
            "{\"tag\":\"v0.2.2\",\"version\":\"0.2.2\",\"versionCode\":12,"
                    + "\"apk\":\"reasonix-for-android-0.2.2.apk\","
                    + "\"notes\":\"修复连接\","
                    + "\"mirrors\":[\"https://gh-proxy.com/https://github.com/x/y.apk\","
                    + "\"http://plain.example/y.apk\"]}";

    @Test
    public void readsAReleaseManifest() {
        UpdateManifest manifest = UpdateManifest.parse(MANIFEST);

        assertEquals("v0.2.2", manifest.tag());
        assertEquals("0.2.2", manifest.version());
        assertEquals(12, manifest.versionCode());
        assertEquals("reasonix-for-android-0.2.2.apk", manifest.apk());
        assertEquals("修复连接", manifest.notes());
        assertEquals(1, manifest.mirrors().size());
        assertEquals(
                "https://github.com/f1shsmell/Reasonix-Android/releases/download/v0.2.2/"
                        + "reasonix-for-android-0.2.2.apk",
                manifest.apkUrl("f1shsmell/Reasonix-Android"));
    }

    @Test
    public void offersOnlyVersionsNewerThanTheInstalledCode() {
        UpdateManifest manifest = UpdateManifest.parse(MANIFEST);

        assertTrue(manifest.isNewerThan(11));
        assertFalse(manifest.isNewerThan(12));
        assertFalse(manifest.isNewerThan(13));
    }

    @Test
    public void rejectsAVersionCodeThatIsMissing() {
        String json = MANIFEST.replace("\"versionCode\":12,", "");

        assertThrows(IllegalArgumentException.class, () -> UpdateManifest.parse(json));
    }

    @Test
    public void rejectsATagThatDisagreesWithTheVersion() {
        String json = MANIFEST.replace("\"version\":\"0.2.2\"", "\"version\":\"0.2.3\"");

        assertThrows(IllegalArgumentException.class, () -> UpdateManifest.parse(json));
    }

    @Test
    public void rejectsAnApkNameThatCouldLeaveTheReleaseDirectory() {
        String json = MANIFEST.replace(
                "reasonix-for-android-0.2.2.apk", "../reasonix-for-android-0.2.2.apk");

        assertThrows(IllegalArgumentException.class, () -> UpdateManifest.parse(json));
    }

    @Test
    public void rejectsAnUnreadableBodyAndAForeignTag() {
        assertThrows(IllegalArgumentException.class, () -> UpdateManifest.parse("not json"));
        assertThrows(IllegalArgumentException.class, () -> UpdateManifest.parse("{}"));
        assertThrows(
                IllegalArgumentException.class,
                () -> UpdateManifest.parse(MANIFEST.replace("\"v0.2.2\"", "\"0.2.2\"")));
    }
}
