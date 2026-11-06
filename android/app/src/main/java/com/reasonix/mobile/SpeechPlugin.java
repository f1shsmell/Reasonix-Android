package com.reasonix.mobile;

import android.Manifest;
import android.content.Intent;
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

    private SpeechRecognizer recognizer;
    private final AtomicInteger sessions = new AtomicInteger();
    /** The hold the live recognizer belongs to; a stale page's stop must not touch it. */
    private volatile int activeSession;
    /** Read and written on the main thread only, next to the callbacks. */
    private long lastLevelAt;

    /**
     * A session the caller knows (0 = "whatever is live", the legacy form).
     * `>=` the last minted id counts as current too: a stop can arrive while
     * the start runnable for its own session is still queued behind this
     * call on the main thread, and dropping it would leave the hold running
     * until the service's silence timeout.
     */
    private boolean isCurrent(PluginCall call) {
        Integer session = call.getInt("session");
        return session == null || session <= 0
                || session == activeSession || session >= sessions.get();
    }

    @PluginMethod
    public void listen(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.resolve(unavailable("no-service"));
            return;
        }
        if (!hasRequiredPermissions()) {
            requestPermissionForAlias("microphone", call, "micResult");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (!hasRequiredPermissions()) {
            call.resolve(unavailable("denied"));
            return;
        }
        start(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // stopListening lets the service flush its final result; the page
        // shows a finishing state until that final event arrives. A stop from
        // a page generation whose hold already ended must not silence the
        // hold a newer generation started.
        if (isCurrent(call)) {
            bridge.executeOnMainThread(() -> {
                if (recognizer != null) recognizer.stopListening();
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        if (isCurrent(call)) {
            bridge.executeOnMainThread(this::destroyRecognizer);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        // Activity teardown already runs on the main thread.
        destroyRecognizer();
        super.handleOnDestroy();
    }

    private void start(PluginCall call) {
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
                // The hold is over either way. A page that died mid-hold never
                // calls cancel, so the recognizer (and the resources its
                // service keeps) must not outlive its own final answer. The
                // session check keeps a callback that raced a newer listen
                // from destroying the recognizer that replaced this one.
                if (activeSession == mySession) {
                    bridge.executeOnMainThread(SpeechPlugin.this::destroyRecognizer);
                }
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
                // The service has given up; an orphaned hold from a dead page
                // releases its recognizer here instead of at process death.
                if (activeSession == mySession) {
                    bridge.executeOnMainThread(SpeechPlugin.this::destroyRecognizer);
                }
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
            activeSession = mySession;
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
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
