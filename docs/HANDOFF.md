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

### The Android SDK is not installed

`ANDROID_HOME` is unset, `adb` is absent, there is no Android Studio. Milestones
1–4 run in a browser; milestone 5 (Capacitor) cannot start until the SDK is
installed. Do not try to `npx cap add android` before then.

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

### StrictMode is on in production

`src/app/main.tsx`. The double-invoked effects it causes are exactly the ones
that break a streaming view. Finding that in development is the point.

## Not verified — read this before claiming anything works

Be precise about this with whoever you report to.

- **Nothing has been seen rendered.** The Chrome relay extension is not
  connected, so no browser was ever opened against this app. Layout, scrolling,
  the software keyboard, safe areas and tap targets are written to mobile
  constraints but have never been looked at. Treat the CSS as a hypothesis.
- **`/answer` and `/approve` have never been called for real.** The handlers in
  `ChatScreen.tsx` post `{id, answers}` and `{id, allow, remember}`. Those
  bodies were inferred from `eventwire/ask.go` and `eventwire/approval.go`, not
  observed on the wire. Verify against a keyed kernel before trusting them.
- **The transcript fold is tested, the view is not.** 18 tests cover the fold;
  zero cover a component.

What *was* verified against a real kernel, through the Vite dev proxy: index
200, `POST /auth/token` → 204 + cookie, `GET /runtimes` → the open pane, SSE
connects, `POST /rt/r1/submit` → `provider.key_missing`.

## Where to go next

`docs/PLAN.md` lists milestones 3–5. My own read, in priority order:

1. **Look at it on a phone.** Everything else is building on unseen CSS.
   `http://<lan-ip>:5274/#token=<token>`.
2. **Verify `/answer` and `/approve`** against a keyed kernel. Two curl calls
   against a real prompt settle the body shape.
3. **Todos** (`todo_progress`) — the payload is at `eventwire/wire.go`,
   `TodoProgress`.
4. **Capacitor packaging** — needs the SDK first.

## The contract rule

The phone and the desktop update on different schedules. The wire contract only
grows: fields and event kinds are added, never renamed or removed. The client
ignores what it does not know. There is a test asserting an unknown kind is
ignored and returns the same transcript object — keep it.
