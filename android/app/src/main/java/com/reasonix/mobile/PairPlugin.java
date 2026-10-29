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
        out.put("paired", result.getResultCode() == android.app.Activity.RESULT_OK);
        call.resolve(out);
    }
}
