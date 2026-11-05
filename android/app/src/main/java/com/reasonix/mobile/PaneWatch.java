package com.reasonix.mobile;

/** One pane the phone is watching, and the state a sweep fills in. */
final class PaneWatch {
    final String runtime;
    /** Notification identity; peers are prefixed so two kernels cannot collide. */
    final String key;
    /** The LAN target of the peer whose pane this is; empty on this computer. */
    final String peer;
    final String peerName;
    volatile String base;
    volatile String root;
    volatile String title;
    volatile boolean running;
    volatile boolean waiting;
    /** Another process holds the lease; this phone cannot answer its asks. */
    volatile boolean readOnly;
    volatile String askSignature = "";

    PaneWatch(String runtime, String key, String base, String root, String title,
              String peer, String peerName, boolean readOnly) {
        this.runtime = runtime;
        this.key = key;
        this.base = base;
        this.root = root;
        this.title = title;
        this.peer = peer;
        this.peerName = peerName;
        this.readOnly = readOnly;
    }

    void update(String nextBase, String nextRoot, String nextTitle) {
        if (!nextBase.isEmpty()) base = nextBase;
        if (!nextRoot.isEmpty()) root = nextRoot;
        // A chat already knows the session's title; discovery only has the
        // transcript file name, so it fills gaps instead of replacing it.
        if (title == null || title.isEmpty()) title = nextTitle;
    }
}