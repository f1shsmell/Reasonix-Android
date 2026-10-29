# Prior art: phone clients for desktop coding agents

Surveyed 2026-10-29. This is the reference set a native Android client for
Reasonix Studio should be read against.

## The uncomfortable headline

Native Android clients in this space have single-digit stars. Web-based and
WebView-shell clients have thousands. Whether that means "nobody tried" or
"people tried and it did not take" is not settled by a star count, but it is
the first thing to know before spending months on the native path.

## Native Kotlin clients (directly comparable)

| Repo | Stars | Notes |
|---|---|---|
| `hiylo/starburst` | 8 | Compose + Material 3, OpenCode protocol. Enormous feature list: offline MNN ASR, git page, theme system, task center. |
| `soul99soul-glitch/opencode-android` | 7 | Compose + SSE streaming. Clearest "not ready" list of the set. |
| `VeryBigSad/pi-app` | 2 | Native Android + a Mac bridge. |
| `pydantick/clawnest` | 2 | Native Android, SSH to a VPS. |

### The honest limitation list

`opencode-android` README, "What is not ready", verbatim:

> - Bundled Local mode outside arm64 test devices
> - Production-grade background survival for the local runtime on aggressive OEM Android builds
> - A dependable Termux handoff flow
> - Reliable SSE reconnection across network changes and Android background limits
> - Signed releases and automatic updates
> - Broad automated test coverage

The middle two are the real cost of this project type. A desktop client is
always online; a phone client is interrupted constantly and has to say what it
does not know.

## Architecture reference: happier (⭐2088)

`happier-dev/happier`. Expo + React Native, one codebase to iOS, Android, web
and Tauri desktop. ~1.85M non-test LOC, 9533 files in `apps/ui`, 181 routes,
2268 files under `components/sessions`.

Design doctrine from its `DESIGN.md`, worth adopting as written:

> "Mobile is as important as desktop and web. Equal importance does not require
> identical layouts."

> "**Mobile is not miniature desktop.** Recompose around touch, thumb reach,
> safe areas, software keyboards, narrow widths, rotation, and interrupted use."

It is a full client, not a thin remote: the phone renders streaming transcripts
with grouped tool calls and syntax-highlighted diff review. The cost is visible
in the shape of the repo — a 1.77M-LOC UI against a 72k-LOC server.

## Anti-pattern: screen scraping (collie, ⭐1495)

`AltanS/collie` drives the agent by reading the terminal with
`tmux capture-pane` and pattern-matching prompts out of the pixels-as-text.
Its own `ARCHITECTURE.md` explains why the approach has a ceiling:

> "An agent's TUI runs on the *alternate screen* (`ESC[?1049h`), so the emulator
> keeps no scrollback ring and a grid read can never return more than the
> visible viewport — the live mirror physically cannot scroll back past it."

Per-agent screen grammars then produce a long list of hard failures: a box
taller than 30 rows cannot be read; a message longer than 8 rows cannot be read
back so the send is refused; two windows of the same agent in one folder cannot
be told apart.

**Do not build chat on the rendered screen.** Reasonix already exposes a
structured event stream; parsing a terminal to recover what the kernel already
told you is a self-inflicted maintenance tail.

## Correct architecture: transcript + PTY as two feeds (ovis, ⭐1608)

`devswha/ovis` separates the two sources: chat reads the agent's own session
file, terminal is a real PTY over WebSocket with xterm.js. Its PTY sidecar
(`crates/pty-sidecar`, Rust, small) is a clean design to copy: newline-delimited
JSON control frames on stdin (`i` input, `r` resize, `p` pause, `w` SIGWINCH),
PTY bytes on stdout, own process group, `PR_SET_PDEATHSIG`, bounded stdin.

It also states the trust contract this project should adopt:

> "Input typed while disconnected waits as a draft for you to send or discard."
> "A typed answer that picks an option of an approval, plan or menu waits for
> **Confirm**."
> "A reload or reconnect never resumes that: the saved copy of such a message
> comes back marked not confirmed, to copy or discard after checking the
> terminal."

## The warning that decides the architecture

Ovis chose to have the PC serve the UI, and says plainly what that costs.
`docs/native-app.md`:

> "bundling the UI in the app is off the table while the PC serves it."
> "The UI and the server ship together, so they never disagree on the wire
> contract."

Consequence: the app can never be updated independently of the desktop, and a
version skew is a broken client.

A native client takes the opposite obligation: **own the wire contract, and let
it only grow.** Fields are added, never renamed or removed. The phone will
routinely be months behind the desktop, and the client that assumes otherwise
breaks in the field where nobody is watching.

## Three things to take, one to refuse

Take from ovis: two feeds over one session; a real PTY; the draft/unconfirmed/
confirm trust contract; per-device pairing with live revocation.

Take from collie: the keys board for driving a TUI from a phone; ordering the
dashboard by "which agent needs me"; prompts as tappable buttons rather than
transcription; modelling "did the send land?" as a first-class UI state.

Take from happier: the design doctrine that a phone layout is a recomposition,
not a shrink.

Refuse: rendering chat from a terminal mirror. Reasonix has a structured event
stream — use it.
