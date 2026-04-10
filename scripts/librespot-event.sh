#!/bin/sh
# =============================================================================
# librespot --onevent hook
# =============================================================================
# librespot calls this script every time playback state changes.
# Event type is passed in $PLAYER_EVENT, additional data in env vars.
# We post a JSON payload back to the bridge HTTP API.
# =============================================================================

BRIDGE_HOST="${HCC_BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${HCC_BRIDGE_PORT:-3081}"
URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}/event"

EVENT="${PLAYER_EVENT:-unknown}"

# Build a JSON object from the librespot env vars we care about.
# librespot sets these depending on the event type:
#   PLAYER_EVENT, TRACK_ID, OLD_TRACK_ID, NAME, ARTISTS, ALBUM,
#   ALBUM_ARTISTS, COVERS, NUMBER, DISC_NUMBER, DURATION_MS, IS_EXPLICIT,
#   ITEM_TYPE, LANGUAGE, POSITION_MS, VOLUME, USER_NAME, SHOW_NAME, etc.

esc() {
    # JSON-escape a value (basic — quotes and backslashes)
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

JSON_FIELDS=""
add_field() {
    NAME="$1"
    VALUE="$2"
    if [ -n "$VALUE" ]; then
        ESCAPED=$(esc "$VALUE")
        if [ -z "$JSON_FIELDS" ]; then
            JSON_FIELDS="\"$NAME\":\"$ESCAPED\""
        else
            JSON_FIELDS="$JSON_FIELDS,\"$NAME\":\"$ESCAPED\""
        fi
    fi
}

add_field "TRACK_ID"     "$TRACK_ID"
add_field "NAME"         "$NAME"
add_field "ARTISTS"      "$ARTISTS"
add_field "ALBUM"        "$ALBUM"
add_field "DURATION_MS"  "$DURATION_MS"
add_field "POSITION_MS"  "$POSITION_MS"
add_field "VOLUME"       "$VOLUME"
add_field "ITEM_TYPE"    "$ITEM_TYPE"
add_field "USER_NAME"    "$USER_NAME"

PAYLOAD="{\"event\":\"$(esc "$EVENT")\",\"data\":{${JSON_FIELDS}}}"

# Fire-and-forget POST. Use wget since it's smaller than curl in alsa-utils image.
# Fall back to curl if available.
if command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --header="Content-Type: application/json" \
        --post-data="$PAYLOAD" "$URL" 2>/dev/null || true
elif command -v curl >/dev/null 2>&1; then
    curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$URL" >/dev/null 2>&1 || true
fi

exit 0
