# Relay lane captures

Evidence for the lane-visibility PR (#198): what the chat header shows when a
runtime's frames arrive on each lane. Synthetic mock, `npm run shots`, 390×900,
light and dark. The badge only appears on a relay link; the LAN baseline has
none because it was never the thing that lies.

| File | Shows |
| --- | --- |
| `lane-mux-*.png` | The mux push lane: green dot, 推送 badge |
| `lane-poll-*.png` | The polled fallback: green dot, 轮询 badge |
| `lane-recovering-*.png` | The healing window: amber dot, 推送 badge |
| `lane-sse-*.png` | The LAN's own SSE: no badge, unchanged |
