# =============================================================================
# HCC Spotify Bridge — librespot supervisor for high-end audio
# =============================================================================
# Two-stage build:
#  1. librespot-fetch: install raspotify (Debian package) just to grab the
#     librespot binary, then discard the rest. Raspotify packages the same
#     librespot we want, properly built for arm64. We replace its broken
#     systemd unit with our own Node.js supervisor.
#  2. runtime: minimal Node + alsa-utils + the extracted librespot binary.
# =============================================================================

FROM debian:bookworm-slim AS librespot-fetch
ARG TARGETARCH=arm64
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# Add the Raspotify apt repo (provides a properly built librespot for arm64).
# We're using Raspotify only as a delivery mechanism for librespot — we will
# NOT install or run the raspotify systemd service.
RUN curl -fsSL https://dtcooper.github.io/raspotify/key.asc | gpg --dearmor -o /usr/share/keyrings/raspotify_key.gpg \
 && chmod 644 /usr/share/keyrings/raspotify_key.gpg \
 && echo 'deb [signed-by=/usr/share/keyrings/raspotify_key.gpg] https://dtcooper.github.io/raspotify raspotify main' \
    > /etc/apt/sources.list.d/raspotify.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends raspotify \
 && /usr/bin/librespot --version

# -----------------------------------------------------------------------------

FROM node:20-bookworm-slim
LABEL org.opencontainers.image.title="HCC Spotify Bridge"
LABEL org.opencontainers.image.description="Stable Spotify Connect bridge for high-end audio. librespot supervisor with HTTP/WS API."

# Runtime deps:
# - alsa-utils for diagnostics + speaker-test
# - libasound2 for librespot's alsa backend
# - tini as PID 1 so signals propagate cleanly
# - wget for the --onevent hook script
RUN apt-get update && apt-get install -y --no-install-recommends \
    alsa-utils \
    libasound2 \
    libpulse0 \
    ca-certificates \
    tini \
    wget \
 && rm -rf /var/lib/apt/lists/*

# Copy the librespot binary from the fetch stage
COPY --from=librespot-fetch /usr/bin/librespot /usr/local/bin/librespot
RUN chmod +x /usr/local/bin/librespot && /usr/local/bin/librespot --version

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
RUN chmod +x scripts/*.sh 2>/dev/null || true

# Persistent data (auth blob, cache)
RUN mkdir -p /app/data && chown -R node:audio /app/data

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
