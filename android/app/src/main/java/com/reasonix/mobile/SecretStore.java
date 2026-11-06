package com.reasonix.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.KeyStoreException;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets at rest, wrapped by the phone's own keystore.
 *
 * The account session token and the proxy's per-install secret sit in
 * SharedPreferences, which any debuggable attach or accidental prefs dump can
 * read. A keystore key that never leaves the TEE (and is set to require it)
 * turns those values into ciphertext a dump cannot use. Each value carries its
 * own random IV; the format prefixes itself, so a plaintext value written by an
 * older build still reads as-is, and a device where the keystore is unavailable
 * (some emulators, ROM quirks, Robolectric) keeps storing plaintext rather than
 * failing the flows it sits under.
 */
final class SecretStore {
    private static final String TAG = "ReasonixSecrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "reasonix.secrets";
    private static final String PREFIX = "enc:v1:";
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    private SecretStore() {}

    /** Sealed under the keystore key, or returned unchanged when it cannot be had. */
    static String protect(String value) {
        SecretKey key = key();
        if (key == null) return value;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String sealed = Base64.encodeToString(
                    cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            return PREFIX + iv + ":" + sealed;
        } catch (Exception e) {
            Log.w(TAG, "cannot seal a secret; storing as-is", e);
            return value;
        }
    }

    /**
     * The plaintext behind a stored value, or "" when it cannot be opened.
     * A value without the prefix is a legacy plaintext write and returns as-is.
     */
    static String unprotect(String stored) {
        if (!stored.startsWith(PREFIX)) return stored;
        SecretKey key = key();
        if (key == null) return "";
        try {
            String[] parts = stored.substring(PREFIX.length()).split(":", 2);
            if (parts.length != 2) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key,
                    new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] plain = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            // A keystore that lost its key (backup restore, reset) cannot open
            // old values; the caller answers "" and mints fresh, which costs a
            // re-pair or a re-login but not a crash.
            Log.w(TAG, "cannot open a stored secret", e);
            return "";
        }
    }

    /** The app's AES key, generated on first use; null when the keystore is unavailable. */
    private static SecretKey key() {
        try {
            KeyStore store = KeyStore.getInstance(KEYSTORE);
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) {
                KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
                if (entry instanceof KeyStore.SecretKeyEntry) {
                    return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                }
                throw new KeyStoreException("alias " + KEY_ALIAS + " is not a secret key");
            }
            KeyGenerator generator = KeyGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return generator.generateKey();
        } catch (Exception e) {
            Log.w(TAG, "keystore unavailable; secrets stay plaintext", e);
            return null;
        }
    }
}
