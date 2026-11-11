# 自建中继：服务端

[English](README.md)

三份文件，一条不变量：**证书留在拥有内核的那台机器上，服务器只搬字节。**

```
手机 ──TLS──▶ 服务器:8443 (frps, tcp) ──隧道──▶ frpc ──▶ Caddy:8443 ──▶ Studio:8791
```

只要服务器终结了 TLS，它就能读到每一段对话。`frpc.toml` 里的 `type = "tcp"`
就是防这件事的；写成 `type = "http"` 会让 frps 解析请求，整套安排就白做了。

## 三份文件

| 文件 | 跑在哪 | 干什么 |
|---|---|---|
| `frps.toml.example` | 服务器 | 接受一条隧道，开一个端口，不解析任何东西 |
| `frpc.toml.example` | 有 Studio 的机器 | 主动拨出，把 Caddy 的回环端口暴露出去 |
| `Caddyfile.example` | 有 Studio 的机器 | 终结 TLS、持有证书、反代到内核 |

证书走 DNS-01 验证，所以服务器不用开 80 端口，域名也不需要解析到家里。

## 开工前

1. 一个你能改 DNS 的域名。Cloudflare 最省事。
2. 两台机器都装 `frp`，版本一致。
3. 带 DNS 插件的 Caddy。原版二进制没有 `dns cloudflare` 指令：

   ```sh
   xcaddy build --with github.com/caddy-dns/cloudflare
   ```

4. Studio 只监听回环，并且用固定 token：

   ```sh
   printf '%s' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" \
     > ~/.reasonix/relay.token
   reasonix serve --addr 127.0.0.1:8791 --auth token \
     --token-file ~/.reasonix/relay.token --no-open
   ```

   `--token-file` 是**读**不是写。路径不存在会让 `serve` 直接启动失败。不传的话
   每次重启都换一个新 token，手机里存的门就失效了。

   **不要**加 `--behind-proxy`：它会把 cookie 标成 `Secure`，而手机侧的代理是用
   明文 HTTP 连回环上游的，加了反而回传不回来。

## 验证

```sh
./verify-sse.sh https://<中继域名>:8443 <token>
```

脚本先打印服务器出示的证书，再把事件流挂 25 秒。两件事必须成立：

- 证书的 subject 是**你自己的**域名、issuer 是公共 CA —— 证明服务器没有终结 TLS；
- 流是持续跳动的（每 15 秒一次 `: ping`），不是一次性涌出来 —— 证明链路上没有
  东西在缓冲。

第一条是这个方案安全性的唯一可验证证据。配置写得再对，也不如这一条输出。

## token 意味着什么

内核把 launch token 当作**宿主自己的凭据**，不是配对设备的凭据。

这样连进来的手机，能碰到内核平时对配对设备隐藏的路由：`POST /changes/discard`、
`GET/POST /git/push`、以及全部终端路由。App 目前不渲染这些按钮，所以实际表现是
「有权限、没入口」。

但安全模型确实变了：**请把 token 当成这台机器的密码，而不是配对码。** 配对码泄露
最多是多一台设备，token 泄露是整台机器。

## 排错

| 现象 | 多半是 |
|---|---|
| `401` | token 填错，或者 `serve` 重启换了新 token |
| `502` / 连不上 | frpc 没连上，或 Caddy 没起在 8443 |
| 证书 subject 是别人的域名 | 请求没走到你的中继，中间有东西在冒充 |
| 事件流一次性涌出然后断 | 链路上有东西在缓冲（`type = "http"`，或前面多了一层反代） |
