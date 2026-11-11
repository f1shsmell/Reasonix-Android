# 自建中继：部署实例

[English](DEPLOY.md)

一台 Linux VPS、一台跑 Studio 的 Windows 机器、一部装了 App 的手机。

分两个阶段。**阶段 1 不需要域名**，半小时能验证链路通不通；阶段 2 再加 TLS。

> 阶段 1 是明文的：token 和对话内容在公网上裸奔。它只用来回答"通不通"，
> 验证完就往下走，别长期这么跑。

---

## 阶段 1 · 明文跑通

### 1.1 服务器

以下按 Ubuntu / Debian 写。CentOS 把 `apt` 换成 `dnf` 即可。

```bash
# frp 当前版本 v0.72.0（2026-11-04）；去 releases 页面确认最新的再替换
curl -LO https://github.com/fatedier/frp/releases/download/v0.72.0/frp_0.72.0_linux_amd64.tar.gz
tar xzf frp_0.72.0_linux_amd64.tar.gz
sudo mv frp_0.72.0_linux_amd64/frps /usr/local/bin/
```

```bash
sudo mkdir -p /etc/frp
TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')
sudo tee /etc/frp/frps.toml >/dev/null <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "$TOKEN"
allowPorts = [{ start = 8443, end = 8443 }]
transport.tls.force = true
webServer.addr = "127.0.0.1"
webServer.port = 7500
EOF
echo "家里要用的 frp token：$TOKEN"
```

```bash
sudo tee /etc/systemd/system/frps.service >/dev/null <<'EOF'
[Unit]
Description=frps
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now frps
systemctl status frps --no-pager
```

**云厂商的安全组要单独放行 7000 和 8443。** `ufw` 只管系统防火墙，
安全组在控制台里，两边都开才通。

### 1.2 家里的 Windows

下载 `frp_0.72.0_windows_amd64.zip`，解压到 `C:\frp\`。

`C:\frp\frpc.toml`：

```toml
serverAddr = "<服务器 IP>"
serverPort = 7000
auth.method = "token"
auth.token = "<上面那个 frp token>"

# 服务器还没起来时不要退出，否则 systemd / NSSM 会以为它在崩溃重启
loginFailExit = false
transport.heartbeatInterval = 10
transport.heartbeatTimeout = 30

[[proxies]]
name = "studio"
# 必须是 tcp。写 http 会让 frps 解析请求，TLS 就白做了。
type = "tcp"
localIP = "127.0.0.1"
localPort = 8791
remotePort = 8443
```

阶段 1 里 `localPort` 直接指 Studio 的 8791；阶段 2 会改成 Caddy 的 8443。

先手动跑一次，看日志里有没有连上：

```powershell
C:\frp\frpc.exe -c C:\frp\frpc.toml
```

### 1.3 起 Studio

```powershell
$tok = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
New-Item -ItemType Directory -Force "$env:USERPROFILE\.reasonix" | Out-Null
Set-Content -NoNewline "$env:USERPROFILE\.reasonix\relay.token" $tok
Write-Host "启动令牌：$tok"

reasonix serve --addr 127.0.0.1:8791 --auth token `
  --token-file "$env:USERPROFILE\.reasonix\relay.token" --no-open
```

`--token-file` 是**读**不是写。路径不存在会让 `serve` 直接启动失败；不传的话
每次重启都换一个新 token，手机里存的门就失效了。

**不要**加 `--behind-proxy`：它会把 cookie 标成 `Secure`，而手机侧的代理是拿
明文 HTTP 连回环上游的，加了反而回传不回来。

### 1.4 手机连接

App → 设置 → 连接 → 手动填写地址：

- **服务器地址**：`http://<服务器 IP>:8443`
- **启动令牌**：上面打印的那个

点「连接这台电脑」。配对码留空——那是局域网门用的，自建中继用令牌。

### 1.5 验证

```bash
./verify-sse.sh http://<服务器 IP>:8443 <启动令牌>
```

期望看到 `GET /runtimes -> 200`，然后事件流里 `: ping` 每隔约 15 秒跳一次。

---

## 阶段 2 · 加 TLS

### 2.1 域名

一个 A 记录指向服务器 IP。证书用 DNS-01 签，所以不需要开 80 端口。

### 2.2 Caddy

需要带 DNS 插件的版本，原版二进制没有 `dns cloudflare` 指令。在
[caddyserver.com/download](https://caddyserver.com/download) 勾选
`caddy-dns/cloudflare`，选 windows amd64 下载。

`C:\caddy\Caddyfile`：

```
{
	email <你的邮箱>
}

<中继域名>:8443 {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8791
}
```

```powershell
$env:CF_API_TOKEN = "<Cloudflare API Token>"
C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
```

### 2.3 把 frpc 指向 Caddy

`frpc.toml` 只改一行：

```toml
localPort = 8443
```

重启 frpc。

### 2.4 手机改地址

`https://<中继域名>:8443`，令牌不变。

### 2.5 验证

```bash
./verify-sse.sh https://<中继域名>:8443 <启动令牌>
```

脚本会先打印证书的 subject 和 issuer。**subject 必须是你的域名、issuer 是公共
CA** —— 这是"服务器没有终结 TLS"的唯一可验证证据。证书对了，服务器就是哑管道。

---

## 常驻

服务器侧 systemd 已经配好。

家里三个进程（frpc、Caddy、serve）用 NSSM 注册成服务：

```powershell
nssm install frpc  C:\frp\frpc.exe   -c C:\frp\frpc.toml
nssm install caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
nssm install studio C:\Users\<你>\AppData\Roaming\npm\reasonix.cmd serve --addr 127.0.0.1:8791 --auth token --token-file C:\Users\<你>\.reasonix\relay.token --no-open
nssm start frpc & nssm start caddy & nssm start studio
```

不要用任务计划程序：控制台程序退出后它不会拉起，而 NSSM 会。

---

## 排错

| 现象 | 多半是 |
|---|---|
| `401` | 启动令牌填错，或 `serve` 重启换了新 token |
| `502` / 连不上 | frpc 没连上，或 Caddy 没起在 8443，或安全组没开端口 |
| `systemctl` 显示 running 但外面连不上 | 云厂商安全组没放行 |
| 证书 subject 是别人的域名 | 请求没走到你的中继，中间有东西在冒充 |
| 事件流一次性涌出然后断 | 链路上有东西在缓冲（`type = "http"`，或前面多了一层反代） |
| 连上了但列表是空的 | `serve` 没带 `--dir`，或那个目录没有会话 |

---

## 合规与风险

分两层看，别混在一起。

**合法性没问题。** 手机访问自己家里的开发机，自用、不对外提供服务。它和"翻墙"
是两回事，只是形式上（境外 VPS + 加密隧道 + 非标端口）有点像，容易被误判。

**合规性看服务器放在哪。**

| 位置 | 备案 | 被封风险 |
|---|---|---|
| 境内 VPS | 严格讲需要 ICP 备案 | 中：非标端口低，80/443 高 |
| 香港 / 境外 VPS | 不需要 | 低：不会被备案卡，但可能被 QoS |
| 家宽直连 | 不需要 | 低，但运营商封入站 80/443 |

会被什么盯上：

1. **备案检测**——境内厂商主要扫 80/443 的 Host 头和 TLS 的 SNI。用 8443
   基本不在扫描范围，这是非标端口最实际的价值。
2. **SNI 阻断**——TLS 握手里的域名是明文的。未备案域名 + 境内 IP，部分省份会拦。
   用 IP 直连就没有 SNI，这条直接消失。
3. **厂商 ToS**——多数境内厂商禁止"未备案建站"和"代理服务"。个人小流量通常不管，
   但被投诉或巡检发现可能停机。这比监管更现实。
4. **流量特征**——frp 的 TCP 隧道就是普通 TLS，没有明显指纹；长期跑满会触发 QoS。

降风险，按效果排：

1. **IP 直连 + IP 证书，完全不用域名**——没有 SNI、没有备案主体。Let's Encrypt
   2026 年起支持 IP 证书。
2. **非标端口**（8443 已经满足）。
3. **选香港 / 境外小厂**，绕开备案这一层。
4. 流量控制在个人用量。

**如果合规是硬约束，Tailscale 比自建中继干净。** 它不对外提供任何"互联网信息
服务"：没有域名、没有备案主体、没有对外开放的端口。代价是 Android 上占一个
VPN 槽，控制面在境外。

本文是工程层面的判断，不是法律意见。真要确认，问 VPS 厂商客服"个人自用远程
访问是否需要备案"，他们的回答比任何分析都准。
