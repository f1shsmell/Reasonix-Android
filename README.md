# Reasonix Mobile

An Android client for [Reasonix Studio](https://github.com/esengine/DeepSeek-Reasonix)
that does not reuse a single desktop component. The phone UI is written for a
phone: thumb reach, safe areas, a software keyboard, rotation, and a
connection that drops.

React + Vite + Capacitor. The desktop app is also a React app inside a shell
(Electron there, Capacitor here), so the two share wire types without sharing
screens.

## Status

Milestone 1 of 5: the connection layer. It authenticates, lists runtimes, and
subscribes to a runtime's event stream with resume. There is no chat UI yet.

**Pick up here: [docs/HANDOFF.md](docs/HANDOFF.md).** It lists the environment
traps, the decisions that will look wrong if you undo them, and what is *not*
verified.

See [docs/PLAN.md](docs/PLAN.md) for scope and milestones, and
[docs/PRIOR_ART.md](docs/PRIOR_ART.md) for the survey this design answers to.

## Running it

A dev session needs a kernel to talk to:

```bash
reasonix serve --addr 127.0.0.1:8791 --auth token --token-file /tmp/t.token
REASONIX_SERVE=http://127.0.0.1:8791 npm run dev
```

Then open `http://<your-lan-ip>:5274/#token=<token>` — the fragment token is
exchanged for a cookie and wiped from the URL. Without `REASONIX_SERVE` the dev
server starts anyway and every kernel call 404s, which reads as a broken app
rather than a missing backend.

```bash
npm run typecheck
npm test
npm run build
```

## The contract rule

The phone and the desktop update on different schedules, so the wire contract
only grows: fields and event kinds are added, never renamed or removed. The
client ignores what it does not know, and nothing is inferred from wording — an
error a caller must tell apart carries a code, not a sentence.

## No Android SDK yet

`ANDROID_HOME` is unset on this machine and `adb` is absent, so milestones 1–4
run in a browser. Packaging (milestone 5) needs the SDK installed first.
