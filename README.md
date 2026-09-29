# STL Strength Analyzer 1.0

**Version 1.0.0** · Offline · Windows friendly · No extra packages to install

Download the ZIP from the [latest release](https://github.com/RodgerE1/STL-Strength-Analyzer/releases/latest), extract it, and open `STL_Strength_Analyzer.html`.


An offline geometry and print-orientation tool for functional FDM parts. Includes
Ender-3 starting settings and both 0.4 mm and 0.6 mm nozzle choices.

## Start on Windows

1. Extract the whole ZIP.
2. Double-click `STL_Strength_Analyzer.html` or `Start_STL_Analyzer.bat`.
3. Click **Open STL**, or drag an STL onto the page.

Chrome, Edge and Opera are suitable browsers. No installation, Python packages,
account, internet connection or server is needed. `Launch_STL_Analyzer.pyw` is an
optional Python 3 launcher; it simply opens the same local HTML in your browser.
All complete source files are included.

The built-in example loads at startup so you can try the controls immediately.
Your own STL stays on your computer. Reference links open external pages only
when clicked. The app does not contact a printer or change any slicer settings.

## Use it

- Confirm **STL units**. Most STLs are millimeters, but STL files carry no units.
- Set **Main loading** and the axis in the **original imported STL**, not the
  print axes. A custom imported model starts with loading set to Unknown.
- For **Pulling**, choose the pull direction. For **Beam bending**, choose the
  beam's length, from root to tip; this is not the direction you push.
- Select a print profile, material priority, nozzle and usable build volume.
  Defaults are 220 × 220 × 250 mm; check the usable limits of your own printer.
- Inspect the recommendation and preview alternatives in the orientation table.
  Changing an input recalculates the recommendation and selects its best candidate.
- Drag the model to rotate the camera; use the wheel to zoom. Camera movement
  does not change the selected print orientation.
- Use the view menu for thickness samples, illustrative layer bands, steep
  downward faces, or plain geometry. The purple arrow is print +Z. The cyan
  double arrow shows your selected original loading/beam/shaft axis.
- **Save oriented STL** creates a separate binary STL in millimeters, translated
  to a bounding-box minimum of [0,0,0]. Load it in PrusaSlicer or OrcaSlicer and
  inspect the toolpaths. A necessary 90° bed rotation is included in the export.
- **Save report** downloads a text report containing inputs, orientation,
  settings, mesh findings, cross-sections, limitations and reference links.

## What it measures

- Binary and ASCII STL, up to 32 MB or 200,000 triangles.
- Dimensions, shared-edge topology, winding consistency and connected shells.
- Sampled normal-ray thickness for a closed, consistently wound single shell.
- Cross-section material area at 37 positions along each original axis.
- Six axial print orientations plus up to eight major face-normal candidates.
- Flat bed-contact estimate, steep downward-face estimate, height and bed fit.
- Wall count, infill, layer height, top/bottom thickness and material presets.

Thickness colors use estimated extrusion width (1.125 × nozzle diameter): purple
is below two lines, gold below four, cyan four or more. Dots mark actual face-center
sample locations; gray faces are unsampled. Entire sampled faces may be colored
from that one point. This is a thickness view, not a stress heat map.

The narrowing table compares the central 15–85% of each axis to the
90th-percentile interior section. End tips are excluded. A small ratio identifies
a geometric neck; whether it is loaded must be established from how the part is used.

## Starting profiles

| Preset | Walls | General infill | Compression infill |
|---|---:|---:|---:|
| Light duty | 3 | 20% | 20% |
| General functional | 4 | 30% | 40% |
| Demanding use / test prototype | 6 | 45% | 55% |

Gyroid or cubic is a practical starting pattern. For a 0.4 mm nozzle, layers start
at 0.20 mm or 0.16 mm for the demanding preset. For 0.6 mm, they start at 0.28 mm.
Top and bottom thickness is at least 1.2 mm, or 1.6 mm for demanding use.

PETG is the default general-toughness choice. PLA is offered for rigid indoor
room-temperature parts. ASA is a candidate for outdoor UV or warmer service;
the app asks you to account for an enclosure and a hotend rated for the actual
filament temperature. TPU is offered for deliberately flexible parts. Confirm
the filament datasheet, service conditions, and your calibrated filament profile.
No nozzle/bed temperatures are imposed by this tool.

## Limits that matter

This is geometry screening and heuristic advice, not finite-element analysis. It
does not predict a failure load or certify a part. It does not know force
magnitude, contact locations, restraints, internal slicer toolpaths, actual layer
bonding, temperature, creep or fatigue.

Pulling and beam bending rank tensile direction relative to layer planes.
Compression, torsion and Unknown rank printability only. A compression load
normal to layers is not treated as an opening tensile load.

An edge check does not detect self-intersections or prove that a solid is valid.
Thickness, volume and section measurements are withheld for defective meshes
and multiple disconnected shells. A normal ray is an approximation and can miss
tiny or angled features. Facet count and ray coverage are displayed.

Flat contact ignores curved contact and first-layer toolpaths. Steep-face area
includes some bridges and cavities and is not a support-volume calculation.
The preview highlights steep bed faces too, while the table excludes faces lying
on the bed. The ranking compares only the generated candidates, not all rotations.
Leave room for a brim and supports beyond the entered part dimensions.

The viewer displays a subset when a model exceeds 60,000 triangles. All triangles
are analyzed and exported. If WebGL is unavailable, a simplified canvas preview
is used; layer bands require WebGL. Analysis/export still work in the fallback.
Zero-area triangles are ignored and reported. Global inward winding is normalized
for queries only; STL export preserves the imported winding of the remaining facets.

Adding a high wall count cannot thicken a web that is too thin in the CAD model.
Inspect the perimeter paths and reinforce loaded roots, transitions and fastener
areas in CAD or with local slicer modifiers. Test a functional part under its
intended load before relying on it.

## Examples and complete source

- `examples/Narrow_Neck_Bar.stl`: 70 × 24 × 6 mm, minimum neck width 4 mm,
  neck cross-section 24 mm², volume 7,680 mm³.
- `examples/Thin_Plate_0.6mm.stl`: 30 × 20 × 0.6 mm.
- `analyzer_engine.js`: parsing, topology, BVH ray queries, sections,
  candidate orientations, settings and STL export.
- `viewer.js`: offline WebGL renderer and canvas fallback.
- `app.js`: interface controls, reports and local downloads.
- `interface.html`: complete page layout and styling.
- `build.py`: embeds the source into the standalone HTML; Python 3 standard library.
- `verify_engine.js`: analytic geometry verification; Node.js only for development.

To rebuild after editing the complete source, run this from the extracted folder:

```bash
python build.py
```

To run the supplied analytic geometry verification if Node.js is installed:

```bash
node verify_engine.js
```

## Reference guidance

Reviewed September 29, 2026. The exact presets and ranking weights are this
tool's heuristics, not certified results from the reference sources.

- [Prusa: modeling, orientation and thin walls](https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135)
- [Prusa: layers and perimeters](https://help.prusa3d.com/article/layers-and-perimeters_1748)
- [Prusa: infill](https://help.prusa3d.com/article/infill_42)
- [Prusa: PETG](https://help.prusa3d.com/article/petg_2059)
- [Prusa: ASA](https://help.prusa3d.com/article/asa_1809)
