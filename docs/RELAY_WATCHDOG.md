# The relay's idle watchdog

A half-open relay socket — the computer slept, the NAT mapping expired, the
radio roamed — raises no TCP error. OkHttp's send succeeds into a local buffer,
no `close` ever arrives, and the link reads as alive while nothing moves. This
is how the link detects and recovers from that state.

## Layers, and who owns what

**Transport (Java, `RelaySocketPlugin`)**: OkHttp `pingInterval(20s)` sends a
WebSocket Ping every 20 seconds; a Pong that never comes fails the socket in
the next interval. Detection bound: ~40s. 20s matches the device-side host's
own ticker (`remotecloud/host.go`) and the relay's advertised `heartbeatMs`
default. Ping/Pong are control frames handled by the endpoints, so the
watchdog adds no traffic above the transport; the in-repo relay fixture
(`relayfake`) skips non-text frames, but the hosted relay is not in this
repository and should be confirmed once against `remote.reasonix.io` before
release.

**Bridge (`src/native/socket.ts`)**: OkHttp reports every failure — refused
dial, refused send, missed Pong — through one `onFailure` callback that carries
no close. The page speaks browser WebSocket semantics and `RelayLink` only
reconnects on close, so `NativeWebSocket` bridges: any error fires the error
event and then a synthetic `close(1006)`, once. Without this bridge the
watchdog detects the dead link and nothing hears about it; it also fixes
plain transport errors, which before this never reconnected at all. The
plugin's events are addressed, not broadcast: each dial carries a tag the
Java side echoes on every event, because Capacitor delivers an event to every
listener ever registered and a replaced socket's slow close would otherwise
arrive at its replacement and read as that one's failure.

**Link (`src/net/relay.ts`, unchanged)**: close → `lost()` → non-fatal code →
internal `reconnect()` (grant, handshake, resend of kept GET/HEAD). Writes are
failed on the loss, not retried: the kernel may already have run them. The
30s per-request timeout keeps covering a kernel that answers slowly; the
watchdog covers a link that cannot carry anything. They are different
questions.

**App (`useLink`, unchanged)**: `watch` (30s on screen) and the
foreground `kick` keep re-verifying the route against the kernel. They own
"kernel unresponsive / session dead / network changed"; the watchdog owns only
"the phone↔relay segment is dead". A second probe on top of these would race
them for no additional coverage, which is why recovery is not wired into the
poller or the screens.

## The full recovery chain

The link's own reconnect walks 6 delays (~30s total). A computer that sleeps
for longer burns that budget, so the chain hands over deliberately:

1. Half-open. Ping draws no Pong; within ~40s OkHttp fails the socket.
2. `onFailure` → bridge → `close(1006)` → `RelayLink.lost()`: writes failed
   now, reads kept.
3. Internal reconnect resends the grant. Computer awake: reads replay, done —
   typically well under a minute of outage.
4. Computer still away: the budget expires, the link ends with the last
   error. `ended` is the handoff: further fetches fail immediately instead of
   hanging 30s each.
5. The App layer takes over: a `watch` tick counts two failed reads, the doors
   walk runs, `ensureRelay` sees `isEnded` and `connectRelay` opens a fresh
   link when the computer answers again.

Foreground worst case is therefore about 40s to detect, 30s to attempt, and
one `watch` interval to hand over. In the background the timers of the WebView
freeze, but the native watchdog does not: it marks the link dead while the
phone sleeps, so the return to the foreground rebuilds at once instead of
spending its first 40s detecting.

## Known race

While the internal reconnect is walking its budget, a `watch` tick can
concurrently conclude the route is lost and start a doors walk. The walk's
`ensureRelay` reuses the still-reconnecting link (not ended), its probe
times out, and `clearRelayRouting` closes the link — which ends it and makes
the in-flight reconnect return. The next attempt then opens cleanly. One
wasted cycle, no wedge, no double link. Removing it would mean exposing
reconnect state to the doors walk; not worth the surface while this is the
worst case.

## Not done on purpose

- Inbound idle timer (kill the link after N quiet seconds): silence is not
  evidence — a healthy link with no stream consumer can sit idle for minutes.
  A Ping that draws no Pong is evidence.
- Application-level heartbeat frames: needs relay forwarding and a kernel
  answer plus version negotiation, for what a control frame already provides.
- TCP keepalive: hours-scale defaults, custom socket factory; OkHttp's ping
  is the designed tool.
- Driving recovery off poll failures: the poller runs only in foreground JS
  and only while a stream consumer exists; the watchdog runs natively either
  way.
- Dynamic interval from `relay_hello.heartbeatMs`: the relay sends that only
  to the device side. If controllers ever receive it, `connect` can take an
  interval parameter and build a per-connection client.
