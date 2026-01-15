#!/usr/bin/env bash
set -euo pipefail

USERNAME="${USERNAME:-agent}"

if ! id -u "${USERNAME}" >/dev/null 2>&1; then
  echo "User ${USERNAME} not found; running as root."
  exec "$@"
fi

TARGET_UID="$(id -u "${USERNAME}")"
TARGET_GID="$(id -g "${USERNAME}")"

DESIRED_UID="${LOCAL_UID:-$TARGET_UID}"
DESIRED_GID="${LOCAL_GID:-$TARGET_GID}"
CHOWN_HOME=0

if [ "$DESIRED_UID" != "$TARGET_UID" ]; then
  usermod -u "$DESIRED_UID" "$USERNAME"
  TARGET_UID="$DESIRED_UID"
  CHOWN_HOME=1
fi

if [ "$DESIRED_GID" != "$TARGET_GID" ]; then
  EXISTING_GROUP="$(getent group "$DESIRED_GID" | cut -d: -f1 || true)"
  if [ -n "$EXISTING_GROUP" ]; then
    usermod -g "$EXISTING_GROUP" "$USERNAME"
  else
    groupmod -g "$DESIRED_GID" "$USERNAME"
  fi
  TARGET_GID="$DESIRED_GID"
  CHOWN_HOME=1
fi

if [ "$CHOWN_HOME" -eq 1 ]; then
  chown -R "${TARGET_UID}:${TARGET_GID}" /home/"${USERNAME}"
fi

HOME_DIR="$(getent passwd "${USERNAME}" | cut -d: -f6)"
if [ -n "$HOME_DIR" ]; then
  mkdir -p "$HOME_DIR/.codex"
  chown -R "${TARGET_UID}:${TARGET_GID}" "$HOME_DIR/.codex"
  export HOME="$HOME_DIR"
  export USER="$USERNAME"
fi

exec gosu "${USERNAME}" "$@"
