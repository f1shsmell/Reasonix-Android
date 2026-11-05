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
 * On API 33+ with an on-device engine installed, a hold uses that engine
 * instead of the system service. The service uploads audio to its own
 * servers, and a VPN/proxy on the phone can black-hole that request
 * (ERROR_NETWORK); the app cannot re-route another app's sockets, so an
 * on-device engine is the only path that works offline. Below 33, or when
 * no offline pack is installed, behaviour is unchanged and the error text
 * says what the person can do instead.
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

    private SpeechRecognizer recognizer;
    private final AtomicInteger sessions = new AtomicInteger();
    /** Read and written on the main thread only, next to the callbacks. */
    private long lastLevelAt;

    /**
     * Pure decision, so the API floor is testable on the JVM without a
     * Context. An on-device engine only exists on 33+, and only when the ROM
     * actually installed one; otherwise we must stay on the system service
     * rather than claim an offline path that is not there.
     */
    static boolean useOnDevice(int sdkInt, boolean installed) {
        return sdkInt >= ON_DEVICE_MIN_SDK && installed;
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
        boolean onDevice = onDeviceAvailable();
        // A phone with only an on-device engine has no default service; do
        // not turn it away with "no-service" when the offline path exists.
        if (!SpeechRecognizer.isRecognitionAvailable(getContext()) && !onDevice) {
            call.resolve(unavailable("no-service"));
            return;
        }
        if (!hasRequiredPermissions()) {
            requestPermissionForAlias("microphone", call, "micResult");
            return;
        }
        start(call, onDevice);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (!hasRequiredPermissions()) {
            call.resolve(unavailable("denied"));
            return;
        }
        start(call, onDeviceAvailable());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // stopListening lets the service flush its final result; the page
        // shows a finishing state until that final event arrives.
        bridge.executeOnMainThread(() -> {
            if (recognizer != null) recognizer.stopListening();
        });
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        bridge.executeOnMainThread(this::destroyRecognizer);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Activity teardown already runs on the main thread.
        destroyRecognizer();
        super.handleOnDestroy();
    }

    private void start(PluginCall call, boolean onDevice) {
        String language = call.getString("language");
        if (language == null || language.isEmpty()) language = "zh-CN";

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        // After speech ends the service waits this long for more before it
        // declares the result; holding the button means stopListening fires
        // first, so this only bounds a person who falls silent mid-hold.
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 8000L);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 8000L);

        int mySession = sessions.incrementAndGet();
        RecognitionListener listener = new RecognitionListener() {
            private void emit(String event, JSObject payload) {
                payload.put("session", mySession);
                notifyListeners(event, payload);
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
                JSObject event = new JSObject();
                event.put("error", error);
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
        JSObject out = new JSObject();
        out.put("session", mySession);
        bridge.executeOnMainThread(() -> {
            destroyRecognizer();
            lastLevelAt = 0;
            recognizer = createRecognizer(onDevice);
            recognizer.setRecognitionListener(listener);
            recognizer.startListening(intent);
        });
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
