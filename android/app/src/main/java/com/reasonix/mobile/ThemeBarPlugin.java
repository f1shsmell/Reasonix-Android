package com.reasonix.mobile;

import android.graphics.Color;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Paints the system bar to match the page.
 *
 * The status bar is not part of the WebView: below WebView 140 Capacitor pads
 * the WebView down by the inset instead of laying it under the bar, so the
 * strip above the content is drawn by the window and no stylesheet can reach
 * it. The theme's own colour follows the *system* dark setting, but the app can
 * pin its appearance independently (`src/app/theme.ts`), and a pinned choice
 * that disagrees with the system would leave a band of the other palette above
 * the page.
 *
 * So the page, which knows which background it actually drew, tells the bar.
 * Both values travel together because they are one decision: a dark bar needs
 * light icons and the reverse.
 */
@CapacitorPlugin(name = "ThemeBar")
public class ThemeBarPlugin extends Plugin {

    @PluginMethod
    public void setAppearance(PluginCall call) {
        String color = call.getString("color", "");
        Boolean darkIcons = call.getBoolean("darkIcons");
        if (getActivity() == null) {
            // No window to paint; the next load asks again.
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            Window window = getActivity() == null ? null : getActivity().getWindow();
            if (window != null && !color.isEmpty()) {
                try {
                    window.setStatusBarColor(Color.parseColor(color));
                } catch (IllegalArgumentException ignored) {
                    // A colour the page could not have produced; keep the last
                    // one rather than crashing a screen over a decoration.
                }
            }
            if (window != null && darkIcons != null) {
                // "Light status bars" is Android's name for a light background,
                // which is what makes the system draw dark icons on it.
                WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(window, window.getDecorView());
                controller.setAppearanceLightStatusBars(darkIcons);
            }
            call.resolve();
        });
    }
}
