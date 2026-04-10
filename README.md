# HCC Spotify Bridge

A stable Spotify Connect bridge for high-end audio. Wraps the official `librespot`
binary with a Node.js supervisor that handles auto-restart, structured logging,
and exposes a tiny HTTP/WebSocket API for the HCC dashboard to monitor.

Built specifically because Raspotify is unreliable on long-running setups
(crashes, never restarts cleanly, package lags upstream librespot by months).

## What it does

- Spawns `librespot` as a managed subprocess
- Auto-restarts on any crash with exponential backoff (1s → 30s max)
- Resets the restart counter after 60s of stable runtime
- Captures every state change via `librespot --onevent` hook script and exposes
  it via HTTP/WS so the HCC dashboard can show live status without polling
  Spotify's Web API
- Bit-perfect ALSA passthrough — no PulseAudio, no PipeWire, no resampling
- Software volume disabled (`--volume-ctrl fixed`) — your AVR does volume
- Volume normalisation enabled to smooth album-to-album loudness differences
- Pinned librespot binary in the Dockerfile so we control upgrades
- Tini as PID 1 so SIGTERM propagates correctly to librespot

## Architecture

```
RPi 4 (host network)
├─ librespot (managed)        → ALSA hw:0,0 → vc4hdmi0 → HDMI → NAD-AVR
│   └─ --onevent hook
│        └─ POST /event back to bridge
│
├─ hcc-spotify-bridge (Node)
│   ├─ supervisor (spawn / restart / state cache)
│   └─ HTTP/WS server on :3081
│       ├─ GET  /health
│       ├─ GET  /status
│       ├─ GET  /logs?n=100
│       ├─ POST /restart
│       ├─ POST /event   (internal — onevent hook)
│       └─ WS   /ws       (live status + log stream)
│
└─ HCC dashboard reads /spotify-bridge/status (proxied)
```

## Configuration

All via env vars (defaults shown):

| Var | Default | Notes |
|-----|---------|-------|
| `BRIDGE_PORT` | `3081` | HTTP/WS port |
| `LIBRESPOT_NAME` | `NAD-AVR` | Display name in Spotify Connect picker |
| `LIBRESPOT_DEVICE` | `hw:0,0` | ALSA device. Run `aplay -l` on host to confirm |
| `LIBRESPOT_DEVICE_TYPE` | `avr` | Icon: `speaker`, `avr`, `tv`, `stb`, `audio_dongle`, `computer`, `smartphone` |
| `LIBRESPOT_BITRATE` | `320` | `96`, `160`, `320` |
| `LIBRESPOT_FORMAT` | `S32` | `S16`, `S24`, `S24_3`, `S32`, `F32` |
| `LIBRESPOT_INITIAL_VOLUME` | `100` | 0-100. Fixed (no software volume) |
| `LIBRESPOT_DISABLE_DISCOVERY` | unset | `on` to disable zeroconf advertisement |
| `LIBRESPOT_BIN` | `/usr/local/bin/librespot` | |
| `LIBRESPOT_CACHE` | `/app/data/librespot` | Persisted via Docker volume |

## Deploy

### Build on the host

```bash
cd ~/hcc-spotify-bridge
docker build -t hcc-spotify-bridge:latest .
```

### Portainer stack

Add to your existing HCC stack or as a separate one:

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

### First-time claim

Once the container is running, the bridge starts librespot which advertises
"NAD-AVR" via Spotify Connect zeroconf. To claim it for your account:

1. Open Spotify on any device on the **same broadcast domain** as the RPi
   (VLAN40 in this homelab — phone/laptop won't work because of VLAN isolation)
2. The desktop / mobile Spotify app's Connect picker should show NAD-AVR
3. Click it. Spotify links the device to your account.
4. After claim, NAD-AVR is visible globally on every device logged into your
   Spotify account, anywhere in the world. No more LAN dependency.

Cross-VLAN workaround if you can't get a device onto VLAN40:
- Plug a laptop directly into one of the RPi's free LAN ports (or temporarily
  put it on VLAN40 via the router)
- Open Spotify desktop, claim it, unplug
- Done forever

## API examples

```bash
# Health
curl http://10.40.40.2:3081/health

# Full status
curl http://10.40.40.2:3081/status | jq

# Last 50 log lines
curl 'http://10.40.40.2:3081/logs?n=50' | jq

# Manual restart of librespot
curl -X POST http://10.40.40.2:3081/restart

# WebSocket live stream
websocat ws://10.40.40.2:3081/ws
```

## Why this beats Raspotify

| Issue | Raspotify | hcc-spotify-bridge |
|-------|-----------|-------------------|
| librespot version | Lags upstream by months | Pinned, we control upgrades |
| Crash recovery | systemd unit unreliable | Exponential backoff, tested |
| Status visibility | `journalctl` only | HTTP/WS API + HCC dashboard card |
| Configuration | `/etc/raspotify/conf` text file | env vars in Portainer |
| ALSA path | Often goes via Pulse | Direct hw:0,0 |
| Volume | Software by default | Fixed/disabled, AVR controls |
| Boot reliability | "Sometimes" | Container restart=unless-stopped |
| Long-running | Connection drops | TODO: monitor in production |
