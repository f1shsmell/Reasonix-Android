package com.reasonix.mobile;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WebMode")
public class WebModePlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty() || !Urls.isWebUrl(url)) {
            call.reject("missing url");
            return;
        }
        Intent intent = new Intent(getActivity(), WebModeActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("viaProxy", Boolean.TRUE.equals(call.getBoolean("viaProxy")));
        String origin = call.getString("origin");
        intent.putExtra("origin", origin == null ? "" : origin);
        JSArray allow = call.getArray("allowHosts");
        if (allow != null) {
            String[] hosts = new String[allow.length()];
            for (int i = 0; i < allow.length(); i++) hosts[i] = allow.optString(i, "");
            intent.putExtra("allowHosts", hosts);
        }
        try {
            getActivity().startActivity(intent);
        } catch (RuntimeException e) {
            // resolve() would leave the promise settled even though no page
            // opened. Rejecting lets the JS side fall back to the system
            // browser instead of hanging with a blank screen.
            call.reject("could not open the full Studio page", e);
            return;
        }
        call.resolve();
    }
}
