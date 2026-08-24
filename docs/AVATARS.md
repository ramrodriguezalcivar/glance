# Avatars

The character is a swappable sprite sheet. Six generic ones ship, and any sheet
meeting the contract below works with every state, tempo and escalation tier
without touching a line of code.

| id | |
|----|---|
| `you-a` `you-b` `you-c` | three looks off one body |
| `you-d` `you-e` `you-f` | three more, distinct silhouettes |

`you-f` is the default — highest hair/skin contrast, so it resolves soonest at
30 inches. Pick another with `GLANCE_MASCOT="you-b"` in `glance.env`.

The ids are deliberately neutral. Naming them would mean naming *people*, and
any name assigns a gender, a language and an ethnicity to a figure meant to be
interchangeable.

## The contract

| | |
|---|---|
| Sheet | 64x160 native pixels |
| Grid | 10 rows x up to 4 frames, cell 16x16 |
| Feet | on local row 15 of each cell |
| Figure | up to 12 wide, up to 13 tall |
| Format | PNG, base64-inlined into `public/index.html` |

Row order is fixed, one row per state:

| row | state | frames | how it reads |
|-----|-------|--------|--------------|
| 0 | idle | 2 | curled up, eyes closed |
| 1 | working | 4 | arms alternating — typing |
| 2 | your turn | 2 | eyes to the top row, slow breath |
| 3 | needs input | 2 | one arm straight up, waving |
| 4 | meeting T-5 | 2 | reaching out |
| 5 | meeting locked | 2 | both arms up, planted |
| 6 | late, tier 1 | 2 | hopping |
| 7 | late, tier 2 | 3 | bigger hop, legs splayed |
| 8 | late, tier 3 | 4 | full jump, body stretched, eyes doubled |
| 9 | offline | 1 | grey, motionless |

## Rules that are not style preferences

**One silhouette, re-posed.** Every frame is the same figure with arms, eyes or
legs moved — never a fresh drawing. That is what stops ten states becoming ten
characters.

**Rows 2 and 3 must not converge.** *Waiting for you* and *blocked on you* are
the pair most easily confused, and they are separated on three axes at once:
pose, tempo, and hue. Keep all three.

**Rows 6-8 share one colour.** The escalation reads through frame count, tempo
and whether the panel itself shakes — not through getting redder. Every state
must survive desaturation.

**The torso is not black.** A true-black figure disappears against the desk and
leaves a floating head. Charcoal.

**Arms are a shade off the torso.** Same colour and the figure is one slab with
no silhouette, which kills every pose the ladder depends on.

## Faces at this size

A head is about 8 pixels wide. Two things repeatedly go wrong:

**Glasses.** A dark frame across the whole face reads as a bandit mask, because
the darkest thing on the face becomes one continuous bar. Temples alone merge
into the sideburns and vanish. What works is a heavy rim over each lens with the
**nose bridge left open** — the gap splits one dark row into two. Note that a
face with glasses cannot raise its eyes, so row 2 has to lean on its bob and
accent instead.

**Hair.** A flat full-width block reads as a cap. A narrower crown with a sweep
reads as hair.

## Making your own

Generate the sheet however you like — from a photo, from a description, by hand
in Aseprite. What matters is the contract above.

If you use an AI design tool, the useful framing is: *"one figure, ten poses,
same silhouette throughout, 16x16 cells, feet on row 15"* — and then check the
result at true panel size on a dark background, not magnified. Almost every
mistake at this scale is invisible at 10x and obvious at 1x.

Inline the finished PNG as base64 into the `SHEETS` object in
`public/index.html`. The panel loads no external assets by design — no CDN, no
network, one file.

## Contributing one

Generic avatars are welcome, particularly ones that widen the range: the three
shipped are palette variants of a single body and read fairly narrowly. A sheet
plus a one-line description of the look is enough.

Please do not contribute avatars of real people without their say-so, or
characters you do not hold the rights to.
