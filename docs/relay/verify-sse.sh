#!/usr/bin/env bash
# Check that a self-hosted relay carries the kernel's event stream unbroken.
#
#   ./verify-sse.sh https://relay.example.com:8443 <token> [runtime-id]
#
# Two things must be true, and neither can be assumed from a config file:
#   - the certificate comes from the machine that owns the kernel, so the server
#     forwarding the bytes never saw plaintext;
#   - the stream keeps ticking instead of arriving in one burst, so nothing on
#     the path is buffering it.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <origin> <token> [runtime-id]" >&2
  exit 2
fi

origin="${1%/}"
token="$2"
runtime="${3:-}"

hostport="${origin#*://}"
hostport="${hostport%%/*}"
host="${hostport%%:*}"
case "${hostport}" in
  *:*) port="${hostport##*:}" ;;
  *)   port=443 ;;
esac

echo "== certificate presented by ${host}:${port}"
if command -v openssl >/dev/null 2>&1; then
  openssl s_client -connect "${host}:${port}" -servername "${host}" </dev/null 2>/dev/null \
    | openssl x509 -noout -subject -issuer 2>/dev/null \
    || echo "  (no certificate read — is this an https origin?)"
else
  echo "  (openssl not found)"
fi

echo
echo "== authentication"
code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer ${token}" "${origin}/runtimes" || true)
echo "  GET /runtimes -> ${code}"
if [ "${code}" != "200" ]; then
  echo "  401: the token is wrong. 5xx: the tunnel is up but Studio is not answering."
  exit 1
fi

if [ -z "${runtime}" ]; then
  runtime=$(curl -s --noproxy '*' --max-time 10 -H "Authorization: Bearer ${token}" "${origin}/runtimes" \
    | tr ',' '\n' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n 1)
fi
if [ -z "${runtime}" ]; then
  echo "  no runtime id in /runtimes: nothing to stream yet"
  exit 1
fi

echo
echo "== event stream /rt/${runtime}/events (25 s)"
echo "  a live stream ticks ': ping' about every 15 s; one burst means buffering"
if command -v timeout >/dev/null 2>&1; then
  timeout 25 curl -sN --noproxy '*' -H "Authorization: Bearer ${token}" "${origin}/rt/${runtime}/events" \
    | head -c 400 || true
else
  # macOS ships no `timeout`; curl's own deadline does the same job.
  curl -sN --noproxy '*' --max-time 25 -H "Authorization: Bearer ${token}" "${origin}/rt/${runtime}/events" \
    | head -c 400 || true
fi

echo
echo
echo "done"
