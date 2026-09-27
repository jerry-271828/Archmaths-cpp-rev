// Self-check for the geometry MEASURE group kernel (geometry_measure.cpp):
// polygon / length / angle / area / isparallel / isperpendicular /
// isconcyclic / fitline.
//
// Usage: node wasm/tests/geometry-measure-check.mjs [path-to-archcore.wasm]
//        (defaults to wasm/dist/archcore.wasm)
//
// The sibling groups (points/constructs/intersect) are exercised only as
// data: point and line entries carry a never-defined variable dependency
// ("novar") so the driver's deps pre-check skips their dispatch (they may
// still be stubs), and their state rows are uploaded with coordinates/dirs
// directly - exactly the fields the measure cases read. The measure entries
// list no deps, so their case bodies run against the seeded rows. That
// isolates this group's port; driver deps/flags mechanics are validated
// separately (GEOMETRY_CONTRACT.md section 11).
import { loadCore } from './harness.mjs';

const WASM = process.argv[2] ?? new URL('../dist/archcore.wasm', import.meta.url).pathname;
const { ex, memory, f64, u8 } = await loadCore(WASM);
const enc = new TextEncoder();
const dec = new TextDecoder();

// GeoOutField indices (geometry_common.h).
const F = {
    x: 0, y: 1, value: 7, dirX: 12, dirY: 13,
    p1x: 16, p1y: 17, p2x: 18, p2y: 19,
    errCode: 28, meaningful: 29, termA: 30, termB: 31, flags: 36,
};
const STRIDE = 40;
const FLAG_DETAILS = 1;
const FLAG_ERR = 2;

let checkCount = 0;
let failCount = 0;

function ok(name, cond, detail = '') {
    checkCount++;
    if (cond) {
        console.log(`ok   ${name}`);
    } else {
        failCount++;
        console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
    }
}
function eq(name, got, want, tol = 1e-12) {
    const good = Number.isFinite(want)
        ? Number.isFinite(got) && Math.abs(got - want) <= tol * Math.max(1, Math.abs(want), Math.abs(got))
        : Number.isNaN(got) && Number.isNaN(want);
    ok(name, good, `got ${got}, want ${want}`);
}

function putStr(s) {
    const b = enc.encode(s);
    const p = ex.ac_alloc(b.length + 1);
    u8().set(b, p);
    u8()[p + b.length] = 0;
    return [p, b.length];
}

function compileSet(entries) {
    const [ep, el] = putStr(entries);
    const [vp, vl] = putStr('');
    const [up, ul] = putStr('');
    const h = ex.ac_geometry_compile(ep, el, vp, vl, up, ul, 100);
    ex.ac_free(ep); ex.ac_free(vp); ex.ac_free(up);
    if (!h) {
        const p = ex.ac_geometry_error_ptr();
        throw new Error(`compile failed: ${dec.decode(new Uint8Array(memory.buffer, p, ex.ac_geometry_error_len()))}`);
    }
    return h;
}

// seeds: one per entry line, or null for an all-NaN row (measure entries).
function runSet(entries, seeds) {
    const lines = entries.split('\n').filter((l) => l.length > 0);
    const h = compileSet(entries);
    const state = new Float64Array(lines.length * STRIDE).fill(NaN);
    lines.forEach((_, i) => {
        const s = seeds[i];
        if (!s) return;
        const r = state.subarray(i * STRIDE, (i + 1) * STRIDE);
        r[F.meaningful] = s.meaningful ?? 0;
        if (s.x !== undefined) r[F.x] = s.x;
        if (s.y !== undefined) r[F.y] = s.y;
        if (s.dirX !== undefined) r[F.dirX] = s.dirX;
        if (s.dirY !== undefined) r[F.dirY] = s.dirY;
    });
    const sp = ex.ac_alloc(state.length * 8);
    f64().set(state, sp >> 3);
    const okRun = ex.ac_geometry_run(h, sp, state.length);
    ex.ac_free(sp);
    if (!okRun) {
        ex.ac_geometry_release(h);
        throw new Error('ac_geometry_run declined (unported group in set?)');
    }
    const op = ex.ac_geometry_out_ptr();
    const ol = ex.ac_geometry_out_len();
    const out = f64().slice(op >> 3, (op >> 3) + ol);
    ex.ac_geometry_release(h);
    return out;
}

const row = (out, i) => out.subarray(i * STRIDE, (i + 1) * STRIDE);

// Assert the driver-visible shape of an evaluated measure row. Polygon rows
// get the Details flag even when not meaningful (driver's polygon exception).
function checkRowShape(name, r, meaningful, isPolygon = false) {
    eq(`${name}.isMeaningful`, r[F.meaningful], meaningful);
    eq(`${name}.errCode`, r[F.errCode], 0);
    const wantFlags = FLAG_ERR | (meaningful || isPolygon ? FLAG_DETAILS : 0);
    eq(`${name}.flags`, r[F.flags], wantFlags);
}

// ---------------------------------------------------------------------------
// Analytic set: every measure type with hand-computable expected values.
// Entry order: 17 points (0-16), 4 lines (17-20), then 17 measure entries.
// ---------------------------------------------------------------------------
const S2 = Math.SQRT1_2; // 1/sqrt(2)
const analyticEntries = [
    '0|A|novar||0|||',   // A = (0,0)
    '0|B|novar||0|||',   // B = (3,4)
    '0|C|novar||0|||',   // C = (3,0)
    '0|H|novar||0|||',   // H = (1,0)
    '0|I|novar||0|||',   // I = (0,1)
    '0|J|novar||0|||',   // J = (1,1)
    '0|K|novar||0|||',   // K = (1,0)
    '0|L|novar||0|||',   // L = (-1,0)
    '0|M|novar||0|||',   // M = (0,1)
    '0|N|novar||0|||',   // N = (0,-1)
    '0|O|novar||0|||',   // O = (2,0)
    '0|Q|novar||0|||',   // Q = (3,0)
    '0|R|novar||0|||',   // R = (1,3)
    '0|S|novar||0|||',   // S = (2,6)
    '0|T|novar||0|||',   // T = (2,0)
    '0|U|novar||0|||',   // U = (2,1)
    '0|V|novar||0|||',   // V = (2,3)
    '5|L1|novar||A|B',   // dir (1,0)
    '5|L2|novar||A|B',   // dir (1,0)
    '5|L3|novar||A|B',   // dir (0,1)
    '5|L4|novar||A|B',   // dir (1,1)/sqrt(2)
    '16|lenAB|||A|B',    // |AB| = 5
    '16|lenHI|||H|I',    // |HI| = sqrt(2)
    '17|angBAC|||B|A|C', // cos = 0.6
    '17|angHAI|||H|A|I', // 90 degrees
    '18|areaABC|||3|A|B|C',   // 6
    '18|areaSQ|||4|A|H|J|I',  // 1
    '19|par12|||L1|L2',   // 1
    '19|par14|||L1|L4',   // 0
    '20|perp13|||L1|L3',  // 1
    '20|perp14|||L1|L4',  // 0
    '21|concKLMN|||K|L|M|N',  // 1 (unit circle)
    '21|concAHIB|||A|H|I|B',  // 0
    '21|concAHOQ|||A|H|O|Q',  // 1 (collinear quirk: D==0 branch, crosses 0)
    '21|concAHOI|||A|H|O|I',  // 0 (D==0 branch, cross_ac != 0)
    '25|fitARS|||3|A|R|S',    // y = 3x
    '25|fitTUV|||3|T|U|V',    // vertical x = 2
    '15|polyABC|||3|A|B|C',   // meaningful, no numeric output
].join('\n');

const pt = (x, y) => ({ x, y, meaningful: 0 });
const analyticSeeds = [
    pt(0, 0), pt(3, 4), pt(3, 0), pt(1, 0), pt(0, 1), pt(1, 1), pt(1, 0),
    pt(-1, 0), pt(0, 1), pt(0, -1), pt(2, 0), pt(3, 0), pt(1, 3), pt(2, 6),
    pt(2, 0), pt(2, 1), pt(2, 3),
    { meaningful: 0, dirX: 1, dirY: 0 },
    { meaningful: 0, dirX: 1, dirY: 0 },
    { meaningful: 0, dirX: 0, dirY: 1 },
    { meaningful: 0, dirX: S2, dirY: S2 },
    // measure rows: uploaded all-NaN / not meaningful
    null, null, null, null, null, null, null, null, null, null,
    null, null, null, null, null, null, null,
];

console.log('-- analytic set');
const out = runSet(analyticEntries, analyticSeeds);
const R = (i) => row(out, i);

// length
checkRowShape('lenAB', R(21), 1);
eq('lenAB.value', R(21)[F.value], 5);
checkRowShape('lenHI', R(22), 1);
eq('lenHI.value', R(22)[F.value], Math.SQRT2);

// angle
checkRowShape('angBAC', R(23), 1);
eq('angBAC.value', R(23)[F.value], Math.acos(0.6) * (180 / Math.PI));
checkRowShape('angHAI', R(24), 1);
eq('angHAI.value', R(24)[F.value], 90);

// area
checkRowShape('areaABC', R(25), 1);
eq('areaABC.value', R(25)[F.value], 6);
checkRowShape('areaSQ', R(26), 1);
eq('areaSQ.value', R(26)[F.value], 1);

// isparallel / isperpendicular
checkRowShape('par12', R(27), 1);
eq('par12.value', R(27)[F.value], 1);
checkRowShape('par14', R(28), 1);
eq('par14.value', R(28)[F.value], 0);
checkRowShape('perp13', R(29), 1);
eq('perp13.value', R(29)[F.value], 1);
checkRowShape('perp14', R(30), 1);
eq('perp14.value', R(30)[F.value], 0);

// isconcyclic
checkRowShape('concKLMN', R(31), 1);
eq('concKLMN.value', R(31)[F.value], 1);
checkRowShape('concAHIB', R(32), 1);
eq('concAHIB.value', R(32)[F.value], 0);
checkRowShape('concAHOQ', R(33), 1);
eq('concAHOQ.value', R(33)[F.value], 1);
checkRowShape('concAHOI', R(34), 1);
eq('concAHOI.value', R(34)[F.value], 0);

// fitline, non-vertical branch: A(0,0) R(1,3) S(2,6) -> y = 3x
{
    const r = R(35);
    checkRowShape('fitARS', r, 1);
    eq('fitARS.m', r[F.termA], 3);
    eq('fitARS.b', r[F.termB], 0);
    eq('fitARS.p1x', r[F.p1x], 0);
    eq('fitARS.p1y', r[F.p1y], 0);
    eq('fitARS.p2x', r[F.p2x], 1);
    eq('fitARS.p2y', r[F.p2y], 3);
    const dirLen = Math.hypot(1, 3);
    eq('fitARS.dirX', r[F.dirX], 1 / dirLen);
    eq('fitARS.dirY', r[F.dirY], 3 / dirLen);
}
// fitline, vertical branch: T(2,0) U(2,1) V(2,3) -> x = 2
{
    const r = R(36);
    checkRowShape('fitTUV', r, 1);
    eq('fitTUV.termA(avg_x)', r[F.termA], 2);
    eq('fitTUV.termB stays NaN', r[F.termB], NaN);
    eq('fitTUV.p1x', r[F.p1x], 2);
    eq('fitTUV.p1y', r[F.p1y], 0);
    eq('fitTUV.p2x', r[F.p2x], 2);
    eq('fitTUV.p2y', r[F.p2y], 1);
    eq('fitTUV.dirX', r[F.dirX], 0);
    eq('fitTUV.dirY', r[F.dirY], 1);
}

// polygon: only meaningful (+ driver Details flag) is observable
{
    const r = R(37);
    checkRowShape('polyABC', r, 1);
}

// ---------------------------------------------------------------------------
// Degenerate set: "meaningless / unsupported" paths. Fields the JS case never
// writes must stay NaN (stale-field semantics, contract section 3).
// ---------------------------------------------------------------------------
const degenerateEntries = [
    '0|A|novar||0|||',   // A = (0,0)
    '0|B|novar||0|||',   // B = (3,4)
    '5|LN|novar||A|B',   // line without a dir (all-NaN row)
    '5|LD|novar||A|B',   // dir (1,0)
    '16|badlen|||A|ZZ',       // p2 unresolvable
    '17|badang|||A|A|B',      // zero-length arm at the vertex
    '18|badarea|||3|A|B|ZZ',  // missing vertex
    '15|badpoly|||3|A|B|ZZ',  // missing vertex
    '19|badpar|||LN|LD',      // l1.dir never assigned
    '20|badperp|||LD|ZZ',     // l2 unresolvable
    '21|badconc|||A|B|ZZ|A',  // p3 unresolvable
    '25|badfit|||1|A',        // n < 2
    '25|badfit2|||3|A|B|ZZ',  // missing point
].join('\n');
const degenerateSeeds = [
    pt(0, 0), pt(3, 4), { meaningful: 0 }, { meaningful: 0, dirX: 1, dirY: 0 },
    null, null, null, null, null, null, null, null, null,
];

console.log('-- degenerate set');
const out2 = runSet(degenerateEntries, degenerateSeeds);
const D = (i) => row(out2, i);

checkRowShape('badlen', D(4), 0);
eq('badlen.value stays NaN', D(4)[F.value], NaN);
checkRowShape('badang', D(5), 0);
eq('badang.value stays NaN', D(5)[F.value], NaN);
checkRowShape('badarea', D(6), 0);
eq('badarea.value stays NaN', D(6)[F.value], NaN);
checkRowShape('badpoly', D(7), 0, true);   // driver still sets Details for Polygon
eq('badpar', D(8)[F.meaningful], 0);
eq('badpar.value stays NaN', D(8)[F.value], NaN);
eq('badpar.flags', D(8)[F.flags], FLAG_ERR);
checkRowShape('badperp', D(9), 0);
eq('badconc', D(10)[F.meaningful], 0);
checkRowShape('badfit', D(11), 0);
checkRowShape('badfit2', D(12), 0);
eq('badfit2.termA stays NaN', D(12)[F.termA], NaN);

console.log(`\n${checkCount} checks, ${failCount} failures`);
if (failCount > 0) process.exit(1);
console.log('geometry-measure-check: PASS');
