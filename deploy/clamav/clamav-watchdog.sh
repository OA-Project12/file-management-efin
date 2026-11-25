#!/bin/sh
set -eu

ping_clamd() {
    local response
    # Read the daemon's reply. clamdscan --ping can succeed after only writing PING.
    response=$(printf 'nPING\n' | timeout -s KILL 2 socat -t 2 - UNIX-CONNECT:/tmp/clamd.sock) 2>/dev/null \
        && [ "$response" = PONG ]
}

if [ "${1:-}" = --probe ]; then
    ping_clamd
    exit $?
fi

# Preserve the upstream image's command mode for interactive diagnostics.
if [ "$#" -gt 0 ]; then
    exec /bin/sh /init "$@"
fi

log() {
    printf 'clamav-watchdog %s\n' "$1"
}

fail() {
    log "$1" >&2
    exit 1
}

uptime_seconds() {
    read -r uptime _ < /proc/uptime
    printf '%s\n' "${uptime%.*}"
}

process_running() {
    local pid=$1 name state
    { read -r _ name state _ < "/proc/$pid/stat"; } 2>/dev/null || return 1
    case "$state" in
        Z|X) return 1 ;;
    esac
    [ "$#" -eq 1 ] || [ "$name" = "($2)" ]
}

shutdown() {
    trap '' TERM INT
    log 'stopping'
    local deadline=$(($(uptime_seconds) + 5)) pid daemon
    # Tini forwards to the group. Convert INT for background jobs that ignore it.
    if [ "$1" = INT ]; then
        if [ -n "$init_pid" ]; then
            kill -TERM "$init_pid" 2>/dev/null || true
        fi
        for daemon in clamd freshclam; do
            pkill -TERM -x "$daemon" || true
        done
    fi
    while [ "$(uptime_seconds)" -lt "$deadline" ]; do
        for pid in $(pgrep -x clamd || true) $(pgrep -x freshclam || true); do
            if process_running "$pid"; then
                sleep 1
                continue 2
            fi
        done
        break
    done
    exit 0
}

init_pid=
trap 'shutdown TERM' TERM
trap 'shutdown INT' INT
startup_deadline=$(($(uptime_seconds) + 1800))
# Run the upstream script without starting its second Tini instance.
/bin/sh /init &
init_pid=$!
clamd_pid=
ready=0
unresponsive_since=

while :; do
    probe_started=$(uptime_seconds)
    process_running "$init_pid" || fail 'upstream startup process exited'

    if [ -z "$clamd_pid" ]; then
        clamd_pid=$(pgrep -x clamd || true)
    fi
    if [ -n "$clamd_pid" ]; then
        process_running "$clamd_pid" clamd || fail 'clamd exited'
    fi

    if [ -n "$clamd_pid" ] && ping_clamd; then
        if [ "$ready" -eq 0 ]; then
            log 'ready'
            ready=1
        fi
        unresponsive_since=
    elif [ "$ready" -eq 0 ]; then
        [ "$(uptime_seconds)" -lt "$startup_deadline" ] || fail 'startup timeout'
    else
        unresponsive_since=${unresponsive_since:-$probe_started}
        [ "$(uptime_seconds)" -lt "$((unresponsive_since + 180))" ] || fail 'clamd ping timeout'
    fi

    remaining=$((probe_started + 5 - $(uptime_seconds)))
    if [ "$remaining" -gt 0 ]; then
        sleep "$remaining" &
        wait "$!"
    fi
done
