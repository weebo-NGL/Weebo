# Three public Playwright failures

Each sample comment below triages one test from a different failed GitHub Actions run in AFFiNE’s public repository. They were written from the annotations visible on the run pages. To see what this version of TraceBrief actually generates, run the bundled demo.

## A development-server overlay intercepted the click

> The page-mode test stopped at `change-page-mode.spec.ts:78`. Playwright found the document link visible, enabled and stable. The development server’s overlay iframe kept receiving the pointer events, so the test never reached its editor-load check.
>
> Check the first browser-console error that appeared when the overlay opened. It could explain why several otherwise unrelated clicks in this run were blocked.

The same overlay appears in the annotations for the peek-view and clipboard tests. [Failed Actions run](https://github.com/toeverything/AFFiNE/actions/runs/22102282125)

## Two paragraph blocks changed order

> After Enter and a text insertion, the editor snapshot failed at `paragraph.spec.ts:571`. Both expected strings, `456` and `789`, are present. The diff places their corresponding blocks in the opposite positions.
>
> Inspect the parent and sibling order immediately after Enter. If it already differs there, start in the block-splitting step. If it matches, check how the snapshot traverses the children after typing.

The final snapshot diff includes the block identifiers as well as the text. [Failed Actions run](https://github.com/toeverything/AFFiNE/actions/runs/23088388689)

## The selection text matched but its index was out of range

> The keyboard-navigation test stopped at `selection/native.spec.ts:294`. The preceding assertion accepted the selected text. The next check expected the index to fall between 12 and 17 and received `-1`.
>
> Inspect how the test computes `indexTwo` after the arrow-key movement. Compare the selection’s DOM node and offset with the text node that the index calculation searches.

The inline annotation shows the selected-text assertion, the two index bounds and the observed value. [Failed Actions run](https://github.com/toeverything/AFFiNE/actions/runs/18091227073)
