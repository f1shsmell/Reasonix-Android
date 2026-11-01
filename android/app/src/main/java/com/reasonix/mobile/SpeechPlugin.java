package com.reasonix.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.util.ArrayList;

/**
 * Dictation through the phone's own recognizer, in-process.
 *
 * The system dialog (ACTION_RECOGNIZE_SPEECH) owns the screen, cannot show
 * interim text and silences the WebView, so the composer can only fire and
 * wait. A SpeechRecognizer instance streams instead: partial results arrive
 * as the person speaks, and RMS level callbacks drive the waveform. The
 * recognizer needs RECORD_AUDIO, granted here through Capacitor's alias
 * flow; a denial resolves with granted=false so the page can say why.
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
    private RecognitionListener listener;
    private int session;
    private long lastLevelAt;

    @PluginMethod
    public void listen(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.resolve(unavailable());
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
            call.resolve(unavailable());
            return;
        }
        start(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        // stopListening lets the service flush its final result; the page
        // shows a finishing state until that final event arrives.
        if (recognizer != null) recognizer.stopListening();
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        destroyRecognizer();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        destroyRecognizer();
        super.handleOnDestroy();
    }

    private void start(PluginCall call) {
        destroyRecognizer();
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

        int mySession = ++session;
        lastLevelAt = 0;
        listener = new RecognitionListener() {
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
        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(listener);
        recognizer.startListening(intent);
        JSObject out = new JSObject();
        out.put("session", mySession);
        call.resolve(out);
    }

    private static String firstTranscript(Bundle bundle) {
        if (bundle == null) return "";
        ArrayList<String> results = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return results == null || results.isEmpty() ? "" : results.get(0);
    }

    private static JSObject unavailable() {
        JSObject out = new JSObject();
        out.put("granted", false);
        return out;
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
            listener = null;
        }
    }
}
