// Constructs-group port checks (geometry_constructs.cpp).
//
// Drives the geometry kernel ABI directly with hand-built entries text and
// asserts analytically known results (tolerance 1e-12) for every type the
// group owns: segment/ray/line/vector, perpendicularline, parallelline,
// anglebisector, circle, ellipse_ab, ellipse, hyperbola, parabola,
// circulararc — two analytic cases plus meaningless/unsupported cases each.
//
// Usage: node wasm/tests/geometry-constructs-check.mjs [path/to/archcore.wasm]
//        (default: wasm/dist/archcore.wasm; env ARCHCORE_WASM also honored)
//
// Note: every construct depends on point entries, so the run declines (0)
// while the points group is still a stub — those sets SKIP. A compile
// failure is always a hard FAIL (serialization of these types must work).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] || process.env.ARCHCORE_WASM ||
                 path.join(here, '..', 'dist', 'archcore.wasm');

const STRIDE = 40;
const F = {
    x: 0, y: 1, radius: 2, a: 3, b: 4, rot: 5, p: 6, value: 7,
    sAng: 8, eAng: 9, distSum: 10, distDiff: 11,
    dirX: 12, dirY: 13, dvecX: 14, dvecY: 15,
    p1x: 16, p1y: 17, p2x: 18, p2y: 19,
    cx: 20, cy: 21, vx: 22, vy: 23,
    f1x: 24, f1y: 25, f2x: 26, f2y: 27,
    err: 28, meaning: 29,
    termA: 30, termB: 31, termC: 32, termD: 33, termE: 34, termF: 35,
    flags: 36,
};

const { ex } = await loadCore(wasmPath);
const enc = new TextEncoder();
const dec = new TextDecoder();
const f64 = () => new Float64Array(ex.memory.buffer);
const u8 = () => new Uint8Array(ex.memory.buffer);

let checks = 0;
let failures = 0;
let skipped = 0;

function approx(got, want, tol, msg) {
    checks++;
    if (!(Math.abs(got - want) <= tol)) {
        failures++;
        console.error(`FAIL ${msg}: got ${got}, want ${want}`);
    }
}

function wasmStr(s) {
    const b = enc.encode(s);
    const p = ex.ac_alloc(b.length + 1);
    u8().set(b, p);
    u8()[p + b.length] = 0;
    return [p, b.length];
}

function geoError() {
    const p = ex.ac_geometry_error_ptr();
    return dec.decode(new Uint8Array(ex.memory.buffer, p, ex.ac_geometry_error_len()));
}

// One geometry set. expect entries: { e, f, is: <number> } | { e, f, nan: true }.
function runSet(label, lines, { vars = [], values = [], points = {}, expect = [] }) {
    const [ep, el] = wasmStr(lines.join('\n'));
    const [vp, vl] = wasmStr(vars.join('\n'));
    const [up, ul] = wasmStr('');
    const h = ex.ac_geometry_compile(ep, el, vp, vl, up, ul, 100);
    ex.ac_free(ep); ex.ac_free(vp); ex.ac_free(up);
    if (!h) { failures++; console.error(`FAIL ${label}: compile returned 0 (${geoError()})`); return; }
    if (values.length) {
        const p = ex.ac_alloc(values.length * 8);
        f64().set(values, p >> 3);
        ex.ac_geometry_setvars(h, p, values.length);
        ex.ac_free(p);
    }
    const n = lines.length;
    const buf = new Float64Array(n * STRIDE).fill(NaN);
    const nameIdx = {};
    lines.forEach((ln, i) => {
        const name = ln.split('|')[1];
        nameIdx[name] = i;
        buf[i * STRIDE + F.err] = 0;
        buf[i * STRIDE + F.flags] = 0;
        buf[i * STRIDE + F.meaning] = 1;   // "was meaningful" on upload
        if (points[name]) {
            buf[i * STRIDE + F.x] = points[name][0];
            buf[i * STRIDE + F.y] = points[name][1];
        }
    });
    const sp = ex.ac_alloc(buf.length * 8);
    f64().set(buf, sp >> 3);
    const ran = ex.ac_geometry_run(h, sp, buf.length);
    ex.ac_free(sp);
    if (!ran) {
        skipped++;
        console.log(`SKIP ${label}: ac_geometry_run declined (other groups unported)`);
        ex.ac_geometry_release(h);
        return;
    }
    const base = ex.ac_geometry_out_ptr() >> 3;
    const out = f64().slice(base, base + ex.ac_geometry_out_len());
    for (const spec of expect) {
        const i = nameIdx[spec.e];
        if (i === undefined) { failures++; console.error(`FAIL ${label}: unknown entry ${spec.e}`); continue; }
        const got = out[i * STRIDE + F[spec.f]];
        const msg = `${label}.${spec.e}.${spec.f}`;
        if (spec.nan) {
            checks++;
            if (!Number.isNaN(got)) { failures++; console.error(`FAIL ${msg}: got ${got}, want NaN`); }
        } else {
            approx(got, spec.is, spec.tol ?? 1e-12, msg);
        }
    }
    ex.ac_geometry_release(h);
}

const P = (name, x, y) => `0|${name}|||0||${x}|${y}`;   // literal point entry line

// ---------------------------------------------------------------- lines ----
{
    const r5 = Math.sqrt(5), r10 = Math.sqrt(10), r2 = Math.SQRT2;
    runSet('lines', [
        P('a', 0, 0), P('b', 4, 2), P('p', 1, 1), P('q', 1, 0), P('r', 0, 1),
        `5|l1||a,b|a|b`,
        `3|s1||a,b|a|b`,
        `4|r1||b,p|b|p`,
        `6|vv||a,p|a|p`,
        `7|pl||l1,p|l1|p`,
        `8|pa||l1,p|l1|p`,
        `9|ab||q,a,r|q|a|r`,
        `3|s2||a,a|a|a`,   // degenerate: dirLen 0
    ], {
        points: { a: [0, 0], b: [4, 2], p: [1, 1], q: [1, 0], r: [0, 1] },
        expect: [
            // line l1 (a->b): dir_vec (4,2), normalized (2/sqrt5, 1/sqrt5)
            { e: 'l1', f: 'dvecX', is: 4 }, { e: 'l1', f: 'dvecY', is: 2 },
            { e: 'l1', f: 'dirX', is: 2 / r5 }, { e: 'l1', f: 'dirY', is: 1 / r5 },
            { e: 'l1', f: 'meaning', is: 1 }, { e: 'l1', f: 'err', is: 0 },
            { e: 'l1', f: 'flags', is: 3 },
            { e: 'l1', f: 'p2x', nan: true },   // p2 is a ref for point-to-point lines
            // segment s1: same body
            { e: 's1', f: 'dvecX', is: 4 }, { e: 's1', f: 'dirX', is: 2 / r5 },
            { e: 's1', f: 'dirY', is: 1 / r5 }, { e: 's1', f: 'meaning', is: 1 },
            // ray r1 (b->p): dir_vec (-3,-1)
            { e: 'r1', f: 'dvecX', is: -3 }, { e: 'r1', f: 'dvecY', is: -1 },
            { e: 'r1', f: 'dirX', is: -3 / r10 }, { e: 'r1', f: 'dirY', is: -1 / r10 },
            { e: 'r1', f: 'meaning', is: 1 },
            // vector vv (a->p): dir_vec (1,1)
            { e: 'vv', f: 'dirX', is: 1 / r2 }, { e: 'vv', f: 'dirY', is: 1 / r2 },
            { e: 'vv', f: 'meaning', is: 1 },
            // perpendicularline to l1 through p: dir = (-l1.dir.y, l1.dir.x)
            { e: 'pl', f: 'dirX', is: -1 / r5 }, { e: 'pl', f: 'dirY', is: 2 / r5 },
            { e: 'pl', f: 'p2x', is: 1 - 1 / r5 }, { e: 'pl', f: 'p2y', is: 1 + 2 / r5 },
            { e: 'pl', f: 'dvecX', nan: true },   // dir_vec only for p2p lines
            { e: 'pl', f: 'meaning', is: 1 }, { e: 'pl', f: 'flags', is: 3 },
            // parallelline to l1 through p
            { e: 'pa', f: 'dirX', is: 2 / r5 }, { e: 'pa', f: 'dirY', is: 1 / r5 },
            { e: 'pa', f: 'p2x', is: 1 + 2 / r5 }, { e: 'pa', f: 'p2y', is: 1 + 1 / r5 },
            { e: 'pa', f: 'meaning', is: 1 },
            // anglebisector of q(1,0), a(0,0), r(0,1): dir (1,1)/sqrt2, p2 (1,1)
            { e: 'ab', f: 'dirX', is: 1 / r2 }, { e: 'ab', f: 'dirY', is: 1 / r2 },
            { e: 'ab', f: 'p2x', is: 1 }, { e: 'ab', f: 'p2y', is: 1 },
            { e: 'ab', f: 'meaning', is: 1 }, { e: 'ab', f: 'flags', is: 3 },
            // degenerate segment s2 (a->a): dir_vec written as (0,0), dir not, meaningless
            { e: 's2', f: 'dvecX', is: 0 }, { e: 's2', f: 'dvecY', is: 0 },
            { e: 's2', f: 'dirX', nan: true }, { e: 's2', f: 'meaning', is: 0 },
            { e: 's2', f: 'flags', is: 2 },
        ],
    });
}

// ---------------------------------------------------------------- circle ----
{
    runSet('circle', [
        P('c1', 1, 2), P('c2', 0, 0), P('pon', 3, 4),
        `10|k1||c1|c1|3|`,          // radius_expr form
        `10|k2||c2,pon|c2||pon`,    // point-on-circle form -> r = 5
        `10|k3||c1|c1|0|`,          // radius 0: written, then meaningless
        `10|k4||c1|c1|-2|`,         // negative radius
        `10|k5|r|c1|c1|r|`,         // radius via variable r = 2.5
    ], {
        vars: ['r'],
        values: [2.5],
        points: { c1: [1, 2], c2: [0, 0], pon: [3, 4] },
        expect: [
            { e: 'k1', f: 'radius', is: 3 }, { e: 'k1', f: 'meaning', is: 1 },
            { e: 'k1', f: 'flags', is: 3 }, { e: 'k1', f: 'err', is: 0 },
            { e: 'k2', f: 'radius', is: 5 }, { e: 'k2', f: 'meaning', is: 1 },
            { e: 'k3', f: 'radius', is: 0 },   // write-then-fail: radius kept
            { e: 'k3', f: 'meaning', is: 0 }, { e: 'k3', f: 'flags', is: 2 },
            { e: 'k4', f: 'radius', is: -2 }, { e: 'k4', f: 'meaning', is: 0 },
            { e: 'k5', f: 'radius', is: 2.5 }, { e: 'k5', f: 'meaning', is: 1 },
        ],
    });
}

// ------------------------------------------------------------ ellipse_ab ----
{
    const c12 = Math.sqrt(12);
    runSet('ellipse_ab', [
        `12|e1|||3|2`,
        `12|e2|||2|4`,
        `12|e3|||-1|2`,   // a <= 0
        `12|e4|||2|0`,    // b <= 0
    ], {
        expect: [
            { e: 'e1', f: 'a', is: 3 }, { e: 'e1', f: 'b', is: 2 },
            { e: 'e1', f: 'cx', is: 0 }, { e: 'e1', f: 'cy', is: 0 },
            { e: 'e1', f: 'rot', is: 0 },
            { e: 'e1', f: 'f1x', is: -Math.sqrt(5) }, { e: 'e1', f: 'f1y', is: 0 },
            { e: 'e1', f: 'f2x', is: Math.sqrt(5) }, { e: 'e1', f: 'f2y', is: 0 },
            { e: 'e1', f: 'meaning', is: 1 }, { e: 'e1', f: 'flags', is: 3 },
            { e: 'e2', f: 'a', is: 2 }, { e: 'e2', f: 'b', is: 4 },
            { e: 'e2', f: 'f1x', is: 0 }, { e: 'e2', f: 'f1y', is: -c12 },
            { e: 'e2', f: 'f2x', is: 0 }, { e: 'e2', f: 'f2y', is: c12 },
            { e: 'e2', f: 'meaning', is: 1 },
            { e: 'e3', f: 'a', nan: true },   // gate before any write
            { e: 'e3', f: 'b', nan: true },
            { e: 'e3', f: 'meaning', is: 0 }, { e: 'e3', f: 'flags', is: 2 },
            { e: 'e4', f: 'meaning', is: 0 },
        ],
    });
}

// --------------------------------------------------------------- ellipse ----
{
    // f1(-1,0) f2(1,0) p(0,1.5): dist_sum = 2*sqrt(3.25), c = 1, b = 1.5
    const a1 = Math.sqrt(3.25);
    // f1(0,0) f2(4,4) p(0,1): dist_sum = 6, c = sqrt(32)/2, a = 3, b = 1, rot pi/4
    const rot2 = Math.atan2(4, 4);
    const cos2 = Math.cos(rot2), sin2 = Math.sin(rot2);
    const A2 = cos2 * cos2 / 9 + sin2 * sin2 / 1;
    const B2 = 2 * cos2 * sin2 / 9 - 2 * cos2 * sin2 / 1;
    const D2 = -2 * 2 * A2 - 2 * B2;
    const F2 = 4 * A2 + 4 * A2 + 4 * B2 - 1;
    runSet('ellipse', [
        P('f1p', -1, 0), P('f2p', 1, 0), P('pep', 0, 1.5), P('pe0', 0, 0),
        P('g1', 0, 0), P('g2', 4, 4), P('gp', 0, 1),
        `11|el1||f1p,f2p,pep|f1p|f2p|pep`,
        `11|el2||g1,g2,gp|g1|g2|gp`,
        `11|el3||f1p,f2p,pe0|f1p|f2p|pe0`,   // p between foci -> dist_sum = 2c
    ], {
        points: {
            f1p: [-1, 0], f2p: [1, 0], pep: [0, 1.5], pe0: [0, 0],
            g1: [0, 0], g2: [4, 4], gp: [0, 1],
        },
        expect: [
            { e: 'el1', f: 'distSum', is: 2 * Math.sqrt(3.25) },
            { e: 'el1', f: 'a', is: a1 }, { e: 'el1', f: 'b', is: 1.5 },
            { e: 'el1', f: 'cx', is: 0 }, { e: 'el1', f: 'cy', is: 0 },
            { e: 'el1', f: 'rot', is: 0 },
            { e: 'el1', f: 'termA', is: 1 / 3.25 }, { e: 'el1', f: 'termB', is: 0 },
            { e: 'el1', f: 'termC', is: 1 / 2.25 }, { e: 'el1', f: 'termD', is: 0 },
            { e: 'el1', f: 'termE', is: 0 }, { e: 'el1', f: 'termF', is: -1 },
            { e: 'el1', f: 'meaning', is: 1 }, { e: 'el1', f: 'flags', is: 3 },
            { e: 'el2', f: 'distSum', is: 6 },
            { e: 'el2', f: 'a', is: 3 }, { e: 'el2', f: 'b', is: 1 },
            { e: 'el2', f: 'cx', is: 2 }, { e: 'el2', f: 'cy', is: 2 },
            { e: 'el2', f: 'rot', is: Math.PI / 4 },
            { e: 'el2', f: 'termA', is: A2 }, { e: 'el2', f: 'termB', is: B2 },
            { e: 'el2', f: 'termC', is: A2 }, { e: 'el2', f: 'termD', is: D2 },
            { e: 'el2', f: 'termE', is: D2 }, { e: 'el2', f: 'termF', is: F2 },
            { e: 'el2', f: 'meaning', is: 1 },
            { e: 'el3', f: 'distSum', is: 2 },     // written before the gate
            { e: 'el3', f: 'meaning', is: 0 },
            { e: 'el3', f: 'a', nan: true }, { e: 'el3', f: 'termA', nan: true },
        ],
    });
}

// -------------------------------------------------------------- hyperbola ----
{
    // f1(-1,0) f2(1,0) p(0.5,0): diff 1, c 1, a 0.5, b sqrt(0.75)
    const b1sq = 0.75;
    // f1(0,0) f2(0,6) p(2,0): diff = sqrt(40)-2, c 3, rot pi/2, center (0,3)
    const dd2 = Math.sqrt(40) - 2;
    const a2v = dd2 / 2;
    const c2v = 3;
    const b2v = Math.sqrt(c2v * c2v - a2v * a2v);
    const rot2 = Math.atan2(6, 0);
    const cs = Math.cos(rot2), sn = Math.sin(rot2);
    const A2 = cs * cs / (a2v * a2v) - sn * sn / (b2v * b2v);
    const B2 = 2 * cs * sn / (a2v * a2v) + 2 * cs * sn / (b2v * b2v);
    const C2 = sn * sn / (a2v * a2v) - cs * cs / (b2v * b2v);
    const h = 0, k = 3;
    const D2 = -2 * h * A2 - k * B2;
    const E2 = -2 * k * C2 - h * B2;
    const F2 = h * h * A2 + k * k * C2 + h * k * B2 - 1;
    runSet('hyperbola', [
        P('f1p', -1, 0), P('f2p', 1, 0), P('hp', 0.5, 0),
        P('hp2', 0, 0), P('hp3', 2, 0),
        P('u1', 0, 0), P('u2', 0, 6), P('up', 2, 0),
        `13|hy1||f1p,f2p,hp|f1p|f2p|hp`,
        `13|hy2||u1,u2,up|u1|u2|up`,
        `13|hy3||f1p,f2p,hp2|f1p|f2p|hp2`,   // diff 0
        `13|hy4||f1p,f2p,hp3|f1p|f2p|hp3`,   // diff = 2c
    ], {
        points: {
            f1p: [-1, 0], f2p: [1, 0], hp: [0.5, 0], hp2: [0, 0], hp3: [2, 0],
            u1: [0, 0], u2: [0, 6], up: [2, 0],
        },
        expect: [
            { e: 'hy1', f: 'distDiff', is: 1 },
            { e: 'hy1', f: 'a', is: 0.5 }, { e: 'hy1', f: 'b', is: Math.sqrt(b1sq) },
            { e: 'hy1', f: 'cx', is: 0 }, { e: 'hy1', f: 'cy', is: 0 },
            { e: 'hy1', f: 'rot', is: 0 },
            { e: 'hy1', f: 'termA', is: 1 / 0.25 }, { e: 'hy1', f: 'termB', is: 0 },
            { e: 'hy1', f: 'termC', is: -1 / b1sq }, { e: 'hy1', f: 'termD', is: 0 },
            { e: 'hy1', f: 'termE', is: 0 }, { e: 'hy1', f: 'termF', is: -1 },
            { e: 'hy1', f: 'meaning', is: 1 }, { e: 'hy1', f: 'flags', is: 3 },
            { e: 'hy2', f: 'distDiff', is: dd2 },
            { e: 'hy2', f: 'a', is: a2v }, { e: 'hy2', f: 'b', is: b2v },
            { e: 'hy2', f: 'cx', is: 0 }, { e: 'hy2', f: 'cy', is: 3 },
            { e: 'hy2', f: 'rot', is: Math.PI / 2 },
            { e: 'hy2', f: 'termA', is: A2 }, { e: 'hy2', f: 'termB', is: B2 },
            { e: 'hy2', f: 'termC', is: C2 }, { e: 'hy2', f: 'termD', is: D2 },
            { e: 'hy2', f: 'termE', is: E2 }, { e: 'hy2', f: 'termF', is: F2 },
            { e: 'hy2', f: 'meaning', is: 1 },
            { e: 'hy3', f: 'distDiff', is: 0 },
            { e: 'hy3', f: 'meaning', is: 0 }, { e: 'hy3', f: 'a', nan: true },
            { e: 'hy4', f: 'distDiff', is: 2 },
            { e: 'hy4', f: 'meaning', is: 0 },
        ],
    });
}

// --------------------------------------------------------------- parabola ----
{
    // focus (0,1), directrix y=-1: vertex (0,0), p=1, rot pi/2, x^2 - 4y = 0
    const rot1 = Math.atan2(2, 0);   // fy - proj_y = 2, fx - proj_x = 0
    const c1 = Math.cos(rot1), s1 = Math.sin(rot1);
    const A1 = s1 * s1, B1 = -2 * c1 * s1, C1 = c1 * c1;
    const D1 = -4 * 1 * c1, E1 = -4 * 1 * s1;
    // focus (1,1), directrix x=0: vertex (0.5,1), p=0.5, rot 0, y^2-2x-2y+2=0
    runSet('parabola', [
        P('f', 0, 1), P('f2p', 1, 1), P('f3', 5, 5),
        P('dm1', -2, -1), P('dm2', 2, -1), P('dn1', 0, 0), P('dn2', 0, 2),
        `5|d1||dm1,dm2|dm1|dm2`,     // horizontal directrix y=-1
        `5|d2||dn1,dn2|dn1|dn2`,    // vertical directrix x=0
        `5|dl||nope1,nope2|nope1|nope2`,   // never meaningful (bad refs)
        `14|pb1||f,d1|f|d1`,
        `14|pb2||f2p,d2|f2p|d2`,
        `14|pb3||f3,dl|f3|dl`,      // deps unmeaningful
    ], {
        points: {
            f: [0, 1], f2p: [1, 1], f3: [5, 5],
            dm1: [-2, -1], dm2: [2, -1], dn1: [0, 0], dn2: [0, 2],
        },
        expect: [
            { e: 'pb1', f: 'vx', is: 0 }, { e: 'pb1', f: 'vy', is: 0 },
            { e: 'pb1', f: 'p', is: 1 }, { e: 'pb1', f: 'rot', is: Math.PI / 2 },
            { e: 'pb1', f: 'termA', is: A1 }, { e: 'pb1', f: 'termB', is: B1 },
            { e: 'pb1', f: 'termC', is: C1 }, { e: 'pb1', f: 'termD', is: D1 },
            { e: 'pb1', f: 'termE', is: E1 }, { e: 'pb1', f: 'termF', is: 0 },
            { e: 'pb1', f: 'meaning', is: 1 }, { e: 'pb1', f: 'flags', is: 3 },
            { e: 'pb2', f: 'vx', is: 0.5 }, { e: 'pb2', f: 'vy', is: 1 },
            { e: 'pb2', f: 'p', is: 0.5 }, { e: 'pb2', f: 'rot', is: 0 },
            { e: 'pb2', f: 'termA', is: 0 }, { e: 'pb2', f: 'termB', is: 0 },
            { e: 'pb2', f: 'termC', is: 1 }, { e: 'pb2', f: 'termD', is: -2 },
            { e: 'pb2', f: 'termE', is: -2 }, { e: 'pb2', f: 'termF', is: 2 },
            { e: 'pb2', f: 'meaning', is: 1 },
            { e: 'pb3', f: 'meaning', is: 0 },
            { e: 'pb3', f: 'flags', is: 0 },    // deps skip leaves flags untouched
            { e: 'pb3', f: 'vx', nan: true },
        ],
    });
}

// ----------------------------------------------------------- circulararc ----
{
    runSet('circulararc', [
        P('o', 0, 0), P('s1p', 1, 0), P('e1p', 0, 1),
        P('o2', 2, 2), P('s2p', 2, 4), P('e2p', 4, 2),
        P('zc', 5, 5),
        `26|ca1||o,s1p,e1p|o|s1p|e1p`,
        `26|ca2||o2,s2p,e2p|o2|s2p|e2p`,
        `26|ca3||o,o,zc|o|o|zc`,      // start == center: radius 0
        `26|ca4||o2,s2p,o2|o2|s2p|o2`, // end == center
    ], {
        points: {
            o: [0, 0], s1p: [1, 0], e1p: [0, 1],
            o2: [2, 2], s2p: [2, 4], e2p: [4, 2], zc: [5, 5],
        },
        expect: [
            { e: 'ca1', f: 'radius', is: 1 },
            { e: 'ca1', f: 'sAng', is: 0 }, { e: 'ca1', f: 'eAng', is: Math.PI / 2 },
            { e: 'ca1', f: 'meaning', is: 1 }, { e: 'ca1', f: 'flags', is: 3 },
            { e: 'ca1', f: 'err', is: 0 },
            { e: 'ca2', f: 'radius', is: 2 },
            { e: 'ca2', f: 'sAng', is: Math.PI / 2 }, { e: 'ca2', f: 'eAng', is: 0 },
            { e: 'ca2', f: 'meaning', is: 1 },
            { e: 'ca3', f: 'radius', is: 0 },     // write-then-fail
            { e: 'ca3', f: 'sAng', nan: true },
            { e: 'ca3', f: 'meaning', is: 0 }, { e: 'ca3', f: 'flags', is: 2 },
            { e: 'ca4', f: 'radius', is: 2 },
            { e: 'ca4', f: 'sAng', is: Math.PI / 2 },  // written before the len gate
            { e: 'ca4', f: 'eAng', nan: true },
            { e: 'ca4', f: 'meaning', is: 0 },
        ],
    });
}

console.log(`geometry-constructs-check: ${checks} checks, ${failures} failures, ${skipped} sets skipped`);
if (skipped > 0) {
    console.log('(skipped sets need the other geometry groups ported; the official ' +
                'suites calcjs-diff/vm-diff do not exercise geometry)');
}
process.exit(failures ? 1 : 0);
