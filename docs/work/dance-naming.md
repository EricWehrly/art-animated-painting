---
id: dance-naming
parent: pose-pipeline
phase: P1
state: in-progress
---

# dance-naming — trying to identify real salsa figures in the 15 baked pairs

## Why

[pose-pipeline](pose-pipeline.md) Round 25 confirmed no source names our 15 baked `60_NN`/`61_NN`
trials individually — CMU, cgspeed, and the una-dinosauria mirror all list every one identically
as "salsa dance," so the picker ships plain "Salsa 1"–"Salsa 15" labels. The user's follow-up ask:
rather than accept that, see whether the actual salsa *figures* performed in each trial can be
identified from the motion data itself, using real dance vocabulary as reference — not by
screenshotting frames and guessing, but by finding an actual glossary of named figures and
testing our motion against it.

This doc exists because that turned into a real methodology with a real external data source
(CoMPAS3D, below) worth recording for posterity, per this project's commit-traceability practice
— not because dance-naming is expected to become its own roadmap phase.

## Terminology: these are move names, not dance names

"Salsa," "cha-cha," "waltz" are dance *styles* — all 30 of our trials are already "salsa" at that
level, so naming isn't happening there. The real vocabulary — Cross Body Lead, Enchufla,
Hammerlock, Right Turn, Copa, etc. — names individual *figures*, and a real ~15–30 second salsa
routine is a *sequence* of many such figures strung together, not one figure end to end. So the
achievable target isn't "what move is this clip" — it's "what is this routine's one standout,
identifiable figure, if it has one," with the rest of the routine reasonably expected to be
ordinary connective vocabulary (basic step, turns, cross body leads) that every routine shares and
that therefore can't distinguish one routine from another.

## Method, round 1: generic kinematic signatures, no glossary

First pass (see chat log, not reproduced here) computed generic motion signatures directly from
the baked joint positions — hip-height drop + spine-lean-from-vertical (candidate "dip"), net
body-heading rotation per dancer (candidate "turn"), and net bearing-angle rotation between the
two dancers' hips (candidate "position swap/cross-body-lead") — then took the single biggest
instance of each per dance and eyeballed a name onto it. Found 3–4 dances with a strong, visually
confirmed backward-lean pose (Salsa 1, 2, 11, and a more extreme, likely mocap-glitch case in 14),
but had no real vocabulary to check the *name* against — "Dip" was assigned by resemblance, not
verified against the real technique. Checking that specific claim (Dip requires a right-hand-to-
right-hand hold transitioning into a close embrace) against the data found neither a hand-hold
nor a consistent embrace-distance at the lean's peak in most cases — so the pose is real and
visually distinctive, but calling it "Dip" specifically was not well supported.

## Method, round 2: work backward from a real glossary

Pivoted per the user's direction: find an actual index of named salsa figures first, then test
our motion against *that*, rather than naming our own ad hoc signatures. Pulled figure
descriptions from LA-style and Cuban-casino instructional sources (Salsa Vida, The Dance Dojo,
Howcast, SalsaSelfie, Cambridge Salsa) — enough to define Cross Body Lead, Right/Left Turn,
Enchufla, Hammerlock, Copa, She-Goes-He-Goes precisely enough to write detectors for their actual
mechanics (who turns, who travels, holds, direction reversals) rather than generic dip/turn/swap.

Rewrote the analysis to scan each dance's *whole* timeline for every rotation/exchange episode
(not just the single biggest moment — a full routine is a sequence of figures, per the
terminology note above) and classify each episode against the glossary's real mechanics. Result:
Cross Body Lead dominates 12 of 15 dances' rankings, which is expected and *not usable* as a name
— it's the near-universal connector move in this style, so its presence doesn't distinguish one
routine from another (confirmed independently in round 3 below: 24% of all real annotated
segments in a reference corpus are XBL). The genuinely informative signal is the rarer figures:

| Dance | Top candidate | Heuristic score | Verified how |
|---|---|---|---|
| Salsa 6 | Hammerlock | 91% | Traced the raw rotation curve by hand: −226° then unwinds to +190°, smooth, not noise |
| Salsa 13 | Hammerlock | 89% | Traced twice: two clean wind/unwind cycles |
| Salsa 9 | Enchufla | 85% | Position swap (~124–194° bearing change) plus a 430–480° follower spin, three times |
| Salsa 5 | *(nothing)* | — | No rotation episode of any kind cleared the detection threshold — the calmest routine |
| all others | Cross Body Lead only | 55–85% | Not usable as a name — see above |

Scores are heuristic pattern-match tightness against the glossary's stated mechanics, **not
calibrated statistical probabilities** — there is no ground truth in this step to calibrate
against, which is exactly the gap round 3 addresses.

## Method, round 3: CoMPAS3D — a real annotated reference corpus

Found via arXiv (Burkanova et al., SFU, 2507.19684): **CoMPAS3D**, a motion-capture dataset of
improvised partner salsa (18 dancers, beginner/intermediate/professional), with **expert
frame-level annotations of move type** across 2,800+ segments, hosted publicly at
[huggingface.co/datasets/Rosie-Lab/compas3d](https://huggingface.co/datasets/Rosie-Lab/compas3d)
under CC-BY-NC-4.0 (non-commercial — fine for calibrating our own heuristics; would need
reconsidering if this toy were ever commercialized). Its 31-move taxonomy independently confirms
several of round 2's picks as real, community-validated figures (XBL, Enchufla, Right/Left Turn,
Copa) and its free-text annotations use "HL" as shorthand for Hammerlock directly, confirming that
naming.

Per explicit scope decision (user, this round): **do not download the full 28.3GB dataset**,
which is almost entirely `.mp4` video. Each sequence's annotation is a separate ~10KB `.txt` file
(ELAN-exported, tab-separated: start/end timecodes + a free-text description); motion is in
separate `.npz` SMPL-X files (~11MB each per dancer). Pulled only the **35 available `.txt`
annotation files** (Pair1–5; Pair6–9 have motion/video but no annotation — matches the paper's
own "50% of sequences annotated" note), no motion files, ~400KB total — enough to get real
frequency and timing statistics without the video weight.

**Findings, 2,920 labeled segments across 35 annotated takes:**

| Move | Occurrences | % of all segments | Median duration |
|---|---|---|---|
| XBL (Cross Body Lead) | 705 | 24.1% | 2.49s |
| Basic step | 562 | 19.2% | 2.48s |
| Right turn | 398 | 13.6% | 2.48s |
| Enchufla | 136 | 4.7% | 2.51s |
| Change of Directions | 136 | 4.7% | 2.48s |
| Left turn | 122 | 4.2% | 2.50s |
| Hammerlock (HL) | 116 | 4.0% | 2.52s |
| Hand throw | 94 | 3.2% | 2.48s |
| Dile que no | 63 | 2.2% | 2.44s |
| Copa | 42 | 1.4% | 2.50s |
| Suzy Q | 28 | 1.0% | 2.48s |
| Natural top | 22 | 0.8% | 2.40s |
| Sombrero | 21 | 0.7% | 2.40s |
| Open break | 9 | 0.3% | 2.41s |
| Body roll | 7 | 0.2% | 2.51s |

Two results directly useful, one important caveat:

1. **Confirms XBL/Basic step/Right turn are the wrong tier to name from** (24%/19%/14% of all
   real annotated segments — exactly the ubiquitous-connector role round 2 already flagged, now
   with real frequency numbers behind it rather than just our own 15-clip observation).
2. **Confirms Hammerlock (4.0%) and Enchufla (4.7%) are real, legitimately uncommon figures** —
   not filler, not universal. Finding a clean, verified kinematic match for one of these in a
   *specific* dance is a meaningful identification, unlike finding XBL everywhere.
3. **Caveat — every move type has nearly identical duration (~2.4–2.7s, p10–p90 across ALL
   2,920 segments regardless of move type).** This is not noise: salsa is danced on an 8-count
   phrase, and figures conventionally occupy one full phrase by musical convention, not by their
   own natural kinematic length. It means duration alone can't help distinguish move types (every
   move "takes a phrase"), and it means calibrating our episode-length thresholds against a
   *count grid* would require first knowing our own CMU clips' tempo/beat — not yet attempted,
   since our clips carry no audio to derive it from directly (foot-strike periodicity could
   proxy for it, untried).

## Status

Salsa 6 (Hammerlock, 91%) and Salsa 13 (Hammerlock, 89%) and Salsa 9 (Enchufla, 85%) are the three
live candidates, now backed by both a verified real kinematic signature (hand-traced rotation
curves, not just a heuristic score) and a real-world frequency prior confirming these are
meaningfully uncommon, nameable figures rather than generic connective tissue. The other 11 of 15
dances show only the universal Cross Body Lead / Basic Step / Right Turn signal, which is real but
not usable as a distinguishing name — no further reference-pulling is expected to help those
specifically, since the gap there is "no distinctive event detected," not "detected event needs
better calibration." A different signal family (footwork/weight-transfer, styling, shines —
currently undetected since all analysis so far is hip-rotation/position only) is the more likely
route to finding anything for them, if pursued at all.

Not yet done, pending user direction: pulling the small number of actual `.npz` motion segments
labeled Hammerlock/Enchufla in CoMPAS3D (a handful of ~11MB files, not the full dataset) to
confirm our detected rotation *magnitude and shape* against a real labeled example, rather than
timing/frequency alone — the last real gap between "heuristically confident" and "verified."

## Sources

- CMU's own `search.php`, Bruce Hahne's (cgspeed) index, una-dinosauria/cmu-mocap's index text —
  see [pose-pipeline](pose-pipeline.md) Round 25 and [docs/credits.md](../credits.md).
- Salsa Vida, The Dance Dojo, Howcast, SalsaSelfie, Cambridge Salsa — informal but consistent
  figure-mechanics descriptions (Cross Body Lead, Right/Left Turn, Enchufla, Hammerlock, Copa,
  She-Goes-He-Goes).
- Burkanova et al., "CoMPAS3D: A Dataset and Benchmark for Interactive Motion," arXiv:2507.19684 —
  [huggingface.co/datasets/Rosie-Lab/compas3d](https://huggingface.co/datasets/Rosie-Lab/compas3d),
  CC-BY-NC-4.0.
