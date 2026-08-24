'use strict';

// Electron wrapper for Glance.
// This process pins a window to the 5-inch panel and forwards one hotkey.
// It contains no arbitration logic - see ../README.md.

const { app, BrowserWindow, globalShortcut, screen, powerMonitor, dialog } = require('electron');
const http = require('http');

const PORT = 7777;                       // must match server.js and hooks.snippet.json
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}/`;
const ACCEL = 'Control+Alt+Command+D';   // NOT Alt+Command+D - macOS owns that (Dock toggle)
// With the panel switched off at night macOS drops the display, and falling back
// to the primary screen puts a 1280x720 window in the middle of his work. That
// fallback exists for developing without the dock, so it is opt-in now.
const DEV = process.env.GLANCE_DEV === '1';

// Any HDMI display works — this only has to match the one you want the panel on.
// A cheap 5-7" panel is typically 1280x720 or 1024x600. See docs/HARDWARE.md.
const PANEL_W = parseInt(process.env.GLANCE_PANEL_W || '1280', 10);
const PANEL_H = parseInt(process.env.GLANCE_PANEL_H || '720', 10);

let win = null;
let placeTimer = null;

const log = (...a) => console.log('[glance]', ...a);

// ------------------------------------------------------------- display

// Returns the 5-inch panel, or null when it is not plugged in.
function findPanel() {
  const all = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  const matches = all.filter((d) => {
    const { width: lw, height: lh } = d.bounds;
    const pw = Math.round(lw * d.scaleFactor);
    const ph = Math.round(lh * d.scaleFactor);
    return (lw === PANEL_W && lh === PANEL_H) || (pw === PANEL_W && ph === PANEL_H);
  });
  // Prefer an external match; the built-in display can coincidentally match.
  return matches.find((d) => d.id !== primaryId) || matches[0] || null;
}

function place() {
  if (!win || win.isDestroyed()) return;
  const panel = findPanel();
  const target = panel || screen.getPrimaryDisplay();

  // If the panel is the ONLY display, it is not a panel any more - it is the
  // user's entire workspace. Covering it with an always-on-top window at
  // screen-saver level leaves nothing clickable, including the display-settings
  // dialog you need to get your real monitor back. Happens whenever a shared
  // monitor is switched to another machine.
  if (screen.getAllDisplays().length < 2 && !DEV) {
    log('only one display attached - standing down until a second one appears');
    win.hide();
    return;
  }

  if (!panel && !DEV) {
    // The panel is off or unplugged. Wait for it rather than colonising the
    // main screen; display-added brings us straight back.
    log(`no ${PANEL_W}x${PANEL_H} display - hiding until it returns (GLANCE_DEV=1 to show on primary)`);
    win.hide();
    return;
  }

  if (!panel) {
    log(
      `no ${PANEL_W}x${PANEL_H} display found - GLANCE_DEV=1, so showing on primary at ${PANEL_W}x${PANEL_H}. ` +
      `Displays seen: ${screen.getAllDisplays().map((d) => `${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}x`).join(', ')}`
    );
  } else {
    log(`panel found: display ${panel.id} at ${panel.bounds.x},${panel.bounds.y}`);
  }

  const w = panel ? panel.bounds.width : PANEL_W;
  const h = panel ? panel.bounds.height : PANEL_H;
  // Level first, then position: a normal-level window gets clamped below the
  // menu bar, and the clamp sticks even after the level is raised.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setBounds({ x: target.bounds.x, y: target.bounds.y, width: w, height: h });
  win.show();
}

// macOS fires display events in bursts on wake/unplug. Settle first.
function schedulePlace(why) {
  log('re-placing:', why);
  clearTimeout(placeTimer);
  placeTimer = setTimeout(place, 600);
}

// ------------------------------------------------------------- dismiss

// Calls the server. The rules (snooze one UID, refuse under T-2) live there.
function dismiss() {
  const req = http.request(
    { host: HOST, port: PORT, path: '/dismiss', method: 'POST', timeout: 2000 },
    (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => log(`dismiss -> ${res.statusCode} ${body.trim()}`));
    }
  );
  req.on('timeout', () => { req.destroy(); log('dismiss -> timeout (is server.js running?)'); });
  req.on('error', (e) => log('dismiss -> failed:', e.message));
  req.end();
}

// ------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    resizable: true,              // setBounds is ignored on macOS when false
    movable: false,
    enableLargerThanScreen: true, // macOS: do not constrain us to the work area
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,             // never steals focus from the terminal
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The server may not be up yet (LaunchAgent ordering). Keep retrying.
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`load failed (${code} ${desc}), retrying in 2s`);
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(URL); }, 2000);
  });

  win.loadURL(URL);
  win.once('ready-to-show', () => { place(); win.show(); });
}

// ------------------------------------------------------------- boot

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();       // panel app, not a Dock citizen
  createWindow();

  // Fail loudly. A silently-unregistered hotkey is an hour of confusion.
  if (globalShortcut.isRegistered(ACCEL)) {
    const msg = `${ACCEL} is already registered by another application. Dismiss hotkey unavailable.`;
    log('FATAL:', msg);
    dialog.showErrorBox('Glance: hotkey unavailable', msg);
  } else if (!globalShortcut.register(ACCEL, dismiss)) {
    const msg = `globalShortcut.register('${ACCEL}') returned false. macOS or another app is holding this combination. Dismiss hotkey unavailable.`;
    log('FATAL:', msg);
    dialog.showErrorBox('Glance: hotkey unavailable', msg);
  } else {
    log(`hotkey registered: ${ACCEL} -> POST /dismiss`);
  }

  // Escape hatch. Not a panel feature - a way out if the window is ever in the
  // way. Silent if the combination is unavailable; it is insurance, not core.
  const ESCAPE = 'Control+Alt+Command+0';
  if (!globalShortcut.isRegistered(ESCAPE)) {
    const ok = globalShortcut.register(ESCAPE, () => {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) { log('hidden by hotkey'); win.hide(); }
      else { log('shown by hotkey'); place(); }
    });
    log(ok ? `escape hatch: ${ESCAPE} hides/shows the window`
           : `escape hatch ${ESCAPE} unavailable (in use elsewhere)`);
  }

  screen.on('display-added', () => schedulePlace('display-added'));
  screen.on('display-removed', () => schedulePlace('display-removed'));
  screen.on('display-metrics-changed', () => schedulePlace('display-metrics-changed'));
  powerMonitor.on('resume', () => schedulePlace('system resume'));

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
