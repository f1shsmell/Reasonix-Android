# Reasonix Mobile — implementation plan

A native-feeling Android client for Reasonix Studio. React + Vite + Capacitor.
The phone UI is written from scratch; no desktop component is reused.

## Scope of v1

In: session list, streaming chat, tool-call cards, todos, approval and question
prompts. Out: file tree, diff review, terminal, git, settings, plugins.

## Why this stack

The desktop app is Electron only in its shell. `desktop/frontend-next` is a
React 19 + Vite application that happens to be loaded by an Electron window over
a loopback HTTP origin. Capacitor takes the same place on a phone, so the client
is a React app either way, and it can share the wire type declarations in
`desktop/frontend-next/src/port/` without sharing a single component.

What that buys, and what it costs, stated plainly:

- Markdown, syntax highlighting and diff rendering are solved on npm and were
  not on Android. Diff is a core surface of this product, so this is decisive.
- `src/port/wire.ts` declares 35 event kinds and their payloads. Consuming those
  types directly removes the class of drift the kernel's `wire-parity` gate
  exists to prevent.
- Vite's dev server plus a phone browser gives a seconds-long loop. The hard part
  of this project is the connection layer, which needs that loop.
- The cost is WebView scroll feel. Capacitor allows replacing individual screens
  with native views later without redoing the app.

## Transport

Plain HTTP + SSE against a running Reasonix kernel. No relay in v1.

```
GET  /runtimes                 -> which panes exist
GET  /rt/{id}/events           -> SSE, resumable via Last-Event-ID
POST /rt/{id}/submit           -> {"input": "..."} sends a turn
POST /rt/{id}/answer           -> answers an ask_request
POST /rt/{id}/approve          -> answers an approval_request
GET  /rt/{id}/todos            -> current todo list
POST /rt/{id}/cancel           -> stops the running turn
```

The SSE handler replays from `Last-Event-ID`, so a reconnect costs only what the
replay log can no longer reach. The client must therefore persist the last id
across app restarts, not just across network blips.

### Auth

`reasonix serve` defaults to token mode: the token arrives in a `#token=`
fragment, is exchanged at `POST /auth/token` for a `reasonix_token` cookie.
The same `#token=` bootstrap exists for the pairing code at `POST /pair`.

The fragment is used deliberately so the credential never reaches a request
line, log or referrer. The client must wipe it with `history.replaceState`
before any other request runs.

### The contract rule

The phone will routinely be months behind the desktop. Therefore:

- Fields are added, never renamed or removed.
- An unknown event kind is ignored, not an error.
- An unknown field in a known event is ignored.
- Nothing is inferred from wording. The kernel's own rule applies here: an error
  a caller must tell apart carries a code, not a sentence.

## App structure

```
src/
  app/          screens and navigation
  chat/         transcript, bubbles, streaming
  cards/        tool call, approval, question, todo
  wire/         types mirrored from the desktop port, and a decoder
  net/          connection, SSE client, reconnect policy, token storage
  ui/           the phone design system: no Mantine, no desktop components
```

`wire/` is generated-once-then-maintained type declarations. It is not imported
from the desktop tree at build time: a phone build must not break because the
desktop branch moved.

## Milestones

1. **Connection** — token bootstrap, `/runtimes`, SSE with resume, visible
   connection state. Verified against a real `reasonix serve`.
2. **Chat** — session list, transcript, streaming text, send.
3. **Cards** — tool calls, todos.
4. **Interaction** — approval and question prompts, cancel.
5. **Packaging** — Capacitor Android, real device.

Milestone 1 is pure logic and testable in a browser against a live kernel.

## Design constraints

- Mobile is not miniature desktop: thumb reach, safe areas, software keyboard,
  rotation, interrupted use.
- Interruption is normal. A draft typed offline survives; an answer to a prompt
  is marked unconfirmed after reconnect until the person confirms it.
- Send is a state machine, not a fire-and-forget call. "Did it land" is shown.

## Verification

Every milestone is checked against a running kernel, not a mock. The kernel's
`tools/relayfake` is the pattern: a real endpoint, exercised for real.

## Milestone log

### 1. Connection — done

Written: `src/net/token.ts` (fragment exchange, wiped before use),
`src/net/stream.ts` (SSE with resume, backoff 0.5s→15s), `src/net/connection.ts`
(reachability and stream health as separate facts), `src/wire/` (event and
runtime types), `src/app/ConnectScreen.tsx` (a surface to watch it work).

Verified against a real kernel, not a mock:

- `POST /auth/token` → 204 + `reasonix_token` cookie.
- `GET /runtimes` → the pane the kernel had open, fields matching `RuntimeView`.
- `GET /rt/{id}/events` → a real `notice` frame.
- Resume accepted both ways: `?lastEventId=` and the `Last-Event-ID` header,
  which is the order the kernel reads them in.

Tests: 14 passing (`token` 4, `stream` 5, `connection` 5). Typecheck clean,
production build 71 kB gzipped.

Two details worth keeping:

- The kernel writes `id:` only on replayable frames, so the cursor is the last
  id actually seen — never a count of frames received.
- Its keepalive is a real `stream_watermark` frame rather than an SSE comment,
  precisely so a client can notice a lost last frame. A client that treats all
  unknown kinds as noise throws that away.

### 2. Chat — done

Written: `src/chat/transcript.ts` (the fold), `src/chat/Rows.tsx` (row
renderers), `src/chat/ChatScreen.tsx` (scroll, composer, send state),
`src/net/submit.ts` (send as a state machine), `src/app/Home.tsx`,
`src/app/SessionList.tsx`, `src/net/tree.ts`, `src/app/App.tsx` (one connection,
one navigation state), `src/ui/chat.css`.

Verified against the real kernel through the dev proxy: index 200, `POST
/auth/token` 204, `GET /runtimes` returned the open pane, SSE connected, and
`POST /rt/r1/submit` answered

    {"code":"provider.key_missing","error":"the selected model has no API key
     yet; add one with /setup","params":{"model":"deepseek-flash",...}}

That refusal is the shape `internal/frontend/serve/fail.go` writes, and it
correctly came back as a code the person can act on rather than a retry.

Tests: 41 passing (transcript 18, submit 9, stream 5, connection 5, token 4).
Typecheck clean, production build 74 kB gzipped.

Four decisions worth keeping:

- **The fold is immutable.** The first version mutated the last row in place;
  a test caught that a snapshot already handed to a renderer was rewritten under
  it. Rows are now copied on every change.
- **A dead turn cannot absorb the next one.** `turn_started` closes any bubble
  still marked streaming, because a turn that never sent `turn_done` (a dropped
  socket) would otherwise keep swallowing the following answer.
- **`audience: "operator"` notices are dropped.** "No API key set" is about the
  machine, not the work, and the kernel already keeps it off the end-user
  conversation.
- **Scroll follows only from the bottom.** A streaming transcript that yanks the
  view down while someone reads back is the worst thing it can do.
### 3–4. Cards and interaction — done, and found wrong on the wire

Milestones 3 and 4 were written before any of this ran against a keyed kernel,
and the handoff said so. Running it against one found that the ask path had
never worked at all:

| What the client did | What the kernel does |
|---|---|
| `ask.prompt`, `ask.options` | `ask.questions[]`, each with its own `options` |
| `POST /answer {answers: ["茶"]}` → **400** | `{answers: [{QuestionID, Selected}]}` → **204** |
| `POST /approve {allow, remember}` | `{allow, session, persist}`; `remember` is accepted and **silently ignored** |

The approve one is the worse of the two. A wrong answer body fails loudly; a
wrong approval body succeeds while granting less than the person asked for, so
nothing on either screen ever says the session grant did not happen.

Two more things came out of the same session:

- **A reopened session was empty.** The kernel answers a first connection with
  initial notices only — it does not replay the session — so `ChatScreen`
  showed nothing for a conversation that had been running for days. `net/history.ts`
  now reads `GET /history` and folds it under the live stream.
- **A prompt could stay pending forever.** A decision made on another device
  never reached this one as a state change, so the row kept its buttons. The
  kernel emits a `decisionReceipt` on a notice frame; that is what closes it.

What was verified against a real kernel this time, not inferred:

- `GET /rt/{id}/history` → 13 messages, folded into user/assistant/tool rows
  with results joined to their calls by id.
- `POST /rt/{id}/answer` with `[{QuestionID, Selected}]` → 204, and the kernel
  then emits `{"kind":"notice","decisionReceipt":{"id":"…","kind":"ask",
  "outcome":"answered"}}`.
- `POST /rt/{id}/approve` with `{id, allow, session, persist}` → 204.
- A **new** SSE connection receives a replay of a prompt that is still open.
  That is why history carries settled messages only: the pending ones arrive
  on their own.

Tests: 89 passing, up from 41. The 17 that matter most are the first component
tests this project has had — `Rows.test.tsx` presses the buttons and asserts
the body, and `ChatScreen.test.tsx` asserts that a live frame lands *below* the
history it followed. Typecheck clean, production build 75.7 kB gzipped.

One environment note: React 19 refuses to batch inside `act` unless
`IS_REACT_ACT_ENVIRONMENT` is set, so `src/test-setup.ts` sets it and stubs
jsdom's missing `Element.prototype.scrollTo`. Without the first, every
component test warns and the batching that makes it deterministic stops
applying — a green run would prove less than it looks like.

### 3. Todos — done (the other half of milestone 3)

The checklist is the kernel's, not the transcript's. `complete_step` advances
it without writing a `todo_write`, and a refused `todo_write` stays in the
conversation, so folding the transcript would show work the kernel never
accepted or miss work it did. `src/net/todos.ts` therefore reads
`GET /rt/{id}/todos`, and a `todo_progress` frame is only a notification: its
three revisions decide whether a re-read is needed.

Written: `src/wire/todos.ts` (the list and the progress payload),
`src/net/todos.ts` (`loadTodos`, `todoRevision`), `src/chat/TodoPanel.tsx`
(one collapsed line above the transcript, open for the checklist), and
`useTodos` in `ChatScreen.tsx`. A newer read always wins — a response that
arrives after the screen moved to another pane is dropped rather than drawn.
A failed refresh keeps the last list and marks it stale; the next frame with
the same clocks is allowed to try again, rather than waiting for a clock to
move.

Tests: 9 for the read layer and the revision rule, 6 for the panel, and 8 more
in `ChatScreen.test.tsx` (first load, refresh, a frame whose clocks did not
move, a failed read, a pane switch, a stale list after a failed refresh, two
overlapping reads, and a retry on the next frame with the same clocks).
Typecheck clean.

Against a real `reasonix serve`: `POST /auth/token` → 204, `GET /runtimes` →
the open pane, and `GET /rt/r1/todos` → 200 `application/json` with `[]` on a
fresh pane. A **non-empty** list was not produced — that needs a keyed turn —
so the refresh path is still tested against fixtures rather than a live
advance.

### 5. Packaging and the connection bridge — LAN loop closed

Capacitor 8.6.0, `appId=com.reasonix.mobile`, minSdk 26 (the barcode-scanner
library requires it), versionName 0.1.0. The Android project is checked in
because it now holds native code, not only generated files.
`./gradlew assembleDebug` produces a **36.97 MB** debug APK at
`android/app/build/outputs/apk/debug/app-debug.apk`. The launcher icon and
splash are app-owned (adaptive vector icon and a dark `launch_background`);
`assembleRelease` produces an unsigned **32.16 MB** APK unless
`android/keystore.properties` exists (see `keystore.properties.example`).

The WebView loads `http://127.0.0.1:8788`, served by `LoopbackProxy`: it serves
the bundle from the APK, forwards every other path to the configured kernel,
keeps kernel cookies in a CookieManager, relays SSE with chunked encoding, and
exposes `/__reasonix/*` for configuration, pairing, candidate retries and the
account device flow. That is the piece that makes the kernel's cookie session
and EventSource usable from a WebView without CORS.

The Connect screen scans a QR code (`@capacitor/barcode-scanner`), accepts a
`reasonix://` deep link (`@capacitor/app`), or takes a manual origin. A LAN
code is `http://<ip>:<port>/#pair=<code>`; the proxy spends it with
`POST /pair` and keeps the device cookie. The Internet code (`https://reasonix.io/remote/?device=<id>`) is recognised.
`src/net/relay.ts` implements its controller protocol: account grant through
the proxy, `wss://remote.reasonix.io/v1/sessions/connect` with the ticket
subprotocol, X25519/HKDF/AES-GCM sealed `desktop.request` frames, and a polled
`/events/replay` stream. The Connect screen lists signed-in devices and can
start a cloud link.

The phone's home screen is two views of one tree, modelled on Alma's phone
client. `GET /tree?scope=active&limit=N` — the desktop sidebar's own endpoint —
returns one row per project with its counts and its newest conversations.
**最近** merges every project's conversations by `lastActiveAt` (a client-side
merge, not a second request); **项目** draws the projects, and tapping one shows
its conversations. A search field filters either list by title, name, project
or path. A conversation opens with `POST /runtimes {root, sessionPath}` (which
binds the stored transcript, or answers the pane already driving it) and
"新会话" is the same POST with no `sessionPath`; the home `＋` asks which
project first. A paired device may only open roots the host already knows;
there is no folder picker and no copy of desktop settings. The earlier flat
list of open panes was replaced because it showed what the desktop was running,
drew one project once per pane, and could not reach a conversation with no pane.

The home screen's **待你处理** block aggregates `GET /rt/{id}/status` across
every conversation that has a running pane: a tool approval, a plan approval, a
recovery choice or an ask is derived by the kernel from the subsystem that owns
it, so the phone stores nothing. A prompt in a session nobody has open is
invisible — the pane is what blocks, on the desktop too. Tapping a card goes to
that pane; it never opens a second one, because the decision belongs to that
controller.

The chat header's model chip reads `GET /rt/{id}/models` on open and switches
with `POST /rt/{id}/model {ref}`. It changes this conversation only: the
desktop's default is a different route and is deliberately not called. The
catalog is never cached, so a key revoked on the desktop cannot leave the sheet
offering a model that refuses. The same sheet carries the model's thinking
effort (`POST /rt/{id}/effort`), offered only when the model declares any.

Three more surfaces landed with it. A running turn accepts a message two ways —
排队 (`intent: "followup"`) or 插话 (`intent: "steer"`) — and the receipt's
`disposition` is what the screen reports, because the kernel may queue a steer.
Conversations pin and projects reorder through `/tree`, both followed by a
re-read rather than a local reorder. The settings page carries appearance,
tool-approval posture and version. The two home views also switch on a sideways
swipe; the rule lives in `src/app/swipe.ts` so the gesture cannot quietly steal
the vertical scroll or the sideways card strip.

A question that arrives as a kernel `surface` instead of `options` is drawn as a
real form (`src/chat/SurfaceCard.tsx`) and answered with field values under
`Value`, `Selected` empty. Before this, such a question rendered as "这个问题
没有可选项" and could not be answered at all.

Images use `POST /rt/{id}/attachments` with a JSON/base64 body because the
installed kernel refused the raw `/attachments/upload` route with `415
request.bad_content_type`; the returned `@ref` goes into the draft and the
transcript fetches it through `/workspace/image`. The cap is 10 MB.

Against a real kernel, `GET /rt/r1/workspaces` returned
current/canSwitch/recents; `POST /runtimes {root}` opened `r2`; `POST
/rt/r1/attachments` returned 200 with an `@ref`; and `GET
/rt/r1/workspace/image?path=...` returned 200 `image/png`.

Account sign-in uses the device flow, but the approval page is hosted by the
app's own WebView (`LoginActivity`), because `/me/remote-grants` wants the
account cookie and only an app-owned WebView shares its cookie store with the
proxy. The proxy reads that cookie for the grant; the Bearer token from
`/device/poll` is used for `/me/devices` only. Revoked devices are hidden, and
a device without the `desktop` capability is disabled in the list.

The same-Wi-Fi retry is real but limited: candidate origins are remembered and
`/__reasonix/refresh` probes them after a network change. If the computer's IP
changes, no candidate answers and a new scan is required — automatic discovery
needs mDNS/UDP advertisement in the kernel.

Verified on a Pixel 6 / API 36 emulator: the Connect screen renders; after
configuring `http://127.0.0.1:8791` through `adb reverse`, the session list
loads, a chat opens, and its stream indicator is green (SSE through the
proxy). Screenshots: `docs/screenshots/{connect,sessions,chat}.png`.

Not verified: the camera scanner (the emulator has no camera), the relay
against a live account or online Studio, and an IP change beyond the candidate
retry. The relay's request/event transport is unit-tested; the account grant
and encrypted handshake have not met the real service.

Build commands:

```bash
npm run build
node ./node_modules/@capacitor/cli/bin/capacitor sync android
cd android && ./gradlew testDebugUnitTest assembleDebug
```

### 6. Hardening — 2026-10-30

Written: `src/net/http.ts` (deadlines and composed aborts), bounded relay
requests, a proxy that limits bodies and only lets SSE wait forever,
POST-only control routes, gap-triggered history reload, draft-snapshot send
clearing, an error boundary, syntax highlighting and copy, and
`TurnService`/`TurnPlugin` for a running turn (foreground `dataSync`, capped
wake lock, completion notification).

Verified locally: `npm run typecheck`, 208 frontend tests across 26 files,
`npm run build`, 11 native unit tests, `minifyReleaseWithR8`, and
`assembleDebug`. `assembleRelease` fails at `verifyReleaseSigning` without a
keystore, by design.

Not verified: the foreground service and notification permission flow on a
device, the R8-shrunk APK at runtime, copy/highlight on a phone, and the new
deadlines against a half-dead TCP connection. The R8 task completes, but an
APK that has actually run under R8 has not been seen.
