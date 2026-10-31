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

The phone opens on **最近** (every conversation, newest first), with **项目**
one tap away, and a chat below that. The shape is modelled on Alma's phone
client: a centred title with settings / new-session / refresh actions, a search
field, a two-way segmented control, and rows of title + relative time + chevron.

- The earlier shape listed open panes (`GET /runtimes`). That answered "what is
  the desktop running", which is not the phone's question; it also drew one
  project three times when three panes were open on it, and a conversation with
  no pane could not be reached at all.
- Both views are one read: `GET /tree?scope=active&limit=N`, the desktop
  sidebar's own endpoint. Each project row carries its counts (`total`,
  `remaining`) and its newest conversations (`path`, `title`, `lastActiveAt`,
  `unread`, `runtimeId`). `/tree` is not host-only, so a paired device may read
  it; the relay carries it too (`isKernelPath`).
- 最近 is the merge of every project's rows by `lastActiveAt`, done in the
  client. The tree already sorts inside a project; this is a merge, not a
  second request. Search filters that list by title, transcript name, project
  name and path — the loaded window only, which is the same data the list drew.
- Tapping a conversation is `POST /runtimes {root, sessionPath}` — the hub binds
  that transcript, or answers the pane already driving it. Tapping "新会话" (in
  a project's list, or from the home `＋` after choosing a project) is the same
  POST with no `sessionPath`. A paired device may only name a root the kernel
  already knows, so there is still no folder picker.
- The chat header shows the conversation's title (passed by whichever list
  opened it) over `project · path`; `chatTitle`/`chatProject` in `App` remember
  both because the pane may not be in the runtime snapshot yet.

The tree is pulled, not subscribed: `GET /tree/events` exists for the desktop
sidebar, and a phone sitting on it would spend battery on a list nobody is
watching. Refresh is the button, a return from a chat, and a project open.

## Needs You, and choosing a model

Two things the home screen and the chat header read from the kernel without any
new server-side aggregation.

**Needs You** (`src/app/useNeedsYou.ts`, `src/net/status.ts`). A decision — a
tool approval, a plan approval, a recovery choice, an ask — lives in the
controller of a *running* pane; `GET /rt/{id}/status` derives it from the
owning subsystem on every read, so nothing here is stored or cached. The sweep
therefore visits only conversations that carry a `runtimeId`:

- The honest limit is that a prompt raised in a session nobody has open is
  invisible to the phone. That is also true on the desktop — the pane is what
  blocks — so it is a property of the model, not a gap in the client.
- One pane failing to answer is dropped silently, not reported. A phone that
  could not reach one runtime must not claim the person has nothing to do.
- The block renders nothing while empty or while the first sweep is running, so
  a quiet list is not interrupted by an empty heading.
- It sits on the 最近 view only, and hides while searching: "what needs me" is
  about conversations, and a filtered list must stay filtered.
- Tapping a card goes to the pane that is already open (`onOpenRuntime`), never
  a `POST /runtimes` — the decision belongs to that controller, and a second
  pane on the same transcript would not carry it.

**The model chip** (`src/chat/ModelSheet.tsx`, `src/net/models.ts`). The chat
header shows the model and opens a sheet that reads `GET /rt/{id}/models` on
open, then `POST /rt/{id}/model {ref}`:

- The catalog is read per open, never cached: a provider added or a key revoked
  on the desktop would otherwise leave the sheet offering a model that refuses.
- Switching is this conversation only. `POST /default-model` is a different
  route and is deliberately not called — silently re-pointing the person's next
  desktop session from a phone is not a switch they asked for.
- The active model's row is disabled: re-posting the current ref is a request
  the kernel would no-op or refuse.
- A read-only pane hides the chip; its composer is disabled for the same
  reason.
- The chip shows the short name (`deepseek-pro`); the sheet shows the full ref,
  because that is what is compared.

The same sheet carries **thinking effort** (`src/net/models.ts`
`switchEffort`). The choices come from the active model's own `efforts`
declaration — a model that declares none gets no control rather than a tap the
kernel refuses — with `auto` first. The value shown is read from
`GET /rt/{id}/status`'s `effort`, not from the model's default, because those
are different facts: one is what the catalog offers, the other is what this
conversation is on. `auto` is posted as the word `auto`; the kernel's own
display test asserts it round-trips as an empty effort.

## Sending into a running turn, and the sidebar writes

**插话 / 排队** (`src/net/inbox.ts`). While a turn runs, the composer's send
slot becomes a labelled **停止** button, so a typed message needs its own way
out. Two chips appear under the composer when there is a draft:

- **排队** posts `{input, intent: "followup"}` and waits for the turn to end.
- **插话** posts `{input, intent: "steer"}` and joins the running turn.

The receipt's `disposition` is what the UI reports, not "success": the kernel
may answer a steer with `queued_followup`, and saying «已插话» there would be a
lie. `receiptText` maps each disposition to what actually happened, including
the queue position. A refusal keeps the draft and shows `inboxMessage(code)`.

The running state is not only what the stream saw. Opening a conversation that
was already mid-turn has no `turn_started` to replay, so `ChatScreen` reads
`GET /rt/{id}/status` on open and enters the stop state on `running: true`.
Without that read the phone showed a send button for a turn it could not stop.

**会话操作 and 项目排序** (`src/net/pin.ts`). Both are writes to the kernel's own
tree, followed by a re-read — never a local reorder:

- 置顶 is not a control on every row. A still press on a conversation opens the
  row's action sheet (`src/app/Home.tsx`); its action posts
  `POST /tree/sessions/pin {path, pinned}`. A pin also tells the kernel's
  automatic archiver what to keep, so a phone-side flag would be a promise the
  kernel did not make.
- The kernel does **not** sort pinned rows first, so `recentConversations`
  applies a stable partition: pinned rows lead, each group keeps its recency.
- Project order is dragged, not stepped. A still press picks a row up
  (`src/app/useProjectDrag.ts`), `src/app/projectOrder.ts` turns the gap under
  the finger into "before this root" (`""` for the end), and
  `POST /tree/workspaces/move {path, before}` places it — the same placement the
  desktop's drag makes. Rows are not draggable while a search filters the list,
  because the first row of a result is not the first project, and a folder the
  kernel does not remember cannot be picked up at all.

## Swiping between the two views

`src/app/swipe.ts` holds the rule as a pure function, because the failure mode
is invisible in a screenshot: a gesture that fires too eagerly steals the
vertical scroll and the sideways card strip.

- At least 56 px of travel, and 1.5× more horizontal than vertical, so a scroll
  that drifted does not change views.
- One step only, no wrap.
- A touch that began inside `.cards` (the Needs You strip, which scrolls
  sideways on its own) or inside an input is ignored.

## The settings page

`ConnectScreen` is the settings screen. Beyond the connection and account
groups it now carries:

- **外观** — `src/app/theme.ts`. Three choices written as `data-theme` on the
  document root, applied in `main.tsx` before the first paint so a cold start
  does not flash the wrong palette. `auto` **removes** the attribute rather
  than writing `data-theme="auto"`, or the `prefers-color-scheme` block would
  stop applying. Only this phone: the desktop's appearance is its own setting.
- **工作方式** — `src/net/approval.ts`. The five postures the kernel's
  `ParseToolApprovalMode` accepts (`readOnly ask auto dontAsk yolo`), posted to
  `POST /rt/{id}/tool-approval-mode`. Labels live beside the wire values, never
  in their place: a translated word is a 400 the person cannot explain. The
  control is hidden when no pane exists to address, since a write with no
  target would silently pick one.
- **关于** — the version comes from `package.json` through `define
  __APP_VERSION__` in `vite.config.ts` (declared in `src/env.d.ts`). A
  hand-written string would drift the first time someone bumps the version,
  and the row exists to answer "which build is this?".

## Cloud device identity

The account grant names the Host's X25519 public key, so the relay's TLS
endpoint and the account service are both outside the identity check: either
could hand the phone a different key and the ciphertext would still open.
`src/net/deviceTrust.ts` closes that: the first cloud connection shows the
SHA-256 of the decoded key (first 16 bytes, grouped by four) and asks; the
accepted pin goes to `localStorage["reasonix.devices.v1"]`. Every later open,
including `RelayLink.reconnect`, recomputes and compares without asking.

- A changed or unreadable key **never** reaches the confirm callback. A tap
  cannot approve a substitution. Two deliberate resets exist: the × on a saved
  cloud row drops the pin with the row, and the settings error for
  `trust_changed` carries a "重新确认身份" action that forgets the pin and
  starts a fresh prompt. The second exists because a pin can outlive the row —
  first trust accepted, then verification failed, so nothing was saved — and
  the row's × would then be unreachable.
- An automatic recovery passes no `confirm`. If the pin is gone (storage
  cleared, device never confirmed), the link ends with `device.trust_required`
  and the person connects once from settings, rather than a prompt appearing
  over a chat nobody asked from.
- `RelayError` kinds `trust_required / trust_changed / trust_unreadable /
  trust_cancelled` are mapped in `failureFromError` and `linkFailure`; all are
  non-retryable. The socket is not opened before the check.
- Not verified: the desktop Studio UI does not necessarily display the same
  fingerprint, so comparing by eye is not yet a supported step. What the pin
  does guarantee is continuity — the second key must equal the first this
  phone approved.

## The link hero

The top of `ConnectScreen` is a hero, not a settings card: the product mark,
the computer, the link state, and — while a stage is running — the three step
names. `src/app/ConnectionHero.tsx` owns the copy and the tone; the tone comes
from `linkTone`, so the hero and the home chip cannot disagree about colour.

The mark is `src/app/RMark.tsx`, the desktop's three-stroke geometry with
`pathLength={100}`. The stylesheet holds the one dash rule
(`24 76`, 2.2 s, path delays −0.72 s / −1.44 s) and applies it only under
`data-live`, which is set for `connecting`, `reconnecting`, or a manual
`busy` label. Idle, connected and failed states show the whole glyph: a mark
that keeps moving with nothing happening is the interface claiming work.
`prefers-reduced-motion` restores the static glyph.

The boot `ConnectScreen` (no verified upstream yet) passes the link state too;
before the machine starts, `link` is idle and the hero shows the setup line.
The step list is drawn only when the machine is working, not for a manual
attempt — one `POST` is not three stages.

## The machine panel and checkpoints

- `MachinePanel` is the settings page's **机器** tab: `/usage?days=30`,
  `/context`, `/tools`, `/permissions`, `/studio/versions`, all read-only.
  Each read is independent (`src/net/machine.ts` turns a failed one into a
  missing section), so a kernel without one route still shows the rest. The
  panel never writes: usage, boundary and version are the desktop's decisions,
  and a phone that could flip them would change every session on that machine.
- The base is the first runtime's `/rt/{id}` (App passes it). The desktop's
  port uses the same path for the running project; a kernel that mounts these
  at the root would need a fallback, which is not implemented.
- `/usage`, `/permissions`, `/sandbox` and `/studio` were added to
  `relay.ts` `KERNEL_PATHS`, so a paired cloud client sees the panel too.
- Checkpoints live in the chat's `…` menu. `CheckpointsSheet` reads
  `/checkpoints`, then `POST /rewind/prepare` (`{turn, scope:"both"}`), shows
  the plan's coverage and gaps, and only `POST /rewind/commit` (`{planId}`)
  changes anything. `requiresConfirmation` is shown, not auto-accepted.
  Only edit-tool writes are snapshotted; shell side effects are not covered,
  and the sheet says so.

## Settings, home and the latest row

- `ConnectScreen` has two panes, **电脑** and **偏好**. The first holds the
  hero, saved computers, scan/manual entry, account and cloud devices; the
  second holds theme, transcript fold, background permissions and about. The
  tab is named 电脑 rather than 连接 because the action button below it is also
  called 连接: two controls with one name made the screen ambiguous (and the
  tests pressed the wrong one).
- Tool approval moved out of settings into the chat's `…` menu
  (`ApprovalSheet`). It is a per-runtime posture; the old placement only
  appeared when a runtime existed, which read as a global switch that was
  sometimes missing.
- `useNeedsYou` returns `running` as well as decisions and sweeps every 20 s
  while the document is visible. Home draws 待你处理 and 正在运行 as separate
  blocks, filtering any blocked pane out of the running list so one
  conversation cannot appear twice. `App` refreshes the sweep and the tree on
  `visibilitychange`.
- Chat shows a `↓ 最新` pill whenever `atBottom` is false; the notice strips
  (send failure, prompt error, attachment error, inbox receipt) are one
  priority chain so they cannot stack over the composer.

## Transcript folds

`src/chat/folding.ts` stores this phone's preference under
`reasonix.folding.v1`: 精简 / 标准 / 详尽, default 标准. `buildDisplay` takes
the mode:

- **standard** — a finished run is one summary; a running run is individual
  (the original behaviour).
- **compact** — thinking is dropped, and even a running run is one summary,
  marked `running` so `ProcessSummary` draws a pulsing dot. Failed steps still
  take the `!` icon.
- **full** — `flush` always marks the entry live, so every step is its own
  row, finished or not.

The chat reads the preference once at mount. Opening settings replaces the
chat screen, so returning is a fresh mount and no event or subscription is
needed; that is also why changing the setting cannot update a chat that is
still mounted underneath.

Not verified: the animation's frame rate on a physical device's WebView. The
CSS is the desktop's rule at a larger size (40 px vs 15 px), where the same
24 % dash reads as a lighter trace; a phone capture is the next check.

## Structured asks (surface)

A question may carry a `surface` instead of `options`. Such a question has no
choices, and its answer is not a label list: it is an object of field values
sent under `Value` with `Selected` empty. Rendering it through the option path
is what produced the "这个问题没有可选项" card that could not be answered — the
bug this section exists for.

`src/wire/surface.ts` parses the spec; `src/chat/SurfaceCard.tsx` draws it.

- **Inputs** (`field`, `choice_card`, `editable_text`, `map`, `comparison`) own
  a `key` and a `field`, and their values make up the answer. A required field
  must be filled; `false` for a bool counts as an answer, or a required
  checkbox could not be answered negatively.
- **Display** nodes (`text`, `kv`, `pip`, `meter`, `divider`, `diff_preview`,
  `dashboard`) are drawn because they are often the reason the question is
  being asked. `markdown` renders as plain text on purpose: a surface is
  untrusted structure from the model, and this client's Markdown path is for
  finished assistant answers.
- **Unknown kinds are skipped, not fatal** — the kernel may grow one, and a
  phone that cannot draw a card must still let the person answer the rest.
- **`button` nodes are shown, not pressed.** A button is an action the kernel
  validates against the spec's own action table, and this client's answer
  carries field values only. Wiring actions needs a route the kernel does not
  expose to a paired device; until then the label is drawn so the person sees
  what the form was for.
- A surface ask holds exactly one question (the kernel's `validateSurfaceAnswer`
  requires it), so `AskCard` renders the surface path and skips the option
  path entirely. `POST /answer` carries
  `{QuestionID, Selected: [], Value: {...}}`.
- An option question always ends with an "other" free-text option, even when
  the kernel offered none — that is what makes a question with no options
  answerable — and a single-choice pick keeps an optional note. Both are sent
  as ordinary selected strings (`[text]`, or `[label, note]`), which is what
  the desktop sends and the kernel joins untouched.

## Images

## Chat as a task record

The transcript is drawn as work, not as a chat log (`src/chat/process.ts`,
`src/chat/Activity.tsx`). A step is one line — icon, 深度思考 / 执行命令, one
line of the command, chevron — and its detail opens underneath. A tool's
thinking is lifted out of the card as its own step, so it is never shown twice.

- While a turn runs, its steps stay individual: that is when watching them is
  useful.
- A finished run of two or more steps collapses into one row whose title ranks
  the tool families (`读取、搜索、执行命令`) and whose tail keeps the count
  (`5 个操作`); its sheet draws the same steps as a timeline and expands one at a
  time.
- A single step stays a row even after the turn ends. An assistant row that
  only carried thinking contributes the step and no answer bubble.
- A thought longer than 900 characters opens the full sheet instead of growing
  an inline row.
- `src/chat/reading.ts` stores scroll offset and whether the person was following
  the newest row, keyed by the session path. ChatScreen restores it once the
  stored history is drawn, so reopening lands where they left instead of at the
  bottom; a screen that never finished reading keeps the old position rather
  than overwriting it with zero.

The composer is a floating card, as Qoder's phone client draws it: images as
numbered thumbnails inside the card, `+` opens 相机 / 图片 / 计划, the model
sits between them and the stop control, and the task checklist is a pill between
the transcript and the composer. 计划 calls `POST /rt/{id}/plan` through
`setPlanMode`, the same runtime setting the desktop toggles; its current state
comes from `/status`, never from a local switch. The header is a floating
capsule carrying the title, the host line and a `…` menu (reload history, pick
model).

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

Both limits are eased by the connection records in `src/net/savedConnections.ts`.
They are places, not credentials: a LAN origin or an account device id, the
label it was given, and when it last worked. Every successful connect records
one, the settings screen lists them with the current one marked (a tap switches,
the × forgets), and recovery tries every remembered LAN address before falling
back to the account. A LAN door is preferred even while a relay still answers —
back on the computer's Wi-Fi the relay is the slower path — but it is trusted
only after `/runtimes` answers through it. The proxy's own origin and candidates
are part of the same list, so an install that predates the records still gains
them on first boot.

The link itself is a state machine (`src/net/link.ts`, `src/app/useLink.ts`):
`connecting` reports which of 探测地址 → 切换上游 → 读取会话 is running,
`connected` only after `probeUpstream` answers `/runtimes`, and a failed attempt
either schedules a retry with 1–30 s full-jitter backoff (eight attempts) or
fails with a typed error. Authorization failures are not retried; network ones
are. A network change, the app returning to the foreground, and the Home retry
button are all `kick()`s: they cut a backoff wait short, and never start a
second machine. A manual switch from the saved list bumps a generation token so
a stale attempt cannot overwrite its result. ConnectScreen performs the same
`/runtimes` check before it calls `onConnected`, so saving an address is no
longer mistaken for connecting to a computer.

Home carries the link as a row under the title bar: dot + computer name + state
(`已连接` / `正在重连（第 n 次）` / `连接失败`). Tapping it opens 切换连接 with the
saved computers, the current marker, and the two actions that belong there —
重试连接 and 管理连接 (the settings screen).

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
code is present, ConnectScreen opens the share link through the `Pair` plugin,
which loads it in a hidden 2×2 WebView inside a translucent `PairActivity`.
The page's own `#pair=` bootstrap spends the code and stores
`reasonix_device`; `PairActivity` polls `CookieManager.getCookie(origin + "/")`
and returns `paired` when the cookie appears. ConnectScreen then saves the
origin without a code, and the proxy reuses that WebView cookie for
`/runtimes` and the rest. The user sees only a brief "正在配对…" card, not the
Studio page.

That page is not the only way in. If it reports no cookie — a timeout, a page
that never loaded, or a share page older than the bootstrap — ConnectScreen
falls back to the proxy's direct `POST /pair` and probes the origin. A code the
page already spent answers 403 there, so a successful probe is what proves its
cookie did land; a cancel from the person does not fall back. The direct
exchange copies its `Set-Cookie` into the WebView store, so that pairing
survives a restart; a failed adoption restores the previous LAN upstream
instead of leaving the phone on a computer it cannot read.

The code is still one-time: opening the link in a browser first spends it for
the app. A hidden pairing that never sees the cookie times out after 15 s, and
the direct exchange then decides rather than reporting a dead code.

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

### Safe-area padding has two sources, and the config picks one

`src/ui/{shell,chat,connect}.css`. Android `targetSdk 35+` draws the app
edge-to-edge, and Android WebView answers zeroes for `env(safe-area-inset-*)`
on many devices — the home title sat under the status-bar clock and the
composer on the gesture bar. Every such rule now reads
`max(env(safe-area-inset-top), var(--safe-area-inset-top, 0px))`: whichever
source reports a real inset wins, and the `max()` means the change is a no-op
where `env()` already worked.

The `--safe-area-inset-*` half is written by Capacitor's bundled `SystemBars`
plugin on each inset dispatch, and **only** while `insetsHandling` is `"css"`
— `SystemBars.injectSafeAreaCSS` returns early otherwise, with no error.
`capacitor.config.ts` therefore states `insetsHandling: "css"` explicitly even
though it is the 8.x default: Capacitor 9 plans to default it to `"native"`,
and a version bump alone would drop the variables and silently restore the
original bug on exactly the devices it was fixed for.

`initialViewportFitValueHint: "cover"` belongs to the same fix — without it the
plugin spends the first frames of a cold start assuming the page is *not*
`viewport-fit=cover` and pushes the whole page below the status bar before
correcting itself.

Both branches of the plugin are safe to combine with this CSS: the passthrough
branch pads the decor view with zero and injects the real values, and the
native-padding branch injects zeroes after padding natively, so `max()` never
double-counts.

Horizontal insets (`left`/`right`, a landscape notch) are **not** covered;
that gap predates this fix and no page pads for it yet.

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
  but scrolling under a finger, the software keyboard, rotation and tap targets
  are still hypotheses. The todo panel's collapsed row, 34 vh cap and sub-step
  indent are claims about CSS. Safe-area padding got a targeted fix (above)
  after a device drew the home title under the status-bar clock; whether that
  fix holds on the device that reported it has not been recorded, and
  horizontal insets are still unhandled.
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
  wake lock **and a Wi-Fi lock** and stops on `turn_done`; if the process dies
  the kernel keeps running and the cursor resumes it. The Wi-Fi lock exists
  because the proxy's upstream sleep with the screen; it covers Wi-Fi only —
  a cellular link is the battery-optimization setting's job.
- While that service runs, it polls the pane's `/status` every 3 s through the
  loopback proxy (the same per-install cookie the WebView holds). `AskStatus`
  reads the decisions; a changed signature posts one high-importance
  notification, an empty answer cancels it, and the tap opens
  `reasonix://chat?runtime=…` which `App` maps back to that chat. Only the pane
  the phone is running is watched — a session that lives only on the desktop
  has no service here, and no notification is claimed for it.
- Ask and done notifications are identified per runtime
  (`askId`/`doneId`, four non-overlapping bands of a million hash buckets). A
  fixed id let a second session overwrite the first, and a shared
  `PendingIntent` request code with `FLAG_UPDATE_CURRENT` rewrote an older
  notification's extras so it opened whichever chat was built last.
  `TurnServiceIdTest` holds the ranges apart.
- The ongoing notification names the path it was started with (`mode` from
  `LinkState`) and switches to “连接中断，正在重试…” after three consecutive
  failed polls, returning to normal on the first answer. One failure is noise.
- The settings page reports notification permission and battery-optimization
  exemption from `TurnPlugin.backgroundStatus`, and opens the matching system
  page. Values are reread on `appStateChange` because the person leaves the
  app to change them. The direct “request ignore optimizations” dialog is not
  used: it needs a restricted permission, and this app is sideloaded, not a
  Play listing to justify it.
- The release build enables R8. The keep rules cover Capacitor's reflective
  plugin bridge; a release without `keystore.properties` fails at
  `assembleRelease` instead of producing an uninstallable APK.

## Trust and input (2026-10-30)

- The composer ignores Enter while `isComposing` (or keyCode 229). A pinyin
  keyboard accepts a candidate with Enter; sending there ships half a word.
- A `/submit` that dies in transit is **unconfirmed**, not retryable. The
  kernel may have started the turn, so the screen says to refresh rather than
  offering a second POST. HTTP refusals keep their own retryability.
- Drafts are keyed like reading positions (`sessionPath`, pane id as fallback).
  A pane opened from a cold link may not know its path on the first render; the
  draft is migrated when it arrives, and both keys are cleared on send.
- `src/app/backStack.ts` holds open sheets. `App`'s `backButton` closes the top
  sheet before navigating or exiting; without it a back press under a model or
  attachment sheet left the screen.
- User bubbles use `--bubble-user` (#4a6be0, 4.7:1 with white) rather than the
  accent (3.1:1). The viewport asks for `interactive-widget=resizes-content`
  and `MainActivity` for `adjustResize`; still needs a device check.
- Release APKs are signed by a key kept outside the repo (see RELEASING.md).
  The workflow refuses to build without the four secrets and verifies the APK
  with `apksigner`. The first signed release needs one uninstall for phones
  that installed a debug-signed build.

## Performance pass (2026-10-31)

- The loopback proxy's accept loop has its own thread and the worker pool is
  `SynchronousQueue`-backed (8 core, 32 max). With the accept call on a pool
  thread, a core of four left three workers and the queue meant the pool never
  grew; two SSE streams could starve every other request.
- SSE upstream reads use a 25 s timeout instead of zero. A timeout writes a
  `: keepalive` chunk to the WebView; when the client is gone that write throws
  and the thread ends. Previously a closed WebView was not noticed until the
  kernel happened to send a frame, leaking one thread per reconnection.
- The turn service renews the 30-minute wake lock on every poll, so a long turn
  keeps the CPU after the first cap; `stopSelf(startId)` no longer stops a
  newer start when a foreground attempt is refused.
- `vite` no longer emits source maps into the APK (5 MB of maps), and
  `ChatScreen` is a lazy chunk: the entry bundle is 699 kB instead of 1.01 MB,
  with Markdown/highlight in a 329 kB chunk loaded on first chat.
- Relay event polling waits 3 s while idle instead of 1.5 s; every poll is a
  relay round trip. Cursor writes are throttled to 500 ms with a `pagehide`
  flush instead of one synchronous localStorage write per SSE frame.
- Not done: history pagination and virtualisation. A very long transcript is
  still read and rendered whole.

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
