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
`src/net/submit.ts` (send as a state machine), `src/app/SessionList.tsx`,
`src/app/App.tsx` (one connection, one navigation state), `src/ui/chat.css`.

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