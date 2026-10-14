#!/usr/bin/env bash
#
# Run a single worker in foreground, after asking engine and target server.
# Ctrl+C stops the worker.
#
# Reads from .env, by target and engine:
#   PROD_HEX_URL, PROD_AI_WORKER_KEY
#   LOCAL_HEX_URL, LOCAL_AI_WORKER_KEY
#   KATAHEX_AI_JOB_TYPES, MOHEX_AI_JOB_TYPES

set -euo pipefail

cd "$(dirname "$0")"

# Get a variable from .env without exporting everything
env_var() {
    (
        set +u
        [ -f .env ] && . ./.env
        printf '%s' "${!1:-}"
    )
}

# Choose an option with arrows and Enter, prints chosen option
menu() {
    local title=$1; shift
    local options=("$@") selected=0 key i

    {
        echo "$title"
        tput civis

        while true; do
            for i in "${!options[@]}"; do
                if [ "$i" -eq "$selected" ]; then
                    printf '\e[2K\e[36m> %s\e[0m\n' "${options[$i]}"
                else
                    printf '\e[2K  %s\n' "${options[$i]}"
                fi
            done

            IFS= read -rsn1 key
            if [ "$key" = $'\e' ]; then
                read -rsn2 key
            fi

            case "$key" in
                '[A') selected=$(( (selected - 1 + ${#options[@]}) % ${#options[@]} )) ;;
                '[B') selected=$(( (selected + 1) % ${#options[@]} )) ;;
                '') break ;;
            esac

            printf '\e[%dA' "${#options[@]}"
        done

        tput cnorm
    } </dev/tty >/dev/tty

    printf '%s' "${options[$selected]}"
}

# Restore cursor if Ctrl+C while in menu
trap 'tput cnorm >/dev/tty' EXIT

ENGINE=$(menu "Engine?" katahex mohex)
TARGET=$(menu "Server?" prod local)

PREFIX=${TARGET^^}
HEX_URL=$(env_var "${PREFIX}_HEX_URL")
AI_WORKER_KEY=$(env_var "${PREFIX}_AI_WORKER_KEY")
AI_JOB_TYPES=$(env_var "${ENGINE^^}_AI_JOB_TYPES")

if [ -z "$HEX_URL" ] || [ -z "$AI_WORKER_KEY" ]; then
    echo "Missing ${PREFIX}_HEX_URL or ${PREFIX}_AI_WORKER_KEY in .env" >&2
    exit 1
fi

export ENGINE HEX_URL AI_WORKER_KEY AI_JOB_TYPES

echo
echo "Running $ENGINE worker on $HEX_URL"
echo "Job types: ${AI_JOB_TYPES:-(engine defaults)}"
echo

exec yarn worker
