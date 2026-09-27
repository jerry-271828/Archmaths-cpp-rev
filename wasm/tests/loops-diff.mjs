// Differential test for sum/prod/int large operators: the page's IIFE code
// (same templates as recompileFunctions) vs the wasm Math.__arch* forms.
// Usage: node wasm/tests/loops-diff.mjs [archcore.wasm] [arch-current.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, extractAdvancedFunctions } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await loadCore(process.argv[2] || path.join(here, '../dist/archcore.wasm'));
const adv = extractAdvancedFunctions(fs.readFileSync(process.argv[3] || path.join(here, '../../arch-current.html'), 'utf8'));

// Templates copied from recompileFunctions().
const js = {
    sum: (b, v, s, e) => `((() => { let __res = 0; let __s = Math.round(${s}); let __e = Math.round(${e}); if(Math.abs(__e - __s) > 50000) return 0; for(let ${v} = __s; ${v} <= __e; ${v}++) { __res += (${b}); } return __res; })())`,
    prod: (b, v, s, e) => `((() => { let __res = 1; let __s = Math.round(${s}); let __e = Math.round(${e}); if(Math.abs(__e - __s) > 50000) return 0; for(let ${v} = __s; ${v} <= __e; ${v}++) { __res *= (${b}); } return __res; })())`,
    int: (b, v, s, e, n) => `((() => { let __sum = 0; let __a = (${s}); let __b = (${e}); let __n = ${n}; let __h = (__b - __a) / __n; if (Math.abs(__h) < 1e-15) return 0; let ${v} = __a; let __val = (${b}); if(!Number.isFinite(__val)) __val=0; __sum += 0.5 * __val; for(let __i = 1; __i < __n; __i++) { ${v} = __a + __i * __h; __val = (${b}); if(!Number.isFinite(__val)) __val=0; __sum += __val; } ${v} = __b; __val = (${b}); if(!Number.isFinite(__val)) __val=0; __sum += 0.5 * __val; return __sum * __h; })())`,
};
const wasm = {
    sum: (b, v, s, e) => `Math.__archsum(${b},${v},${s},${e})`,
    prod: (b, v, s, e) => `Math.__archprod(${b},${v},${s},${e})`,
    int: (b, v, s, e, n) => `Math.__archint(${b},${v},${s},${e},${n})`,
};
// Each case builds both strings from the same structure.
const cases = [
    (f) => f.sum('k*x', 'k', '1', '5'),
    (f) => f.sum('1/k', 'k', '-0.3', '3'),                       // Math.round(-0.3) = -0 -> 1/-0
    (f) => f.sum('__advanced__.pow(x,k)/k', 'k', '1', 'y'),       // lane-dependent bound
    (f) => f.prod('(1+x/k)', 'k', '1', '20'),
    (f) => f.sum('k', 'k', '5', '1'),                              // empty
    (f) => f.sum('k', 'k', '0', '60000'),                          // cap -> 0
    (f) => f.prod('k', 'k', '0', '60000'),                         // cap -> 0 (not 1)
    (f) => f.sum('k', 'k', 'x', 'y'),                              // NaN bounds when x is NaN
    (f) => f.int('Math.sin(t)', 't', '0', 'x', 100),
    (f) => f.int('Math.exp(-t*t)', 't', '-x', 'x', 250),
    (f) => f.int('1/t', 't', '-1', '1', 100),                      // non-finite samples -> 0
    (f) => f.int('t', 't', 'x', 'x', 100),                         // |h| < 1e-15 -> 0
    (f) => f.int('a*t+x', 't', '0', '1', 7.5),                     // non-integer step count
    (f) => f.sum(f.sum('j*k', 'j', '1', 'k'), 'k', '1', '6'),      // nested, inner uses outer var
    (f) => f.sum('x', 'x', '1', '3') + '+x',                       // loop var shadows lane arg
    (f) => f.sum('a*x', 'a', '1', '3') + '*a',                     // loop var shadows param
    (f) => f.int(f.sum('Math.cos(k*t)', 'k', '1', '3'), 't', '0', 'y', 50),
    (f) => '2*' + f.sum('Math.sin(k*x)/k', 'k', '1', '25') + '-' + f.prod('Math.cos(x/k)', 'k', '1', '8'),
];
const probes = [-3.2, -1, -0.5, 0, 0.25, 1, 2, 2.5, 3.7, 7, NaN, 1e-9];

function same(a, b) {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
}

let checks = 0, exact = 0, failures = 0;
for (const make of cases) {
    const jsSrc = make(js);
    const wSrc = make(wasm);
    const fn = new Function('x', 'y', 'a', '__advanced__', `return (${jsSrc});`);
    const h = core.compile(wSrc, ['x', 'y'], ['a']);
    if (!h) { failures++; console.log('COMPILE FAIL', wSrc, core.lastError()); continue; }
    core.setParams(h, [1.75]);
    const n = probes.length * probes.length;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = probes[i % probes.length]; ys[i] = probes[Math.floor(i / probes.length)]; }
    const out = core.evalLanes(h, [xs, ys], n, 0);
    for (let i = 0; i < n; i++) {
        const want = fn(xs[i], ys[i], 1.75, adv);
        checks++;
        if (Object.is(out[i], want) || (Number.isNaN(out[i]) && Number.isNaN(want))) exact++;
        if (!same(out[i], want)) {
            failures++;
            if (failures < 20) console.log(`MISMATCH ${wSrc} @x=${xs[i]},y=${ys[i]}: wasm=${out[i]} js=${want}`);
        }
    }
}
console.log(`${checks} checks, ${exact} bit-exact, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
