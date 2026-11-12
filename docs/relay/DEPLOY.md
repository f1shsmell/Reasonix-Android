# Self-hosted relay: a worked deployment

[中文](DEPLOY.zh-CN.md)

One Linux VPS, one Windows machine running Studio, one phone with the app.

Two stages. **Stage 1 needs no domain** and takes about half an hour to answer
"does this work at all"; stage 2 adds TLS.

> Stage 1 is plaintext: the token and every conversation cross the internet in
> the clear. It exists to prove the path, not to be lived in. Move on once it
> answers.

---

## Stage 1 · prove the path

### 1.1 The server

Ubuntu / Debian below; swap `apt` for `dnf` on CentOS.

```bash
# frp is v0.72.0 as of 2026-11-04 — check the releases page and substitute.
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
echo "frp token for the house: $TOKEN"
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

**Open 7000 and 8443 in the provider's security group as well.** `ufw` only
covers the host firewall; the console-side group is a separate door and both
have to be open.

### 1.2 The Windows machine

Download `frp_0.72.0_windows_amd64.zip` and unpack it to `C:\frp\`.

`C:\frp\frpc.toml`:

```toml
serverAddr = "<server address>"
serverPort = 7000
auth.method = "token"
auth.token = "<the frp token>"

# Do not exit while the server is down, or the service manager reads a missing
# server as a crash loop.
loginFailExit = false
transport.heartbeatInterval = 10
transport.heartbeatTimeout = 30

[[proxies]]
name = "studio"
# tcp, never http: an http proxy parses the request and the TLS in front of it
# becomes pointless.
type = "tcp"
localIP = "127.0.0.1"
localPort = 8791
remotePort = 8443
```

`localPort` points at Studio's 8791 in stage 1; stage 2 moves it to Caddy's 8443.

Run it once by hand and watch the log:

```powershell
C:\frp\frpc.exe -c C:\frp\frpc.toml
```

### 1.3 Start Studio

```powershell
$tok = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
New-Item -ItemType Directory -Force "$env:USERPROFILE\.reasonix" | Out-Null
Set-Content -NoNewline "$env:USERPROFILE\.reasonix\relay.token" $tok
Write-Host "launch token: $tok"

reasonix serve --addr 127.0.0.1:8791 --auth token `
  --token-file "$env:USERPROFILE\.reasonix\relay.token" --no-open
```

`--token-file` is **read**, not written. A path that does not exist makes
`serve` fail at startup; without it, every restart mints a new token and the
phone's saved door stops working.

Do **not** add `--behind-proxy`: it marks the cookie `Secure`, and the phone's
proxy speaks plain HTTP to the loopback upstream.

### 1.4 Connect the phone

Settings → Connection → enter an address by hand:

- **Server address**: `http://<server address>:8443`
- **Launch token**: the one printed above

Tap "连接这台电脑". Leave the pair code empty — that is the LAN door's
credential; a relay door uses the token.

### 1.5 Verify

```bash
./verify-sse.sh http://<server address>:8443 <launch token>
```

Expect `GET /runtimes -> 200`, then a `: ping` roughly every 15 seconds on the
event stream.

---

## Stage 2 · add TLS

### 2.1 A name

One A record pointing at the server. The certificate is obtained with a DNS-01
challenge, so port 80 never has to be open.

### 2.2 Caddy

You need a build with the DNS plugin; the stock binary has no `dns cloudflare`
directive. Pick `caddy-dns/cloudflare` at
[caddyserver.com/download](https://caddyserver.com/download) and take the
windows amd64 build.

`C:\caddy\Caddyfile`:

```
{
	email <you@example.com>
}

<relay host>:8443 {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:8791
}
```

```powershell
$env:CF_API_TOKEN = "<Cloudflare API token>"
C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
```

### 2.3 Point frpc at Caddy

One line in `frpc.toml`:

```toml
localPort = 8443
```

Restart frpc.

### 2.4 Point the phone at the name

`https://<relay host>:8443`, same token.

### 2.5 Verify

```bash
./verify-sse.sh https://<relay host>:8443 <launch token>
```

The script prints the certificate's subject and issuer first. **The subject must
be your host and the issuer a public CA** — that is the only verifiable evidence
that the server did not terminate TLS. With that confirmed, the server is a dumb
pipe.

---

## Keep it running

The server side is already a systemd unit.

Register the three Windows processes with NSSM:

```powershell
nssm install frpc  C:\frp\frpc.exe   -c C:\frp\frpc.toml
nssm install caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
nssm install studio C:\Users\<you>\AppData\Roaming\npm\reasonix.cmd serve --addr 127.0.0.1:8791 --auth token --token-file C:\Users\<you>\.reasonix\relay.token --no-open
nssm start frpc & nssm start caddy & nssm start studio
```

Do not use Task Scheduler: it does not bring a console program back after it
exits, and these three will exit.

---

## When it does not work

| Symptom | Usually |
|---|---|
| `401` | wrong launch token, or `serve` restarted with a new one |
| `502` / refused | frpc is not connected, Caddy is not on 8443, or the security group is shut |
| `systemctl` says running but nothing answers | the provider's security group |
| Certificate subject is someone else's host | the request never reached your relay |
| The stream arrives in one burst and stops | something on the path buffers (`type = "http"`, or an extra reverse proxy) |
| Connected, but the list is empty | `serve` was started without `--dir`, or that directory has no sessions |

---

## Legality and compliance

Two different questions; do not merge them.

**Legality is not in doubt.** A phone reaching the developer machine in your own
house, for your own use, serving nobody else. It is not circumvention, even
though it looks similar in shape — an overseas VPS, an encrypted tunnel, a
non-standard port.

**Compliance depends on where the server sits.**

| Location | Filing | Risk of being shut |
|---|---|---|
| Mainland VPS | ICP filing required, strictly | Medium: low on a non-standard port, high on 80/443 |
| Hong Kong / overseas | Not required | Low: no filing gate, but possible QoS |
| Home line, direct | Not required | Low, though carriers block inbound 80/443 |

What notices:

1. **Filing scans** — mainland providers scan Host headers and TLS SNI on
   80/443. On 8443 you are largely outside that sweep, which is the real value
   of a non-standard port.
2. **SNI blocking** — the name in the TLS handshake is plaintext. An unfiled
   name pointing at a mainland IP is blocked in some provinces. Dialling by IP
   removes SNI entirely.
3. **Provider terms** — most mainland providers forbid unfiled sites and proxy
   services. Small personal traffic is usually ignored, but a complaint or an
   inspection can suspend the machine. This is the likelier risk than
   regulation.
4. **Traffic shape** — an frp TCP tunnel is ordinary TLS with no fingerprint;
   sustained saturation invites QoS.

In order of effect:

1. **Dial by IP with an IP certificate, no name at all** — no SNI, no filing
   subject. Let's Encrypt has issued IP certificates since 2026.
2. **A non-standard port** (8443 already is).
3. **A Hong Kong or overseas host**, which sidesteps filing entirely.
4. Keep the traffic to personal volume.

**If compliance is a hard constraint, Tailscale is cleaner than a relay.** It
offers no internet information service at all: no name, no filing subject, no
open port. The cost is one Android VPN slot and a control plane abroad.

This is an engineering assessment, not legal advice. To settle it, ask the
provider's support whether personal remote access needs filing — their answer
beats any analysis, and asking costs nothing.
