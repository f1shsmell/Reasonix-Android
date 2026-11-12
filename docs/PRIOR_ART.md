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

## 2026-11-12 复核：herdr 成了平台，上面的结论反而更硬

上一轮（2026-10-29）漏了最大的一块。**herdr 现在是这个领域的运行时层**，
而 collie / ovis 都只是它上面的客户端。

| 仓库 | Stars | 定位 | 创建 |
|---|---|---|---|
| `herdrdev/herdr` | **50,260** | 所有 coding agent 的运行时，Rust 单二进制 | 2026-03 |
| `herdrdev/herdr-app` | 2,723 | 官方桌面端 | 2026-10 |
| `devswha/ovis` | 2,023 | 浏览器 / 手机客户端 | 2026-09 |
| `AltanS/collie` | 1,635 | 手机 PWA | 2026-06 |
| `eliasstravik/shepherdr` | 1,125 | 手机上跨机器跑多个 agent | 2026-09 |

上一轮记的 collie 1495、ovis 1608，一个月各涨了一成多。

### 平台层已被占住

herdr 的原话是 *"herdr doesn't wrap or replace them; it owns their terminals."*
它走 **PTY，不走 ACP**——整个仓库没有 ACP 一个字。它的资产是 libghostty-vt 加
从终端输出推断出的三态（working / blocked / idle），对外只暴露一个本地 socket API。

所以「一个客户端连所有 agent」这件事的答案是**把 agent 当终端**，不是当 API。
agent 的语义永远统一不了，终端是唯一公约数。Collie 把这层抽象写成了
`MUX_CONTRACT.md`，herdr / herdr-core / tmux / zellij 收敛成同一套
pane + keys + snapshot。

### 但这也证明了本文的主张

上面「不要用渲染屏幕做聊天」那一节，现在有了规模化的证据：**所有通用客户端都
只能抓终端，因为它们的 agent 不提供结构化事件流。**

Collie 自己的 `ARCHITECTURE.md` 承认了这个天花板——alternate screen 没有
scrollback、超过 30 行的框读不出、超过 8 行的消息发不出去。

Reasonix 内核提供 `/rt/{id}/events` 的类型化 SSE，这条限制对本项目不存在。
**通用客户端做不到结构化，只能做终端；能做结构化，恰恰因为它只服务一个内核。**

### 另一个共同选择：Tailscale

collie 和 shepherdr 都用 `tailscale serve`，都明确拒绝 `tailscale funnel`：

> Never `tailscale funnel` this. `funnel` exposes the port to the public
> internet, whereas `serve` limits access to your private tailnet.

这意味着两者的安装成本都是：常开电脑 + 两端装 Tailscale + 跑一个 bridge 守护进程
+ `tailscale serve` + 配对。**没有一个方案做到「装个 App 扫码就用」。**

### 对本项目的含义

独特性按强度排：

1. **结构化事件流**——通用客户端在架构上做不到（见上）。
2. **零基础设施**——装 APK 扫码，不需要 VPN、不需要额外守护进程。
3. **官方账号打通 + 局域网/云端自动切换**——依附 Studio 的账号体系。

第 1 条是技术护城河，第 2 条是体验护城河，第 3 条是身份护城河，但它同时也是
枷锁：它把远程能力绑在 `remote.reasonix.io` 上，而那个中继又慢又不稳。

**所以这个项目该做的不是变成通用客户端，而是保住 1 和 2、解开 3。**
自建 relay 的全部意义就在这里——不是增加功能，是让「零配置入口」不再受官方
中继的性能限制。
