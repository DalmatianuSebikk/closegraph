#!/usr/bin/env bash
set -euo pipefail
if [ ! -d vendor/excalidraw ]; then
  git clone --depth 1 https://github.com/excalidraw/excalidraw vendor/excalidraw
fi
git -C vendor/excalidraw rev-parse HEAD
