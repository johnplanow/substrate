# Nightly live smoke (H2.3)

One real claude dispatch per night against the Python/uv fixture, proving the
full live cycle (create-story → dev-story → commit-first → 9-check
verification incl. `uv run pytest` → merge) on this workstation — the only
environment holding subscription CLI auth (GitHub runners cannot).

## What it does

`run.mjs` builds a fresh workspace under `~/.substrate-smoke/ws-<date>/`,
runs `substrate run --stories 1-1` with the REAL claude adapter, asserts the
merged result, and appends a `PASS`/`FAIL` line to
`~/.substrate-smoke/history.log`. Failed workspaces and logs are preserved.

Cost: one story per night, ≈ $0.01–$0.40 depending on routing.

## Enabling (explicit operator step — commits nightly quota spend)

```sh
mkdir -p ~/.config/systemd/user
cp scripts/nightly-live-smoke/substrate-smoke.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now substrate-smoke.timer
systemctl --user list-timers substrate-smoke.timer   # verify schedule
```

Disable with `systemctl --user disable --now substrate-smoke.timer`.

## Monitoring

- `tail ~/.substrate-smoke/history.log` — last line is the latest verdict.
- Per the homelab anti-drift rule: if you want estate-level monitoring, add a
  dead-man heartbeat (e.g. an Uptime Kuma push URL curl at the end of the
  service unit) and a catalog entry — deliberately left out here because the
  estate config lives in the ansible-playbooks repo, not this one.

## Prerequisites

- `dist/` built at the substrate repo (`npm run build`) — the timer runs the
  repo's bundled CLI, so the smoke always tests your latest local build.
- `uv`, `dolt`, and a logged-in `claude` CLI on PATH.
