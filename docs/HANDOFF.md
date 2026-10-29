# Handoff

Everything a new agent needs that is not obvious from reading the code. Written
2026-10-29 after milestones 1–2 of `docs/PLAN.md`.

Read `docs/PLAN.md` for scope and the milestone log, and `docs/PRIOR_ART.md` for
why the architecture looks the way it does. This file is the part that would
otherwise be lost: environment traps, deliberate decisions, and the things that
are **not** verified.

## Environment traps

These will each cost an hour if you hit them cold.

### `npm run dev` is broken on this machine

It fails with `'"node"' is not recognized as an internal or external command`.
Git Bash double-quotes the path npm hands to `cmd`. Use node directly:

```bash
REASONIX_SERVE=http://127.0.0.1:8791 node ./node_modules/vite/bin/vite.js
```

`npx tsc` has the same problem and additionally resolves to an unrelated
`tsc@2.0.4` package from npm. Always use `./node_modules/.bin/tsc`.

### The global git proxy is dead

`http.proxy` is set to `http://127.0.0.1:7890` and nothing is listening. Every
`git clone`/`fetch`/`push` fails until it is bypassed:

```bash
git -c http.proxy= clone <url>
```

The repo was initialised and committed that way. `git push` to
`github.com/f1shsmell/Reasonix-Android` needs the same treatment, or the proxy
config fixed properly.

### The Android SDK is installed now

`ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`, with platform-tools 37.0.1,
platforms;android-36 and build-tools;36.0.0. The machine's user-level
`JAVA_HOME` points at Zulu 25, which Gradle 8.14 cannot parse
(`Unsupported class file major version 69`). Prefix every Android build with
`$env:JAVA_HOME='C:\Program Files\Java\jdk-21.0.12.1'` in PowerShell (or set
it for the session). The shell and its first APK are described below; the
first launch on an API 36 emulator succeeded, and the operator has since run
the phone build on a physical device.

### The Android shell

Capacitor 8.6.0, `appId=com.reasonix.mobile`, minSdk 26 (the barcode-scanner
library requires it). The Android project is checked in: it holds
`MainActivity` and `LoopbackProxy.java`, not only generated files. Build
outputs are still ignored by `android/.gitignore`.

The WebView loads `http://127.0.0.1:8788`, served by `LoopbackProxy` from the
APK's `assets/public`. The proxy:

- serves the bundle and forwards every non-static path to the configured kernel;
- keeps kernel cookies in a `CookieManager` keyed by upstream origin;
- relays `text/event-stream` with chunked encoding, which is what makes SSE
  work from a WebView with no CORS;
- exposes `/__reasonix/*` for config, pairing, candidate retries and the
  account device flow.

The loopback listener is not open to every app on the phone. `MainActivity`
installs a per-install `reasonix_loopback` HttpOnly cookie in its own WebView
cookie jar before Capacitor constructs the bridge; `LoopbackProxy.handle`
requires that cookie (constant-time compare) and rejects a foreign `Origin`
with `403 proxy.unauthorized`. The cookie is stripped before forwarding and is
never sent to the kernel. Verified on the emulator: no cookie → 403, the
prefs secret → 200, and the app's first screen renders.

The relay event source surfaces an `onerror` after an already-open feed dies,
and `RuntimeStream` catches an `EventSource` constructor failure during a
transport switch and retries. `Connection` clears `lastEvent` on attach and
detach, so one pane's last frame cannot be folded into the next pane.

The Connect screen (`src/app/ConnectScreen.tsx`) scans a QR code with
`@capacitor/barcode-scanner`, accepts a `reasonix://` deep link, or takes a
manual origin. A LAN code is `http://<ip>:<port>/#pair=<code>`; the proxy
spends the code with `POST /pair` and stores the device cookie. The Internet
code (`https://reasonix.io/remote/?device=<id>`) is recognised, and the relay
controller protocol is implemented in `src/net/relay.ts`.

The scanner asks for `QR_CODE` only and pins Android to the MLKit library. A
Studio code is always a QR code; the earlier `hint: ALL` made the detector
evaluate every symbology per frame, which is the likely cause of the slow
first read. The remaining latency is the plugin's camera Activity (focus and
frame rate), which its public options do not expose.

Account sign-in uses the device flow, but the approval page is hosted by the
app's own WebView (`LoginActivity`, opened through the `Login` plugin), not the
system browser. That distinction is load-bearing: `/me/remote-grants` wants the
account cookie, and only a WebView the app owns shares its cookie store with
the proxy. The proxy reads
`CookieManager.getCookie("https://id.reasonix.io")` for the grant; the Bearer
token from `/device/poll` is used for `/me/devices` only. The device list hides
revoked devices, and a device without the `desktop` capability is rendered
disabled instead of being attempted.

Grant succeeded after an in-app login (the next failure was the WebSocket),
so the WebView cookie read does work. If it regresses, the next step is still
to run the grant fetch inside that WebView.

The approval page rendered its primary button white-on-white inside the app's
WebView; a phone showed only "拒绝". `LoginActivity` now forces a light color
scheme, gives approve-ish buttons an explicit blue/white style, and exposes a
native "同意并批准" button that clicks the page's approve control by its text.
If that native button reports "not-found", the page's approve control is not a
matched `button`/`a`/`[role=button]` and its markup needs another pass.

## Sessions and projects on the phone

The session list and chat header each expose one `＋` action, which opens a
bottom sheet with "current project: new conversation" and the host's remembered
projects. It reads `GET /rt/{id}/workspaces` and opens a fresh pane with `POST
/runtimes {root}`. It deliberately does not call `/workspace` (that needs the
host grant) and does not mirror desktop settings. A paired device may only open
roots the host already knows; there is no arbitrary folder picker.

## Images

The composer's `📎` accepts a 10 MB image, posts `{name, mime, data}` as JSON to
`POST /rt/{id}/attachments`, inserts the returned `@ref` into the draft, and
shows the sent image through `GET /rt/{id}/workspace/image?path=...`. The raw
`/attachments/upload` route was refused by the installed kernel with `415
request.bad_content_type`, so the JSON route is the one the phone uses. A
failed upload keeps the draft; the image chip can be removed before sending.

A send is drawn locally as a user row before `POST /submit` returns. The
kernel's later `turn_started` confirms that row by matching its text instead of
appending a second copy; a failed submit removes it and leaves the draft in the
composer.

Long agent turns used to leave one reasoning-only assistant bubble per tool
step, plus empty bubbles from tool-call-only `message` frames, which read as a
wall of blank strips on a phone. Both folds now drop a reasoning-only step when
its tool starts, stored history keeps only the tool card for such a step, and an
assistant row with neither text nor reasoning renders nothing.

A closed `<details>` was also being forced into `.row`'s `display:flex`; Android
WebView then drew only the card's border, which is the one-pixel bar between
messages. The tool `details` now sits inside a row wrapper, so its summary
(status and tool name) is always visible.

An uploaded image appends a newline after its `@ref`, and sending runs
`isolateImageRefs`, so text typed next to a reference becomes a separate token.
The desktop Studio draws user images from `attachments` metadata, not from
arbitrary message text; a reference glued to the next word is not recognized as
an image.

The Internet path is implemented in `src/net/relay.ts`. It is the desktop
page's controller protocol reduced to fetch and a polled stream:

- `POST /me/remote-grants` (through the proxy) returns a one-time ticket, the
  device's X25519 public key and the relay origin;
- the WebSocket dials `/v1/sessions/connect` with subprotocols
  `reasonix.remote.v1` and `reasonix.auth.<ticket>`. It is carried by native
  OkHttp (`RelaySocketPlugin` + `src/native/socket.ts`), not the WebView: the
  relay answers **403 `origin_rejected`** to `Origin: http://127.0.0.1:8788`
  and accepts `Origin: https://reasonix.io`. A WebView cannot set that header;
  OkHttp can;
- the controller sends `hello` (X25519 public key + 16-byte salt); the key is
  HKDF-SHA256 over the ECDH secret with info `reasonix-remote-v1|<deviceId>`,
  and every later frame is AES-GCM-sealed JSON;
- requests are `desktop.request {id, method, path, body}`; answers are
  `desktop.response` chunks assembled by id;
- the event stream is `GET …/events/replay` polled, because the relay carries
  messages, not a long-lived byte stream.

Installing the link swaps `fetch` and `EventSource` only for kernel paths; the
LAN proxy still serves the bundle and `/__reasonix/*`. `RelayLink` reconnects
and re-sends only reads; a write that may have run is failed rather than
repeated, so a submit cannot execute twice.

The relay socket has not completed a live session yet. With the native socket
built, the next failure (if any) carries the relay's HTTP status instead of a
bare "can't reach".

The same-Wi-Fi retry is real but limited: the proxy remembers candidate origins
and `/__reasonix/refresh` probes them on a network change. If the computer's IP
changes, no candidate answers and a new scan is required. Automatic discovery
would need mDNS or UDP advertisement in the kernel.

The LAN listener picks a free port unless `[serve].share_port` is set; its QR
code carries `http://<ip>:<port>/#pair=<code>`. `/pair` does not exist on 8791
(the Studio's main port). A code is valid for 5 minutes and once; the proxy
reports a stale code as `device.pairing_invalid` and a wrong port as
`device.pair_route_missing`. If a phone browser cannot open the QR link at all,
the problem is the network or the Windows firewall, not the app.

The proxy sets `Origin` and `Referer` to the upstream origin on every forward.
This is not cosmetic: `loopbackOriginAllowed` accepts an empty Origin only for
GET/HEAD, so before this a paired phone could read history and runtimes but
every POST — submit, approve, answer, cancel — was refused with
`device.origin_rejected`.

A second, browser-identical path exists for the case where the direct
`POST /pair` is refused on a code the Studio page accepts. On Android, when a
code is present, ConnectScreen no longer calls `/pair` at all: it opens the
share link through the `Pair` plugin, which loads it in a hidden 2×2 WebView
inside a translucent `PairActivity`. The page's own `#pair=` bootstrap spends
the code and stores `reasonix_device`; `PairActivity` polls
`CookieManager.getCookie(origin + "/")` and returns `paired` when the cookie
appears. ConnectScreen then saves the origin without a code, and the proxy
reuses that WebView cookie for `/runtimes` and the rest. The user sees only a
brief "正在配对…" card, not the Studio page. The direct `POST /pair` remains
for the browser build and for an address entered without a code.

The code is still one-time: opening the link in a browser first spends it for
the app. A hidden pairing that never sees the cookie times out after 15 s and
reports failure instead of hanging.

Verified on the emulator: the Connect screen renders; after configuring
`http://127.0.0.1:8791` through an `adb reverse`, the session list loads, a
chat opens, and its stream indicator is green (SSE through the proxy).
Screenshots are in `docs/screenshots/`. The relay build also renders the
account and cloud-device sections, `/__reasonix/config` reports `mode` and
`relayDevice`, and an unauthenticated `/__reasonix/account/grant` answers 401
`account.signed_out`.

### The kernel needs an API key to do anything

`reasonix serve` starts and serves fine without one, but every turn is refused:

```json
{"code":"provider.key_missing","error":"the selected model has no API key yet; add one with /setup",
 "params":{"model":"deepseek-flash","provider":"deepseek"}}
```

That refusal is *useful* — it exercises the whole submit path and the refusal
rendering. But it means approval and ask prompts cannot be triggered, because
nothing ever calls a tool. Milestone 4 is therefore written but unverified.

To run against a kernel:

```bash
REASONIX_HOME=/tmp/rxh reasonix serve --addr 127.0.0.1:8791 --auth token --token-file /tmp/t.token --no-open
```

The token lands in `$REASONIX_HOME/remote/launch-*.token`.

## Decisions that will look wrong if you undo them

Each of these was arrived at by something breaking.

### The transcript fold is immutable

`src/chat/transcript.ts`. An earlier version mutated the last row in place and
returned `rows.slice()`. A test caught that a transcript already handed to
React was rewritten underneath it. `appendOrExtend` now copies the row it
extends. Do not reintroduce in-place mutation for speed; the reference identity
is what lets the view skip re-rendering.

### Assistant text is Markdown, parsed once

`src/chat/Markdown.tsx` renders finished answers with `react-markdown` and
`remark-gfm`; raw HTML is deliberately not enabled, so a message cannot inject
markup. Links carry `target="_blank"` and `rel="noreferrer noopener"`, and wide
tables/code scroll inside the bubble instead of widening it.

While a row is still `streaming`, the view shows its raw text; parsing the
whole growing answer on every delta made long answers stutter. The finished
answer is parsed once and memoised by text. Do not switch streaming rows to
Markdown without measuring.

### Tool output that is a diff is read line by line

`Rows.tsx` splits `outputDiff` output into spans: `+` additions, `-` removals,
`@@` hunks, and file headers are toned. A diff is a core surface of this
product, and a wall of uniform monospace is the one thing that makes it
useless on a phone. Non-diff output still renders as one `<pre>`; do not run
the splitter on it, or arbitrary text with a leading `-` would look like a
deletion.

### `turn_started` closes every open bubble

A dropped socket means `turn_done` never arrives, so a bubble stays
`streaming: true` forever. Without this, the next turn's text appends to the
previous turn's answer. There is a test named "closes a bubble a dead turn left
open" — it exists because this happened.

### A cursor is the last id seen, not a frame count

The kernel writes `id:` only on replayable frames (`eventstream.go`, `f.Seq >
0`). Frames without an id are deltas a reconnect **must not** ask to have
replayed. So `RuntimeStream` stores the last id carried by a frame, and sends it
as `lastEventId`. A count of received frames would re-deliver every delta on
every reconnect, duplicating text.

### Reachability and stream health are separate

`src/net/connection.ts`. A stream retrying while the kernel is fine, and a
kernel gone while the last frame is still on screen, are different situations
asking the person for different things. Collapsing them into one indicator lies
about which happened.

### `audience: "operator"` notices are dropped

"No API key set" is about the machine, not the work. The kernel already keeps
these out of the end-user conversation; the phone agrees.

### Refusals are carried as codes, never as wording

`internal/frontend/serve/fail.go` writes `{code, error, params}`. `code` is the
stable identity, `error` is only its wording. `src/net/submit.ts` carries the
code and the UI shows it above the sentence. Do not match on the message.

### Scroll follows only from the bottom

`ChatScreen.tsx` tracks `atBottom` within 48 px. A streaming transcript that
yanks the view down while someone scrolls back to read is the worst thing it can
do.

### A draft belongs to one pane, and survives interruption

`src/chat/drafts.ts` stores unsent text under `reasonix.draft.<runtimeId>`.
`App` renders `ChatScreen` with `key={runtimeId}`, so a mount reads exactly one
key and unmount writes the last text; without the key, one session's draft
would appear in another. A successful `submit` clears the key before clearing
the composer. The mount effect re-runs `grow` after restoring a multi-line
draft. Do not replace this with a single `draft` state in `App`.

### Android back is a navigation action, not an exit

`App` listens for Capacitor's `backButton`: the connect overlay closes, then a
chat returns to the session list, and only the root exits. The `popstate`
history entry remains for a browser/PWA only; on Android the plugin is the
source of truth. The screen is keyed by runtime so returning to the list and
opening another pane starts with that pane's scroll and send state.


`src/app/main.tsx`. The double-invoked effects it causes are exactly the ones
that break a streaming view. Finding that in development is the point.

## Verified, and what is still not

Be precise about this with whoever you report to.

**Verified against a keyed kernel on 2026-10-29** (`reasonix serve` with a
working provider, driven by the app's own modules rather than by curl):

- `POST /auth/token` → 204 + `reasonix_token`; `GET /runtimes` → the open pane.
- SSE connects, and a **new** connection receives a replay of a prompt that is
  still open. That is why history carries settled messages only.
- `GET /rt/{id}/history` → the stored conversation, folded into rows with tool
  results joined to their calls by id.
- `POST /rt/{id}/answer` with `{answers: [{QuestionID, Selected}]}` → 204. A
  bare string list → 400 `request.missing_field`; that was the old body.
- `POST /rt/{id}/approve` with `{id, allow, session, persist}` → 204.
- The kernel then emits a `decisionReceipt` on a notice frame, which is what
  closes a pending prompt that was answered elsewhere.

**Still not verified:**

- **Layout has not been systematically reviewed on a phone.** The phone build
  has run on a physical device and the component tests mount real components,
  but scrolling under a finger, the software keyboard, safe areas, rotation
  and tap targets are still hypotheses. The todo panel's collapsed row, 34 vh
  cap and sub-step indent are claims about CSS.
- **The transcript is never scrolled under a real finger.** `atBottom` is
  asserted only by reading the code.
- **The relay channel has not been exercised end to end.** The protocol is
  ported and unit-tested at the transport level, but no signed-in account or
  online device was available; the grant, handshake and reconnect paths have
  not met the real service.
- **`GET /rt/{id}/todos` was called against a running kernel**: 204 on token
  exchange, 200 `application/json` with `[]` on a fresh pane. A **non-empty**
  list has still not been observed on a live stream — that needs a keyed turn —
  so the `todo_progress` refresh is tested against fixtures rather than a real
  advance.
- **Sessions/projects and images were exercised against a real kernel**:
  `GET /rt/r1/workspaces` → current/canSwitch/recents, `POST /runtimes {root}`
  → r2, `POST /rt/r1/attachments` → 200 with `@ref`, and `GET
  /rt/r1/workspace/image?path=...` → 200 `image/png`. The raw upload route
  returned 415 `request.bad_content_type`; the phone therefore uses JSON.
- **The APK launches on an API 36 emulator (Pixel 6, x86_64) and reaches a LAN
  kernel through the loopback proxy** (session list, chat, SSE). A physical
  device has since run the phone build. The loopback-auth build was verified
  on the emulator with a missing-cookie `403`, the prefs secret `200`, and a
  rendered first screen. Typecheck is clean and the suite is 208 tests across
  26 files. Native unit tests cover body limits, chunked bodies, header
  length, control-route methods and WebView URL schemes.
- **The 2026-10-30 hardening pass has not been re-run on a device.** In
  particular: the foreground service and its notification permission flow,
  R8-shrunk release output, syntax highlighting and copy, and the new request
  deadlines under a half-dead TCP connection. The deadlines and proxy limits
  are unit-tested; the phone behaviour is not.

## Hardening pass (2026-10-30)

Decisions that will look optional until they are removed:

- Every request goes through `src/net/http.ts`. A socket that connected and
  then went quiet is the ordinary phone failure; without a deadline the
  composer stays "sending" forever and `recover()`'s latch never releases.
  The relay request also has its own 30 s timer.
- `LoopbackProxy` gives only SSE an infinite read timeout. Control routes that
  change state are POST-only, because the loopback cookie is present in the
  app's own WebView and an `<img>` can issue a GET without an Origin.
- A relay `stream_gap` marks the transcript and offers a fresh history read.
  Silently continuing would let the person answer from a conversation missing
  its middle.
- A send clears only the draft snapshot it took. Text typed while the POST was
  in flight belongs to the next turn.
- `TurnService` is priority, not a second transport. It holds a capped partial
  wake lock and stops on `turn_done`; if the process dies the kernel keeps
  running and the cursor resumes it.
- The release build enables R8. The keep rules cover Capacitor's reflective
  plugin bridge; a release without `keystore.properties` fails at
  `assembleRelease` instead of producing an uninstallable APK.

## Review result

The 2026-10-29 review found two blockers — the unauthenticated loopback proxy
and a relay event feed that never surfaced failure after opening — plus two
should-fix findings. All were fixed: the proxy now requires the per-install
HttpOnly cookie, the relay feed reports `onerror` and `RuntimeStream` retries,
`Connection` clears `lastEvent` on pane changes, and a failed cloud attempt no
longer tears down a working relay. A re-review of those sites returned pass
with no new blocker. The proxy auth was also exercised on the emulator
(missing cookie 403, secret cookie 200, cold launch renders). Native unit
tests now cover request-body limits, chunked bodies, header length,
control-route methods and WebView URL schemes; the proxy's cookie comparison
itself still has no automated test.

The 2026-10-30 hardening review flagged one apparent blocker in code-block
copy. The parent test disproved it — `Markdown.test.tsx` copies the fenced
source and passes — but the review found real issues that were fixed: R8 was
missing Gson annotations referenced by the barcode-scanner AAR (now
`-dontwarn`), `client.timeout` had no sentence of its own, a gap reload could
drop a pending prompt or an unconfirmed send, a negative chunk size reached
`new byte[-1]`, and `bundleRelease` was not covered by the signing guard.
`minifyReleaseWithR8` completes; `assembleRelease` fails without a keystore by
design. The 208 frontend tests and 11 native tests pass.

## Where to go next

`docs/PLAN.md` lists milestones 3–5. My own read, in priority order:

1. **Look at it on a phone.** Everything else is building on unseen CSS.
   `http://<lan-ip>:5274/#token=<token>`.
2. **Exercise the relay against a live account** — the controller protocol is
   ported, but it has not met the real account service or an online Studio.
   Until then, cloud links and the "云端电脑" list are code paths, not verified
   behaviour.
3. **Run it on a physical device** — the emulator launch is done; a real phone
   over Wi-Fi is the point of the project and has not happened.
4. **Read a non-empty `/todos` from a live kernel** — the endpoint and its
   empty answer are verified; a real todo list still is not.

Todos shipped this round (`src/net/todos.ts`, `src/chat/TodoPanel.tsx`), so
they are off this list. Answered prompts were verified last round; they are
off it too. What is *not* answered is whether a phone can reach a kernel over
the LAN at all: every verification so far went through loopback or the dev
proxy.

## The contract rule

The phone and the desktop update on different schedules. The wire contract only
grows: fields and event kinds are added, never renamed or removed. The client
ignores what it does not know. There is a test asserting an unknown kind is
ignored and returns the same transcript object — keep it.
