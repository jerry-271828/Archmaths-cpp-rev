// Self-check for the geometry kernel INTERSECT group (geometry_intersect.cpp:
// 'intersect' + 'tangent'). Drives the real driver (geometry.cpp) and the real
// group over the ac_geometry_* ABI with hand-built text-protocol entries, and
// asserts analytically known results (tolerance 1e-12).
//
// Because a single unported group stub aborts the whole run, this check runs
// against a PRIVATE wasm build in which the other three groups are no-ops that
// keep pre-uploaded state rows (wasm/tests/geometry_intersect_fixture.cpp).
// Build it with (repo root, zig on PATH or ZIG set):
//
//   mkdir -p build/archdist_intersect
//   zig c++ -target wasm32-wasi -mexec-model=reactor -std=c++17 -O3 -msimd128 \
//     -fno-exceptions -fno-rtti -DARCHMATHS_NO_PARSER_TRACE \
//     -Wno-nullability-completeness -Iinclude -Iwasm/core -Iwasm/core/kernels \
//     src/math/Tokenizer.cpp src/math/ExpressionParser.cpp wasm/core/*.cpp \
//     wasm/core/kernels/geometry.cpp wasm/core/kernels/geometry_intersect.cpp \
//     wasm/tests/geometry_intersect_fixture.cpp \
//     -Wl,--strip-all -Wl,-z,stack-size=1048576 \
//     -o build/archdist_intersect/archcore.wasm
//
// (If /tmp is writable, ARCHCORE_OUT_DIR=/tmp/archdist_intersect bash
// wasm/build.sh is NOT sufficient here: it links the stub groups, whose
// decline aborts every run below.)
//
// Usage: node wasm/tests/geometry-intersect-check.mjs [path/to/archcore.wasm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const wasmPath = process.argv[2] || path.join(root, 'build', 'archdist_intersect', 'archcore.wasm');
if (!fs.existsSync(wasmPath)) {
    console.error('wasm not found: ' + wasmPath);
    console.error('see the build command in the header of this file');
    process.exit(2);
}

const core = await loadCore(wasmPath);
const { ex, memory } = core;
const f64 = () => new Float64Array(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function putStr(s) {
    const b = encoder.encode(s);
    const p = ex.ac_alloc(b.length + 1);
    u8().set(b, p);
    u8()[p + b.length] = 0;
    return [p, b.length];
}

function geoError() {
    const p = ex.ac_geometry_error_ptr();
    return decoder.decode(new Uint8Array(memory.buffer, p, ex.ac_geometry_error_len()));
}

// Compile a geometry set. entries: array of protocol lines; vars: names.
function compileGeo(lines) {
    const [ep, el] = putStr(lines.join('\n'));
    const [vp, vl] = putStr('');
    const [up, ul] = putStr('');
    const h = ex.ac_geometry_compile(ep, el, vp, vl, up, ul, 100);
    ex.ac_free(ep); ex.ac_free(vp); ex.ac_free(up);
    if (!h) throw new Error('ac_geometry_compile failed: ' + geoError());
    return h;
}

// State row field indices (geometry_common.h GeoOutField).
const F = {
    x: 0, y: 1, radius: 2, a: 3, b: 4, rotation: 5, p: 6, value: 7,
    startAngle: 8, endAngle: 9, distSum: 10, distDiff: 11,
    dirX: 12, dirY: 13, dirVecX: 14, dirVecY: 15,
    p1x: 16, p1y: 17, p2x: 18, p2y: 19,
    centerX: 20, centerY: 21, vertexX: 22, vertexY: 23,
    f1x: 24, f1y: 25, f2x: 26, f2y: 27,
    err: 28, meaningful: 29,
    termA: 30, termB: 31, termC: 32, termD: 33, termE: 34, termF: 35,
    flags: 36,
};
const STRIDE = 40;

function row(over) {
    const r = new Array(STRIDE).fill(NaN);
    for (const [k, v] of Object.entries(over)) {
        if (!(k in F)) throw new Error('unknown field ' + k);
        r[F[k]] = v;
    }
    return r;
}

// Run one scenario: rows uploaded in entry order; returns the output rows.
function runGeo(h, rows) {
    const flat = Float64Array.from(rows.flat());
    const p = ex.ac_alloc(flat.length * 8);
    f64().set(flat, p >> 3);
    const ok = ex.ac_geometry_run(h, p, flat.length);
    ex.ac_free(p);
    if (!ok) throw new Error('ac_geometry_run declined (group stub linked?)');
    const outLen = ex.ac_geometry_out_len();
    if (outLen !== rows.length * STRIDE) throw new Error('bad out len ' + outLen);
    const base = ex.ac_geometry_out_ptr() >> 3;
    const out = f64().slice(base, base + outLen);
    const result = [];
    for (let i = 0; i < rows.length; i++) result.push(out.slice(i * STRIDE, (i + 1) * STRIDE));
    return result;
}

let failures = 0;
let checks = 0;
function near(actual, expected, label, tol = 1e-12) {
    checks++;
    const ok = Number.isFinite(expected)
        ? Number.isFinite(actual) && Math.abs(actual - expected) <= tol
        : Number.isNaN(actual);
    if (!ok) {
        failures++;
        console.error(`  FAIL ${label}: got ${actual}, want ${expected}`);
    }
}
function eq(actual, expected, label) {
    checks++;
    const ok = Object.is(actual, expected);
    if (!ok) {
        failures++;
        console.error(`  FAIL ${label}: got ${actual}, want ${expected}`);
    }
}
function scenario(name, lines, rows, asserts) {
    console.log('scenario: ' + name);
    const h = compileGeo(lines);
    try {
        const out = runGeo(h, rows);
        asserts(out);
    } finally {
        ex.ac_geometry_release(h);
    }
}

const SQ = Math.sqrt;
// Convenient row builders (all uploads carry meaningful=1 unless overridden).
const point = (x, y) => row({ x, y, meaningful: 1 });
// Segment/ray/line/vector rows: dir is the normalized (p2-p1); p1/p2 are refs.
const line = (p1x, p1y, dx, dy) => row({ meaningful: 1, dirX: dx, dirY: dy, p1x, p1y });
const circle = (cx, cy, r) => row({ meaningful: 1, radius: r });
const ellipseAb = (a, b) => row({ meaningful: 1, a, b, centerX: 0, centerY: 0, rotation: 0 });
const circArc = (r, sA, eA) => row({ meaningful: 1, radius: r, startAngle: sA, endAngle: eA });

// ---------------------------------------------------------------- intersect --
// S1: line x line. A(0,0) B(4,2) -> y=x/2 ; C(0,2) D(4,0) -> y=2-x/2.
// Intersection (2,1). l3 parallel to l1 -> not meaningful.
{
    const d1x = 4 / SQ(20), d1y = 2 / SQ(20);   // (2,1)/sqrt(5)
    const lines = [
        '0|a|||0||0|0',
        '0|b|||0||4|2',
        '0|c|||0||0|2',
        '0|d|||0||4|0',
        '0|e|||0||0|1',
        '0|f|||0||4|3',
        '5|l1|||a|b',
        '5|l2|||c|d',
        '5|l3|||e|f',          // parallel to l1 (same direction)
        '2|i12|||l1|l2|1',
        '2|i13|||l1|l3|1',
    ];
    const rows = [
        point(0, 0), point(4, 2), point(0, 2), point(4, 0),
        point(0, 1), point(4, 3),
        line(0, 0, d1x, d1y),                       // l1 (literal p1 unused for line type)
        line(0, 2, 4 / SQ(20), -2 / SQ(20)),        // l2
        line(0, 1, d1x, d1y),                       // l3
        row({ meaningful: 1 }),                     // i12
        row({ meaningful: 1 }),                     // i13
    ];
    scenario('intersect line x line -> (2,1); parallel -> none', lines, rows, (out) => {
        near(out[9][F.x], 2, 'i12.x');
        near(out[9][F.y], 1, 'i12.y');
        eq(out[9][F.meaningful], 1, 'i12.meaningful');
        eq(out[10][F.meaningful], 0, 'i13.meaningful');
    });
}

// S2: line y=1 x circle r=2 -> (+/-sqrt(3), 1); miss y=5 -> none.
{
    const lines = [
        '0|p|||0||0|1',
        '0|q|||0||4|1',
        '0|r|||0||0|5',
        '0|o|||0||0|0',
        '5|lm|||p|q',            // horizontal y=1, dir (1,0)
        '5|lx|||r|q',            // horizontal y=5, dir (1,0)
        '10|c1|||o||2',         // radius expr "2"
        '2|is|||lm|c1|1',
        '2|im|||lm|c1|-1',
        '2|ix|||lx|c1|1',
    ];
    const rows = [
        point(0, 1), point(4, 1), point(0, 5), point(0, 0),
        line(0, 1, 1, 0), line(0, 5, 1, 0), circle(0, 0, 2),
        row({ meaningful: 1 }), row({ meaningful: 1 }), row({ meaningful: 1 }),
    ];
    scenario('intersect line x circle -> (+-sqrt(3),1); disjoint -> none', lines, rows, (out) => {
        near(out[7][F.x], SQ(3), 'is.x');
        near(out[7][F.y], 1, 'is.y');
        near(out[8][F.x], -SQ(3), 'im.x');
        near(out[8][F.y], 1, 'im.y');
        eq(out[9][F.meaningful], 0, 'ix.meaningful');
    });
}

// S3: circle r=2 @ (0,0) x circle r=2 @ (3,0) -> (1.5, -+sqrt(1.75)).
// Concentric pair -> d < 1e-9 -> none.
{
    const lines = [
        '0|o|||0||0|0',
        '0|t|||0||3|0',
        '10|c1|||o||2',
        '10|c2|||t||2',
        '10|c3|||o||1',
        '2|i1|||c1|c2|1',
        '2|i2|||c1|c2|-1',
        '2|i3|||c1|c3|1',
    ];
    const rows = [
        point(0, 0), point(3, 0),
        circle(0, 0, 2), circle(0, 0, 2), circle(0, 0, 1),
        row({ meaningful: 1 }), row({ meaningful: 1 }), row({ meaningful: 1 }),
    ];
    scenario('intersect circle x circle -> (1.5,-+sqrt(1.75)); concentric -> none', lines, rows, (out) => {
        near(out[5][F.x], 1.5, 'i1.x');
        near(out[5][F.y], -SQ(1.75), 'i1.y');
        near(out[6][F.x], 1.5, 'i2.x');
        near(out[6][F.y], SQ(1.75), 'i2.y');
        eq(out[7][F.meaningful], 0, 'i3.meaningful');
    });
}

// S4: line y=1 x ellipse_ab a=3 b=2 (x^2/9 + y^2/4 = 1) -> (+-3sqrt(3)/2, 1).
{
    const lines = [
        '0|p|||0||0|1',
        '0|q|||0||4|1',
        '5|lm|||p|q',
        '12|e1|||3|2',
        '2|i1|||lm|e1|1',
        '2|i2|||lm|e1|-1',
    ];
    const rows = [
        point(0, 1), point(4, 1), line(0, 1, 1, 0), ellipseAb(3, 2),
        row({ meaningful: 1 }), row({ meaningful: 1 }),
    ];
    scenario('intersect line x ellipse_ab -> (+-3sqrt(3)/2, 1)', lines, rows, (out) => {
        near(out[4][F.x], 3 * SQ(3) / 2, 'i1.x');
        near(out[4][F.y], 1, 'i1.y');
        near(out[5][F.x], -3 * SQ(3) / 2, 'i2.x');
        near(out[5][F.y], 1, 'i2.y');
    });
}

// S5: circle x conic and conic x conic -> errCode 1 "交点求解复杂", not meaningful.
{
    const lines = [
        '0|o|||0||0|0',
        '10|c1|||o||2',
        '12|e1|||3|2',
        '2|i1|||c1|e1|1',
        '2|i2|||e1|e1|1',
    ];
    const rows = [point(0, 0), circle(0, 0, 2), ellipseAb(3, 2), row({}), row({})];
    scenario('intersect circle x conic / conic x conic -> errCode 1', lines, rows, (out) => {
        eq(out[3][F.meaningful], 0, 'i1.meaningful');
        eq(out[3][F.err], 1, 'i1.errCode');
        eq(out[4][F.meaningful], 0, 'i2.meaningful');
        eq(out[4][F.err], 1, 'i2.errCode');
    });
}

// S6: missing object -> not meaningful, errCode untouched (0).
{
    const lines = ['2|i1|||nope|missing|1'];
    const rows = [row({})];
    scenario('intersect missing objects -> none', lines, rows, (out) => {
        eq(out[0][F.meaningful], 0, 'i1.meaningful');
        eq(out[0][F.err], 0, 'i1.errCode');
    });
}

// ----------------------------------------------------------------- tangent --
// S7: tangents from (1,2) to circle x^2+y^2=4: k=-4/3 (sign=1), k=0 (sign=-1).
{
    const lines = [
        '0|o|||0||0|0',
        '0|p|||0||1|2',
        '10|c1|||o||2',
        '27|t1|||c1|p|1',
        '27|t2|||c1|p|-1',
    ];
    const rows = [point(0, 0), point(1, 2), circle(0, 0, 2), row({}), row({})];
    scenario('tangent to circle from (1,2): k=-4/3 / k=0', lines, rows, (out) => {
        near(out[3][F.termA], -4 / 3, 't1.termA(k)');
        near(out[3][F.dirX], 3 / 5, 't1.dirX');
        near(out[3][F.dirY], -4 / 5, 't1.dirY');
        near(out[3][F.p1x], 1, 't1.p1x');
        near(out[3][F.p1y], 2, 't1.p1y');
        near(out[3][F.p2y], 2 / 3, 't1.p2y');
        eq(out[3][F.meaningful], 1, 't1.meaningful');
        near(out[4][F.termA], 0, 't2.termA(k)');
        near(out[4][F.dirX], 1, 't2.dirX');
        near(out[4][F.dirY], 0, 't2.dirY');
    });
}

// S8: tangent at (2,0) on the circle (single vertical solution):
// aq == 0 -> vertical branch pushes only {isVertical}; dir = (0,1), termA NaN.
{
    const lines = [
        '0|o|||0||0|0',
        '0|p|||0||2|0',
        '10|c1|||o||2',
        '27|t1|||c1|p|1',
    ];
    const rows = [point(0, 0), point(2, 0), circle(0, 0, 2), row({})];
    scenario('tangent to circle at (2,0): vertical, single solution', lines, rows, (out) => {
        eq(out[3][F.meaningful], 1, 't1.meaningful');
        near(out[3][F.dirX], 0, 't1.dirX');
        near(out[3][F.dirY], 1, 't1.dirY');
        near(out[3][F.p1x], 2, 't1.p1x');
        near(out[3][F.p2y], 1, 't1.p2y');
        near(out[3][F.termA], NaN, 't1.termA (never set on vertical branch)');
    });
}

// S9: tangents from (2,2) to circle r=2: vertical + k=0 both pushed (aq==0),
// sign selects. sign=1 -> vertical; sign=-1 -> k=0.
{
    const lines = [
        '0|o|||0||0|0',
        '0|p|||0||2|2',
        '10|c1|||o||2',
        '27|t1|||c1|p|1',
        '27|t2|||c1|p|-1',
    ];
    const rows = [point(0, 0), point(2, 2), circle(0, 0, 2), row({}), row({})];
    scenario('tangent to circle from (2,2): vertical (sign=1) / k=0 (sign=-1)', lines, rows, (out) => {
        eq(out[3][F.meaningful], 1, 't1.meaningful');
        near(out[3][F.dirX], 0, 't1.dirX');
        near(out[3][F.dirY], 1, 't1.dirY');
        eq(out[4][F.meaningful], 1, 't2.meaningful');
        near(out[4][F.termA], 0, 't2.termA(k)');
        near(out[4][F.dirX], 1, 't2.dirX');
        near(out[4][F.dirY], 0, 't2.dirY');
    });
}

// S10: tangents from (0,4) to ellipse_ab a=3 b=2: k = -+2/sqrt(3).
{
    const lines = [
        '0|p|||0||0|4',
        '12|e1|||3|2',
        '27|t1|||e1|p|1',
        '27|t2|||e1|p|-1',
    ];
    const rows = [point(0, 4), ellipseAb(3, 2), row({}), row({})];
    scenario('tangent to ellipse x^2/9+y^2/4=1 from (0,4): k=-+2/sqrt(3)', lines, rows, (out) => {
        near(out[2][F.termA], -2 / SQ(3), 't1.termA(k)');
        near(out[3][F.termA], 2 / SQ(3), 't2.termA(k)');
        eq(out[2][F.meaningful], 1, 't1.meaningful');
        eq(out[3][F.meaningful], 1, 't2.meaningful');
    });
}

// S11: circulararc range gate. Arc r=2 first quadrant (start (2,0), end (0,2)):
// both tangents from (2,2) touch inside. Arc second quadrant (start (0,2),
// end (-2,0)): the vertical tangent (sign=1) touches at angle 0 -> outside ->
// errCode 2 "切点不在圆弧范围内"; k=0 tangent (sign=-1) touches (0,2) -> inside.
{
    const lines = [
        '0|o|||0||0|0',
        '0|s1|||0||2|0',
        '0|e1p|||0||0|2',
        '0|s2|||0||0|2',
        '0|e2p|||0||-2|0',
        '0|p|||0||2|2',
        '26|a1|||o|s1|e1p',
        '26|a2|||o|s2|e2p',
        '27|t1|||a1|p|1',
        '27|t2|||a1|p|-1',
        '27|t3|||a2|p|1',
        '27|t4|||a2|p|-1',
    ];
    const rows = [
        point(0, 0), point(2, 0), point(0, 2), point(0, 2), point(-2, 0), point(2, 2),
        circArc(2, 0, Math.PI / 2), circArc(2, Math.PI / 2, Math.PI),
        row({}), row({}), row({}), row({}),
    ];
    scenario('tangent circulararc in/out of range -> errCode 2 on the outside one', lines, rows, (out) => {
        eq(out[8][F.meaningful], 1, 't1.meaningful');
        near(out[8][F.dirY], 1, 't1.dirY (vertical)');
        eq(out[9][F.meaningful], 1, 't2.meaningful');
        near(out[9][F.termA], 0, 't2.termA(k)');
        eq(out[10][F.meaningful], 0, 't3.meaningful (touch outside arc)');
        eq(out[10][F.err], 2, 't3.errCode');
        eq(out[11][F.meaningful], 1, 't4.meaningful');
        near(out[11][F.termA], 0, 't4.termA(k)');
    });
}

// S12: tangent with a non-conic "conic" -> not meaningful, errCode untouched.
{
    const lines = [
        '0|pa|||0||0|0',
        '0|pt|||0||1|2',
        '27|t1|||pa|pt|1',
    ];
    const rows = [point(0, 0), point(1, 2), row({})];
    scenario('tangent with point as conic -> none', lines, rows, (out) => {
        eq(out[2][F.meaningful], 0, 't1.meaningful');
        eq(out[2][F.err], 0, 't1.errCode');
    });
}

// S13: tangent from an interior point (0,0) of the ellipse -> no real slope.
{
    const lines = [
        '0|p|||0||0|0',
        '12|e1|||3|2',
        '27|t1|||e1|p|1',
    ];
    const rows = [point(0, 0), ellipseAb(3, 2), row({})];
    scenario('tangent from interior point -> none', lines, rows, (out) => {
        eq(out[2][F.meaningful], 0, 't1.meaningful');
    });
}

console.log(`\n${checks} assertions, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
