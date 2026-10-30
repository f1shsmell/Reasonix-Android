package com.reasonix.mobile;

import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Pair")
public class PairPlugin extends Plugin {
    @PluginMethod
    public void pair(PluginCall call) {
        String url = call.getString("url");
        String origin = call.getString("origin");
        if (url == null || url.isEmpty() || origin == null || origin.isEmpty()) {
            call.reject("missing url or origin");
            return;
        }
        Intent intent = new Intent(getActivity(), PairActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("origin", origin);
        startActivityForResult(call, intent, "pairResult");
    }

    @ActivityCallback
    private void pairResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        boolean paired = result.getResultCode() == android.app.Activity.RESULT_OK;
        android.content.Intent data = result.getData();
        // A result without data is not the person's cancel: the page may have
        // died, and the direct exchange is still worth trying.
        String reason = paired ? "paired"
                : data == null ? "unavailable" : data.getStringExtra(PairActivity.EXTRA_REASON);
        out.put("paired", paired);
        out.put("reason", reason == null ? "unavailable" : reason);
        call.resolve(out);
    }
}
