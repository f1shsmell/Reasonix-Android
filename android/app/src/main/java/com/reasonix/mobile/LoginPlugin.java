package com.reasonix.mobile;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Login")
public class LoginPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("missing url");
            return;
        }
        Intent intent = new Intent(getActivity(), LoginActivity.class);
        intent.putExtra("url", url);
        getActivity().startActivity(intent);
        call.resolve();
    }
}
