#!/usr/bin/env bash
# Export the AutoDev-generated OTLP receiver token to a mode-0600 file outside
# the repository. The same token is injected into OpenLIT's pinned Collector
# receiver as OPENLIT_OTLP_API_KEY by docker compose.

set -euo pipefail

SECRET_FILE=""
KEY_FILE=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--secret-file)
			SECRET_FILE="$2"
			shift 2
			;;
		--key-file)
			KEY_FILE="$2"
			shift 2
			;;
		*)
			echo "bootstrap-otlp-key.sh: unknown argument: $1" >&2
			exit 1
			;;
	esac
done

CODEX_HOME="${CODEX_HOME:-${HOME:?HOME must be set}/.codex}"
SECRET_FILE="${SECRET_FILE:-$CODEX_HOME/openlit-secrets.env}"
KEY_FILE="${KEY_FILE:-$CODEX_HOME/openlit-otlp-api-key}"

if [[ ! -f "$SECRET_FILE" ]]; then
	echo "bootstrap-otlp-key.sh: secret file is missing; run bootstrap-secrets.sh first" >&2
	exit 2
fi
API_KEY="$(awk -F= '$1 == "OPENLIT_OTLP_API_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$SECRET_FILE")"
if [[ ${#API_KEY} -lt 32 ]]; then
	echo "bootstrap-otlp-key.sh: OTLP receiver token is missing or too weak" >&2
	exit 2
fi

mkdir -p "$(dirname "$KEY_FILE")"
chmod 0700 "$(dirname "$KEY_FILE")"
TEMP_FILE="${KEY_FILE}.tmp.$$"
umask 077
printf '%s\n' "$API_KEY" > "$TEMP_FILE"
chmod 0600 "$TEMP_FILE"
mv -f "$TEMP_FILE" "$KEY_FILE"
chmod 0600 "$KEY_FILE"
printf '==> OTLP receiver token materialized to %s (mode 0600; value redacted)\n' "$KEY_FILE"
printf '    Producer header: Authorization=Bearer%%20<value from key file>\n'
