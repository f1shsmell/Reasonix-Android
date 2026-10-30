package com.reasonix.mobile;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * The Quick Settings tile: how much work is waiting, or a way back in.
 *
 * The watcher writes the counts; this tile reads them when the shade opens.
 * Tapping always opens the app rather than a specific conversation: the tile
 * cannot know which one the person wants.
 */
public class ReasonixTileService extends TileService {
    static final String PREFS = "reasonix_turn";
    static final String KEY_RUNNING = "tile_running";
    static final String KEY_WAITING = "tile_waiting";

    @Override
    public void onStartListening() {
        super.onStartListening();
        refresh();
    }

    @Override
    public void onClick() {
        super.onClick();
        openApp();
    }

    private void refresh() {
        Tile tile = getQsTile();
        if (tile == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        int running = prefs.getInt(KEY_RUNNING, 0);
        int waiting = prefs.getInt(KEY_WAITING, 0);
        tile.setLabel("Reasonix");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(TileCounts.subtitle(running, waiting));
        }
        tile.setState(running + waiting > 0 ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setIcon(Icon.createWithResource(this, R.drawable.ic_tile_reasonix));
        tile.updateTile();
    }

    private void openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            PendingIntent pending = PendingIntent.getActivity(
                    this, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            startActivityAndCollapse(pending);
        } else {
            startActivityAndCollapse(intent);
        }
    }

    /** Ask the tile to re-read the counts after the watcher changes them. */
    static void requestRefresh(android.content.Context context) {
        try {
            TileService.requestListeningState(
                    context, new ComponentName(context, ReasonixTileService.class));
        } catch (RuntimeException ignored) {
            // A platform without the tile simply does not update it.
        }
    }
}
