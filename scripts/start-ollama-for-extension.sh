#!/usr/bin/env sh
set -eu

export OLLAMA_ORIGINS="chrome-extension://*,http://localhost:*,http://127.0.0.1:*"
exec ollama serve
