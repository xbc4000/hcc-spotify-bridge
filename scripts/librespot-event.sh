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
    # JSON-escape a value: backslashes, quotes, control chars (newlines, tabs, etc)
    printf '%s' "$1" \
        | sed 's/\\/\\\\/g' \
        | sed 's/"/\\"/g' \
        | tr -d '\000-\031' \
        | tr '\t' ' '
}

JSON_FIELDS=""
add_field() {
    # IMPORTANT: do NOT use 'NAME' or 'VALUE' as local var names — they
    # would shadow librespot's $NAME env var (track name) on subsequent
    # calls in the same shell. Use prefixed names.
    _f_key="$1"
    _f_val="$2"
    if [ -n "$_f_val" ]; then
        _f_esc=$(esc "$_f_val")
        if [ -z "$JSON_FIELDS" ]; then
            JSON_FIELDS="\"$_f_key\":\"$_f_esc\""
        else
            JSON_FIELDS="$JSON_FIELDS,\"$_f_key\":\"$_f_esc\""
        fi
    fi
}

# Snapshot env vars BEFORE add_field calls to be extra safe against
# any local var leakage. (Belt + suspenders.)
_TRACK_ID="$TRACK_ID"
_NAME="$NAME"
_ARTISTS="$ARTISTS"
_ALBUM="$ALBUM"
_DURATION_MS="$DURATION_MS"
_POSITION_MS="$POSITION_MS"
_VOLUME="$VOLUME"
_ITEM_TYPE="$ITEM_TYPE"
_USER_NAME="$USER_NAME"

add_field "TRACK_ID"     "$_TRACK_ID"
add_field "NAME"         "$_NAME"
add_field "ARTISTS"      "$_ARTISTS"
add_field "ALBUM"        "$_ALBUM"
add_field "DURATION_MS"  "$_DURATION_MS"
add_field "POSITION_MS"  "$_POSITION_MS"
add_field "VOLUME"       "$_VOLUME"
add_field "ITEM_TYPE"    "$_ITEM_TYPE"
add_field "USER_NAME"    "$_USER_NAME"

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
