#!/bin/bash
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if curl -fs http://localhost:3000/api/health >/dev/null 2>&1; then
  open "http://localhost:3000"
  exit 0
fi
(sleep 1 && open "http://localhost:3000") &
node server.js
