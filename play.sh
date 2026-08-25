#!/usr/bin/env sh
# ---------------------------------------------------------------------------
#  Chance of Precipitation — start the game without npm.
#
#  The project has no runtime dependencies, so this is all "npm start" did.
#  Arguments pass through:  ./play.sh --port 9000
# ---------------------------------------------------------------------------
set -e
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" ]; then
  NODE="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" | tail -1)/bin/node"
else
  echo
  echo "  Could not find Node.js. You do not need admin rights to install it:"
  echo "  download the binary tarball from https://nodejs.org/en/download and"
  echo "  unpack it somewhere you own, or use nvm."
  echo
  exit 1
fi

exec "$NODE" tools/serve.js --open "$@"
