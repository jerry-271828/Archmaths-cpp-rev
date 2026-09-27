// Differential test: archcore.wasm expression VM vs the page's own JS semantics.
// Usage: node wasm/tests/vm-diff.mjs [path/to/archcore.wasm] [path/to/arch-current.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, extractAdvancedFunctions } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] || path.join(here, '../dist/archcore.wasm');
const htmlPath = process.argv[3] || path.join(here, '../../arch-current.html');

const core = await loadCore(wasmPath);
const adv = extractAdvancedFunctions(fs.readFileSync(htmlPath, 'utf8'));
const strictAdv = { ...adv, pow: (a, b) => (a < 0 && Math.abs(b - Math.round(b)) > 1e-10) ? NaN : adv.pow(a, b) };

function same(a, b) {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    if (a === b) return true;
    return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
}

let failures = 0;
let checks = 0;
let exact = 0;
function check(label, got, want) {
    checks++;
    if (Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want))) exact++;
    if (!same(got, want)) {
        failures++;
        if (failures <= 25) console.log(`MISMATCH ${label}: wasm=${got} js=${want}`);
    }
}

// 1) advanced pow over a dense set of tricky inputs, both variants.
const bases = [-8, -27, -2, -1, -0.5, -0, 0, 0.5, 1, 2, 3, 10, -1e-300, 1e300, -Infinity, Infinity, NaN, -3.7, 4.2];
const exps = [0, 1, 2, 3, -1, -2, 0.5, 1 / 3, 2 / 3, -1 / 3, 1 / 5, 2 / 5, 0.25, 0.75, 1 / 25, 2 / 25, 1 / 26, 1.5, -1.5,
    2.5, 1e-10, 0.1, 0.3333333, 0.33333333333, 7 / 9, 11 / 13, 24 / 25, Infinity, -Infinity, NaN, 1e20, -0, 3.0000000001];
for (const [label, fn, flags] of [['pow', adv.pow, 0], ['powStrict', strictAdv.pow, 1]]) {
    const h = core.compile('__advanced__.pow(x,y)', ['x', 'y'], []);
    for (const b of bases) for (const e of exps) {
        check(`${label}(${b},${e})`, core.evalOne(h, [b, e], flags), fn(b, e));
    }
    for (let i = 0; i < 20000; i++) {
        const b = (Math.random() - 0.5) * 20;
        const e = Math.random() < 0.5 ? Math.round((Math.random() - 0.5) * 12) / (1 + Math.floor(Math.random() * 30)) : (Math.random() - 0.5) * 8;
        check(`${label}(${b},${e})`, core.evalOne(h, [b, e], flags), fn(b, e));
    }
}

// 2) whole expressions in the transpiler's output dialect.
const exprs = [
    ['Math.sin(x)*__advanced__.pow(x,2)+Math.cos(3*x)', ['x'], []],
    ['(__advanced__.pow(x,2)+__advanced__.pow(y,2)+Math.sin(3*x)*y)-(4)', ['x', 'y'], []],
    ['a*Math.sin(b*x)+c', ['x'], ['a', 'b', 'c']],
    ['Math.round(x)+Math.sign(x)*Math.abs(x)-Math.floor(x)+Math.ceil(x)', ['x'], []],
    ['Math.log(x)+Math.log10(x)+Math.sqrt(x)+Math.cbrt(x)+Math.exp(-x)', ['x'], []],
    ['Math.asin(x/10)+Math.acos(x/10)+Math.atan(x)+Math.sinh(x/5)+Math.cosh(x/5)+Math.tanh(x)', ['x'], []],
    ['Math.asinh(x)+Math.acosh(x)+Math.atanh(x/10)', ['x'], []],
    ['-x*-y/z+x-y', ['x', 'y', 'z'], []],
    ['__advanced__.pow(x,1/3)-__advanced__.pow(y,2/3)+__advanced__.pow(-x,0.5)', ['x', 'y'], []],
    ['1/(x-2)+1/(y+1)', ['x', 'y'], []],
    ['Math.max(x,y,a)-Math.min(x,y)', ['x', 'y'], ['a']],
    ['k', ['x'], ['k']],
    ['x', ['x'], []],
    ['2.718281828459045*3.141592653589793', ['x'], []],
    ['__advanced__.pow(__advanced__.pow(x,2)+__advanced__.pow(y,2)-1,3)-__advanced__.pow(x,2)*__advanced__.pow(y,3)', ['x', 'y'], []],
    ['Math.tan(x*y)-Math.sin(__advanced__.pow(x,a))', ['x', 'y'], ['a']],
];
const probes = [-7.3, -2, -1, -0.5, -0, 0, 0.3, 0.5, 1, 1.7, 2, 3.14159, 10, 123.4, -55.5, 1e-9, 2.5, -2.5, 0.49999999999999994];
const paramVals = [1.5, -2, 0.75];
for (const [src, args, params] of exprs) {
    const h = core.compile(src, args, params);
    if (!h) { failures++; console.log('COMPILE FAIL', src, core.lastError()); continue; }
    const js = new Function(...args, ...params, '__advanced__', `return (${src});`);
    core.setParams(h, paramVals.slice(0, params.length));
    for (const flags of [0, 1]) {
        const a = flags ? strictAdv : adv;
        // batched evaluation of many lanes
        const n = probes.length ** Math.min(args.length, 2);
        const lanes = args.map(() => new Float64Array(n));
        for (let i = 0; i < n; i++) {
            lanes.forEach((lane, k) => { lane[i] = probes[(k === 0 ? i : Math.floor(i / probes.length) + k) % probes.length]; });
        }
        const out = core.evalLanes(h, lanes, n, flags);
        for (let i = 0; i < n; i++) {
            const argv = lanes.map((l) => l[i]);
            check(`${src} @${argv} f${flags}`, out[i], js(...argv, ...paramVals.slice(0, params.length), a));
        }
    }
}

// 3) inputs that must be rejected (the page keeps its JS path for them).
const rejects = ['Math.random()', 'x**2', 'foo(x)', '__advanced__.psi(x)', 'x.y', '012+x', 'x^2', 'window', 'Math.diff(x)',
    '((() => { let __res = 0; return __res; })())', 'x ? 1 : 2', 'x>1', 'undefinedVar+1'];
for (const src of rejects) {
    const h = core.compile(src, ['x'], []);
    if (h) { failures++; console.log('SHOULD REJECT', src); }
}

console.log(`${checks} checks, ${exact} bit-exact, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
