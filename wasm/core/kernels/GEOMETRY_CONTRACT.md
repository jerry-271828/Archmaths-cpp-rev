# Geometry kernel contract (recalculateGeometryObjects port)

This document is the binding contract between the four parallel porting agents
and the driver/adapter scaffolding. It specifies the text protocol, the state
layout, the group division, the fixed-point semantics, and the hard rules for
porting the JS case bodies. Source of truth for code structures:
`wasm/core/kernels/geometry_common.h` (structs, enums, helpers).

All JS line references are arch-current.html as of 2026-09-26
(parseGeometryDefinition 15923-16296, recalculateGeometryObjects 16480-17366,
resolvePointCoords 17712-17721, plotSingleGeometryGL 20453+, geometry
click/drag switch 26519-27100). If the page shifts, follow the symbols, not
the numbers.

---

## 0. Architecture

```
arch-current.html  recalculateGeometryObjects()            (JS fallback)
      |  top guard: ArchCore.kernels.geometry(this) -> true = handled
      v
wasm/js/kernels/geometry.js   serialize/compile-cache/run/apply
      |  ac_geometry_* ABI (wasm32-wasi reactor, ABI v2 additive)
      v
wasm/core/kernels/geometry.cpp         driver: protocol parse, name maps,
                                       [A,x] rewriting, fixed-point loop
      |  geoDispatch -> per-type group function
      v
geometry_points.cpp / geometry_intersect.cpp /
geometry_constructs.cpp / geometry_measure.cpp     (the four porting targets)
```

Whole-call semantics: the kernel is all-or-nothing. ANY of the following
makes the adapter return false and the original JS body run instead:
serialization guard hit, compile failure of any expression slot, a group
function returning false for any entry (the stub state), ABI run returning 0.

---

## 1. Text protocol (entries / vars / userFns)

`ac_geometry_compile(entries, entriesLen, vars, varsLen, userFns, userFnsLen, integralSteps)`

### 1.1 entries

One entry per line, fields `|`-separated. Delimiters are `|` and newline, so
the ADAPTER refuses (returns false) any name/expression containing `|`, `\n`,
`\r`, and any NAME containing a non-printable-ASCII char or `,`. The kernel
additionally refuses variable names starting with `gpr` (synthetic-param
namespace, see §5).

```
typeId|name|varDepsCsv|objDepsCsv|<type-specific fields...>
```

- `typeId`: integer, see §2.
- `name`: raw entry name (map keys are ASCII-lowercased; page names are
  pre-trimmed by parseGeometryDefinition).
- `varDepsCsv`: the page's `entry.variableDependencies`, comma-joined, empty
  if none. Do NOT sort/dedup.
- `objDepsCsv: the page's `entry.objectDependencies` (already lowercased by
  the page), comma-joined, empty if none.

Per-type fields (order fixed; `ref` = object name, resolved compile-time to a
state index, empty = absent; `expr` = raw calcJs source, compiled, may contain
`[A,x]`/`[A,y]` refs; `n` = decimal integer; `sign` = "1" or "-1"):

| typeId | keyword | fields |
|---|---|---|
| 0 | point | `po,onObjName,exprA,exprB` — po="1": refA=onObjName, exprA=parameter_expr, exprB empty; po="0": exprA=x_expr, exprB=y_expr |
| 1 | midpoint | `p1Name,p2Name` |
| 2 | intersect | `obj1Name,obj2Name,sign` |
| 3-6 | segment/ray/line/vector | `p1Name,p2Name` |
| 7 | perpendicularline | `lineName,pointName` |
| 8 | parallelline | `lineName,pointName` |
| 9 | anglebisector | `p1Name,vertexName,p3Name` |
| 10 | circle | `centerName,radiusExpr,pointOnCircleName` (exactly one of radiusExpr/pointOnCircleName non-empty) |
| 11 | ellipse | `f1Name,f2Name,pName` |
| 12 | ellipse_ab | `aExpr,bExpr` |
| 13 | hyperbola | `f1Name,f2Name,pName` |
| 14 | parabola | `focusName,directrixName` |
| 15 | polygon | `n,p1..pn` |
| 16 | length | `p1Name,p2Name` |
| 17 | angle | `p1Name,vertexName,p3Name` |
| 18 | area | `n,p1..pn` |
| 19 | isparallel | `l1Name,l2Name` |
| 20 | isperpendicular | `l1Name,l2Name` |
| 21 | isconcyclic | `p1Name,p2Name,p3Name,p4Name` |
| 22 | rotate | `centerName,rotatedPointName,angleExpr` |
| 23 | reflect | `axisName,reflectedPointName` |
| 24 | translate | `vectorName,translatedPointName,dxExpr,dyExpr` (vectorName empty ⇔ dx/dy form) |
| 25 | fitline | `n,p1..pn` |
| 26 | circulararc | `centerName,startPointName,endPointName` |
| 27 | tangent | `conicName,pointName,sign` |

Field counts are validated per type; any mismatch → whole compile fails.

### 1.2 vars

Variable names, `\n`-joined, adapter order (Map insertion order, filtered to
`^[a-z_][a-z0-9_]*$`, unique). This is the `ac_geometry_setvars` value order.

### 1.3 userFns

Identical encoding to `ac_calc_compile`: one record per line
`name|p1,p2|body`, body = the page's stored bodyTokens joined by single
spaces, records sorted. Empty string = none.

---

## 2. GeoType ids (fixed forever)

```
-1 Unknown
 0 Point               point
 1 Midpoint            midpoint
 2 Intersect           intersect
 3 Segment             segment
 4 Ray                 ray
 5 Line                line
 6 Vector              vector
 7 PerpendicularLine   perpendicularline
 8 ParallelLine        parallelline
 9 AngleBisector       anglebisector
10 Circle              circle
11 Ellipse             ellipse          (foci form)
12 EllipseAb           ellipse_ab       (a,b form; page keyword is 'ellipse')
13 Hyperbola           hyperbola
14 Parabola            parabola
15 Polygon             polygon
16 Length              length
17 Angle               angle
18 Area                area
19 IsParallel          isparallel
20 IsPerpendicular     isperpendicular
21 IsConcyclic         isconcyclic
22 Rotate              rotate
23 Reflect             reflect
24 Translate           translate
25 Fitline             fitline
26 CircularArc         circulararc
27 Tangent             tangent
```

NOTE: there are 28 keywords (ellipse and ellipse_ab are distinct types).

Shared type predicates live in geometry_common.h: `isPointLikeType`
(point/midpoint/intersect/rotate/reflect/translate — the page's point-like
list), `isLineLikeType` (segment/ray/line/vector/perpendicularline/
parallelline/anglebisector/fitline/tangent), `isCircleType` (circle,
circulararc), `isConicType` (ellipse, hyperbola, parabola, ellipse_ab).

---

## 3. State / output record layout (stride 40 doubles)

Input upload and output readback use the SAME row layout (`kGeoStride = 40`).
NaN means "field never set" (mirrors a missing property on the JS entry
object). The adapter uploads the current JS entry fields (NaN for absent),
the kernel iterates, and the adapter writes everything back — so fields a
case does not write keep their previous values exactly like stale JS
properties.

| idx | enum | JS field | meaning |
|---|---|---|---|
| 0 | GeoX | x_val | point-like coordinate |
| 1 | GeoY | y_val | point-like coordinate |
| 2 | GeoRadius | radius | circle / circulararc |
| 3 | GeoA | a | ellipse/ellipse_ab/hyperbola semi-axis |
| 4 | GeoB | b | same |
| 5 | GeoRotation | rotation | conic rotation (radians) |
| 6 | GeoPFocal | p | PARABOLA focal length only (ellipse's p is an object ref) |
| 7 | GeoValue | value | measure entries |
| 8 | GeoStartAngle | startAngle | circulararc |
| 9 | GeoEndAngle | endAngle | circulararc |
| 10 | GeoDistSum | dist_sum | ellipse |
| 11 | GeoDistDiff | dist_diff | hyperbola |
| 12 | GeoDirX | dir.x | entry.dir (normalized) |
| 13 | GeoDirY | dir.y | |
| 14 | GeoDirVecX | dir_vec.x | raw direction; point-to-point lines only |
| 15 | GeoDirVecY | dir_vec.y | |
| 16 | GeoP1X | (literal p1) | x_val-style literal; REF p1 slots are compile-time, see §7 |
| 17 | GeoP1Y | | |
| 18 | GeoP2X | (literal p2) | |
| 19 | GeoP2Y | | |
| 20 | GeoCenterX | center.x | {x,y}-style LITERAL conic center; circle/arc center is a ref |
| 21 | GeoCenterY | | |
| 22 | GeoVertexX | vertex.x | parabola vertex ({x,y}-style literal) |
| 23 | GeoVertexY | | |
| 24 | GeoF1X | f1.x_val | ellipse_ab literal foci; ellipse f1 is a ref |
| 25 | GeoF1Y | | |
| 26 | GeoF2X | | |
| 27 | GeoF2Y | | |
| 28 | GeoErrCode | compilationError | 0 none / 1 交点求解复杂 / 2 切点不在圆弧范围内 |
| 29 | GeoMeaningful | isMeaningful | uploaded, iterated, written back (1/0) |
| 30 | GeoTermA | — | display intermediates, see §6 |
| 31 | GeoTermB | — | |
| 32 | GeoTermC | — | |
| 33 | GeoTermD | — | |
| 34 | GeoTermE | — | |
| 35 | GeoTermF | — | |
| 36 | GeoFlags | — | bit0 regen detailsString, bit1 ErrTouched (apply GeoErrCode) |
| 37-39 | reserved | | |

### 3.1 Compile-time ref slots (NOT state)

`GeoEntry::refSlots[8]` holds state indices resolved from names at compile:
`GeoRefA`=0, `GeoRefB`=1, `GeoRefC`=2, `GeoRefD`=3, `GeoRefPointList`=4
(index into `GeoEntry::pointRefs`, a variable-length vector). Per type:

| type | A | B | C | D | pointRefs |
|---|---|---|---|---|---|
| point (on object) | onObjectName | — | — | — | |
| midpoint | p1 | p2 | | | |
| intersect | obj1 | obj2 | | | |
| segment/ray/line/vector | p1 | p2 | | | |
| perp/parallel line | line | point | | | |
| anglebisector | p1 | p3 | vertex | | |
| circle | center | pointOnCircle | | | |
| ellipse/hyperbola | f1 | f2 | p | | |
| parabola | focus | directrix | | | |
| polygon/area/fitline | | | | | p1..pn |
| length | p1 | p2 | | | |
| angle | p1 | p3 | vertex | | |
| isparallel/isperpendicular | l1 | l2 | | | |
| isconcyclic | p1 | p2 | p3 | p4 | |
| rotate | center | rotatedPoint | | | |
| reflect | axis | reflectedPoint | | | |
| translate | vector | translatedPoint | | | |
| circulararc | center | startPoint | endPoint | | |
| tangent | conic | point | | | |

Unresolvable name → -1 (the case body must then take the page's
"object not found" branch, e.g. `!p1` → newMeaningful = false).

Expression slots: `GeoEntry::exprSlots` indexed by `GeoExprA`=0 / `GeoExprB`=1:
point → x_expr(0), y_expr(1) or parameter_expr(0); circle radius_expr(0);
ellipse_ab a_expr(0), b_expr(1); rotate angle_expr(0); translate dx_expr(0),
dy_expr(1).

---

## 4. Fixed-point iteration (driver-owned, do not reimplement in groups)

Exact port of recalculateGeometryObjects' outer loop. Pseudocode (the
driver implements this; groups implement ONE case evaluation):

```
maxIterations = 20; iteration = 0; changedInIteration = true
state = uploaded rows                       // n * 40 doubles
while (changedInIteration && iteration < maxIterations):
  changedInIteration = false; iteration++
  for i in 0..n-1 (state order = page geometryEntries order):
    st = row(i)
    oldMeaningful = st[GeoMeaningful] != 0
    old = { x: st[GeoX], y: st[GeoY], r: st[GeoRadius] }      // BEFORE the case
    depsMeaningful = ∀ v in entry.varDeps: v in varNames && isFinite(varValues[v])
                  && ∀ o in entry.objDeps: o in objectMap && row(objectMap[o]).meaningful
    if !depsMeaningful:
      st[GeoMeaningful] = 0          // GeoErrCode/GeoFlags untouched (JS leaves compilationError)
      if oldMeaningful: changedInIteration = true
      continue
    st[GeoErrCode] = 0; st[GeoFlags] = 0
    if !geoDispatch(type, state, entry, st): ABORT RUN -> return 0   // group declined
    newMeaningful = st[GeoMeaningful] != 0
    st[GeoFlags] = ErrTouched | (newMeaningful || type == Polygon ? Details : 0)
    if newMeaningful != oldMeaningful: changedInIteration = true
    else if newMeaningful:
      if type ∈ {point, midpoint, intersect}
         && (|st[GeoX]-old.x| > 1e-9 || |st[GeoY]-old.y| > 1e-9): changedInIteration = true
      else if type == circle && |st[GeoRadius]-old.r| > 1e-9: changedInIteration = true
return 1; out = state
```

Notes that MUST survive porting:
- `old` is captured BEFORE the case body runs.
- JS `Math.abs(entry.x_val - undefined) > 1e-9` is false (NaN); NaN-initialised
  rows reproduce this — do not "fix" it.
- The change tracking only watches x/y for point/midpoint/intersect and
  radius for circle. Other types can oscillate forever without extending the
  loop — that is the page's behavior, keep it.
- The deps check reads variable values uploaded via `ac_geometry_setvars`
  (NaN = missing/non-number/non-finite).

---

## 5. Expression evaluation and [A,x] point-coord refs

Every expression slot is compiled once via `Program::compileCalcJs`
(0 args; params = all vars then the slot's synthetic refs; userFns +
integralSteps from the compile call). A compile failure of ANY slot fails the
whole compile.

`evaluateExpressionWithCalcJS` (arch-current.html:11236) runs
`resolvePointCoords` (17712) on the RAW string at EVERY evaluation: each
`[name,x]`/`[name,y]` (regex `\[\s*([^,\]\s]+)\s*,\s*(x|y)\s*\]`, coord
letter lowercase only, left-to-right non-overlapping) is replaced by the
referenced point-like entry's CURRENT x_val/y_val, or `(0)` when the entry or
a finite value is missing. The driver reproduces this dynamically: at compile
each match becomes a synthetic parameter `gpr<j>` (leading-underscore ids do
not survive the CalcJs pipeline; variable names starting with `gpr` are
rejected at compile), and `GeoState::evalExpr(entry, slot)` refreshes
[var values + ref values] before every evaluation. Ref lookup is the
`pointMap` (FIRST match in entry order among point-like types;
resolvePointCoords uses Array.find) — and it deliberately does NOT check
isMeaningful, matching the page.

Group code calls `state.evalExpr(entry, slot)` — never touches params.

---

## 6. detailsString (adapter-side, driven by kernel intermediates)

The page sets `entry.detailsString` INSIDE recalculateGeometryObjects; the
kernel does not emit strings. The adapter regenerates it when GeoFlags bit0
is set, from output fields plus these rules:

- point/midpoint/intersect/rotate/reflect/translate:
  `` `(${x.toPrecision(4)}, ${y.toPrecision(4)})` `` from GeoX/GeoY.
- segment..anglebisector (lines): from entry.p1 (JS object, possibly a ref —
  read its CURRENT x_val/y_val) and entry.dir; if `|dir.x| < 1e-9`
  `` `x = ${p1.x_val.toPrecision(4)}` `` else
  `m = dir.y/dir.x; b = p1.y_val - m*p1.x_val;`
  `` `y = ${m.toPrecision(3)}x ${b >= 0 ? '+' : '-'} ${Math.abs(b).toPrecision(3)}` ``.
  (Bit-exact: same expression over the round-tripped dir values.)
- circle: h=center.x_val, k=center.y_val (ref), r2 = GeoRadius*GeoRadius,
  `` `(x ${h > 0 ? '-' : '+'} ${|h|.toPrecision(3)})² + (y ...)² = ${r2.toPrecision(3)}` ``.
- ellipse_ab: `` `x²/${(a*a).toPrecision(3)} + y²/${(b*b).toPrecision(3)} = 1` ``.
- ellipse/hyperbola/parabola: `engine.formatConicEquation(TermA..TermF)` —
  groups MUST write the six coefficients into GeoTermA..GeoTermF exactly when
  the JS case computes them (16955/16988/17015 area).
- polygon: `""` (set unconditionally by the page whenever the case runs —
  hence the driver's Polygon exception for the Details flag).
- length: `` `l(${p1Name}, ${p2Name}) = ${value.toPrecision(4)}` ``.
- angle: `` `∠(${p1Name}, ${vertexName}, ${p3Name}) = ${value.toPrecision(3)}°` ``.
- area: `` `S(${pointNames.join(', ')}) = ${value.toPrecision(4)}` ``.
- isparallel/isperpendicular: `` `${name}(${l1Name}, ${l2Name}) = ${value}` ``.
- isconcyclic: `` `${name}(${p1Name}, ${p2Name}, ${p3Name}, ${p4Name}) = ${value}` ``.
- fitline: vertical branch (JS sets dir={x:0,y:1}) → `x = ${GeoP1X.toPrecision(4)}`
  (avg_x); else m=GeoTermA, b=GeoTermB. The group MUST write m/b there — the
  adapter cannot rebuild them bit-exactly from the normalized dir.
- circulararc: `` `圆心: ${centerName}, 半径: ${radius.toPrecision(4)}` ``.
- tangent: vertical (dir={x:0,y:1}) → `x = ${GeoP1X.toPrecision(4)}`; else
  k=GeoTermA (group-written), `b = GeoP1Y - k*GeoP1X`.

GeoErrCode: 1 → compilationError = "交点求解复杂" (intersect), 2 →
"切点不在圆弧范围内" (tangent), 0 → undefined. Only applied when GeoFlags
bit1 is set; other error texts the page can produce (eval exceptions) are
NOT reproducible and intentionally collapse to undefined.

---

## 7. JS write-back shapes (adapter contract, for reference)

Refs become the live entry object (`entry.p1 = objectMap.get(name)`);
literals become plain objects. Consumers (plotSingleGeometryGL 20453+, the
click/drag switch 26519+, updateGeometryMeasurementDisplay 12351+) read:

- point-likes: x_val, y_val.
- segment/vector: p1,p2 (x_val-style) + dir.
- ray/line/perp/parallel/anglebisector/fitline/tangent: p1 (x_val-style) + dir.
- circle/circulararc: center (REF, x_val-style), radius (+start/endAngle).
- ellipse_ab/ellipse/hyperbola: center {x,y} literal, a, b, rotation.
- parabola: vertex {x,y} literal, p (focal), rotation.
- polygon/area: points = array of entry refs (possibly with undefined holes).
- measures: value.

Apply order is entry order; detailsString generation reads referenced
entries' fields at that moment, reproducing the page's mid-loop staleness.

---

## 8. Group division (4 parallel agents)

| file | group fn | types (JS case lines) |
|---|---|---|
| geometry_points.cpp | geoEvalPoints | point 16534-16622, midpoint 16623-16633, rotate 16634-16651, reflect 16652-16676, translate 16677-16697 |
| geometry_intersect.cpp | geoEvalIntersect | intersect 16698-16828, tangent 17191-17349 |
| geometry_constructs.cpp | geoEvalConstructs | segment/ray/line/vector 16829-16888, perpendicularline 16840-16845, parallelline 16846-16851, anglebisector 16852-16864, circle 16889-16909, ellipse_ab 16910-16939, ellipse 16940-16972, hyperbola 16973-17005, parabola 17006-17032, circulararc 17167-17190 |
| geometry_measure.cpp | geoEvalMeasure | polygon 17033-17038, length 17039-17046, angle 17047-17065, area 17066-17079, isparallel 17080-17088, isperpendicular 17089-17097, isconcyclic 17098-17132, fitline 17133-17166 |

Dispatch is `geoDispatch` in geometry_common.h. The group function receives
`state`, `entry`, `st` (the entry's state row) with deps already checked, and:

- returns false ONLY for "not ported" (driver aborts → JS fallback);
- otherwise sets `st[GeoMeaningful]` to the newMeaningful value (1/0),
  writes output fields at EXACTLY the JS write moments, sets GeoErrCode /
  GeoTermA..F per §6.

---

## 9. Hard porting requirements

1. **Line-by-line.** Transcribe the JS case body statement by statement.
   Keep every arithmetic expression's operation order and grouping —
   `Math.sqrt((pOn.x_val - c.x_val)**2 + ...)` must become the identical
   sequence of C++ double ops. Use JsMath helpers (JsMath.h) for Math.*
   semantics: `JsMath::hypot`, `JsMath::sign`, `JsMath::min/max` (NOT
   std::min/max — NaN semantics differ), `JsMath::isFinite`, `JsMath::kNaN`.
   `std::sqrt/std::cos/...` match V8 for these inputs; `Math.hypot(a,b)` →
   `JsMath::hypot(a,b)`.
2. **Write timing.** Fields are written at the same points as JS, including
   "write then fail" paths (e.g. circle writes radius BEFORE the finiteness
   check; JS catch sets isMeaningful=false only). Never pre-zero or pre-clear
   state fields.
3. **Field existence checks.** JS `!obj.dir` / `!obj.p1` means "property
   never assigned". In the kernel that is "row slot is NaN" (or ref index
   -1 for missing objects). A slot that was ever written holds a value even
   when the entry is not meaningful — check NaN, not meaningfulness, when the
   JS checks field existence. (Driver-validated example: a point on object
   reads `onObject.dir_vec || onObject.dir` → finite-check GeoDirVecX/Y first,
   fall back to GeoDirX/Y.)
4. **Meaningfulness gates.** The JS cases set `newMeaningful = false` on
   failed checks; port every threshold verbatim (`1e-9`, `1e-7`, `magic_offset
   = 100000` in the hyperbola point-on-object branch, `2 * Math.PI`, etc.).
5. **Quirks to preserve, not fix.** Examples: hyperbola pointOnObject's
   `magic_offset` reparametrization; intersect's `Math.max(0, discriminant)`;
   the tangent adjugate indices (`S12 = -(m21*m33 - m23*m31)` etc.); the
   inBounds lambda (16789-16816) including circulararc angle wrapping; the
   circle-circle `d < 1e-9` rejection; angle's `acos(max(-1, min(1, cos)))`.
6. **evaluateExpressionWithCalcJS results.** Call `state.evalExpr(entry,
   slot)`; gate on `JsMath::isFinite` exactly where the JS uses
   `Number.isFinite`. The page's eval can yield NaN without throwing — the
   kernel never throws, so the JS `catch (e) { isMeaningful=false;
   compilationError=e.message }` path maps to "case gates produce
   newMeaningful=false; GeoErrCode stays 0".
7. **Polygon/area/fitline points.** The case reads `entry.pointNames.map(
   name => objectMap.get(name))`; the kernel equivalent is `entry.pointRefs`
   with the "some undefined" check = "any ref == -1". `entry.points` itself is
   adapter-side (§7) — groups do not write it.
8. **Cross-entry reads.** Always read the CURRENT row of the referenced
   entry (`state.row(refIdx)[GeoX]` etc.) — later entries see this pass's
   updates, earlier ones see last pass's, exactly like the JS object refs.

---

## 10. Semantics the driver already guarantees (do not duplicate)

- depsMeaningful pre-check (§4), including the "skip entry without touching
  compilationError" behavior.
- ErrCode/Flags clearing before each evaluated case.
- The Details flag rule (including polygon's unconditional "").
- Change detection / loop termination.
- Point-ref param refresh before every evalExpr.
- Name maps: objectMap LAST-wins (JS Map.set over entries), pointMap
  FIRST-wins among point-like types (JS Array.find), ASCII-lowercased.

---

## 11. Validation status at scaffold handoff

- `bash wasm/build.sh` passes with all four stubs declining (page behavior
  unchanged: the adapter returns false, the JS body runs).
- Regression suites green: vm-diff / loops-diff / advfuncs-diff / calcjs-diff
  (0 failures).
- Driver mechanics validated end-to-end with a temporary point/polygon/length
  implementation (since removed): compile of all 28 types, [A,x] rewriting,
  variable upload, deps-fail staleness, seeded re-runs, flags semantics.

## 12. Known limitations (fallback-safe by construction)

- Non-printable-ASCII / delimiter-bearing object names → adapter falls back.
- User variables named `gpr*` → kernel refuses compile → fallback.
- Compilation is per geometry-set: one exotic expression (e.g. an advanced
  function the core has not ported, a non-pristine advanced redefinition)
  disables the kernel for the whole set until edited away.
- Generic eval-throw error texts from the page are not reproduced (collapse
  to undefined); the two known geometry error strings are exact.
