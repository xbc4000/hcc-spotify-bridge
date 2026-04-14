#!/usr/bin/env python3
"""
Regenerates docs/architecture.png — signal chain + API surface of the bridge.

Mirrors the cyberpunk style of homelab-network/topology.png. Run with:

    python3 scripts/generate-architecture.py
"""

import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "docs", "architecture.png")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

BG          = (3, 6, 16)
BG_CARD     = (10, 14, 24)
CYAN        = (0, 183, 255)
CYAN_BRIGHT = (0, 212, 255)
MAGENTA     = (255, 0, 178)
ORANGE      = (255, 153, 0)
GREEN       = (0, 255, 136)
PURPLE      = (185, 134, 242)
GOLD        = (255, 215, 0)
SPOTIFY     = (29, 185, 84)
TEXT        = (153, 170, 208)
TEXT_BRIGHT = (208, 221, 240)
TEXT_MUTED  = (85, 102, 136)

FONT_CANDIDATES = [
    "/run/host/fonts/google-noto/NotoSansMono-SemiCondensedMedium.ttf",
    "/run/host/fonts/google-noto/NotoSansMono-SemiCondensedBold.ttf",
    "/usr/share/fonts/google-noto/NotoSansMono-SemiCondensedMedium.ttf",
    "/usr/share/fonts/google-noto/NotoSansMono-SemiCondensedBold.ttf",
    "/usr/share/fonts/gnu-free/FreeMono.ttf",
    "/usr/share/fonts/gnu-free/FreeMonoBold.ttf",
]

def _find_font(bold=False):
    needle = "Bold" if bold else "Medium"
    for p in FONT_CANDIDATES:
        if needle in p and os.path.exists(p):
            return p
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None

def font(size, bold=False):
    p = _find_font(bold=bold)
    return ImageFont.truetype(p, size) if p else ImageFont.load_default()


def box(d, x, y, w, h, color, title, lines):
    d.rectangle([x, y, x + w, y + h], outline=color, width=2)
    d.rectangle([x + 1, y + 1, x + w - 1, y + 24], fill=BG_CARD)
    d.text((x + 10, y + 5), title, font=font(12, bold=True), fill=color)
    for i, line in enumerate(lines):
        d.text((x + 10, y + 32 + i * 16), line, font=font(11), fill=TEXT)


def arrow(d, x1, y1, x2, y2, color, width=2):
    d.line([(x1, y1), (x2, y2)], fill=color, width=width)
    if y2 > y1:   # pointing down
        d.polygon([(x2 - 5, y2 - 5), (x2 + 5, y2 - 5), (x2, y2 + 3)], fill=color)
    elif x2 > x1: # pointing right
        d.polygon([(x2 - 5, y2 - 5), (x2 - 5, y2 + 5), (x2 + 3, y2)], fill=color)


def main():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    # Title
    d.text((W // 2, 20), "// HCC SPOTIFY BRIDGE  //  SIGNAL CHAIN + API",
           font=font(18, bold=True), fill=SPOTIFY, anchor="mt")
    d.text((W // 2, 47),
           "librespot (pinned)  //  bit-perfect ALSA  //  HDMI-CEC  //  HTTP + WS",
           font=font(11), fill=TEXT_MUTED, anchor="mt")

    # ─── Source: Spotify Connect ───────────────────────────────────────
    sp_x, sp_y, sp_w, sp_h = 80, 95, 300, 95
    box(d, sp_x, sp_y, sp_w, sp_h, SPOTIFY, "▲ Spotify Connect",
        ["phone / desktop / web",
         "320kbps stream + metadata",
         "zeroconf discovery"])
    arrow(d, sp_x + sp_w, sp_y + sp_h // 2, 450, sp_y + sp_h // 2, SPOTIFY)

    # ─── Control source: HCC Dashboard ─────────────────────────────────
    dash_x, dash_y, dash_w, dash_h = 900, 95, 300, 95
    box(d, dash_x, dash_y, dash_w, dash_h, CYAN, "◆ HCC Dashboard",
        ["HOME:    Now Playing card",
         "CONTROL: CEC buttons",
         "WS subscribes to /ws"])
    arrow(d, dash_x, dash_y + dash_h // 2, 830, dash_y + dash_h // 2, CYAN)

    # ─── Middle: the bridge itself ─────────────────────────────────────
    br_x, br_y, br_w, br_h = 380, 230, 520, 170
    box(d, br_x, br_y, br_w, br_h, CYAN_BRIGHT,
        "◆ hcc-spotify-bridge  (Docker host-net :3081)",
        ["supervisor.js  spawn  /  crash  /  exponential backoff 1-30s",
         "cec.js         cec-ctl wrapper, topology probe, addr cache",
         "server.js      HTTP + WS server, onevent hook capture",
         "",
         "HTTP:  /health  /status  /logs  /restart  /event",
         "       /cec/{vol,power,source,mute,remote,swap,raw,status}",
         "WS:    /ws  (live status + log stream)"])

    # ─── Audio path out ────────────────────────────────────────────────
    audio_y = 450
    pos = [
        (100,  SPOTIFY,  "▲ librespot",
         ["decodes Spotify stream",
          "--volume-ctrl fixed",
          "--onevent hook"]),
        (350,  ORANGE,   "▲ ALSA hw:0,0",
         ["bit-perfect S32 / 320",
          "no PulseAudio",
          "no resampling"]),
        (600,  PURPLE,   "▲ HDMI (vc4hdmi0)",
         ["pi 4 HDMI out",
          "1-bit audio path",
          "no software vol"]),
        (850,  MAGENTA,  "▲ NAD T748 AVR",
         ["receives audio",
          "receives CEC",
          "drives speakers"]),
        (1080, GOLD,     "▲ Speakers",
         ["7.1 output",
          "listening room",
          ""]),
    ]
    chain_w = 175
    chain_h = 105
    for x, color, title, lines in pos:
        box(d, x, audio_y, chain_w, chain_h, color, title, lines)

    # Arrows between audio-path cards
    for i in range(len(pos) - 1):
        x1 = pos[i][0] + chain_w
        x2 = pos[i + 1][0]
        y = audio_y + chain_h // 2
        arrow(d, x1, y, x2, y, pos[i + 1][1])

    # Down-arrow from bridge to librespot
    arrow(d, br_x + 80, br_y + br_h, pos[0][0] + chain_w // 2, audio_y, SPOTIFY)
    # Side-arrow: bridge CEC → AVR (top of AVR)
    arrow(d, br_x + br_w - 60, br_y + br_h,
          pos[3][0] + chain_w // 2, audio_y, MAGENTA)

    # ─── Footer ────────────────────────────────────────────────────────
    footer_y = 615
    d.rectangle([60, footer_y, W - 60, footer_y + 60], outline=CYAN, width=1)
    stats = [
        ("BITRATE",    "320 kbps",   SPOTIFY),
        ("FORMAT",     "S32 native", CYAN_BRIGHT),
        ("CEC ROUTES", "11",         MAGENTA),
        ("API",        "HTTP + WS",  ORANGE),
        ("UPTIME",     "supervised", GREEN),
        ("PID 1",      "tini",       GOLD),
    ]
    cell_w = (W - 120) // len(stats)
    for i, (label, value, color) in enumerate(stats):
        sx = 60 + i * cell_w
        d.text((sx + 20, footer_y + 12), label,
               font=font(9), fill=TEXT_MUTED)
        d.text((sx + 20, footer_y + 28), value,
               font=font(13, bold=True), fill=color)

    d.text((W // 2, 690),
           "◆ XBC SYSTEMS  //  HOMELAB COMMAND CENTER  //  hcc-spotify-bridge ◆",
           font=font(9), fill=TEXT_MUTED, anchor="mt")
    d.text((W // 2, 705),
           "[ 2026 · one less reason to pick up the remote ]",
           font=font(8), fill=TEXT_MUTED, anchor="mt")

    im.save(OUT)
    print(f"wrote {OUT}  ({W}x{H})")


if __name__ == "__main__":
    main()
