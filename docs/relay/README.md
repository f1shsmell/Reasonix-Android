# Self-hosted relay: the server side

[中文](README.zh-CN.md)

Three files, one invariant: **the certificate lives on the machine that owns the
kernel, and the server only forwards bytes.**

```
phone ──TLS──▶ server:8443 (frps, tcp) ──tunnel──▶ frpc ──▶ Caddy:8443 ──▶ Studio:8791
```

If the server ever terminates TLS, it can read every conversation. `type = "tcp"`
in `frpc.toml` is what prevents that; `type = "http"` would parse the request and
defeat the whole arrangement.

## Files

| File | Runs on | Does |
|---|---|---|
| `frps.toml.example` | the server | accepts one tunnel, opens one port, parses nothing |
| `frpc.toml.example` | the machine with Studio | dials out, exposes Caddy's loopback port |
| `Caddyfile.example` | the machine with Studio | terminates TLS, holds the certificate, proxies to the kernel |

The certificate is obtained with a DNS-01 challenge, so the server never needs
port 80 open and the name never has to resolve to the house.

## Before you start

1. A domain whose DNS you control (Cloudflare is the shortest path).
2. `frp` on both machines, same version.
3. Caddy built with the DNS provider plugin — the stock binary has no
   `dns cloudflare` directive. `xcaddy build --with github.com/caddy-dns/cloudflare`.
4. Studio listening on loopback with a fixed token:

   ```sh
   printf '%s' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" > ~/.reasonix/relay.token
   reasonix serve --addr 127.0.0.1:8791 --auth token --token-file ~/.reasonix/relay.token --no-open
   ```

   `--token-file` is read, not written. A path that does not exist makes `serve`
   fail at startup. Without it, every restart mints a new token and the phone's
   saved door stops working.

   Do **not** add `--behind-proxy`: it marks the cookie `Secure`, and the phone's
   proxy speaks plain HTTP to the loopback upstream.

## Verify

`./verify-sse.sh https://<relay host>:8443 <token>` prints the certificate the
server presented and then holds the event stream open for 25 seconds. Two things
must be true:

- the certificate's subject is **your** host and the issuer is a public CA — proof
  the server did not terminate TLS;
- the stream keeps ticking (`: ping` every 15 s) instead of arriving in one burst
  — proof nothing on the path buffers.

## What the token grants

The kernel treats a launch token as the **host's own credential**, not a paired
device's. A phone that connects this way can reach the routes the kernel hides
from paired devices (`POST /changes/discard`, `GET/POST /git/push`, the terminal
routes). The app does not render them yet, but the backend allows them: treat the
token like a password to the machine, not like a pairing code.
