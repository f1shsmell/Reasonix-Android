# Reasonix Mobile

An Android client for [Reasonix Studio](https://github.com/esengine/DeepSeek-Reasonix)
that does not reuse a single desktop component. The phone UI is written for a
phone: thumb reach, safe areas, a software keyboard, rotation, and a
connection that drops.

React + Vite + Capacitor. The desktop app is also a React app inside a shell
(Electron there, Capacitor here), so the two share wire types without sharing
screens.

## Status

Milestones 1–4 are written: token bootstrap, runtime list, SSE with resume,
the chat transcript, tool cards, todos, approval and question prompts, and
cancel. The connection, chat, tool-card and prompt paths have been exercised
in a browser against a real `reasonix serve`.

The home screen also carries **待你处理** (Needs You): every conversation whose
pane is blocked on an approval or a question, gathered from
`GET /rt/{id}/status` and ordered above the list. A chat's header shows the
model it runs on and switches it with `POST /rt/{id}/model` — this conversation
only, never the desktop's default — and the same sheet carries the model's
thinking effort (`POST /rt/{id}/effort`).

While a turn is running the composer offers two ways in: **排队** queues the
message for after it, and **插话** sends it into the turn
(`POST /rt/{id}/inbox/items` with `intent`). What the kernel actually did is
reported from the receipt's `disposition`, not assumed.

Conversations can be pinned and projects reordered from the list, both by
writing to `/tree` and re-reading — never by reordering a local copy. The
settings page carries appearance (follow the system, light, dark), the tool
approval posture, and the version. The two home views also switch on a
sideways swipe, with the gesture rule kept in `src/app/swipe.ts`.

A question that arrives as a kernel `surface` instead of options — the shape
that used to render as "这个问题没有可选项" and could not be answered — is drawn
as a real form (`src/chat/SurfaceCard.tsx`) and answered with field values
under `Value`.

The phone build has also run on a physical device: LAN pairing (through the
Studio page in a hidden WebView), the recent/project list, history, account sign-in
and the cloud connection work there. Assistant answers now render Markdown
(`react-markdown` + `remark-gfm`): headings, lists, tables, fenced code and
links; raw HTML stays text, and streaming deltas remain plain until the answer
finishes. Tool output flagged as a diff is split into lines with added,
removed and hunk tones instead of one monospace block. The latest proxy fix —
sending `Origin` on forwarded POSTs — is built but has not been re-tested on
the phone yet.

A hardening pass on 2026-10-30 added the parts a prototype usually skips:
every kernel and proxy request has a deadline; the loopback proxy bounds
request bodies, reads non-SSE responses with a timeout, and refuses
state-changing control routes on GET; relay requests and reconnects are
bounded, and an incomplete replay marks the transcript for a history reload.
Sending no longer wipes text typed while the request was in flight, Android
back walks the project → conversations → chat stack, and a render error
boundary replaces the white screen. Assistant answers gained syntax highlighting and copy actions. A
foreground service keeps a running turn alive while the phone is locked and
posts a completion notification when it ends. The first two items are the ones
to exercise on a real phone; none of the new native code has been re-run there
yet.

**Pick up here: [docs/HANDOFF.md](docs/HANDOFF.md).** It lists the environment
traps, the decisions that will look wrong if you undo them, and what is *not*
verified.

See [docs/PLAN.md](docs/PLAN.md) for scope and milestones, and
[docs/PRIOR_ART.md](docs/PRIOR_ART.md) for the survey this design answers to.
[docs/SELF_HOST.md](docs/SELF_HOST.md) records the decision to reach this
Studio through a Cloudflare Tunnel instead of the account relay, and what it
costs.

## Running it

A dev session needs a kernel to talk to:

```bash
reasonix serve --addr 127.0.0.1:8791 --auth token --token-file /tmp/t.token
REASONIX_SERVE=http://127.0.0.1:8791 npm run dev
```

Then open `http://<your-lan-ip>:5274/#token=<token>` — the fragment token is
exchanged for a cookie and wiped from the URL. Without `REASONIX_SERVE` the dev
server starts anyway and every kernel call 404s, which reads as a broken app
rather than a missing backend.

```bash
npm run typecheck
npm test
npm run build
```

## The contract rule

The phone and the desktop update on different schedules, so the wire contract
only grows: fields and event kinds are added, never renamed or removed. The
client ignores what it does not know, and nothing is inferred from wording — an
error a caller must tell apart carries a code, not a sentence.

## Android shell

Capacitor 8.6.0 (`capacitor.config.ts`). The `android/` project is checked in
because it holds the loopback proxy that makes the kernel same-origin with the
WebView, not only generated files. Build an APK with:

```bash
npm run build
node ./node_modules/@capacitor/cli/bin/capacitor sync android
cd android && ./gradlew assembleDebug
```

The debug APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`
(36.97 MB, version 0.1.0). The WebView serves the bundle from `127.0.0.1:8788`
and forwards kernel routes through `LoopbackProxy`; the first screen scans a
Studio LAN QR code or takes an address. The loopback listener requires a
per-install HttpOnly cookie that `MainActivity` installs before the WebView
starts; a missing or foreign cookie gets `403 proxy.unauthorized`. Verified on
an API 36 emulator (first screen, auth 403/200, session list, chat, SSE), and
the operator has run the phone build on a physical device. The Internet relay
channel is implemented in `src/net/relay.ts`: account grant through the in-app
login cookie, X25519/HKDF/AES-GCM, request transport, polled events, and a
native OkHttp WebSocket that sends the `Origin: https://reasonix.io` the relay
requires. The operator reports a live cloud connection working; a formal
end-to-end relay run is still not recorded.

The launcher icon and splash are app-owned: adaptive icon
(`drawable/ic_launcher_foreground.xml`, dark `#0F172A` background) and a
layer-list launch background. `versionCode` and `versionName` live in
`android/gradle.properties` (`reasonix.versionCode` / `reasonix.versionName`)
so a release bump is one edit. Release builds enable R8 and resource shrinking;
the keep rules for Capacitor's reflective plugin bridge are in
`android/app/proguard-rules.pro`. `assembleRelease` now fails unless
`android/keystore.properties` exists — copy `keystore.properties.example` and
fill it in. Native unit tests run with `cd android && ./gradlew
testDebugUnitTest`; they cover request-body limits, chunked bodies, header
length, control-route methods and WebView URL schemes.

A running turn starts `TurnService` (foreground, `dataSync`, partial wake
lock) and stops it on `turn_done`. The service is priority, not a second
transport: if the process dies, the kernel keeps running and the next launch
resumes from the SSE cursor.
