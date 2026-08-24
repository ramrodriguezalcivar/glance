#!/bin/sh
# Started by com.example.glance.app. The window retries loading on its own
# if the server is not up yet, so start order does not matter.
#
# launchd gives us a minimal PATH, and node_modules/.bin/electron is a
# `#!/usr/bin/env node` shim - it exits 127 without Homebrew on PATH.
PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
cd "$(dirname "$0")/.." || exit 1
[ -f glance.env ] && . ./glance.env
exec ./app/node_modules/.bin/electron ./app
