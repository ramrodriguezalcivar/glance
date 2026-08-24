# Glance — the design system

Why the panel is the way it is. If you are modifying it, the rules below are
load-bearing: most were arrived at by getting them wrong first on real hardware.

The system is called Glance, and it is named after its own acceptance test:
**if it does not read in one look from 30 inches, it is not Glance.**

## The premise

It is furniture, not an app. It is on all day in peripheral vision. You glance
at it; you never study it. Every rule below follows from that.

There is no touch digitizer and no pointer — macOS does not support touch on
external displays, and the only input is one global hotkey. So the system has
**no hover states, no press states, no buttons and no navigation**. What it has
instead is a character, a type ladder and a motion ladder.

## Invariants

**The server owns all arbitration.** `compute()` decides what is on screen. The
client renders and never makes a priority judgement. If you find yourself
writing an `if` about urgency in the client, it belongs in `compute()`.

**One thing at a time.** Up to four lines of ~28 characters plus a one-line
strip. If you are tempted to add a fourth element to a screen, don't.

**All sizing in `vmin`, never `px`.** A cheap panel's backing scale is not
something to depend on. `--u: 1vmin` is declared on the panel element, not
`:root` — a custom property resolves its `var()` where it is *declared*, so
tokens at `:root` would peg to the fallback and never follow the viewport.

**`steps()` only.** No easing, no tweens, no springs. Pixel art that eases stops
being pixel art, and this runs 24 hours a day with no JS loop and no canvas.
The only non-stepped animations are slow linear fades between day scenes.

**The client must be idempotent.** The same payload rendered twice must produce
no visible motion. The server is required to send a frame at least every 10s —
a socket quiet for 30s is treated as dead — so any animation that replays per
frame becomes a blink on a timer. Every replayed animation is gated on a
signature of what it animates.

**Nothing persists.** Session state is in memory. No prompts, no paths, no
transcripts are written anywhere.

## The ten states

| # | kind | esc | accent | moment |
|---|------|-----|--------|--------|
| 1 | `idle` | 0 | neutral | nothing running — asleep |
| 2 | `working` | 0 | green | working; session and tool shown |
| 3 | `your_turn` | 0 | blue | finished, waiting on you |
| 4 | `needs_input` | 0 | amber | blocked on you mid-task |
| 5 | `meeting` | 0 | amber | T-5, dismissable |
| 6 | `meeting` | 0 | red, locked | T-2, cannot be dismissed |
| 7 | `meeting` | 1 | red, locked | started — you're late |
| 8 | `meeting` | 2 | red, locked | 2+ min late |
| 9 | `meeting` | 3 | red, locked | 5+ min late; the whole field shakes |
| 10 | offline | — | grey | the client cannot hear the server |

**3 and 4 must never converge.** *Waiting for you* and *blocked on you* are the
pair most easily confused, and they are separated on three axes at once: pose,
tempo and hue. Keep all three.

**7, 8 and 9 share one red.** The escalation reads through frame count, tempo
and whether the panel itself moves — not through getting redder.

## Colour is never the only signal

Green, amber and red across one system is the classic colour-vision trap. Every
state is identifiable with colour removed — by pose, motion, silhouette, and
by pip *shape* in the strip: filled = needs you, hollow = your turn, half-height
bar = working.

Accents encode **state**. Do not spend hue on anything else — source, priority,
or category. That rule is what the colour-blind fallback rests on.

## The strip is a hint channel, not a roll-up channel

The single easiest thing to get wrong.

`payload.strip` as a **string** takes the strip's left half *verbatim*. It does
not add to the roll-up — it **replaces** it, suppressing the pips, the adaptive
name-shedding and the peek hint along with it. Send `null` and let the display
compose from `counts` and `list`.

Use a string only for something transient that must pre-empt the roll-up for a
few seconds: a hotkey hint, or a flash like `DISMISSED · …`. Never for a summary
you have already computed — only the display knows how much room it has.

## The one key

| condition | what it does |
|-----------|--------------|
| peek is open | closes peek |
| the meeting is unhandled | dismiss · refuse · acknowledge |
| anything else | opens peek |

"Unhandled" excludes a meeting already dismissed, acknowledged, **or refused
once**. A locked meeting cannot be dismissed — that is the entire content of the
lock — but after it has said no once, the key falls through to peek. Otherwise a
lock holds the key hostage for its whole window, which is punishment rather than
information.

Peek's force-exit is **edge-triggered**, not level-triggered: a meeting
*reaching* its start closes an open peek, but being inside that window does not
keep peek shut. Level-triggered, this and the refusal fall-through cancel out
exactly — the key opens peek and the same tick kills it.

Peek's duration is derived, not chosen: **2s to notice the list arrived + 1s per
row to read it**, capped. Each column floors at one row so peek is never a blank
rectangle.

## Things that were tried and rejected

**Rotating simultaneous meetings** ("1 of 3", then "2 of 3"). Rotation makes what
you see depend on *when* you look, which breaks the one promise the panel makes.
A count — `08:00 Standup +2` — says *there is a clash here* in a single glance,
and peek has the detail.

**A second hotkey.** The machine having exactly one input is a feature of it,
not a limitation to route around.

**Letting the calendar source change loudness.** A deadline is a deadline, and a
panel that shouts less for a family event is making a values judgement it has no
business making. Source is *identification*, not priority: it may change lead
time, and it may appear as a tag, but never volume, order or hue.

**Putting an app inside the desk monitor.** The monitor is furniture that agrees
with the state, never a second readout. A competing information surface is
exactly the failure this system exists to avoid.

**All-day events in the meeting ladder.** They have no moment to count down to,
and a twelve-hour countdown pins the panel and teaches you to ignore it. They
live in the window with the weather instead — a property of the day rather than
a moment in it.

## Credit

The visual system was produced with Claude Design over thirteen rounds of
review, most of them arguments this document is the settlement of.
