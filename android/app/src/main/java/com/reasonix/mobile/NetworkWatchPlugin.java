package com.reasonix.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The default network as the system sees it, with a stable network id.
 *
 * Capacitor's Network plugin reports only a validated internet connection, so
 * a Wi-Fi handover (both ends connected) and a LAN-only Wi-Fi are invisible to
 * it. This exposes the network itself and an event whenever it changes.
 */
@CapacitorPlugin(name = "NetworkWatch")
public class NetworkWatchPlugin extends Plugin {
    private ConnectivityManager manager;
    private ConnectivityManager.NetworkCallback callback;
    private String lastKey = "";
    private String lastType = "none";
    private boolean lastValidated = false;

    @Override
    public void load() {
        manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return;
        callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                publish();
            }

            @Override
            public void onLost(Network network) {
                publish();
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                if (changed(network, capabilities)) publish();
            }
        };
        try {
            manager.registerDefaultNetworkCallback(callback);
        } catch (Throwable ignored) {
            // getStatus still answers; the JS fallback keeps the old path.
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status(false));
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null && callback != null) {
            try {
                manager.unregisterNetworkCallback(callback);
            } catch (Throwable ignored) {
                // Already gone with the process.
            }
        }
        callback = null;
        super.handleOnDestroy();
    }

    private void publish() {
        JSObject out = status(true);
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            try {
                notifyListeners("changed", out);
            } catch (Throwable ignored) {
                // The page may have reloaded under the callback.
            }
        });
    }

    private synchronized boolean changed(Network network, NetworkCapabilities capabilities) {
        String key = keyOf(network);
        String type = typeOf(capabilities, key);
        boolean validated = validated(capabilities);
        boolean changed =
                !key.equals(lastKey) || !type.equals(lastType) || validated != lastValidated;
        lastKey = key;
        lastType = type;
        lastValidated = validated;
        return changed;
    }

    private synchronized JSObject status(boolean changed) {
        Network active = manager == null ? null : manager.getActiveNetwork();
        NetworkCapabilities capabilities =
                active == null ? null : manager.getNetworkCapabilities(active);
        String key = active == null ? "" : keyOf(active);
        String type = active == null ? "none" : typeOf(capabilities, key);
        boolean validated = validated(capabilities);
        lastKey = key;
        lastType = type;
        lastValidated = validated;

        JSObject out = new JSObject();
        out.put("connected", active != null);
        out.put("connectionType", type);
        out.put("validated", validated);
        out.put("networkKey", key);
        out.put("changed", changed);
        return out;
    }

    private static String keyOf(Network network) {
        try {
            return String.valueOf(network.getNetworkHandle());
        } catch (Throwable t) {
            return String.valueOf(network.hashCode());
        }
    }

    private static String typeOf(NetworkCapabilities capabilities, String key) {
        if (capabilities == null) return key.isEmpty() ? "none" : "other";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "vpn";
        return "other";
    }

    private static boolean validated(NetworkCapabilities capabilities) {
        return capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
}
