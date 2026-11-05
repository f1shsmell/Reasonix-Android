package com.reasonix.mobile;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Dictation through the phone's own recognizer, in-process.
 *
 * The system dialog (ACTION_RECOGNIZE_SPEECH) owns the screen, cannot show
 * interim text and silences the WebView, so the composer can only fire and
 * wait. A SpeechRecognizer instance streams instead: partial results arrive
 * as the person speaks, and RMS level callbacks drive the waveform. The
 * recognizer needs RECORD_AUDIO, granted here through Capacitor's alias
 * flow; a denial resolves with reason "denied" so the page can point at
 * Settings instead of claiming the phone has no recognizer.
 *
 * Capacitor runs @PluginMethod bodies on its own handler thread, while
 * SpeechRecognizer must be created and driven from the main thread (a hard
 * requirement since API 31), so every recognizer call hops once. The
 * listener's callbacks then arrive on the main thread; notifyListeners is
 * safe to call from there.
 *
 * One plugin instance exists while every page generation registers its own
 * listeners, so each listen() mints a session id and every event carries it;
 * listeners that own another session ignore the event.
 *
 * The default service uploads audio to its own servers, and a VPN/proxy on
 * the phone can black-hole that request (ERROR_NETWORK). The app cannot
 * re-route another app's sockets, so when that happens on API 33+ with an
 * on-device engine installed, the hold restarts once on that engine. Audio
 * is streamed, not buffered: the person has to say the words again, but does
 * not have to release and re-press. Online recognition stays the default
 * (it is usually the better engine), and the error text says what to change.
 */
@CapacitorPlugin(
    name = "Speech",
    permissions = {
        @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "microphone"),
    }
)
public class SpeechPlugin extends Plugin {
    /** Level events arrive per audio frame; 80ms matches the waveform step. */
    private static final long LEVEL_INTERVAL_MS = 80;
    /** TIRAMISU (33) introduced createOnDeviceSpeechRecognizer(). */
    static final int ON_DEVICE_MIN_SDK = 33;
    private static final int ERROR_LANGUAGE_NOT_SUPPORTED = 12;
    private static final int ERROR_LANGUAGE_UNAVAILABLE = 13;

    private SpeechRecognizer recognizer;
    private final AtomicInteger sessions = new AtomicInteger();
    /** Bumped on every start, stop and cancel so a queued retry cannot reopen the mic. */
    private final AtomicInteger epochs = new AtomicInteger();
    /** Read and written on the main thread only, next to the callbacks. */
    private long lastLevelAt;

    /**
     * Pure decision, so the API floor is testable on the JVM without a
     * Context. An on-device engine only exists on 33+, and only when the ROM
     * actually installed one; otherwise there is nothing to fall back to.
     */
    static boolean useOnDevice(int sdkInt, boolean installed) {
        return sdkInt >= ON_DEVICE_MIN_SDK && installed;
    }

    /** Only ERROR_NETWORK (2) is worth retrying offline. NETWORK_TIMEOUT (1)
     * is mapped to "没听清" on the page, so reporting it after a failed
     * fallback would be misleading. A no-match or a permission error is not
     * a network failure at all.
     */
    static boolean isNetworkError(int error) {
        return error == SpeechRecognizer.ERROR_NETWORK;
    }

    /**
     * Pure policy functions so the branch matrix is testable on the JVM.
     * Online is the default whenever a default service exists; the offline
     * engine is only the starting point when it is the only engine at all.
     */
    static boolean startOnDevice(boolean systemAvailable, boolean offlineAvailable) {
        return offlineAvailable && !systemAvailable;
    }

    static boolean canFallback(boolean systemAvailable, boolean offlineAvailable) {
        return systemAvailable && offlineAvailable;
    }

    /**
     * If the offline retry also fails on a network/language error, the honest
     * report is still the original network failure (the VPN/proxy), not a
     * vague "语音输入出了问题" and not a misleading "language unsupported".
     * A speech timeout after the retry is a real new outcome and must stay.
     */
    static int reportAfterFallback(int original, int second) {
        if (original != 0 && (isNetworkError(second)
                || second == ERROR_LANGUAGE_NOT_SUPPORTED
                || second == ERROR_LANGUAGE_UNAVAILABLE)) {
            return original;
        }
        return second;
    }

    /**
     * isOnDeviceRecognitionAvailable() does not exist below 33, so the query
     * sits inside an explicit TIRAMISU guard that lint can recognise.
     */
    private boolean onDeviceAvailable() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
            return useOnDevice(Build.VERSION.SDK_INT, true);
        }
        return false;
    }

    /** A few ROMs advertise an on-device engine but fail to create one. */
    private SpeechRecognizer createRecognizer(boolean onDevice) {
        // Repeat the guard at the call site: lint cannot prove a boolean
        // parameter only becomes true above the API floor.
        if (onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                return SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            } catch (RuntimeException ignored) {
                // Fall back to the system's default service.
            }
        }
        return SpeechRecognizer.createSpeechRecognizer(getContext());
    }

    @PluginMethod
    public void listen(PluginCall call) {
        boolean offlineAvailable = onDeviceAvailable();
        boolean systemAvailable = SpeechRecognizer.isRecognitionAvailable(getContext());
        // A phone with only an on-device engine has no default service; do
        // not turn it away with "no-service" when the offline path exists.
        if (!systemAvailable && !offlineAvailable) {
            call.resolve(unavailable("no-service"));
            return;
        }
        if (!hasRequiredPermissions()) {
            requestPermissionForAlias("microphone", call, "micResult");
            return;
        }
        start(call, systemAvailable, offlineAvailable);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (!hasRequiredPermissions()) {
            call.resolve(unavailable("denied"));
            return;
        }
        start(call, SpeechRecognizer.isRecognitionAvailable(getContext()), onDeviceAvailable());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // Release also invalidates a queued offline retry: after the finger
        // is up there is nobody left to speak again. The running recognizer
        // still flushes its final result; only open() is blocked.
        epochs.incrementAndGet();
        bridge.executeOnMainThread(() -> {
            if (recognizer != null) recognizer.stopListening();
        });
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        // Also invalidates any offline retry that has been posted but not run.
        epochs.incrementAndGet();
        bridge.executeOnMainThread(this::destroyRecognizer);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Activity teardown already runs on the main thread.
        epochs.incrementAndGet();
        destroyRecognizer();
        super.handleOnDestroy();
    }

    private void start(PluginCall call, boolean systemAvailable, boolean offlineAvailable) {
        String language = call.getString("language");
        if (language == null || language.isEmpty()) language = "zh-CN";

        final Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        // After speech ends the service waits this long for more before it
        // declares the result; holding the button means stopListening fires
        // first, so this only bounds a person who falls silent mid-hold.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 8000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 8000L);

        // Online is the default; the offline engine is only the starting
        // point when it is the only engine on the phone.
        final boolean startOffline = startOnDevice(systemAvailable, offlineAvailable);
        final boolean[] fallbackLeft = {canFallback(systemAvailable, offlineAvailable)};
        final int[] networkError = {0};
        final int myEpoch = epochs.incrementAndGet();
        final int mySession = sessions.incrementAndGet();
        final RecognitionListener[] holder = new RecognitionListener[1];
        // open() is a private method of the anonymous listener below, so the
        // outer method cannot name it. These slots hand the two calls in.
        final Runnable[] openInitial = new Runnable[1];
        final Runnable[] openOffline = new Runnable[1];

        RecognitionListener listener = new RecognitionListener() {
            {
                openInitial[0] = () -> open(startOffline);
                openOffline[0] = () -> open(true);
            }

            private void emit(String event, JSObject payload) {
                payload.put("session", mySession);
                notifyListeners(event, payload);
            }

            /** Always called on the main thread. */
            private void open(boolean onDevice) {
                if (myEpoch != epochs.get()) {
                    // The hold ended (stop/cancel) while this offline retry
                    // was queued. Report the network failure instead of
                    // leaving the page waiting on its 15s final-result timer.
                    if (networkError[0] != 0) {
                        JSObject event = new JSObject();
                        event.put("error", networkError[0]);
                        emit("recerror", event);
                    }
                    return;
                }
                destroyRecognizer();
                lastLevelAt = 0;
                recognizer = createRecognizer(onDevice);
                recognizer.setRecognitionListener(holder[0]);
                recognizer.startListening(intent);
            }

            @Override
            public void onReadyForSpeech(Bundle params) {
                emit("ready", new JSObject());
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                String text = firstTranscript(partialResults);
                if (text.isEmpty()) return;
                JSObject event = new JSObject();
                event.put("text", text);
                emit("partial", event);
            }

            @Override
            public void onResults(Bundle results) {
                JSObject event = new JSObject();
                event.put("text", firstTranscript(results));
                emit("final", event);
            }

            @Override
            public void onRmsChanged(float rmsdB) {
                // Cheap waveform, already computed by the service. Only the
                // pace is ours: the callback fires per audio frame, far more
                // often than the bridge should carry.
                long now = System.currentTimeMillis();
                if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
                lastLevelAt = now;
                JSObject event = new JSObject();
                event.put("value", rmsdB);
                emit("volume", event);
            }

            @Override
            public void onError(int error) {
                if (fallbackLeft[0] && isNetworkError(error)) {
                    fallbackLeft[0] = false;
                    networkError[0] = error;
                    // Post past this callback: destroying the recognizer
                    // inside its own onError is not safe on every ROM. The
                    // session id stays the same, so the page keeps waiting
                    // for the person to speak again.
                    bridge.executeOnMainThread(openOffline[0]);
                    return;
                }
                JSObject event = new JSObject();
                event.put("error", reportAfterFallback(networkError[0], error));
                emit("recerror", event);
            }

            @Override
            public void onBeginningOfSpeech() {}

            @Override
            public void onBufferReceived(byte[] buffer) {}

            @Override
            public void onEndOfSpeech() {}

            @Override
            public void onEvent(int eventType, Bundle params) {}
        };
        holder[0] = listener;
        JSObject out = new JSObject();
        out.put("session", mySession);
        bridge.executeOnMainThread(openInitial[0]);
        call.resolve(out);
    }

    private static String firstTranscript(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> results = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return results == null || results.isEmpty() ? "" : results.get(0);
    }

    private static JSObject unavailable(String reason) {
        JSObject out = new JSObject();
        out.put("granted", false);
        out.put("reason", reason);
        return out;
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }
}
