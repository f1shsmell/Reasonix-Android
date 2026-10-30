package com.reasonix.mobile;

/** The sentence the Quick Settings tile shows under its name. */
final class TileCounts {
    private TileCounts() {}

    static String subtitle(int running, int waiting) {
        if (waiting > 0 && running > 0) return waiting + " 待处理 · " + running + " 运行中";
        if (waiting > 0) return waiting + " 待处理";
        if (running > 0) return running + " 运行中";
        return "打开 Reasonix";
    }
}
