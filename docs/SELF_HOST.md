# 自建接入：决策记录

记录日期 2026-10-29。回答的问题是：Reasonix 走账号登录的互联网中继又慢又不稳，
能不能自建，选哪条路，代价多少。

**结论：走 Cloudflare Tunnel 把 Studio 直接暴露成 https 源站，手机不再经过
`remote.reasonix.io`。** 自建 relay 可行但不推荐，理由见下文。

本文只记录决策和可执行步骤。改动尚未实施，验证清单里的每一项都还没跑过。

## 问题拆成两半

"慢"和"不稳定"是两件不同的事，混在一起会选错方案。

**不稳定**来自中继链路本身：手机 → `remote.reasonix.io` → Studio，任何一段抖动
都会断开，而且 `RelayLink.lost()`（`src/net/relay.ts:497`）会主动 fail 掉所有
非 GET 请求——写操作丢了就是丢了，只能靠人重试。

**慢**不来自中继的物理距离，来自协议模型：

```ts
// Reasonix-Android/src/net/relay.ts:651
await new Promise((resolve) => setTimeout(resolve, active ? 200 : 1500));
```

relay 通道用轮询模拟 SSE。有数据时 200 ms 一轮，空闲时 1500 ms 一轮，每一轮
都是一次完整的加密请求-响应往返。**换一个再近的中继也改不掉这 200 ms 的下限。**

所以自建中继能改善的是可控性和抖动，改善不了延迟模型。要真正快，只能让手机走
真 SSE 直连。

## 为什么不走自建 relay

技术上完全可行，协议是公开的：

- 设备侧 `GET /v1/devices/{id}/connect`，Bearer deviceCredential
- 控制器侧 `GET /v1/sessions/connect`，subprotocol `reasonix.remote.v1` +
  `reasonix.auth.<ticket>`
- 消息只有 `controller_connected` / `controller_message` /
  `controller_disconnected` / `relay_hello` 四种
- 单条上限 64 KiB（`internal/platform/remotecloud/host.go` 的 `writeDirected`）
- 中继只读 `to` / `payload`，内容经 X25519 + HKDF + AES-GCM 密封，中继看不到明文
- `tools/relayfake/main.go` 是一份 300 行、可运行的骨架，同时扮演 accounts 和 relay

但要走这条路，**accounts 服务也得一起自建**，因为 grant 是它签发的：
`POST /me/devices`、`GET /me/devices`、`POST /me/remote-grants`（返回
`{grant:{ticket}, device, relay}`）、`/device/start`、`/device/poll`。

代价是 2–3 天开发，外加一台服务器，换回来的仍是 200 ms 轮询。**除非你需要多人
多设备共享，否则性价比最低。**

## 选定的链路

```
手机 App
  └─ WebView → http://127.0.0.1:8788（LoopbackProxy，APK 里的 bundle）
       └─ 转发 → https://rx.example.com（Cloudflare 边缘，TLS 终止）
            └─ cloudflared（出站隧道）
                 └─ http://127.0.0.1:8791（reasonix serve）
```

关键点：

- Studio 仍然**只监听 loopback**，不暴露到局域网，也不需要开放入站端口。
- cloudflared 主动出站建隧道，NAT 后面和动态 IP 都能用。
- 手机拿到的是真 SSE，不是轮询。

`LoopbackProxy` 用 `HttpURLConnection`（`LoopbackProxy.java:449`），
`https` 上游天然支持，不受 WebView mixed-content 限制——`capacitor.config.ts`
里的 `allowMixedContent` 只影响 WebView 自己的请求。

## 前置条件

- 一个域名，托管在 Cloudflare（NS 指过去即可，免费套餐够用）
- 本机装 `cloudflared`
- Android SDK 环境（要重新打包 APK 的话），或先只用手机浏览器验证

## 步骤

### 第 0 步：不改代码，先用手机浏览器验证（建议先做）

这一步能在投入改动前判断 A 路线到底值不值。手机浏览器直接打开公网地址，
走的是内核自己的 token 引导，完全绕开 App。

```powershell
# 起 Studio，只监听 loopback；--public-url 让打印出来的链接指向公网地址。
# 不传 --token-file：serve 会自己生成 token，并把它的路径打印在 "share:" 一行。
reasonix serve --addr 127.0.0.1:8791 --auth token `
  --public-url https://rx.example.com --no-open

# 另开一个终端
cloudflared tunnel --url http://127.0.0.1:8791
```

quick tunnel 会打印一个 `https://<随机>.trycloudflare.com` 地址。先用它验证链路，
再决定是否绑自己的域名。

手机浏览器打开 `https://<地址>/#token=<token>`。token 从 serve 打印的
`share: ... (token in <路径>)` 里那个文件读。fragment 会被
`src/net/token.ts` 换成 HttpOnly cookie 并从 URL 抹掉。

注意 `--token-file` 是**读**（`internal/frontend/cli/serve_files.go:19` 的
`readServeTokenFile`），不是写；传一个不存在的路径会让 serve 直接启动失败。
要么不传让它自己生成，要么先把 token 写进那个文件。

**如果这一步就卡住，先别改 App。**

### 第 1 步：绑定自己的域名（named tunnel）

quick tunnel 的域名每次重启都变，长期用要建 named tunnel。

```powershell
cloudflared tunnel login
cloudflared tunnel create reasonix
cloudflared tunnel route dns reasonix rx.example.com
```

`~/.cloudflared/config.yml`：

```yaml
tunnel: <上一步打印的 UUID>
credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json

ingress:
  - hostname: rx.example.com
    service: http://127.0.0.1:8791
  - service: http_status:404
```

```powershell
cloudflared tunnel run reasonix
```

装成服务（`cloudflared service install`）可以让它开机自启，但调试阶段先手工跑，
日志看得见。

### 第 2 步：让 App 走公网地址

这一步需要改代码，见下一节。改完之后的用法：

```powershell
npm run build
node ./node_modules/@capacitor/cli/bin/capacitor sync android
cd android; ./gradlew assembleDebug
```

App 里在连接页填 `https://rx.example.com`，token 一并填进去。

## 改动量

**上一轮口头说的"0 行代码"是错的，这里更正。** 原因是 `LoopbackProxy` 只认
`/pair` 和账号 token，没有内核 token 的概念：

- `parseServerLink()`（`src/net/server.ts:169`）对 `https://rx/#token=xxx`
  只返回 `{kind:"lan", origin}`，token 被丢掉；
- WebView 的 origin 是 `127.0.0.1:8788`，`bootstrap()` 读的是这个 origin 的
  fragment，扫码得来的 fragment 到不了它；
- 内核的 `/pair` 只存在于 `DeviceShare` 的局域网监听上
  （`internal/frontend/serve/device_gate.go:17`），主 serve 端口没有这个路由。
  所以"扫码配对"这条路对公网地址不成立，`LoopbackProxy` 会拿到
  `device.pair_route_missing`。

最小改动是给 `LoopbackProxy` 加 token 透传，三处：

| 文件 | 改动 | 估计 |
|---|---|---|
| `android/.../LoopbackProxy.java` | `KEY_TOKEN` 偏好；`configure` 接受 `token` 字段；`forward` 与 `probe` 加 `Authorization: Bearer` | ~25 行 |
| `src/net/server.ts` | `configureProxy(origin, pairCode?, token?)` | ~5 行 |
| `src/app/ConnectScreen.tsx` | 地址框下面加一个 token 输入框 | ~20 行 |

内核侧**不需要改**：`authGate.presentsLaunchToken` 已经接受
`Authorization: Bearer <token>`（`internal/frontend/serve/launch_token.go:37`），
`csrfGuard` 只检查 `Content-Type`，代理转发时保持 JSON 即可。

也可以只改 `parseServerLink` 让它认 `#token=`，但那样 token 会进
`configureProxy` 的请求体，不如直接存 prefs 干净。

## 验证清单

每一项都还没跑过，按顺序做：

1. `curl -N https://rx.example.com/rt/<id>/events` 能持续收到
   `: ping`（内核 15 s 一次），说明 Cloudflare 没有缓冲 SSE。
2. 手机浏览器第 0 步能进会话列表并发出一个 turn。
3. App 改完后能连上，`/runtimes` 返回 200 而不是 401。
4. 断网 10 s 再恢复，`RuntimeStream` 用 `Last-Event-ID` 续传，不丢帧。
5. 切到移动网络（换 IP）后还能重连——这是 Cloudflare 相对中继最直接的优势。
6. 连续挂 30 min，看是否被 Cloudflare 的空闲超时切断。

## 成本

| 项 | 费用 |
|---|---|
| Cloudflare Tunnel | 免费（不限带宽，Zero Trust 免费版 50 用户） |
| 域名 | ¥60–80/年 |
| 服务器 | ¥0（跑在自己机器上） |
| 开发 | 半天（含打包和真机验证） |

对比自建 relay：同样的服务器成本，多 2–3 天开发，且性能仍是轮询。

## 未验证与风险

- **Cloudflare 对 SSE 的缓冲行为**是这条路线最大的不确定项。免费版历史上对
  `text/event-stream` 有过缓冲和 100 s 空闲超时。内核心跳 15 s 应该够，但必须用
  第 1 条验证。
- **`--behind-proxy` 先不要加。** 它只做两件事：让 `hostGuard` 信任
  `X-Forwarded-For`（token 模式下 `hostGuard` 本就不生效），以及让
  `authGate.isTLS()` 信任 `X-Forwarded-Proto`、从而给 cookie 加 `Secure`
  （`internal/frontend/serve/auth.go:497,669`）。Studio 监听 `127.0.0.1` 时
  `isTLS` 本来就是 false，cookie 不带 `Secure`，`LoopbackProxy` 的
  `HttpURLConnection` 上游正好能用。加了反而把 cookie 变成 `Secure`，而
  `java.net.CookieManager` 在 `http` 请求上是否回传它没有验证过。**这条不改
  才对，不是"加了更好"。**
- **`--public-url` 不改变绑定地址**，只影响分享链接和 `AllowHost`
  （`internal/frontend/cli/serve_frontend.go:152,174`）。而 `hostGuard` 只在
  `auth none` 下生效（`internal/frontend/serve/host_guard.go:99`），token 模式下
  不起作用。所以它在这里的作用只有"打印正确地址"。
- **Cloudflare 免费版不能代理非标准端口**，但这条链路里公网只走 443，入站到
  `127.0.0.1:8791` 是隧道内部的事，不受限制。
- **token 存在 App 的 SharedPreferences 里**，不是加密存储。和现在的账号 token
  同等保护级别，不引入新的弱点，但也不比现在更好。
- **域名如果被 Cloudflare 的免费套餐限速**，`/rt/*/events` 的长连接会计入并发
  连接数。单人使用远低于任何阈值。

## 回滚

删掉 cloudflared 服务、把 App 的连接地址改回局域网 IP 即可。Studio 侧没有任何
改动，`REASONIX_ACCOUNTS_URL` / `REASONIX_REMOTE_URL` 也没动，原有的账号中继
路径继续可用。

## 如果 A 失败

退到 VPS + Caddy 反代。命令形状一样（`--public-url` + `--behind-proxy`），只是
把 Cloudflare 换成自己的机器，SSE 缓冲完全可控。国内 VPS 需要备案，海外
（RackNerd / Hetzner）不需要但延迟 100–200 ms。

`RelayEventSource` 的 200 ms 轮询是独立的技术债，不影响 A/B 路线，但会让 C 路线
一直慢。
