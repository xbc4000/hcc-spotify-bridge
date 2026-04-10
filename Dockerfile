# =============================================================================
# HCC Spotify Bridge — librespot supervisor for high-end audio
# =============================================================================
# Stage 1: download a known-good librespot binary for arm64 (Pi 4)
# Stage 2: minimal Node runtime with the supervisor
# =============================================================================

FROM debian:bookworm-slim AS librespot-fetch
ARG LIBRESPOT_VERSION=0.6.0
ARG TARGETARCH=arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/librespot
# Pinned upstream release. ARM64 build ships statically with the audio backends.
RUN curl -fsSL "https://github.com/librespot-org/librespot/releases/download/v${LIBRESPOT_VERSION}/librespot-${LIBRESPOT_VERSION}-aarch64-unknown-linux-gnu.tar.xz" \
      -o librespot.tar.xz \
 && tar -xJf librespot.tar.xz \
 && find . -name librespot -type f -exec mv {} /usr/local/bin/librespot \; \
 && chmod +x /usr/local/bin/librespot \
 && /usr/local/bin/librespot --version

# -----------------------------------------------------------------------------

FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="HCC Spotify Bridge"
LABEL org.opencontainers.image.description="Stable Spotify Connect bridge for high-end audio. librespot supervisor with HTTP/WS API."

# Runtime deps:
# - alsa-utils for diagnostics + speaker-test
# - libasound2 for librespot's alsa backend
# - libpulse0 stub (some librespot builds expect it for symbol resolution; harmless)
# - dnsutils for connectivity diag
# - tini as PID 1 so signals propagate cleanly
RUN apt-get update && apt-get install -y --no-install-recommends \
    alsa-utils \
    libasound2 \
    ca-certificates \
    tini \
    wget \
 && rm -rf /var/lib/apt/lists/*

# Copy the pinned librespot binary
COPY --from=librespot-fetch /usr/local/bin/librespot /usr/local/bin/librespot

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
RUN chmod +x scripts/*.sh 2>/dev/null || true

# Persistent data (auth blob, cache)
RUN mkdir -p /app/data && chown -R node:audio /app/data

# Audio group needs to match host audio gid for /dev/snd access
# We pass --group-add audio at runtime instead.
ENV NODE_ENV=production
ENV BRIDGE_PORT=3081
ENV LIBRESPOT_BIN=/usr/local/bin/librespot
ENV LIBRESPOT_CACHE=/app/data/librespot
ENV LIBRESPOT_DEVICE=hw:0,0
ENV LIBRESPOT_NAME="NAD-AVR"
ENV LIBRESPOT_BITRATE=320
ENV LIBRESPOT_DEVICE_TYPE=avr
ENV LIBRESPOT_FORMAT=S32
ENV LIBRESPOT_INITIAL_VOLUME=100

EXPOSE 3081

# tini handles SIGTERM properly so we can shut down librespot cleanly
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
