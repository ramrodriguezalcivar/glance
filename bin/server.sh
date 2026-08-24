#!/bin/sh
# Started by com.example.glance.server. Keeps server.js dependency-free by
# sourcing config from glance.env rather than baking it into the plist.
cd "$(dirname "$0")/.." || exit 1
[ -f glance.env ] && . ./glance.env
exec /opt/homebrew/bin/node server.js
