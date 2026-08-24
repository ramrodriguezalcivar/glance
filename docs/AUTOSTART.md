# Starting at login (macOS)

Two LaunchAgents, both `RunAtLoad` and `KeepAlive`, so each is revived
independently. Order does not matter — the window retries loading when the
server is not up.

Create `~/Library/LaunchAgents/com.example.glance.server.plist` and
`...app.plist`, each pointing at `bin/server.sh` and `bin/app.sh`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.glance.server</string>
  <key>ProgramArguments</key><array><string>/FULL/PATH/glance/bin/server.sh</string></array>
  <key>WorkingDirectory</key><string>/FULL/PATH/glance</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>/FULL/PATH/glance/logs/server.log</string>
  <key>StandardErrorPath</key><string>/FULL/PATH/glance/logs/server.log</string>
</dict>
</plist>
```

Then:

```sh
mkdir -p logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.glance.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.glance.app.plist
launchctl list | grep glance
```

## Two things that will bite you

**`bin/app.sh` pins `PATH`.** launchd gives a minimal one, and
`node_modules/.bin/electron` is a `#!/usr/bin/env node` shim — without Homebrew
on `PATH` the agent dies with exit 127 and no useful message.

**Permission prompts appear twice.** macOS attributes Automation and Full Disk
Access to the *parent* process, so your terminal and the launchd-run server are
separate grants. Approve both.

## Restarting after a config change

```sh
launchctl kickstart -k gui/$(id -u)/com.example.glance.server
```

The server reads `glance.env` once at startup, so an edit needs this.
