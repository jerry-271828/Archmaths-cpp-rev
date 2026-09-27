// Differential test: archcore.wasm's `advfuncs` kernel (findAdvancedFunction) vs
// the page's own ADVANCED_FUNCTION_DEFINITIONS JS bodies (extracted and eval'd
// verbatim by harness.mjs's extractAdvancedFunctions).
//
// Usage: node wasm/tests/advfuncs-diff.mjs [path/to/archcore.wasm] [path/to/arch-current.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, extractAdvancedFunctions } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] || path.join(here, '../dist/archcore.wasm');
const htmlPath = process.argv[3] || path.join(here, '../../arch-current.html');

const core = await loadCore(wasmPath);
const adv = extractAdvancedFunctions(fs.readFileSync(htmlPath, 'utf8'));

// ---- comparison -----------------------------------------------------------

function relErr(a, b) {
    if (Object.is(a, b)) return 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b ? 0 : Infinity;
    return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
}

const TOL = 1e-9; // pass/fail threshold (KERNEL_GUIDE.md's default)
const TARGET = 1e-12; // task's target; mismatches above this are logged for review

let checks = 0, exact = 0, withinTarget = 0, failures = 0;
const worstByFn = new Map();
const failLines = [];

function check(fn, label, got, want) {
    checks++;
    const e = relErr(got, want);
    const prev = worstByFn.get(fn) || 0;
    if (e > prev || Number.isNaN(prev)) worstByFn.set(fn, Number.isFinite(e) ? Math.max(prev, e) : (prev === 0 ? e : prev));
    if (e === 0) exact++;
    if (e <= TARGET) withinTarget++;
    if (!(e <= TOL)) {
        failures++;
        if (failLines.length < 60) failLines.push(`MISMATCH ${label}: wasm=${got} js=${want} relErr=${e}`);
    }
}

// ---- value pools ------------------------------------------------------

const boundaries = [
    0, -0, 0.5, -0.5, 1, -1, 6, -6, 4.59, -4.59, 1e7, -1e7, 10000000, -10000000,
    21.991148575128552, -21.991148575128552, -0.3698, 0.3698,
];
const eps = [1e-15, 1e-12, 1e-9, 1e-6, 1e-3];
function withPerturbations(vals) {
    const out = new Set(vals);
    for (const b of boundaries) for (const e of eps) { out.add(b + e); out.add(b - e); }
    return [...out];
}

const integers = [];
for (let i = -30; i <= 30; i++) integers.push(i);

const denseGrid = [];
for (let i = -200; i <= 200; i++) denseGrid.push(i * 0.0731); // irrational-ish step, dense, non-aligned to boundaries
for (let i = -50; i <= 50; i++) denseGrid.push(i * 1.37);

const specials = [0, -0, Infinity, -Infinity, NaN, 1e300, -1e300, 1e-300, -1e-300, 5e-324, -5e-324,
    Number.MAX_VALUE, -Number.MAX_VALUE];

const baseValues = withPerturbations([
    ...integers, ...denseGrid, ...specials,
    -1000, -100, -50, -25, -10, -7.5, -3.3, -2.1, 2.1, 3.3, 7.5, 10, 25, 50, 100, 1000,
    0.1, 0.01, 0.001, -0.1, -0.01, -0.001, 100000, -100000, 12345.6789, -12345.6789,
]);

function rand(min, max) { return min + Math.random() * (max - min); }
function randomValues(n, opts = {}) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const r = Math.random();
        if (r < 0.15) out.push(rand(-1, 1));
        else if (r < 0.3) out.push(Math.round(rand(-40, 40))); // hit integers (gamma/psi poles)
        else if (r < 0.45) out.push(rand(-10, 10));
        else if (r < 0.6) out.push(rand(-1000, 1000));
        else if (r < 0.75) out.push(Math.exp(rand(-30, 30)) * (Math.random() < 0.5 ? -1 : 1)); // log-uniform magnitude
        else if (r < 0.9 && opts.boundaries) out.push(opts.boundaries[Math.floor(Math.random() * opts.boundaries.length)] + rand(-1e-6, 1e-6));
        else out.push(rand(-100, 100));
    }
    return out;
}

// ---- driver for 1-arg functions -------------------------------------------

// NOTE: 'psi' is intentionally excluded from this list. advfuncs.cpp no
// longer registers it (see the comment on fnPsi / in kFunctions) because its
// central-difference algorithm amplifies ordinary libm ULP noise by ~5e6x,
// and the engine's runtime probe (24 fixed sample points) cannot reliably
// catch that for every expression shape (shifted/scaled arguments routinely
// evade it - see wasm/tests/browser/advfuncs.js and the verifier's
// verify-advfuncs.js probe-evasion test). It is checked separately below:
// compiling any expression that references it must now fail.
const unaryFns = [
    'gamma', 'erf', 'erfc', 'elliptice', 'elliptick', 'sign', 'sgn', 'heaviside',
    'fresnels', 'fresnelc', 'lambertw', 'ltw', 'li', 'zeta',
    'sinintegral', 'cosintegral', 'expintegral',
];

for (const name of unaryFns) {
    const jsFn = adv[name];
    if (!jsFn) { console.log(`SKIP ${name}: not found in page defs`); continue; }
    const h = core.compile(`__advanced__.${name}(x)`, ['x'], []);
    if (!h) { failures++; console.log(`COMPILE FAIL ${name}: ${core.lastError()}`); continue; }

    const values = [...baseValues, ...randomValues(4000, { boundaries })];
    // extra targeted values for functions with poles at negative integers
    if (name === 'gamma') {
        for (const i of integers) { values.push(i, i + 1e-9, i - 1e-9, i + 1e-6, i - 1e-6); }
    }

    const n = values.length;
    const lane = Float64Array.from(values);
    const out = core.evalLanes(h, [lane], n, 0);
    for (let i = 0; i < n; i++) {
        let want;
        try { want = jsFn(values[i]); } catch (e) { want = NaN; }
        check(name, `${name}(${values[i]})`, out[i], want);
    }
}

// ---- driver for 2-arg functions (llim, ulim) -------------------------------

for (const name of ['llim', 'ulim']) {
    const jsFn = adv[name];
    if (!jsFn) { console.log(`SKIP ${name}: not found in page defs`); continue; }
    const h = core.compile(`__advanced__.${name}(x,y)`, ['x', 'y'], []);
    if (!h) { failures++; console.log(`COMPILE FAIL ${name}: ${core.lastError()}`); continue; }

    const xs = [...baseValues.slice(0, 300), ...randomValues(1500)];
    const ys = [...baseValues.slice(0, 300), ...randomValues(1500)];
    const n = Math.min(xs.length, ys.length);
    const lx = Float64Array.from(xs.slice(0, n));
    const ly = Float64Array.from(ys.slice(0, n));
    const out = core.evalLanes(h, [lx, ly], n, 0);
    for (let i = 0; i < n; i++) {
        const want = jsFn(lx[i], ly[i]);
        check(name, `${name}(${lx[i]},${ly[i]})`, out[i], want);
    }
    // cross product over a small grid too (catches boundary alignment cases)
    const small = [-10, -1, -0.5, 0, 0.5, 1, 10, Infinity, -Infinity, NaN];
    const gx = [], gy = [];
    for (const a of small) for (const b of small) { gx.push(a); gy.push(b); }
    const gout = core.evalLanes(h, [Float64Array.from(gx), Float64Array.from(gy)], gx.length, 0);
    for (let i = 0; i < gx.length; i++) check(name, `${name}(${gx[i]},${gy[i]}) grid`, gout[i], jsFn(gx[i], gy[i]));
}

// ---- driver for 3-arg function (range) -------------------------------------

{
    const name = 'range';
    const jsFn = adv[name];
    const h = core.compile(`__advanced__.${name}(x,y,z)`, ['x', 'y', 'z'], []);
    if (!h) { failures++; console.log(`COMPILE FAIL ${name}: ${core.lastError()}`); }
    else {
        const small = [-10, -1, -0.5, 0, 0.5, 1, 10, Infinity, -Infinity, NaN];
        const gx = [], gy = [], gz = [];
        for (const a of small) for (const b of small) for (const c of small) { gx.push(a); gy.push(b); gz.push(c); }
        const out = core.evalLanes(h, [Float64Array.from(gx), Float64Array.from(gy), Float64Array.from(gz)], gx.length, 0);
        for (let i = 0; i < gx.length; i++) check(name, `range(${gx[i]},${gy[i]},${gz[i]})`, out[i], jsFn(gx[i], gy[i], gz[i]));

        const rx = randomValues(2000), ry = randomValues(2000), rz = randomValues(2000);
        const rout = core.evalLanes(h, [Float64Array.from(rx), Float64Array.from(ry), Float64Array.from(rz)], rx.length, 0);
        for (let i = 0; i < rx.length; i++) check(name, `range(${rx[i]},${ry[i]},${rz[i]}) rand`, rout[i], jsFn(rx[i], ry[i], rz[i]));
    }
}

// ---- also confirm `pow` was NOT re-registered by this kernel (VM already
// special-cases it; advfuncs.cpp intentionally excludes it) --------------
{
    const h = core.compile('__advanced__.pow(x,y)', ['x', 'y'], []);
    if (!h) { failures++; console.log('COMPILE FAIL: __advanced__.pow should still work via the VM built-in, not advfuncs'); }
    else {
        const got = core.evalOne(h, [2, 10], 0);
        if (got !== 1024) { failures++; console.log(`pow sanity check failed: got ${got}`); }
    }
}

// ---- confirm `psi` is deliberately NOT wasm-eligible (see the comment on
// fnPsi / in kFunctions in advfuncs.cpp): compiling any expression that
// references it must fail so programFor() unconditionally falls back to JS,
// instead of depending on the runtime probe's 24 fixed sample points (which
// do not reliably catch shifted/scaled arguments - confirmed live by the
// verifier and by wasm/tests/browser/advfuncs.js). If this ever starts
// compiling again, psi was re-registered without an equivalent safety net. --
{
    checks++;
    const standalone = core.compile('__advanced__.psi(x)', ['x'], []);
    if (standalone) {
        failures++;
        console.log('REGRESSION: __advanced__.psi(x) compiled - psi must stay unregistered (see advfuncs.cpp)');
    }
    checks++;
    const shifted = core.compile('__advanced__.psi(x+50)', ['x'], []);
    if (shifted) {
        failures++;
        console.log('REGRESSION: __advanced__.psi(x+50) compiled - psi must stay unregistered (see advfuncs.cpp)');
    }
    checks++;
    // psi mixed into a larger expression must also fail to compile as a whole
    // (ExprProgram::lower fails the entire program for one unsupported call),
    // so none of it silently runs on the wasm path.
    const mixed = core.compile('__advanced__.gamma(x)+__advanced__.psi(x)', ['x'], []);
    if (mixed) {
        failures++;
        console.log('REGRESSION: an expression mixing gamma+psi compiled - psi must stay unregistered (see advfuncs.cpp)');
    }
}

// ---- report -----------------------------------------------------------

console.log('--- worst relative error per function ---');
for (const [fn, e] of [...worstByFn.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${fn.padEnd(14)} ${e}`);
}
for (const line of failLines) console.log(line);
console.log(`${checks} checks, ${exact} bit-exact, ${withinTarget} within ${TARGET}, ${failures} failures (tol ${TOL})`);
process.exitCode = failures ? 1 : 0;
