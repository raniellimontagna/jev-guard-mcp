#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname -- "$SCRIPT_DIR")

if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  TYPESAFE_API_KEY=$(security find-generic-password -s typesafe-api-key -w)
  export TYPESAFE_API_KEY
fi

exec node "$PROJECT_DIR/dist/src/index.js"
