#!/bin/bash
# KeePass Credential Helper for Golf Bot
# Securely retrieves credentials from KeePass at runtime
# Usage: source keepass-helper.sh && get_golf_bot_creds

KEEPASS_DB="/Users/nautilus-air/Library/CloudStorage/GoogleDrive-martyshawz@gmail.com/My Drive/Password/password.kdbx"

# Retrieve golf_bot credentials from KeePass
get_golf_bot_creds() {
  if [ -z "$KEEPASS_PASSWORD" ]; then
    echo "Error: KEEPASS_PASSWORD not set. Store master password in env or KeePass." >&2
    return 1
  fi

  echo "Reading golf_bot configuration from KeePass..." >&2

  # Get bot token
  BOT_TOKEN=$(echo "$KEEPASS_PASSWORD" | keepassxc-cli show "$KEEPASS_DB" "golf_bot/golf_book_bot" --show-protected 2>/dev/null | grep "^Username:" | awk '{print $2}')

  # Get club configuration (JSON from Notes)
  CLUB_CONFIG=$(echo "$KEEPASS_PASSWORD" | keepassxc-cli show "$KEEPASS_DB" "golf_bot/kilspindie" --all 2>/dev/null | tail -n +10)

  # Export as env vars (memory only, never logged)
  export GOLF_BOT_TOKEN="$BOT_TOKEN"
  export GOLF_CLUB_CONFIG="$CLUB_CONFIG"

  echo "✅ Credentials loaded (not logged)" >&2
}

# Retrieve a specific entry from KeePass
get_keepass_entry() {
  local ENTRY_PATH="$1"

  if [ -z "$KEEPASS_PASSWORD" ]; then
    echo "Error: KEEPASS_PASSWORD not set" >&2
    return 1
  fi

  echo "$KEEPASS_PASSWORD" | keepassxc-cli show "$KEEPASS_DB" "$ENTRY_PATH" --show-protected --all 2>/dev/null
}

# Security: Never log credentials
redact_logs() {
  sed 's/token=.*/token=***REDACTED***/g' | \
  sed 's/pin=.*/pin=***REDACTED***/g' | \
  sed 's/memberid=.*/memberid=***REDACTED***/g'
}

echo "✅ KeePass helper loaded"
echo "Usage: get_golf_bot_creds  (requires KEEPASS_PASSWORD env var)"
