// Self-check for the geometry kernel POINT group (point/midpoint/rotate/
// reflect/translate) built from wasm/core/kernels/geometry_points.cpp.
//
// Drives the ac_geometry_* ABI directly with hand-built text-protocol entry
// sets and asserts analytically known results (tolerance 1e-12). Only the
// five point-group types are used, because any other type still belongs to a
// stub group and would make the whole run decline (JS fallback).
//
// Usage: node wasm/tests/geometry-points-check.mjs [archcore.wasm]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await loadCore(process.argv[2] || path.join(here, '../dist/archcore.wasm'));
const { ex } = core;

const STRIDE = 40;
const F = { x: 0, y: 1, err: 28, meaningful: 29, p1x: 16, p1y: 17, p2x: 18, p2y: 19, flags: 36 };

const enc = new TextEncoder();
function allocStr(s) {
    const b = enc.encode(s);
    const p = ex.ac_alloc(b.length + 1);
    core.u8().set(b, p);
    core.u8()[p + b.length] = 0;
    return [p, b.length];
}

function geoCompile(entriesText, vars = [], userFns = '', steps = 100) {
    const [ep, el] = allocStr(entriesText);
    const [vp, vl] = allocStr(vars.join('\n'));
    const [up, ul] = allocStr(userFns);
    const h = ex.ac_geometry_compile(ep, el, vp, vl, up, ul, steps);
    ex.ac_free(ep); ex.ac_free(vp); ex.ac_free(up);
    return h;
}

function geoSetVars(h, values) {
    if (!values.length) return;
    const p = ex.ac_alloc(values.length * 8);
    core.f64().set(values, p >> 3);
    ex.ac_geometry_setvars(h, p, values.length);
    ex.ac_free(p);
}

// rows: array of {meaningful, x, y} partial uploads; everything else NaN.
// The real adapter always uploads the isMeaningful slot as 0/1 (never NaN) -
// the driver's change detection depends on it, so default it to 0 here.
function makeState(n, seeds = {}) {
    const st = new Float64Array(n * STRIDE).fill(NaN);
    for (let i = 0; i < n; i++) st[i * STRIDE + F.meaningful] = 0;
    for (const [i, seed] of Object.entries(seeds)) {
        const r = Number(i) * STRIDE;
        if (seed.x !== undefined) st[r + F.x] = seed.x;
        if (seed.y !== undefined) st[r + F.y] = seed.y;
        if (seed.meaningful !== undefined) st[r + F.meaningful] = seed.meaningful ? 1 : 0;
    }
    return st;
}

function geoRun(h, state) {
    const p = ex.ac_alloc(state.length * 8);
    core.f64().set(state, p >> 3);
    const ok = ex.ac_geometry_run(h, p, state.length);
    let out = null;
    if (ok) out = core.f64().slice(ex.ac_geometry_out_ptr() >> 3, (ex.ac_geometry_out_ptr() >> 3) + ex.ac_geometry_out_len());
    ex.ac_free(p);
    return { ok, out };
}

let failures = 0;
function check(name, cond, detail = '') {
    if (cond) { console.log(`ok   ${name}`); }
    else { failures++; console.log(`FAIL ${name} ${detail}`); }
}
function close(a, b, tol = 1e-12) {
    return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// point (free form)
// ---------------------------------------------------------------------------
{
    const h = geoCompile(['0|A|||0||1|2'].join('\n'));
    check('compile free point', h > 0);
    const { ok, out } = geoRun(h, makeState(1));
    check('run free point', ok === 1);
    check('free point (1,2)', out[F.meaningful] === 1 && out[F.x] === 1 && out[F.y] === 2, `got ${out[F.x]},${out[F.y]} m=${out[F.meaningful]}`);
    ex.ac_geometry_release(h);
}
{
    // x/y from variables, plus [A,x]/[A,y] point-coord refs into a second point
    const h = geoCompile(['0|A|t||0||t|2', '0|B|||0||[A,x]+1|[A,y]*2'].join('\n'), ['t']);
    geoSetVars(h, [3]);
    const { ok, out } = geoRun(h, makeState(2));
    const a = out.slice(0, STRIDE), b = out.slice(STRIDE, 2 * STRIDE);
    check('point from var t=3', ok === 1 && a[F.x] === 3 && a[F.y] === 2, `got ${a[F.x]},${a[F.y]}`);
    check('point with [A,x] refs -> (4,4)', b[F.meaningful] === 1 && b[F.x] === 4 && b[F.y] === 4, `got ${b[F.x]},${b[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // non-finite expression -> case gate, not meaningful, coords untouched
    const h = geoCompile(['0|A|||0||1/0|2'].join('\n'));
    const { ok, out } = geoRun(h, makeState(1));
    check('point 1/0 -> meaningless', ok === 1 && out[F.meaningful] === 0 && Number.isNaN(out[F.x]), `m=${out[F.meaningful]} x=${out[F.x]}`);
    ex.ac_geometry_release(h);
}
{
    // point on an object whose name does not resolve -> object-dep gate fails
    const h = geoCompile(['0|A||ghost|1|ghost|0.5|'].join('\n'));
    const { ok, out } = geoRun(h, makeState(1));
    check('point on missing object -> meaningless', ok === 1 && out[F.meaningful] === 0, `m=${out[F.meaningful]}`);
    ex.ac_geometry_release(h);
}
{
    // QUIRK: point on another point-like object hits no case branch; the page
    // keeps newMeaningful true and leaves x_val/y_val untouched (the flip to
    // not-meaningful on the real page happens via a toPrecision TypeError in
    // the detailsString tail, which the adapter cannot reproduce - see report).
    const h = geoCompile(['0|A|||0||1|2', '0|C||A|1|A|0.5|'].join('\n'));
    const { ok, out } = geoRun(h, makeState(2, { 1: { x: 7, y: 8, meaningful: 1 } }));
    const c = out.slice(STRIDE, 2 * STRIDE);
    check('point-on-point keeps stale coords', ok === 1 && c[F.meaningful] === 1 && c[F.x] === 7 && c[F.y] === 8,
        `m=${c[F.meaningful]} x=${c[F.x]} y=${c[F.y]}`);
    const r2 = geoRun(h, makeState(2));
    const c2 = r2.out.slice(STRIDE, 2 * STRIDE);
    check('point-on-point from fresh state stays meaningful, coords NaN',
        r2.ok === 1 && c2[F.meaningful] === 1 && Number.isNaN(c2[F.x]), `m=${c2[F.meaningful]} x=${c2[F.x]}`);
    ex.ac_geometry_release(h);
}

// ---------------------------------------------------------------------------
// midpoint
// ---------------------------------------------------------------------------
{
    const h = geoCompile([
        '0|A|||0||0|0',
        '0|B|||0||4|2',
        '1|M||A,B|A|B',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(3));
    const m = out.slice(2 * STRIDE, 3 * STRIDE);
    check('midpoint (0,0)-(4,2) = (2,1)', ok === 1 && m[F.meaningful] === 1 && m[F.x] === 2 && m[F.y] === 1,
        `got ${m[F.x]},${m[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // midpoint of a rotate output: R = (2,1) rotated 90 deg about (1,1) = (1,2)
    const h = geoCompile([
        '0|C|||0||1|1',
        '0|P|||0||2|1',
        '22|R||C,P|C|P|90',
        '1|M||R,A|R|A',
        '0|A|||0||0|0',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(5));
    const r = out.slice(2 * STRIDE, 3 * STRIDE);
    const m = out.slice(3 * STRIDE, 4 * STRIDE);
    check('rotate 90 about (1,1) -> (1,2)', r[F.meaningful] === 1 && close(r[F.x], 1, 1e-12) && close(r[F.y], 2, 1e-12),
        `got ${r[F.x]},${r[F.y]}`);
    check('midpoint of R and (0,0) = (0.5,1)', ok === 1 && m[F.meaningful] === 1 && close(m[F.x], 0.5, 1e-12) && m[F.y] === 1,
        `got ${m[F.x]},${m[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    const h = geoCompile(['0|A|||0||0|0', '1|M||A,ghost|A|ghost'].join('\n'));
    const { ok, out } = geoRun(h, makeState(2, { 1: { meaningful: 1, x: 5, y: 5 } }));
    const m = out.slice(STRIDE, 2 * STRIDE);
    check('midpoint with missing p2 -> meaningless (stale coords kept)', ok === 1 && m[F.meaningful] === 0 && m[F.x] === 5,
        `m=${m[F.meaningful]} x=${m[F.x]}`);
    ex.ac_geometry_release(h);
}

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------
{
    const h = geoCompile([
        '0|C|||0||0|0',
        '0|P|||0||1|0',
        '22|R||C,P|C|P|90',
        '0|Q|||0||0|1',
        '22|R2||C,Q|C|Q|180',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(5));
    const r = out.slice(2 * STRIDE, 3 * STRIDE);
    const r2 = out.slice(4 * STRIDE, 5 * STRIDE);
    check('rotate (1,0) 90 deg ccw about origin', ok === 1 && r[F.meaningful] === 1 && close(r[F.x], 0, 1e-12) && close(r[F.y], 1, 1e-12),
        `got ${r[F.x]},${r[F.y]}`);
    check('rotate (0,1) 180 deg about origin -> (0,-1)', r2[F.meaningful] === 1 && close(r2[F.x], 0, 1e-12) && close(r2[F.y], -1, 1e-12),
        `got ${r2[F.x]},${r2[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // angle from a variable, 30 deg: (1,0) -> (cos30, sin30)
    const h = geoCompile(['0|C|||0||0|0', '0|P|||0||1|0', '22|R|t|C,P|C|P|t'].join('\n'), ['t']);
    geoSetVars(h, [30]);
    const { ok, out } = geoRun(h, makeState(3));
    const r = out.slice(2 * STRIDE, 3 * STRIDE);
    const cos30 = Math.cos(30 * Math.PI / 180), sin30 = 0.5;
    check('rotate by var t=30 -> (cos30, 0.5)',
        ok === 1 && close(r[F.x], cos30, 1e-12) && close(r[F.y], sin30, 1e-12), `got ${r[F.x]},${r[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    const h = geoCompile(['0|C|||0||0|0', '0|P|||0||1|0', '22|R||C,P|C|P|1/0'].join('\n'));
    const { ok, out } = geoRun(h, makeState(3, { 2: { meaningful: 1, x: 9, y: 9 } }));
    const r = out.slice(2 * STRIDE, 3 * STRIDE);
    check('rotate with non-finite angle -> meaningless', ok === 1 && r[F.meaningful] === 0 && r[F.x] === 9,
        `m=${r[F.meaningful]} x=${r[F.x]}`);
    ex.ac_geometry_release(h);
}

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------
{
    // point-axis form: 2*axis - p
    const h = geoCompile([
        '0|X|||0||1|1',
        '0|P|||0||3|4',
        '23|Rf||X,P|X|P',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(3));
    const rf = out.slice(2 * STRIDE, 3 * STRIDE);
    check('reflect (3,4) over point (1,1) -> (-1,-2)', ok === 1 && rf[F.meaningful] === 1 && rf[F.x] === -1 && rf[F.y] === -2,
        `got ${rf[F.x]},${rf[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // midpoint-axis form: M = midpoint((0,0),(2,2)) = (1,1); P=(5,6) -> (-3,-4)
    const h = geoCompile([
        '0|A|||0||0|0',
        '0|B|||0||2|2',
        '1|M||A,B|A|B',
        '0|P|||0||5|6',
        '23|Rf||M,P|M|P',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(5));
    const rf = out.slice(4 * STRIDE, 5 * STRIDE);
    check('reflect (5,6) over midpoint (1,1) -> (-3,-4)', ok === 1 && rf[F.x] === -3 && rf[F.y] === -4,
        `got ${rf[F.x]},${rf[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // QUIRK: a rotate-type axis is point-like but NOT in the page's
    // ['point','midpoint','intersect'] list and not line-like -> meaningless
    const h = geoCompile([
        '0|C|||0||0|0',
        '0|P|||0||1|0',
        '22|R||C,P|C|P|90',
        '0|Q|||0||2|2',
        '23|Rf||R,Q|R|Q',
    ].join('\n'));
    const { ok, out } = geoRun(h, makeState(5));
    const rf = out.slice(4 * STRIDE, 5 * STRIDE);
    check('reflect over rotate-point axis -> meaningless', ok === 1 && rf[F.meaningful] === 0,
        `m=${rf[F.meaningful]}`);
    ex.ac_geometry_release(h);
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------
{
    const h = geoCompile(['0|P|||0||1|2', '24|T||P||P|3|4'].join('\n'));
    const { ok, out } = geoRun(h, makeState(2));
    const t = out.slice(STRIDE, 2 * STRIDE);
    check('translate (1,2) by (3,4) -> (4,6)', ok === 1 && t[F.meaningful] === 1 && t[F.x] === 4 && t[F.y] === 6,
        `got ${t[F.x]},${t[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    const h = geoCompile(['0|P|t||0||t|2', '24|T|t,u|P||P|t|u'].join('\n'), ['t', 'u']);
    geoSetVars(h, [1, 5]);
    const { ok, out } = geoRun(h, makeState(2));
    const t = out.slice(STRIDE, 2 * STRIDE);
    check('translate (1,2) by (t,u)=(1,5) -> (2,7)', ok === 1 && t[F.x] === 2 && t[F.y] === 7,
        `got ${t[F.x]},${t[F.y]}`);
    ex.ac_geometry_release(h);
}
{
    // QUIRK: vector form naming a point - points have no p1/p2 in the page,
    // so the case declines even though the ref resolves and is meaningful.
    const h = geoCompile(['0|A|||0||1|1', '0|P|||0||3|4', '24|T||P,A|A|P||'].join('\n'));
    const { ok, out } = geoRun(h, makeState(3));
    const t = out.slice(2 * STRIDE, 3 * STRIDE);
    check('translate by point as vector -> meaningless', ok === 1 && t[F.meaningful] === 0,
        `m=${t[F.meaningful]}`);
    ex.ac_geometry_release(h);
}
{
    const h = geoCompile(['0|P|||0||1|2', '24|T||ghost,P||P|3|4'].join('\n'));
    const { ok, out } = geoRun(h, makeState(2, { 1: { meaningful: 1, x: 9, y: 9 } }));
    const t = out.slice(STRIDE, 2 * STRIDE);
    check('translate of missing point -> meaningless', ok === 1 && t[F.meaningful] === 0 && t[F.x] === 9,
        `m=${t[F.meaningful]} x=${t[F.x]}`);
    ex.ac_geometry_release(h);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
