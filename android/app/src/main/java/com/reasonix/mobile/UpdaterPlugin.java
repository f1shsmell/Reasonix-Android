package com.reasonix.mobile;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * In-app updates: read the release manifest, download the APK, hand it to the
 * system installer. A download that "succeeded" is not an installable package —
 * proxies have answered 200 with HTML — so the file is parsed, version-checked
 * and signature-checked first.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    static final String REPO = "f1shsmell/Reasonix-Android";

    private static final String BRANCH = "main";
    private static final String[] MIRRORS = {
            "https://gh-proxy.com/",
            "https://ghfast.top/",
    };
    private static final String PREFS = "updater";
    private static final String KEY_MANIFEST = "manifest";
    private static final String KEY_FETCHED = "fetchedAt";
    private static final long CACHE_MS = 6 * 60 * 60 * 1000L;
    private static final long CHECK_DEADLINE_MS = 20 * 1000L;
    private static final long MIN_APK_BYTES = 1024 * 1024L;
    private static final long MAX_APK_BYTES = 256L * 1024 * 1024;
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    private static final String APK_NAME = "reasonix-update.apk";
    private static final String APK_PART = "reasonix-update.apk.part";

    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .build();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    /**
     * Manifest reads get their own lane: a multi-minute download queued on the
     * same single thread made the sheet's check spinner hang until the
     * download finished, with no deadline of its own to break out.
     */
    private final ExecutorService checker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile Call activeDownload;

    @PluginMethod
    public void check(PluginCall call) {
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        checker.execute(() -> {
            try {
                long installedCode = installedCode();
                UpdateManifest manifest = force ? null : cachedManifest();
                if (manifest == null) manifest = fetchManifest();

                JSObject out = new JSObject();
                out.put("update", manifest.isNewerThan(installedCode));
                out.put("tag", manifest.tag());
                out.put("version", manifest.version());
                out.put("versionCode", manifest.versionCode());
                out.put("apk", manifest.apk());
                out.put("url", manifest.apkUrl(REPO));
                out.put("mirrors", new JSONArray(manifest.mirrors()));
                out.put("notes", manifest.notes());
                out.put("installedVersion", installedName());
                out.put("installedCode", installedCode);
                call.resolve(out);
            } catch (ManifestError e) {
                call.reject("cannot read update manifest", e.code);
            } catch (Throwable t) {
                call.reject("check failed", "UPDATE_NETWORK");
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (!downloading.compareAndSet(false, true)) {
            call.reject("download in progress", "UPDATE_BUSY");
            return;
        }
        List<String> urls = downloadUrls(call);
        Integer expectedBoxed = call.getInt("versionCode", 0);
        int expectedCode = expectedBoxed == null ? 0 : expectedBoxed;
        if (urls.isEmpty()) {
            downloading.set(false);
            call.reject("no download url", "UPDATE_DOWNLOAD");
            return;
        }
        worker.execute(() -> {
            try {
                File apk = null;
                boolean fetched = false;
                for (String url : urls) {
                    if (Thread.currentThread().isInterrupted()) break;
                    try {
                        File candidate = download(url);
                        fetched = true;
                        if (validate(candidate, expectedCode)) {
                            apk = candidate;
                            break;
                        }
                        candidate.delete();
                    } catch (Throwable ignored) {
                        // The next mirror is the retry.
                    }
                }
                if (apk == null) {
                    call.reject("no valid apk", fetched ? "UPDATE_VERIFY" : "UPDATE_DOWNLOAD");
                    return;
                }
                handOff(apk, call);
            } catch (Throwable t) {
                call.reject("install failed", "UPDATE_INSTALL");
            } finally {
                downloading.set(false);
            }
        });
    }

    @PluginMethod
    public void launchInstaller(PluginCall call) {
        File apk = new File(updateDir(), APK_NAME);
        if (!apk.exists()) {
            call.reject("nothing downloaded", "UPDATE_STALE");
            return;
        }
        worker.execute(() -> {
            try {
                if (!validate(apk, 0)) {
                    apk.delete();
                    call.reject("downloaded apk is stale or invalid", "UPDATE_STALE");
                    return;
                }
                handOff(apk, call);
            } catch (Throwable t) {
                call.reject("install failed", "UPDATE_INSTALL");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        Call active = activeDownload;
        if (active != null) active.cancel();
        worker.shutdownNow();
        checker.shutdownNow();
        super.handleOnDestroy();
    }

    private List<String> downloadUrls(PluginCall call) {
        List<String> urls = new ArrayList<>();
        addUrl(urls, call.getString("url", ""));
        String rawMirrors = call.getString("mirrors", "[]");
        try {
            JSONArray array = new JSONArray(rawMirrors);
            for (int i = 0; i < array.length(); i++) addUrl(urls, array.optString(i, ""));
        } catch (JSONException ignored) {
            // A malformed mirror list still leaves the direct url.
        }
        return urls;
    }

    private static void addUrl(List<String> urls, String url) {
        if (!url.startsWith("https://") || urls.contains(url)) return;
        String host = Uri.parse(url).getHost();
        if (host == null) return;
        if (host.equals("github.com")
                || host.equals("gh-proxy.com")
                || host.equals("ghfast.top")
                || host.endsWith(".githubusercontent.com")) {
            urls.add(url);
        }
    }

    private UpdateManifest cachedManifest() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        String json = prefs.getString(KEY_MANIFEST, null);
        long fetchedAt = prefs.getLong(KEY_FETCHED, 0);
        if (json == null || System.currentTimeMillis() - fetchedAt > CACHE_MS) return null;
        try {
            return UpdateManifest.parse(json);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private UpdateManifest fetchManifest() throws Exception {
        Exception last = null;
        String lastCode = "UPDATE_NETWORK";
        long deadline = System.currentTimeMillis() + CHECK_DEADLINE_MS;
        for (String url : manifestUrls()) {
            if (System.currentTimeMillis() > deadline) break;
            try {
                String json = getText(url);
                try {
                    UpdateManifest manifest = UpdateManifest.parse(json);
                    getContext().getSharedPreferences(PREFS, 0).edit()
                            .putString(KEY_MANIFEST, json)
                            .putLong(KEY_FETCHED, System.currentTimeMillis())
                            .apply();
                    return manifest;
                } catch (IllegalArgumentException e) {
                    lastCode = "UPDATE_MANIFEST";
                    last = e;
                }
            } catch (Exception e) {
                last = e;
            }
        }
        throw new ManifestError(lastCode, last);
    }

    private List<String> manifestUrls() {
        List<String> urls = new ArrayList<>();
        urls.add("https://github.com/" + REPO + "/releases/latest/download/latest.json");
        String raw = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/latest.json";
        urls.add(raw);
        for (String mirror : MIRRORS) urls.add(mirror + raw);
        return urls;
    }

    private String getText(String url) throws IOException {
        Request request = new Request.Builder()
                .url(url)
                .header("User-Agent", "ReasonixAndroid-Updater")
                .header("Cache-Control", "no-cache")
                .build();
        try (Response response = http.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("http " + response.code());
            ResponseBody body = response.body();
            if (body == null) throw new IOException("empty response");
            // A declared length is checked up front; a chunked answer without
            // one is read with its own cap, because body.string() would buffer
            // the whole stream before any length check could run — and the
            // mirrors are third parties.
            if (body.contentLength() > MAX_MANIFEST_BYTES) throw new IOException("manifest too large");
            java.io.InputStream input = body.byteStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            long total = 0;
            int n;
            while ((n = input.read(chunk)) != -1) {
                total += n;
                if (total > MAX_MANIFEST_BYTES) throw new IOException("manifest too large");
                buffer.write(chunk, 0, n);
            }
            return buffer.toString("UTF-8");
        }
    }

    private File download(String url) throws IOException {
        File dir = updateDir();
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no update directory");
        File part = new File(dir, APK_PART);
        File apk = new File(dir, APK_NAME);
        Request request = new Request.Builder()
                .url(url)
                .header("User-Agent", "ReasonixAndroid-Updater")
                .build();
        Call call = http.newCall(request);
        activeDownload = call;
        boolean complete = false;
        try (Response response = call.execute()) {
            if (!response.isSuccessful()) throw new IOException("http " + response.code());
            ResponseBody body = response.body();
            if (body == null) throw new IOException("empty response");
            MediaType type = body.contentType();
            if (type != null && type.toString().toLowerCase(Locale.ROOT).contains("text/html")) {
                throw new IOException("html response");
            }
            long total = body.contentLength();
            if (total >= 0 && total < MIN_APK_BYTES) throw new IOException("response too small");
            if (total > MAX_APK_BYTES) throw new IOException("response too large");

            try (InputStream in = body.byteStream();
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[65536];
                long wrote = 0;
                long lastEmit = 0;
                boolean first = true;
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("cancelled");
                    // The APK is a zip; a proxy's HTML page never starts with it.
                    if (first) {
                        if (read < 4 || buffer[0] != 'P' || buffer[1] != 'K') {
                            throw new IOException("not an apk");
                        }
                        first = false;
                    }
                    out.write(buffer, 0, read);
                    wrote += read;
                    if (wrote > MAX_APK_BYTES) throw new IOException("response too large");
                    long now = System.currentTimeMillis();
                    if (now - lastEmit >= 250) {
                        lastEmit = now;
                        emitProgress(wrote, total);
                    }
                }
                out.flush();
                if (wrote < MIN_APK_BYTES) throw new IOException("download truncated");
                emitProgress(wrote, total);
            }
            complete = true;
        } finally {
            activeDownload = null;
            if (!complete) part.delete();
        }
        if (apk.exists() && !apk.delete()) throw new IOException("cannot replace previous apk");
        if (!part.renameTo(apk)) throw new IOException("cannot publish apk");
        return apk;
    }

    private void emitProgress(long transferred, long total) {
        if (getActivity() == null) return;
        JSObject progress = new JSObject();
        progress.put("transferred", transferred);
        progress.put("total", total);
        getActivity().runOnUiThread(() -> {
            try {
                notifyListeners("progress", progress);
            } catch (Throwable ignored) {
                // The page may have reloaded under the download.
            }
        });
    }

    /**
     * A downloaded APK is accepted only if it is this app, newer than what is
     * installed, the release the manifest offered, and signed by the same key.
     */
    private boolean validate(File apk, int expectedCode) {
        try {
            PackageManager pm = getContext().getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28
                    ? PackageManager.GET_SIGNING_CERTIFICATES
                    : PackageManager.GET_SIGNATURES;
            PackageInfo candidate = pm.getPackageArchiveInfo(apk.getPath(), flags);
            if (candidate == null) return false;
            if (!getContext().getPackageName().equals(candidate.packageName)) return false;
            long candidateCode = Build.VERSION.SDK_INT >= 28
                    ? candidate.getLongVersionCode()
                    : candidate.versionCode;
            if (candidateCode <= installedCode()) return false;
            if (expectedCode > 0 && candidateCode != expectedCode) return false;
            byte[] candidateSigner = firstSigner(candidate);
            byte[] installedSigner = firstSigner(
                    pm.getPackageInfo(getContext().getPackageName(), flags));
            return candidateSigner != null && installedSigner != null
                    && Arrays.equals(candidateSigner, installedSigner);
        } catch (Throwable t) {
            return false;
        }
    }

    private static byte[] firstSigner(PackageInfo info) throws Exception {
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            signatures = info.signingInfo.hasMultipleSigners()
                    ? info.signingInfo.getApkContentsSigners()
                    : info.signingInfo.getSigningCertificateHistory();
        }
        if ((signatures == null || signatures.length == 0) && info.signatures != null) {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) return null;
        return MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray());
    }

    private void handOff(File apk, PluginCall call) {
        if (getActivity() == null) {
            call.reject("app is not visible", "UPDATE_INSTALL");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                PackageManager pm = getContext().getPackageManager();
                if (!pm.canRequestPackageInstalls()) {
                    Intent settings = new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(settings);
                    JSObject out = new JSObject();
                    out.put("state", "permission");
                    call.resolve(out);
                    return;
                }
                Uri content = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        apk);
                Intent installer = new Intent(Intent.ACTION_VIEW);
                installer.setDataAndType(content, "application/vnd.android.package-archive");
                installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(installer);
                JSObject out = new JSObject();
                out.put("state", "downloaded");
                call.resolve(out);
            } catch (Throwable t) {
                call.reject("installer did not open", "UPDATE_INSTALL");
            }
        });
    }

    private File updateDir() {
        File external = getContext().getExternalFilesDir("updates");
        return external != null ? external : new File(getContext().getCacheDir(), "updates");
    }

    /** A manifest we could not read carries its own class: bad bytes vs no network. */
    private static final class ManifestError extends Exception {
        final String code;

        ManifestError(String code, Throwable cause) {
            super(code, cause);
            this.code = code;
        }
    }

    private long installedCode() throws PackageManager.NameNotFoundException {
        PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private String installedName() {
        try {
            return getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }
}
