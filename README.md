<p align="center">
  <img src="https://img.shields.io/badge/librespot-Pinned-1DB954?style=for-the-badge&logo=spotify&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/ALSA-Bit--Perfect-FF6600?style=for-the-badge&logoColor=white" />
  <img src="https://img.shields.io/badge/Docker-Container-2496ED?style=for-the-badge&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/WebSocket-Live_Status-00B7FF?style=for-the-badge&logoColor=white" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/last-commit/xbc4000/hcc-spotify-bridge?style=flat-square&color=00B7FF" />
  <img src="https://img.shields.io/github/repo-size/xbc4000/hcc-spotify-bridge?style=flat-square&color=00B7FF" />
  <img src="https://img.shields.io/github/license/xbc4000/hcc-spotify-bridge?style=flat-square&color=00B7FF" />
  <img src="https://img.shields.io/badge/Audio-320kbps_S32-1DB954?style=flat-square" />
  <img src="https://img.shields.io/badge/Volume-AVR_Passthrough-FF00B2?style=flat-square" />
</p>

<h1 align="center">HCC SPOTIFY BRIDGE</h1>

<p align="center">
  <strong>Stable Spotify Connect bridge for high-end audio.</strong><br>
  <strong>Bit-perfect ALSA · auto-restart · HTTP/WebSocket API · HCC dashboard integration</strong><br>
  Wraps the official librespot binary with a Node.js supervisor. Built because Raspotify is unreliable.
</p>

<p align="center">
  <img src="social-preview.png" width="720" />
</p>

---

## 📑 Table of Contents

- [Why This Exists](#-why-this-exists)
- [Features](#-features)
- [Architecture](#-architecture)
- [Configuration](#-configuration)
- [Deploy](#-deploy)
- [API](#-api)
- [Raspotify Comparison](#-raspotify-comparison)

---

## 💡 Why This Exists

Raspotify crashes on long-running setups. It doesn't restart cleanly. The package lags upstream librespot by months. Configuration is a flat text file with no visibility into what's happening. When it goes silent on a Friday night, you're SSHing into a Raspberry Pi to restart a systemd unit while your music is dead.

This bridge fixes all of that.

---

## ✨ Features

- **Managed librespot** — spawns as a subprocess, auto-restarts on any crash with exponential backoff (1s → 30s max), resets after 60s of stability
- **Bit-perfect ALSA** — direct `hw:0,0` passthrough, no PulseAudio, no PipeWire, no resampling
- **Fixed volume** — software volume disabled (`--volume-ctrl fixed`), your AVR controls the volume
- **Volume normalisation** — smooths album-to-album loudness differences
- **Event capture** — every librespot state change (play, pause, track change, connect, disconnect) captured via `--onevent` hook and exposed over HTTP/WS
- **Live dashboard** — HCC dashboard shows real-time playback status without polling Spotify's Web API
- **Pinned binary** — librespot version locked in the Dockerfile, upgrades are deliberate
- **Tini PID 1** — proper signal propagation, clean container shutdown

---

## 🏗 Architecture

```
RPi 4 (host network)
│
├─ librespot (managed subprocess)
│   ├─ ALSA hw:0,0 → vc4hdmi0 → HDMI → NAD-AVR
│   └─ --onevent hook
│        └─ POST /event → bridge
│
├─ hcc-spotify-bridge (Node.js)               :3081
│   ├─ Supervisor
│   │   ├─ spawn / restart / state cache
│   │   └─ exponential backoff (1s → 30s)
│   │
│   └─ HTTP/WS Server
│       ├─ GET  /health        → container health
│       ├─ GET  /status        → full playback state
│       ├─ GET  /logs?n=100    → recent log lines
│       ├─ POST /restart       → manual librespot restart
│       ├─ POST /event         → internal (onevent hook)
│       └─ WS   /ws            → live status + log stream
│
└─ HCC Dashboard reads /spotify-bridge/status (proxied via Caddy)
```

---

## ⚙ Configuration

All via environment variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `BRIDGE_PORT` | `3081` | HTTP/WS port |
| `LIBRESPOT_NAME` | `NAD-AVR` | Spotify Connect display name |
| `LIBRESPOT_DEVICE` | `hw:0,0` | ALSA device — run `aplay -l` to confirm |
| `LIBRESPOT_DEVICE_TYPE` | `avr` | Icon in Connect picker: `speaker`, `avr`, `tv`, `stb`, `audio_dongle`, `computer`, `smartphone` |
| `LIBRESPOT_BITRATE` | `320` | `96`, `160`, `320` |
| `LIBRESPOT_FORMAT` | `S32` | `S16`, `S24`, `S24_3`, `S32`, `F32` |
| `LIBRESPOT_INITIAL_VOLUME` | `100` | 0-100 (fixed, no software volume) |
| `LIBRESPOT_DISABLE_DISCOVERY` | unset | `on` to disable zeroconf |
| `LIBRESPOT_BIN` | `/usr/local/bin/librespot` | |
| `LIBRESPOT_CACHE` | `/app/data/librespot` | Persisted via Docker volume |

---

## 🚀 Deploy

### Build

```bash
cd ~/hcc-spotify-bridge
docker build -t hcc-spotify-bridge:latest .
```

### Portainer Stack

```yaml
services:
  hcc-spotify-bridge:
    image: hcc-spotify-bridge:latest
    container_name: hcc-spotify-bridge
    restart: unless-stopped
    network_mode: host
    devices:
      - /dev/snd:/dev/snd
    group_add:
      - audio
    environment:
      - LIBRESPOT_NAME=NAD-AVR
      - LIBRESPOT_DEVICE=hw:0,0
      - LIBRESPOT_DEVICE_TYPE=avr
      - LIBRESPOT_BITRATE=320
      - LIBRESPOT_FORMAT=S32
    volumes:
      - hcc-spotify-data:/app/data

volumes:
  hcc-spotify-data:
    driver: local
```

### First-Time Claim

1. Start the container — librespot advertises "NAD-AVR" via Spotify Connect zeroconf
2. Open Spotify on a device on the **same broadcast domain** as the RPi (VLAN40 in this homelab — phone/laptop won't work due to VLAN isolation)
3. Tap NAD-AVR in the Connect picker — Spotify links the device to your account
4. After claim, NAD-AVR appears globally on every device logged into your Spotify account, anywhere

**Cross-VLAN workaround:** Plug a laptop directly into the RPi's LAN port (or temporarily put it on VLAN40), claim in Spotify, unplug. Done forever.

---

## 🔌 API

```bash
# Health check
curl http://10.40.40.2:3081/health

# Full playback status
curl http://10.40.40.2:3081/status | jq

# Recent logs
curl 'http://10.40.40.2:3081/logs?n=50' | jq

# Manual restart
curl -X POST http://10.40.40.2:3081/restart

# Live WebSocket stream
websocat ws://10.40.40.2:3081/ws
```

---

## ⚔ Raspotify Comparison

| | Raspotify | HCC Spotify Bridge |
|---|-----------|-------------------|
| **librespot version** | Lags upstream by months | Pinned in Dockerfile — deliberate upgrades |
| **Crash recovery** | systemd unit, unreliable | Exponential backoff (1s → 30s), tested |
| **Status visibility** | `journalctl` only | HTTP/WS API + HCC dashboard card |
| **Configuration** | `/etc/raspotify/conf` flat file | env vars in Portainer |
| **ALSA path** | Often routes through PulseAudio | Direct `hw:0,0` — bit-perfect |
| **Volume** | Software by default | Fixed/disabled — AVR controls |
| **Boot reliability** | "Sometimes" | `restart: unless-stopped` |
| **Signal handling** | systemd PID management | Tini as PID 1, clean propagation |
