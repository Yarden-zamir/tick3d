# App icon

The app icon comes from one SVG master in `candidates/`. Every icon file is a render of that master.

## Candidates

Each candidate is a square of 1024 × 1024 with an opaque background. Except for 14-tab-tile, the artwork stays inside the Android safe zone, so one file serves as the plain icon, the maskable icon and the Apple icon.

| Candidate | Idea |
| --- | --- |
| 0-current | The shipped icon: two stacked 2×2 boards. It exists only as PNG files with a transparent background. |
| 1-tower | Four 4×4 boards, like the game screen, with a line of four X marks down the front corner. |
| 2-board | One 4×4 board with a winning diagonal of four X marks. |
| 3-badges | An X tile and an O tile with hard shadows, like the tick3d wordmark badge. |
| 4-cube | A 4×4×4 cube with grids on three faces, and X and O marks on the top. |
| 5-xo | One bold X over one bold O, no board. |
| 6-face | A flat 4×4 grid, front view, with a winning diagonal of four X marks. |
| 7-layers | Four plain plates stacked, with a big X on the top plate. |
| 8-current-vector | The current icon redrawn as vector, with an opaque background. |
| 9-classic | The current concept, redrawn: two tilted 2×2 boards, one behind the other. |
| 10-classic-bold | The same stack with bigger marks, on violet, so it stands out on a light home screen. |
| 11-classic-4x4 | The same stack with the 4×4 boards of the game and a winning diagonal. |
| 12-classic-tower | Four thin 2×2 boards, one per layer of the game, with the marks on the top board. |
| 13-classic-single | One tilted board with the biggest marks, on the dark page colour. |
| 14-tab-tile | Only for the browser tab (16 and 32 px): a yellow tile with a big X and O. It fills the square, so it is not for the launcher masks. |

## Checks and contact sheet

Run `uv run branding/icon/icon.py sheet <output.png>`. For each candidate, the script checks:

- opaque: the icon has no transparent pixel. The App Store refuses an icon with alpha.
- safe zone: the artwork stays inside the circle of 80% diameter that Android keeps for a maskable icon.
- 16 px marks: how many pixels keep the X colour and the O colour at 16 px. 0 means that the mark is gone at that size.

The sheet shows each candidate at several sizes, inside the Android and iOS masks on light and dark wallpapers, with the safe zone, and with deuteranopia (red-green colour blindness).

## Export

After a maintainer picks a candidate, run `uv run branding/icon/icon.py export <candidate>`. It writes the web and PWA icons in `public/`, the Play icon and `apple/icon.png`, and checks the size and the opaque colour mode of each file.
