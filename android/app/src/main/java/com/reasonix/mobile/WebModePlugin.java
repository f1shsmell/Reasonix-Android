package com.reasonix.mobile;

import android.content.Intent;

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
        getActivity().startActivity(intent);
        call.resolve();
    }
}
