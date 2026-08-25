#!/usr/bin/env node
'use strict';

// Glance - see README.md for the contract.
// Zero dependencies on purpose. Do not add any.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------- config

const PORT = 7777;              // hard-coded, never auto-selected. See README.
const HOST = '127.0.0.1';       // loopback only.

const MOCK = process.env.MOCK === '1';
const MOCK_FAST = process.env.MOCK_FAST === '1';
// GLANCE_ICS is the unlabelled source; GLANCE_ICS_<LABEL> adds named ones, so
// several calendars can be merged and each meeting still knows where it came
// from. e.g. GLANCE_ICS_FAMILY, GLANCE_ICS_WORK.
function icsSources() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k === 'GLANCE_ICS') out.push({ source: 'calendar', url: v });
    else if (k.startsWith('GLANCE_ICS_')) {
      out.push({ source: k.slice('GLANCE_ICS_'.length).toLowerCase(), url: v });
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}
const ICS = icsSources();
const LATLON = process.env.GLANCE_LATLON || '';   // "51.48,0.00" - enables weather
const MASCOT = process.env.GLANCE_MASCOT || '';   // you-a | you-b | you-c
// macOS Calendar.app source, for accounts that cannot be published as .ics
// (New Outlook exposes no calendar AppleScript, and the local store needs Full
// Disk Access). Read over Apple Events, which is slow — a filter pass scans the
// whole calendar — so this polls far less often than a URL source.
const MACCAL = process.env.GLANCE_MACCAL || '';            // calendar index or name
const MACCAL_LABEL = (process.env.GLANCE_MACCAL_LABEL || 'work').toLowerCase();
// Default 15 min. One full read is ~45s of Calendar.app churn over Apple
// Events (three filter passes over the whole calendar), so this cannot be
// polled like a URL. 15min keeps the duty cycle ~5% and still catches anything
// scheduled more than a quarter hour ahead, which is nearly everything.
const MACCAL_POLL_MS = Math.max(60000, parseInt(process.env.GLANCE_MACCAL_POLL_MS || '900000', 10));
const MACCAL_DAYS = 3;
// macOS keeps every calendar as real .ics files under ~/Library/Calendars.
// They carry RRULE/EXDATE, so the same parser the webcal sources use handles
// them correctly — unlike AppleScript, which hands back recurring events as
// masters stuck at their original start date and silently drops the series.
// Needs Full Disk Access; does nothing without it.
const LOCALCAL = process.env.GLANCE_LOCALCAL === '1';
const LOCALCAL_EXCLUDE = (process.env.GLANCE_LOCALCAL_EXCLUDE
  || 'birthdays,siri suggestions,us holidays,united states holidays,scheduled reminders')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
// Which source goes UNMARKED in peek — the high-volume one, since a tag on
// every row is a tag on none. Derived from config rather than hardcoded, so
// renaming a source label cannot silently invert the rule. Absent = no tags.
const DEFAULT_SOURCE = (process.env.GLANCE_DEFAULT_SOURCE
  || (process.env.GLANCE_MACCAL ? (process.env.GLANCE_MACCAL_LABEL || 'work') : '')).toLowerCase();
const DEBUG = process.env.DEBUG === '1';

// MOCK_FAST reads the ladder in seconds so it can be rehearsed without waiting.
const UNIT = MOCK_FAST ? 1000 : 60000;
const T_NOW = 2 * UNIT;
const T_SOON = 5 * UNIT;
const T_HEADSUP = 10 * UNIT;

// v6: source changes lead time, never loudness. A work meeting at T-5 is fine
// because joining takes thirty seconds; a family event at T-5 may already be
// lost if you have to drive. Same ladder, started earlier.
//   GLANCE_LEAD_FAMILY="20,10,5"   headsup,soon,now in minutes
function leadTimes() {
  const out = { default: { headsup: T_HEADSUP, soon: T_SOON, now: T_NOW } };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GLANCE_LEAD_') || !v) continue;
    const [a, b, c] = String(v).split(',').map((x) => parseFloat(x.trim()));
    if (![a, b, c].every((n) => Number.isFinite(n) && n > 0)) {
      log(`GLANCE_LEAD_${k.slice(12)} malformed, expected "headsup,soon,now" in minutes`);
      continue;
    }
    out[k.slice('GLANCE_LEAD_'.length).toLowerCase()] =
      { headsup: a * UNIT, soon: b * UNIT, now: c * UNIT };
  }
  return out;
}
const LEAD = leadTimes();
const leadFor = (src) => LEAD[src] || LEAD.default;

const CAL_POLL_MS = 60000;
const WEATHER_POLL_MS = 15 * 60000;
const FORECAST_HOURS = 3;                          // the horizon Glance asks for
const SESSION_TTL_MS = 10 * 60000;
// Backstop for a session that dies without Stop/SessionEnd (terminal closed,
// crash). Real work posts Pre/PostToolUse constantly, so prolonged silence
// means it is not working. Long enough not to trip on a slow single tool call.
const WORKING_STALE_MS = 3 * 60000;
// `Stop` fires whether Claude asked a question or just finished the job - the
// hook cannot tell those apart. So "your turn" is only honest while it is
// recent. After this it decays to idle: a session that came back to you four
// minutes ago is news, one that came back an hour ago is just a session.
const AWAITING_FRESH_MS = 4 * 60000;
const TICK_MS = 1000;
const HEARTBEAT_MS = 8000;   // client's watchdog is 30s; its contract asks for <=10s
const MAX_LINE = 28;
const MAX_LISTED_SESSIONS = 6;    // DeskMonitor draws one bar per session
// v6: peek duration is derived, not chosen — 2s to notice the list arrived,
// 1s per row to read it, capped. PEEK_MS is the cap, not the duration.
// CD's formula: "2s to notice the list arrived + 1s per row to read it", capped.
// Tunable because they said so explicitly — "if it still feels short on the real
// panel, raise the cap". Reading three 28-char meeting names is ~5s of pure
// reading before you have located the panel, so the default is tight.
const PEEK_MS = parseInt(process.env.GLANCE_PEEK_MAX_MS || '8000', 10);
const PEEK_BASE_MS = parseInt(process.env.GLANCE_PEEK_BASE_MS || '2000', 10);
const PEEK_ROW_MS = parseInt(process.env.GLANCE_PEEK_ROW_MS || '1000', 10);
const AGENDA_MAX = 3;
const PEEK_SESSION_ROWS_MAX = 4;   // PeekList names 4, then an overflow row

// v7: each peek column floors at one row — an empty column renders its own
// "nothing" line, and that line is a row you read, so it counts. This is why
// peek can never be a blank rectangle, and why the 2s empty peek cannot occur.
// Must match PeekList's peekRows() exactly; the server owns the countdown, so
// if they ever disagree the display should drain from peek.secondsLeft.
function peekRows(list, ag) {
  const named = Math.min(list.length, PEEK_SESSION_ROWS_MAX);
  const sessionRows = list.length > PEEK_SESSION_ROWS_MAX ? named + 1 : named;
  return Math.max(1, sessionRows) + Math.max(1, ag.length);
}
const HINT_MS = 6000;                    // how long the dismiss hint rides the strip
const HINT_TEXT = 'CTRL+OPT+CMD+D to dismiss';   // ASCII: ⌃⌥⌘ font-fallback badly
// 7 days, not 24h. This only feeds `agenda` (peek's right column) and the
// list occurrences are drawn from — the escalation ladder still only fires
// inside the per-source lead times, so a wider window cannot make the panel
// shout earlier. A family calendar is sparse enough that 24h is usually empty.
const LOOKAHEAD_MS = 7 * 24 * 3600 * 1000;

// ---------------------------------------------------------------- state
// In memory only. Nothing here is ever written to disk.

const sessions = new Map();   // id -> { state, tool, at }
const refused = new Set();    // meeting keys already told "no" once - see v6
const snoozed = new Set();    // meeting occurrence keys, dismissed pre-start
const acked = new Set();      // meeting occurrence keys, acknowledged after start
let occurrences = [];         // sorted upcoming meetings
let lastPayload = '';
let weather = null;           // { condition, tempC, trend: { tempC, at, storm } }
let flash = null;             // { text, until } - transient ack, e.g. a refused dismiss
let peekUntil = 0;            // the panel is showing the full session list until this
let lastPhase = null;         // for edge-triggered force-exit, see sweep below

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- ics

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = left.split(';');
  const params = {};
  for (let k = 1; k < parts.length; k++) {
    const j = parts[k].indexOf('=');
    if (j > 0) params[parts[k].slice(0, j).toUpperCase()] = parts[k].slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0].toUpperCase(), params, value };
}

// Offset of `tz` from UTC at a given instant, in ms.
function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const h = p.hour === '24' ? 0 : +p.hour;
  return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) - utcMs;
}

// Wall-clock time in `tz` -> UTC ms. Two passes settle DST boundaries.
function zonedToUTC(y, mo, d, h, mi, s, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    try { guess = naive - tzOffsetMs(tz, guess); } catch { return naive; }
  }
  return guess;
}

// Returns { ms, dateOnly } or null.
function parseDT(value, params) {
  const v = value.trim();
  const dateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), dateOnly };
  if (params.TZID) return { ms: zonedToUTC(+y, +mo, +d, +h, +mi, +s, params.TZID), dateOnly };
  return { ms: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), dateOnly };  // floating = local
}

function parseICS(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = { exdates: new Set() }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.summary = p.value.replace(/\\,/g, ',').replace(/\\n/gi, ' ').replace(/\\\\/g, '\\'); break;
      case 'STATUS': if (p.value.toUpperCase() === 'CANCELLED') cur.cancelled = true; break;
      case 'RRULE': cur.rrule = p.value; break;
      case 'DTSTART': { const d = parseDT(p.value, p.params); if (d) { cur.start = d.ms; cur.dateOnly = d.dateOnly; } break; }
      case 'DTEND': { const d = parseDT(p.value, p.params); if (d) cur.end = d.ms; break; }
      case 'EXDATE':
        for (const piece of p.value.split(',')) {
          const d = parseDT(piece, p.params);
          if (d) cur.exdates.add(d.ms);
        }
        break;
    }
  }
  return events;
}

// Urgency order for listing sessions. Same order the aggregate picks by.
const STATE_RANK = { needs_input: 0, working: 1, awaiting: 2, idle: 3 };

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(s) {
  const o = {};
  for (const kv of s.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
  }
  return {
    freq: (o.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(o.INTERVAL || '1', 10) || 1),
    count: o.COUNT ? parseInt(o.COUNT, 10) : null,
    until: o.UNTIL ? (parseDT(o.UNTIL, {}) || {}).ms ?? null : null,
    byday: o.BYDAY ? o.BYDAY.split(',').map(d => WEEKDAYS[d.slice(-2).toUpperCase()]).filter(n => n !== undefined) : null,
  };
}

const DAY = 86400000;

// Expand one event into occurrences overlapping [from, to].
function expand(ev, from, to) {
  if (!ev.start || ev.cancelled) return [];
  // All-day events are still not meetings - they have no moment to count down
  // to and must never ride the ladder - but they are 71% of a family calendar,
  // so they are carried separately rather than discarded.
  const allDay = !!ev.dateOnly;
  const dur = ev.end && ev.end > ev.start ? ev.end - ev.start
    : (allDay ? 86400000 : 3600000);
  const out = [];
  const emit = (start) => {
    if (ev.exdates.has(start)) return;
    const end = start + dur;
    if (end <= from || start >= to) return;
    out.push({ uid: ev.uid || String(start), key: (ev.uid || 's') + '@' + start,
               summary: ev.summary || 'Meeting', start, end, allDay });
  };

  if (!ev.rrule) { emit(ev.start); return out; }

  const r = parseRRule(ev.rrule);
  if (r.freq !== 'DAILY' && r.freq !== 'WEEKLY') { emit(ev.start); return out; }

  const base = new Date(ev.start);
  const days = r.freq === 'WEEKLY' && r.byday && r.byday.length ? r.byday.slice().sort((a, b) => a - b) : [base.getDay()];
  let n = 0;                                   // occurrence ordinal, for COUNT
  const CAP = 3000;
  const stepMs = (r.freq === 'DAILY' ? r.interval : r.interval * 7) * DAY;

  for (let i = 0, cursor = ev.start; i < CAP; i++, cursor += stepMs) {
    const slots = r.freq === 'DAILY'
      ? [cursor]
      : days.map(d => cursor + ((d - new Date(cursor).getDay() + 7) % 7) * DAY);
    let anyBefore = false;
    for (const s of slots.sort((a, b) => a - b)) {
      if (s < ev.start) continue;
      if (r.count !== null && n >= r.count) return out;
      if (r.until !== null && s > r.until) return out;
      n++;
      emit(s);
      if (s < to) anyBefore = true;
    }
    if (!anyBefore && cursor > to) break;
  }
  return out;
}

// ---------------------------------------------------------------- weather
// The panel has no network by design, so the server fetches and the client
// just renders. Open-Meteo needs no API key. Location comes from config and is
// never logged.

// WMO code -> the four conditions the display knows about.
function wmoCondition(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  return 'rain';                                   // drizzle, rain, showers, thunder
}
const isStorm = (code) => code === 95 || code === 96 || code === 99;

async function pollWeather() {
  if (!LATLON) return;
  const [lat, lon] = LATLON.split(',').map((x) => x.trim());
  if (!lat || !lon) return log('GLANCE_LATLON malformed, expected "lat,lon"');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}&current=temperature_2m,weather_code` +
    `&hourly=temperature_2m,weather_code&forecast_hours=${FORECAST_HOURS + 1}&timezone=auto`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const cur = d.current || {};
    const h = d.hourly || {};
    const times = h.time || [];
    const temps = h.temperature_2m || [];
    const codes = h.weather_code || [];
    const i = Math.min(FORECAST_HOURS, times.length - 1);
    weather = {
      condition: wmoCondition(cur.weather_code),
      temp: Math.round(cur.temperature_2m),
      next: i >= 0 ? {
        at: String(times[i]).slice(11, 16),          // "15:00" local
        temp: Math.round(temps[i]),
        // Only a storm gets an accent colour, so only a storm is flagged.
        storm: codes.slice(0, i + 1).some(isStorm),
      } : null,
    };
  } catch (e) {
    log('weather poll failed:', e.message);          // keep last known
  }
}

// ---------------------------------------------------------------- local store

let localOccurrences = [];
let localAllDay = [];

function calendarTitle(dir) {
  // Info.plist is binary or XML; pull the Title either way without a parser.
  try {
    const raw = fs.readFileSync(path.join(dir, 'Info.plist'));
    const txt = raw.toString('latin1');
    const xml = txt.match(/<key>Title<\/key>\s*<string>([^<]*)<\/string>/);
    if (xml) return xml[1];
    const bin = txt.match(/Title[\x00-\x20]{1,4}([A-Za-z0-9 ._'\-]{1,60})/);
    if (bin) return bin[1].trim();
  } catch { /* unreadable */ }
  return path.basename(dir, '.calendar');
}

// macOS stores calendars in Calendar.sqlitedb, not .ics files. Recurrence lives
// in Apple's own encoding rather than an RRULE string, but it decodes cleanly:
// frequency 1..4 = DAILY/WEEKLY/MONTHLY/YEARLY, and `specifier` is "D=0MO,0FR"
// for BYDAY. Rebuilding a standard RRULE lets the same expander the .ics sources
// use handle it — which AppleScript could not, since it hands back recurring
// events as masters pinned to their original start date.
const CD_EPOCH = 978307200;                       // Core Data: seconds since 2001-01-01
const cdms = (v) => (Number(v) + CD_EPOCH) * 1000;
const FREQ = { 1: 'DAILY', 2: 'WEEKLY', 3: 'MONTHLY', 4: 'YEARLY' };

function rruleFrom(row) {
  const f = FREQ[row.frequency];
  if (!f) return '';
  let r = 'FREQ=' + f;
  if (row.interval > 1) r += ';INTERVAL=' + row.interval;
  if (row.specifier) {
    const days = String(row.specifier).replace(/^D=/, '').split(',')
      .map((d) => d.replace(/^[-0-9]+/, '').trim()).filter(Boolean);
    if (days.length) r += ';BYDAY=' + days.join(',');
  }
  if (row.count > 0) r += ';COUNT=' + row.count;
  else if (row.r_end) r += ';UNTIL=' + new Date(cdms(row.r_end)).toISOString()
    .replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return r;
}

function pollLocalCalendars() {
  if (!LOCALCAL) return;
  const now = Date.now();
  const from = now - 3600000, to = now + LOOKAHEAD_MS;
  const dbPath = path.join(process.env.HOME || '', 'Library', 'Group Containers',
    'group.com.apple.calendar', 'Calendar.sqlitedb');
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    return log('local calendar open failed:', (e.code || e.message || '').slice(0, 90));
  }
  try {
    const lo = (from / 1000) - CD_EPOCH, hi = (to / 1000) - CD_EPOCH;
    const rows = db.prepare(`
      select ci.ROWID id, ci.summary, ci.start_date, ci.end_date, ci.all_day,
             ci.status, c.title cal,
             r.frequency, r.interval, r.specifier, r.count, r.end_date r_end
      from CalendarItem ci
      join Calendar c on c.ROWID = ci.calendar_id
      left join Recurrence r on r.owner_id = ci.ROWID
      where ci.summary is not null
        and ((ci.start_date between ? and ?) or r.ROWID is not null)`).all(lo, hi);

    let ex = new Map();
    try {
      for (const e of db.prepare('select owner_id, date from ExceptionDate').all()) {
        if (!ex.has(e.owner_id)) ex.set(e.owner_id, []);
        ex.get(e.owner_id).push(cdms(e.date));
      }
    } catch { /* no exceptions table shape we know - skip */ }

    const timed = [], allday = [];
    for (const r of rows) {
      if (r.status === 2) continue;                       // cancelled
      const source = String(r.cal || 'calendar').toLowerCase();
      if (LOCALCAL_EXCLUDE.includes(source)) continue;
      const ev = {
        uid: 'db-' + r.id,
        summary: String(r.summary).trim(),
        start: cdms(r.start_date),
        end: r.end_date ? cdms(r.end_date) : null,
        dateOnly: !!r.all_day,
        rrule: rruleFrom(r),
        exdates: new Set(ex.get(r.id) || []),
        cancelled: false,
      };
      for (const occ of expand(ev, from, to)) {
        (occ.allDay ? allday : timed).push({ ...occ, source });
      }
    }
    localOccurrences = timed;
    localAllDay = allday;
    log(`local calendars: ${rows.length} rows -> ${timed.length} timed + ${allday.length} all-day`);
  } catch (e) {
    log('local calendar read failed:', (e.code || e.message || '').slice(0, 120));
  } finally {
    try { db.close(); } catch {}
  }
}

function pollLocalCalendarsOld() {
  if (!LOCALCAL) return;
  const root = path.join(process.env.HOME || '', 'Library', 'Calendars');
  const now = Date.now();
  const from = now - 3600000, to = now + LOOKAHEAD_MS;
  const timed = [], allday = [];
  let cals = 0, files = 0;
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith('.calendar')) continue;
      const dir = path.join(root, entry);
      const title = calendarTitle(dir);
      if (LOCALCAL_EXCLUDE.includes(title.toLowerCase())) continue;
      const evDir = path.join(dir, 'Events');
      let names = [];
      try { names = fs.readdirSync(evDir); } catch { continue; }
      cals++;
      const source = title.toLowerCase();
      for (const f of names) {
        if (!f.endsWith('.ics')) continue;
        files++;
        try {
          for (const ev of parseICS(fs.readFileSync(path.join(evDir, f), 'utf8'))) {
            for (const occ of expand(ev, from, to)) {
              (occ.allDay ? allday : timed).push({ ...occ, source });
            }
          }
        } catch { /* skip a malformed file rather than lose the calendar */ }
      }
    }
    localOccurrences = timed;
    localAllDay = allday;
    log(`local calendars: ${cals} calendars, ${files} files, ${timed.length} timed + ${allday.length} all-day`);
    if (!cals) {
      let top = [];
      try { top = fs.readdirSync(root).slice(0, 25); } catch (e) { top = ['<' + e.code + '>']; }
      log('  store contents:', JSON.stringify(top));
      const H = process.env.HOME;
      for (const c of [
        H + '/Library/Calendars',
        H + '/Library/Group Containers/group.com.apple.calendar',
        H + '/Library/Application Support/Calendar',
        H + '/Library/Containers/com.apple.CalendarAgent/Data/Library/Calendars',
      ]) {
        let r;
        try { r = fs.readdirSync(c).slice(0, 12); } catch (e) { r = e.code; }
        log('  probe', c.replace(H, '~'), '->', JSON.stringify(r));
      }

    }
  } catch (e) {
    log('local calendar read failed:', e.code || e.message,
        e.code === 'EPERM' ? '- Full Disk Access not granted' : '');
  }
}

// ---------------------------------------------------------------- mac calendar

const MONTHS = ['january','february','march','april','may','june','july',
                'august','september','october','november','december'];

// "Monday, August 24, 2026 at 1:00:00 PM" -> epoch ms, in local time.
function parseAppleDate(str) {
  const m = String(str).match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  if (mo < 0) return null;
  let h = parseInt(m[4], 10);
  const ap = (m[7] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return new Date(+m[3], mo, +m[2], h, +m[5], +m[6]).getTime();
}

function runOsa(script) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('osascript', ['-e', script], { timeout: 120000, maxBuffer: 8 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

let macOccurrences = [];
let allDayEvents = [];
let macCalName = '';

// All-day entries covering today. No time, so no ladder and no countdown.
function allDayToday(now) {
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = dayStart + 86400000;
  return allDayEvents
    .filter((o) => o.start < dayEnd && o.end > dayStart)
    .slice(0, 4)
    .map((o) => ({ summary: trunc(o.summary), source: o.source || 'calendar' }));
}

// GLANCE_MACCAL is an index when numeric, and indexes shift if an account is
// added or removed. Log what it actually resolved to so drift is visible.
async function checkMacCalendar() {
  if (!MACCAL) return;
  const sel = /^\d+$/.test(MACCAL) ? `calendar ${MACCAL}` : `calendar "${MACCAL}"`;
  try {
    macCalName = (await runOsa(`tell application "Calendar" to return name of ${sel}`)).trim();
    log(`mac calendar resolved: ${MACCAL} -> "${macCalName}" as source "${MACCAL_LABEL}"`);
  } catch (e) {
    log('mac calendar could not be resolved:', e.message.slice(0, 120));
  }
}

async function pollMacCalendar() {
  if (!MACCAL) return;
  const sel = /^\d+$/.test(MACCAL) ? `calendar ${MACCAL}` : `calendar "${MACCAL}"`;
  const win = `set d1 to (current date) - (1 * hours)
    set d2 to d1 + (${MACCAL_DAYS} * days)`;
  // Three bulk fetches. The per-event form is ~12x slower - do not "tidy" this
  // into a repeat loop over event references.
  // The delimiter must be set OUTSIDE the tell block and qualified: inside one,
  // `text item delimiters` resolves to Calendar's own property and errors -10006.
  const q = (prop) => `set AppleScript's text item delimiters to "@@|@@"
  tell application "Calendar"
    ${win}
    set r to ${prop} of (every event of ${sel} whose start date is greater than d1 and start date is less than d2)
  end tell
  return r as string`;
  try {
    // Ask Calendar to pull from Exchange first. The panel is two sync hops from
    // the server (Exchange -> Calendar.app -> here), and only the second is ours.
    // This does not guarantee freshness, but it removes the hop we can influence.
    try { await runOsa('tell application "Calendar" to reload calendars'); } catch {}
    // Sequential, not Promise.all: concurrent Apple Events to one app contend
    // and hang rather than overlapping.
    const t0 = Date.now();
    const names = await runOsa(q('summary'));
    const starts = await runOsa(q('start date'));
    const ends = await runOsa(q('end date'));
    const took = Date.now() - t0;
    const sp = (t) => t.replace(/\n$/, '').split('@@|@@');
    const ns = sp(names), ss = sp(starts), es = sp(ends);
    const out = [];
    for (let i = 0; i < ns.length; i++) {
      const start = parseAppleDate(ss[i]);
      if (!start || !ns[i]) continue;
      const end = parseAppleDate(es[i]) || start + 3600000;
      out.push({
        uid: 'maccal-' + i + '-' + start,
        key: 'maccal@' + start + '@' + ns[i],
        summary: ns[i], start, end, source: MACCAL_LABEL,
      });
    }
    macOccurrences = out;
    log(`mac calendar: ${out.length} events in ${(took / 1000).toFixed(1)}s`);
  } catch (e) {
    log('mac calendar poll failed:', e.message);   // keep last known
  }
}

// ---------------------------------------------------------------- calendar

async function loadICS(src) {
  // iCloud and Outlook both hand out webcal:// links; it is http(s) underneath.
  const url = src.replace(/^webcal:\/\//i, 'https://');
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  }
  return fs.readFileSync(url, 'utf8');
}

function mockOccurrences(now) {
  const start = mockOccurrences.start || (mockOccurrences.start = now + 12 * UNIT);
  return [{ uid: 'mock-1', key: 'mock-1@' + start, summary: 'Design review', start, end: start + 30 * UNIT }];
}

async function pollCalendar() {
  const now = Date.now();
  if (MOCK) { occurrences = mockOccurrences(now); return; }
  if (!ICS.length && !macOccurrences.length && !localOccurrences.length) {
    occurrences = []; return;
  }
  const from = now - 3600000, to = now + LOOKAHEAD_MS;
  const all = [];
  let failures = 0;
  for (const { source, url } of ICS) {
    try {
      const text = await loadICS(url);
      for (const ev of parseICS(text)) {
        for (const occ of expand(ev, from, to)) all.push({ ...occ, source });
      }
    } catch (e) {
      failures++;
      log(`calendar "${source}" poll failed:`, e.message);   // URL never logged
    }
  }
  // One source failing must not wipe the others; all failing keeps the last
  // known set rather than silently emptying the panel.
  if (failures === ICS.length && ICS.length) return;
  all.push(...macOccurrences);
  all.push(...localOccurrences);
  all.sort((a, b) => a.start - b.start);
  // The same meeting often sits on two calendars (a work invite mirrored to
  // personal). Same title at the same instant is one meeting; first source wins.
  // Forwarded and re-sent invites arrive as separate events with the same start:
  // "FW: (OPTIONAL) Office Hours" beside "(OPTIONAL) Office Hours" is one meeting
  // wearing three hats. Strip the routing prefixes before comparing.
  const dedupeKey = (o) =>
    o.summary.replace(/^\s*(?:(?:fw|fwd|re|tr)\s*:\s*)+/i, '').trim().toLowerCase()
    + '@' + o.start;
  const seen = new Set();
  const deduped = all.filter((o) => {
    const k = dedupeKey(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  occurrences = deduped.filter((o) => !o.allDay);
  allDayEvents = deduped.filter((o) => o.allDay).concat(localAllDay);
}

function nextMeeting(now) {
  for (const o of occurrences) if (o.end > now) return o;
  return null;
}

const two = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); };
const isTomorrow = (ms) => new Date(ms).toDateString() !== new Date().toDateString();

// What peek lists on its right-hand column.
// Excludes the active meeting - line 0 already carries it.
function agenda(now, activeKey) {
  return occurrences
    .filter((o) => o.end > now && o.key !== activeKey)
    .slice(0, AGENDA_MAX)
    .map((o) => ({
      t: hhmm(o.start),
      name: trunc(o.summary),
      tomorrow: isTomorrow(o.start),
      source: o.source || 'calendar',
    }));
}

function phaseOf(m, now) {
  if (!m) return null;
  const until = m.start - now;
  const L = leadFor(m.source);
  if (until <= 0) return 'started';           // meeting is underway
  if (until <= L.now) return 'now';           // locked, dismissal refused
  if (until <= L.soon) return 't5';
  if (until <= L.headsup) return 't10';
  return null;
}

// How hard the panel should be nagging. 0 = not yet, 3 = you are properly late.
function escalationOf(m, now) {
  const late = now - m.start;
  if (late >= 5 * UNIT) return 3;
  if (late >= 2 * UNIT) return 2;
  return 1;
}

// ---------------------------------------------------------------- sessions

function sweepSessions(now) {
  for (const [id, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(id);
}

function sessionState() {
  const now = Date.now();
  // Decay rather than drop, so a quiet session still counts toward the total
  // and keeps its name - it just stops claiming to need anything.
  const live = [...sessions.values()].map((s) => {
    const quiet = now - s.at;
    if (s.state === 'working' && quiet > WORKING_STALE_MS) return { ...s, state: 'idle' };
    if (s.state === 'awaiting' && quiet > AWAITING_FRESH_MS) return { ...s, state: 'idle' };
    return s;
  });
  const pick = (st) => {
    // Most recently active wins. Map insertion order is arbitrary from the
    // user's point of view - two working sessions would name whichever one
    // happened to register first, which changes answer for no visible reason.
    const hit = live.filter((s) => s.state === st).sort((a, b) => b.at - a.at)[0];
    if (!hit) return null;
    return {
      state: st,
      tool: hit.tool || '',
      label: hit.title || hit.dir || '',
      total: live.length,
      counts: {
        needs_input: live.filter((s) => s.state === 'needs_input').length,
        working: live.filter((s) => s.state === 'working').length,
        awaiting: live.filter((s) => s.state === 'awaiting').length,
      },
    };
  };
  const list = live
    .slice()
    .sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || (b.at - a.at))
    .slice(0, MAX_LISTED_SESSIONS)
    .map((x) => ({
      name: x.title || x.dir || 'Claude',
      state: x.state,
      tool: x.tool || '',
    }));
  const withList = (o) => (o ? Object.assign(o, { list }) : o);

  // needs_input > working > awaiting > idle
  return withList(pick('needs_input')) || withList(pick('working')) || withList(pick('awaiting'))
    || { state: 'idle', tool: '', label: '', total: live.length, list,
         counts: { needs_input: 0, working: 0, awaiting: 0 } };
}

function ingestHook(body) {
  let ev;
  try { ev = JSON.parse(body); } catch { return; }
  if (process.env.PROBE === '1') {
    // Keys only, plus the two path-ish fields. Never values - UserPromptSubmit
    // carries the prompt text and that must not touch disk.
    log('PROBE keys=' + JSON.stringify(Object.keys(ev)) +
        ' cwd=' + JSON.stringify(ev.cwd || null) +
        ' project_dir=' + JSON.stringify(ev.project_dir || ev.projectDir || null) +
        ' transcript=' + JSON.stringify(ev.transcript_path ? '<present>' : null));
  }
  const id = ev.session_id || ev.sessionId || 'default';
  const name = ev.hook_event_name || ev.hookEventName || '';
  const now = Date.now();

  if (name === 'SessionEnd') {
    sessions.delete(id);
    if (DEBUG) log(`hook SessionEnd session=${id.slice(0, 8)} | live=${sessions.size}`);
    return broadcast();
  }

  const cur = sessions.get(id) || { state: 'idle', tool: '', title: '', dir: '' };
  cur.at = now;
  // Claude Code sends session_title on UserPromptSubmit - the name shown in the
  // app. That is what the user thinks of as "the session". cwd is only where it
  // was launched from, which is often a different project entirely.
  if (ev.session_title) cur.title = String(ev.session_title);
  const cwd = ev.cwd || ev.workingDirectory || '';
  if (cwd) cur.dir = cwd.split('/').filter(Boolean).pop() || '';

  switch (name) {
    case 'SessionStart': cur.state = 'idle'; cur.tool = ''; break;
    case 'UserPromptSubmit': cur.state = 'working'; cur.tool = ''; break;
    case 'PreToolUse': cur.state = 'working'; cur.tool = ev.tool_name || ev.toolName || ''; break;
    case 'PostToolUse': cur.state = 'working'; break;
    case 'Notification': cur.state = 'needs_input'; break;
    case 'Stop': cur.state = 'awaiting'; cur.tool = ''; break;
    case 'SubagentStop': break;
    default: break;
  }
  sessions.set(id, cur);
  if (ev.transcript_path || ev.transcriptPath) {
    recoverTitle(id, ev.transcript_path || ev.transcriptPath);
  }
  if (DEBUG) log(`hook ${name} session=${id.slice(0, 8)} -> ${cur.state}${cur.tool ? ' (' + cur.tool + ')' : ''} | live=${sessions.size}`);
  broadcast();
}

// Recover a session title without waiting for the next UserPromptSubmit.
// A session running autonomously never sends one, so it would stay labelled
// with its folder forever. Claude Code records the title in the transcript as
// a `custom-title` / `ai-title` line.
//
// Read-only, and only ever the title field - no message content is parsed out,
// nothing is written, and the path is never logged.
const titleProbe = new Map();   // session id -> last attempt (ms)

const TAIL_BYTES = 256 * 1024;

async function recoverTitle(id, transcriptPath) {
  if (!transcriptPath) return;
  const cur = sessions.get(id);
  if (!cur) return;
  const last = titleProbe.get(id) || 0;
  if (Date.now() - last < 60000) return;      // at most once a minute
  titleProbe.set(id, Date.now());
  // Already named? Only look at the tail - a rename appends a fresh
  // custom-title line, so there is no need to re-read megabytes to find it.
  const refresh = !!cur.title;
  try {
    const stat = await fsp.stat(transcriptPath);
    if (stat.size > 64 * 1024 * 1024) return;
    let text;
    if (refresh && stat.size > TAIL_BYTES) {
      const fh = await fsp.open(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        await fh.read(buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
        text = buf.toString('utf8');          // first line may be partial; it fails to parse and is skipped
      } finally { await fh.close(); }
    } else {
      text = await fsp.readFile(transcriptPath, 'utf8');
    }
    let custom = '', ai = '';
    for (const line of text.split('\n')) {
      if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'custom-title' && o.customTitle) custom = String(o.customTitle);
        else if (o.type === 'ai-title' && o.aiTitle) ai = String(o.aiTitle);
      } catch { /* malformed line, skip */ }
    }
    const now = sessions.get(id);
    if (!now) return;
    // A title you set always wins, and a later one replaces an earlier one.
    // A generated title only fills a blank - it must never overwrite a rename.
    const next = custom || (now.title ? '' : ai);
    if (next && next !== now.title) {
      now.title = next;
      if (DEBUG) log(`title ${refresh ? 'updated' : 'recovered'} for session=${id.slice(0, 8)}`);
      broadcast();
    }
  } catch { /* unreadable or format changed - folder name remains the fallback */ }
}

// ---------------------------------------------------------------- compute
// All arbitration lives here. The client never decides anything.

const trunc = (s) => {
  const t = String(s == null ? '' : s);
  return t.length <= MAX_LINE ? t : t.slice(0, MAX_LINE - 1) + '…';
};

function countdown(m, now) {
  const until = m.start - now;
  if (until <= 0) return 'MEETING NOW';
  const n = Math.ceil(until / UNIT);
  return 'MEETING IN ' + n + (MOCK_FAST ? 's' : 'm');
}

// INTERIM - plain-text multi-session rows. Placeholder until Claude Design
// answers the multi-session question in DESIGN-BRIEF.md. Delete this with the
// branch that calls it.
const STATE_WORD = { needs_input: 'needs you', working: 'working', awaiting: 'waiting' };

function otherRows(s) {
  if (!s.list || s.total <= 1) return [];
  return s.list
    .filter((x) => x.name !== s.label)
    .slice(0, 2)
    .map((x) => `${STATE_WORD[x.state] || x.state} · ${x.name}`);
}

function sessionStrip(s) {
  if (s.state === 'needs_input') return 'Claude · needs you';
  if (s.state === 'working') return 'Claude · working' + (s.tool ? ' · ' + s.tool : '');
  if (s.state === 'awaiting') return 'Claude · your turn';
  return 'Claude · idle';
}

// The session list, compressed to one line and ordered by urgency. Only shown
// when more than one session is live - otherwise it just repeats `main`.
function rollup(s) {
  if (s.total <= 1) return null;
  const c = s.counts;
  const parts = [];
  if (c.needs_input) parts.push(`${c.needs_input} needs you`);
  if (c.working) parts.push(`${c.working} working`);
  if (c.awaiting) parts.push(`${c.awaiting} waiting`);
  return parts.length ? parts.join(' · ') : `${s.total} sessions`;
}

function meetingStrip(m, now) {
  const until = Math.max(0, Math.ceil((m.start - now) / UNIT));
  return until + (MOCK_FAST ? 's' : 'm') + ' · ' + m.summary;
}

function compute(now) {
  const s = sessionState();
  const m = nextMeeting(now);
  const phase = phaseOf(m, now);
  const isSnoozed = m ? snoozed.has(m.key) : false;

  // `strip` is a HINT channel, not a roll-up channel. Per the display contract a
  // string takes the strip's left half VERBATIM; null lets it compose from
  // counts + list with its own pips, name-shedding and rail budget. Sending a
  // composed roll-up here overrode all of that, and blocked the peek hint,
  // whose guard is `if (p.strip) return false`.
  let kind, accent, lines, strip = null, locked = false;
  let dim = false;       // dismissed meetings stay visible but recede
  let escalation = 0;    // 0 none, 1..3 increasingly late for a meeting

  if (phase === 'started' && !acked.has(m.key)) {
    // 0. Meeting is underway and unacknowledged. Outranks everything, and it
    //    gets louder the longer it is ignored. Cleared by the hotkey (= ACK).
    kind = 'meeting'; accent = 'red'; locked = true;
    escalation = escalationOf(m, now);
    const late = Math.floor((now - m.start) / UNIT);
    lines = [late <= 0 ? 'MEETING NOW' : `LATE ${late}${MOCK_FAST ? 's' : 'm'}`, m.summary];
    strip = 'CTRL+OPT+CMD+D = on my way';
  } else if (phase === 'now') {
    // 1. The meeting owns the panel. Outranks needs_input. Not dismissable.
    kind = 'meeting'; accent = 'red'; locked = true;
    lines = [countdown(m, now), m.summary];
  } else if (s.state === 'needs_input') {
    // 2. needs_input preempts the t5/t10 headsup.
    kind = 'needs_input'; accent = 'amber';
    lines = s.total > 1
      ? ['NEEDS YOU', s.label || 'waiting on input', ...otherRows(s)]
      : ['NEEDS YOU', s.label || 'waiting on input', s.tool || ''];
    if (phase) dim = isSnoozed;
  } else if (phase === 't5' && !isSnoozed) {
    // 3. Meeting takes over, dismissable. For the first few seconds after it
    //    seizes the panel, say how - a hotkey is invisible otherwise. Never at
    //    'now': offering a dismissal we would refuse is a lie.
    kind = 'meeting'; accent = 'amber';
    lines = [countdown(m, now), m.summary];
    const inPhase = now - (m.start - leadFor(m.source).soon);
    if (inPhase >= 0 && inPhase < HINT_MS) strip = HINT_TEXT;
  } else if (s.state === 'awaiting') {
    // 4. Claude finished and is waiting on you. Distinct from idle: idle
    //    means nothing is running, this means it is his move.
    kind = 'your_turn'; accent = 'blue';
    lines = ['YOUR TURN', s.label || 'Claude is waiting', ...otherRows(s)];
    if (phase) dim = isSnoozed;
  } else {
    // 5/6. Session state owns the panel; meeting rides the strip if within t10.
    kind = s.state; accent = s.state === 'working' ? 'green' : 'neutral';
    lines = s.state === 'working'
      ? ['WORKING', s.label || 'Claude Code', ...(s.total > 1 ? otherRows(s) : [s.tool || ''])]
      // Line 0 is the STATE, per Glance's content rules — "CLAUDE CODE" is a
      // brand label, not a state, and it pushed "idle" into line 1, which is
      // reserved for which session. ASLEEP over IDLE because the character is
      // the thing that is asleep, which was CD's own answer.
      : ['ASLEEP'];
    if (phase) dim = isSnoozed;
  }

  // A refused dismiss must say so. Silence is indistinguishable from a dead key.
  if (flash && now < flash.until) { strip = flash.text; dim = false; }

  const peeking = now < peekUntil;

  return {
    v: 1,
    ts: now,
    kind,
    locked,
    accent,
    lines: lines.slice(0, 4).map(trunc),
    strip: strip === null ? null : trunc(strip),
    stripDim: dim,
    escalation,
    label: s.label || '',
    mascot: MASCOT || undefined,   // omitted = the client's own default
    defaultSource: DEFAULT_SOURCE || undefined,
    sessions: s.total,
    counts: s.counts,
    // Structured, for displays that format their own words. The `lines` and
    // `strip` strings above stay authoritative for the text-only build.
    // Counts down 8..1 so the display can drain a hairline one step a second
    // without inventing a timer of its own.
    peek: peeking ? { secondsLeft: Math.ceil((peekUntil - now) / 1000) } : null,
    // Exclude only the meeting actually on line 0. Excluding one that is not
    // being shown would silently drop it from the agenda too.
    agenda: agenda(now, (m && phase) ? m.key : null),
    allDay: allDayToday(now),
    // Only the ACTIVE meeting, per the client contract - null otherwise. Sending
    // the next meeting regardless of phase meant startsInSec ticked every
    // second all day, which pushed a frame per second and made the panel blink.
    meeting: (m && phase) ? {
      name: trunc(m.summary),
      summary: trunc(m.summary),   // kept for the text-only build
      startsInSec: Math.round((m.start - now) / 1000),
      phase,
      locked,
      dismissed: isSnoozed,
      source: m.source || 'calendar',
    } : null,
    weather,
    // Every live session, urgency-ordered, names truncated to the panel width.
    // The display decides what to do with this; the server just supplies it.
    list: (s.list || []).map((x) => ({ ...x, name: trunc(x.name) })),
  };
}

// ---------------------------------------------------------------- sse

const clients = new Set();

function broadcast(force) {
  const state = compute(Date.now());
  const payload = JSON.stringify(state);
  // Compare WITHOUT `ts`: it changes every tick, so including it defeated the
  // dedupe entirely and pushed a frame every second. The client crossfades on
  // each frame, so an idle panel visibly blinked.
  const { ts, ...stable } = state;
  const key = JSON.stringify(stable);
  if (!force && key === lastPayload) return;
  lastPayload = key;
  for (const res of clients) {
    try { res.write('data: ' + payload + '\n\n'); } catch { clients.delete(res); }
  }
}

// ---------------------------------------------------------------- http

function readBody(req, cb) {
  let buf = '';
  req.setEncoding('utf8');
  req.on('data', c => { if (buf.length < 1e6) buf += c; });
  req.on('end', () => cb(buf));
  req.on('error', () => {});
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // A loopback bind keeps other machines out; it does not keep a web page out. A site the
  // user visits can POST here, and DNS rebinding can point a hostname the site controls at
  // 127.0.0.1 and then read the replies. Both are visible in these two headers: a rebound
  // request carries the attacker's Host, and any browser-issued cross-site request carries
  // an Origin. Local callers - the hook, the app - send neither.
  const host = String(req.headers.host || '').split(':')[0];
  if (host && host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403); res.end(); return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
    res.writeHead(403); res.end(); return;
  }

  // Invariant 2: /hook answers 204 before any work happens.
  if (url === '/hook' && req.method === 'POST') {
    res.writeHead(204);
    res.end();
    readBody(req, body => setImmediate(() => {
      try { ingestHook(body); } catch (e) { log('hook ingest error:', e.message); }
    }));
    return;
  }

  if (url === '/dismiss' && req.method === 'POST') {
    const now = Date.now();
    const m = nextMeeting(now);
    const phase = phaseOf(m, now);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const refuse = (reason, text) => {
      flash = { text, until: now + 3000 };
      broadcast();
      return send(409, { ok: false, reason });
    };
    // One key, three jobs, resolved in this order:
    //   1. peek open      -> close it. Pressing a key while a list is on screen
    //                        must dismiss the list, never silently act on a
    //                        meeting the list is covering.
    //   2. meeting present-> dismiss / acknowledge / refuse, as before.
    //   3. nothing urgent -> open peek.
    // A second hotkey was rejected on the grounds that having exactly one
    // input is a feature of this machine, not a limitation to route around.
    if (now < peekUntil) {
      peekUntil = 0;
      broadcast();
      return send(200, { ok: true, action: 'peek_closed' });
    }
    // A meeting is only "actionable" while there is something left to do about
    // it. Once dismissed (or acknowledged) the key must fall through to peek,
    // otherwise peek is unreachable for the ten minutes before every meeting.
    const actionable = !!(m && phase) && !(
      ((phase === 't10' || phase === 't5') && snoozed.has(m.key)) ||
      (phase === 'started' && acked.has(m.key)) ||
      (phase === 'now' && refused.has(m.key))
    );
    if (!actionable) {
      const rows = peekRows(sessionState().list || [], agenda(now, null));
      const ms = Math.min(PEEK_MS, PEEK_BASE_MS + PEEK_ROW_MS * rows);
      peekUntil = now + ms;
      broadcast();
      return send(200, { ok: true, action: 'peek_opened', rows, ms });
    }
    if (phase === 'started') {
      // The hotkey means "on my way" once the meeting is underway, not "dismiss".
      acked.add(m.key);
      flash = { text: 'ON MY WAY', until: now + 2500 };
      log('acknowledged', m.key, '(' + m.summary + ')');
      broadcast();
      return send(200, { ok: true, action: 'acknowledged', uid: m.uid, summary: m.summary });
    }
    if (phase === 'now') {
      refused.add(m.key);   // told once; the next press falls through to peek
      const mins = Math.max(0, Math.ceil((m.start - now) / UNIT));
      return refuse('locked, refused',
        m.start <= now ? 'REFUSED · meeting has started' : `REFUSED · starts in ${mins}${MOCK_FAST ? 's' : 'm'}`);
    }
    snoozed.add(m.key);
    flash = { text: 'DISMISSED · ' + m.summary, until: now + 2500 };
    log('dismissed', m.key, '(' + m.summary + ')');
    broadcast();
    return send(200, { ok: true, uid: m.uid, summary: m.summary });
  }

  if (url === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(compute(Date.now())) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url === '/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(compute(Date.now()), null, 2));
  }

  if (url === '/sessions' && req.method === 'GET') {
    const now = Date.now();
    const out = [...sessions.entries()].sort((a, b) => b[1].at - a[1].at).map(([id, v]) => ({
      id: id.slice(0, 8), state: v.state, tool: v.tool || null,
      label: v.title || v.dir || null, title: v.title || null, dir: v.dir || null,
      idleSec: Math.round((now - v.at) / 1000),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ aggregate: sessionState(), count: out.length, sessions: out }, null, 2));
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404);
  res.end('not found');
});

// ---------------------------------------------------------------- boot

setInterval(() => {
  const now = Date.now();
  sweepSessions(now);

  // Peek is server-owned so the force-exit rule cannot be forgotten by a
  // display. It is EDGE-triggered, not level-triggered: a meeting *reaching*
  // the lock or starting closes an open peek, but being inside that window
  // does not keep peek shut. v5 wanted the former; v6's amendment — that a
  // refusal is handling, and the next press falls through to peek — needs the
  // latter. Level-triggering satisfies v5 and silently breaks v6.
  const ph = phaseOf(nextMeeting(now), now);
  if (ph !== lastPhase && (ph === 'now' || ph === 'started')) peekUntil = 0;
  lastPhase = ph;
  for (const o of occurrences) if (o.end <= now) {
    snoozed.delete(o.key); acked.delete(o.key); refused.delete(o.key);
  }
  broadcast();
}, TICK_MS);

// The client declares itself offline after 30s without a FRAME - a comment
// heartbeat does not count. An idle panel changes nothing for minutes, so
// force a real frame on this interval regardless of change.
setInterval(() => broadcast(true), HEARTBEAT_MS);

pollCalendar().then(() => broadcast(true));
setInterval(pollCalendar, CAL_POLL_MS);
if (LOCALCAL) { pollLocalCalendars(); setInterval(pollLocalCalendars, CAL_POLL_MS); }
pollWeather().then(() => broadcast());
setInterval(pollWeather, WEATHER_POLL_MS);
if (MACCAL) {
  checkMacCalendar()
    .then(() => pollMacCalendar())
    .then(() => pollCalendar())
    .then(() => broadcast(true));
  setInterval(() => pollMacCalendar().then(() => pollCalendar()), MACCAL_POLL_MS);
}

server.listen(PORT, HOST, () => {
  log(`glance on http://${HOST}:${PORT}`);
  if (MOCK) log(`MOCK calendar: meeting in ${12 * UNIT / 1000}s${MOCK_FAST ? ' (FAST: ladder in seconds)' : ''}`);
  else if (ICS.length || MACCAL) {
    const names = ICS.map((x) => x.source);
    if (MACCAL) names.push(`${MACCAL_LABEL} (Calendar.app, every ${MACCAL_POLL_MS / 60000}min)`);
    log('calendar sources:', names.join(', '));
  }
  else log('no calendar source. Set GLANCE_ICS=<file|url> or MOCK=1. Panel shows session state only.');
});

server.on('error', (e) => {
  log('listen failed:', e.message);
  process.exit(1);
});
