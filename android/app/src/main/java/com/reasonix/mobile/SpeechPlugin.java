package com.reasonix.mobile;

import android.app.Activity;
import android.content.Intent;
import android.speech.RecognizerIntent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;

/**
 * Dictation, using the recognizer the phone already ships.
 *
 * The system recognizer activity owns the microphone prompt; the app only
 * receives the transcript. A cancelled dialog resolves with an empty string,
 * so the composer keeps whatever was already typed.
 */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {
    @PluginMethod
    public void listen(PluginCall call) {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "说点什么…");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        String language = call.getString("language");
        if (language != null && !language.isEmpty()) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        }
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("speech.unavailable");
            return;
        }
        startActivityForResult(call, intent, "speechResult");
    }

    @ActivityCallback
    private void speechResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        String text = "";
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            ArrayList<String> results =
                    result.getData().getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (results != null && !results.isEmpty()) text = results.get(0);
        }
        out.put("text", text == null ? "" : text);
        call.resolve(out);
    }
}
