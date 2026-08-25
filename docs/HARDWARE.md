# Hardware

Glance needs a second display and nothing else. There is no SDK, no firmware,
no driver — macOS treats the panel as an ordinary monitor and the app pins a
window to it. That is deliberate: it means almost any screen works.

## You may already own one

Before buying anything: some docks, drive enclosures and keyboards now ship with
a small display on the front that goes unused. If one of those is on your desk
already, it is very likely a plain second display to the OS, and it will work.
That is what the author's own panel is — a 1280x720 screen built into a
Thunderbolt 5 SSD enclosure, bought for the storage, not the screen.

## Choosing a screen

| | what to look for |
|---|---|
| **Connection** | HDMI, or USB-C with DisplayPort alt-mode. Avoid "USB display" panels that need a vendor driver — those are the ones that will not work |
| **Size** | 5-7" sits well beside a keyboard. Bigger stops being peripheral and starts competing with your main screen |
| **Resolution** | 1280x720 is the sweet spot and the default. 1024x600 is common and fine — set `GLANCE_PANEL_W`/`H` |
| **Brightness** | Look for adjustable backlight. This thing is on all night |
| **Power** | Many small panels need USB power *and* HDMI. Check before buying |

Typical cost is $35-50. Search terms that land on the right category: *"5 inch
HDMI IPS display module"*, *"portable mini monitor HDMI 1024x600"*.

## Placement

The design assumes the panel is **below eye level and looked down at**, roughly
an arm's length away, with the bottom edge nearest you. That is why the strip —
the line that tells you what wants your attention — is pinned to the bottom.

If yours sits above eye level, the layout still works but the strip is then the
far edge rather than the near one, which is worth knowing before you decide the
design is wrong.

## A case

Any stand works. If you are printing one, the things that matter:

- **Angle.** 15-25° back from vertical suits a desk. Flat is unreadable, upright
  catches ceiling lights
- **Cable exit at the bottom or rear**, not the side — two cables leaving
  sideways is what makes these look like a prototype
- **Do not enclose the back fully.** These panels get warm and are usually
  passively cooled
- **Leave the backlight control reachable** if the board has one

A replica-Macintosh case is a pleasing option and roughly the right proportions
for a 5" panel, but nothing in the software assumes it.

## Non-macOS

The server and the browser client are plain Node and plain HTML — they run
anywhere. Two pieces are macOS-only:

- **The Electron wrapper** (`app/`), which finds the display and registers the
  global hotkey. On Linux, a kiosk browser plus a window-manager rule does the
  same job in fewer lines
- **The local calendar reader** (`GLANCE_LOCALCAL`), which reads macOS
  Calendar's SQLite store. Elsewhere, use published `.ics` feeds

Neither is load-bearing for the panel itself. A Raspberry Pi in kiosk mode
pointed at `http://<your-mac>:7777` works, if you also change the server to
bind beyond loopback — which you should think about before doing.
