package com.reasonix.mobile;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

/** Applies one cloud snapshot to the watch list, without Android state. */
final class CloudSweep {
    interface Sink {
        PaneWatch get(String runtimeId);

        PaneWatch create(RuntimeList.Row row);

        void update(PaneWatch watch, RuntimeList.Row row);

        void remove(PaneWatch watch);

        Collection<PaneWatch> watches();

        void applyStatus(PaneWatch watch, AskStatus status);
    }

    static final class Counts {
        final int runtimes;
        final int statuses;
        final int asks;

        Counts(int runtimes, int statuses, int asks) {
            this.runtimes = runtimes;
            this.statuses = statuses;
            this.asks = asks;
        }
    }

    private CloudSweep() {}

    static Counts apply(CloudSnapshot snapshot, Sink sink) {
        Set<String> seen = new HashSet<>();
        for (RuntimeList.Row row : snapshot.runtimes) {
            seen.add(row.id);
            PaneWatch watch = sink.get(row.id);
            if (watch == null) {
                sink.create(row);
            } else {
                sink.update(watch, row);
                watch.readOnly = row.readOnly;
            }
        }
        for (PaneWatch watch : new java.util.ArrayList<>(sink.watches())) {
            // The key is the identity; a peer watch shares the runtime id with
            // the same pane on this computer but is a different row.
            if (seen.contains(watch.key)) continue;
            sink.remove(watch);
        }
        int asks = 0;
        for (PaneWatch watch : sink.watches()) {
            String status = snapshot.statuses.get(watch.runtime);
            if (status == null) continue;
            AskStatus parsed = AskStatus.parse(status);
            asks += parsed.count;
            sink.applyStatus(watch, parsed);
        }
        return new Counts(snapshot.runtimes.size(), snapshot.statuses.size(), asks);
    }
}