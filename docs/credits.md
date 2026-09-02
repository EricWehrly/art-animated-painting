# Credits

This is attribution text for the data and code this project builds on — not marketing copy.
It is also the single source of truth for the in-scene credits panel (`src/shell/credits.ts`
imports this file's raw text and renders it directly, so the two can't drift apart).

## Source data — CMU Graphics Lab Motion Capture Database

The two dancers are performed by real motion-capture data: subjects **60** and **61** of the
[CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu/), each captured performing
15 numbered salsa trials (`60_01`-`60_15`, `61_01`-`61_15`). All 15 pairs are baked into this
toy and selectable from the "trial pair" picker in the params panel.

CMU's own database lists both subjects simply as "salsa (15 trials)", and every single trial's
motion description reads identically "salsa dance" - there is no per-trial name or description
to draw on, which is why this toy's trial-pair picker shows plain numbers rather than named
routines. For comparison, CMU does explicitly label some *other* subject pairs in its database
as paired captures, with real per-trial descriptions - e.g. subjects 18/19 ("human interaction
and communication (2 subjects - subject A/B)"), 20/21, 22/23, and 33/34 ("throw and catch
football"). Subjects 60/61 carry no such explicit pairing label or per-trial text.

That `60_NN` and `61_NN` are the same physical performance, captured simultaneously from two
people's marker sets, is this project's own conclusion, verified directly from the data rather
than read off CMU's metadata: every `60_NN`/`61_NN` pair has matching frame counts, and the two
skeletons' root trajectories sit 13.5-20.2 units apart (clustered around ~17 units) - consistent
with two people captured together at partner distance in the same capture volume, not two
independent solo takes that happen to share a number.

A quick survey of the rest of CMU's database found no other explicitly paired subjects
performing a partnered *dance* - the labeled 2-subject pairs elsewhere in the database (18/19,
20/21, 22/23, 33/34) cover interaction/communication, play, and a football throw-and-catch, not
dance. So 60/61 appears to be the only paired-couple dance capture CMU's database offers.

### License

CMU's FAQ states plainly, under "How can I use this data?":

> The motion capture data may be copied, modified, or redistributed without permission.

CMU separately requests (not requires) attribution and a citation email for published results:

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created
> with funding from NSF EIA-0196217.

## BVH conversion - Bruce Hahne ("cgspeed")

CMU's own database ships motion in ASF/AMC format, not BVH. The BVH files this project actually
uses were converted by Bruce Hahne, released under the "cgspeed" name in 2010. His own terms,
from the conversion's `READMEFIRST.txt`:

> CMU places no restrictions on the use of the original dataset, and I (Bruce) place no
> additional restrictions on the use of this particular BVH conversion.

## GitHub mirror - una-dinosauria/cmu-mocap

This project fetches BVH files directly from
[una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap), a GitHub mirror of
Bruce Hahne's BVH conversion (see `scripts/fetch-bvh.mjs`, which pulls `60_NN.bvh`/`61_NN.bvh`
straight from that repository's raw content). No modifications are made to the mocap data
itself beyond this project's own offline bake (decimation, trimming - see
`docs/work/pose-pipeline.md`).

## This project

**art-animated-painting** is a generative art toy: it renders the two mocap dancers not as
characters but as flung, painted oil-brush strokes that accumulate into a crusty,
three-dimensional painted surface. Built with Three.js/WebGL2, TypeScript, and Vite. See
`docs/roadmap.md` for the full project background.
