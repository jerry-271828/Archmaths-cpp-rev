// Differential test for the root[expr,var,init] numerical root finding kernel
// (ac_calc_compile with one lane arg + ac_root_run) against a verbatim copy of
// the page's JS algorithm (arch-current.html, recalculateVariableValues'
// isRootFinding branch), with the page's own calcJSUtils pipeline (extracted
// from arch-current.html) as the reference evaluator.
//
// Part 1 (wasm-direct): page-parses each (expr, init) into the stored expanded
// token arrays exactly like parseInputInternal does, joins them back into
// source (what wasm/js/kernels/rootfind.js feeds the core), compiles f(rootVar)
// with rootVar as the single arg and all scope variables as params, uploads
// the scope, and compares ac_root_run against the JS algorithm over the
// cartesian product of equations x scope grids x init grids. NaN-ness must
// match exactly; finite values within 1e-9 relative.
//
// Part 2 (kernel-level): loads wasm/js/kernels/calc.js + rootfind.js against a
// shim ArchCore to verify the guard/fallback contract: normal path (probe
// accepted, sticky cache), non-pristine advanced function -> null, unknown
// advanced name -> compile failure -> null, non-finite init -> null, probe
// mismatch -> null and permanently rejected.
//
// Usage: node wasm/tests/rootfind-diff.mjs [archcore.wasm] [arch-current.html]
// Exit code: number of failures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, extractAdvancedFunctions } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await loadCore(process.argv[2] || path.join(here, '../dist/archcore.wasm'));
const html = fs.readFileSync(process.argv[3] || path.join(here, '../../arch-current.html'), 'utf8');

// ---- extract the calcJSUtils object literal (same as calcjs-diff) ----------
function extractBalanced(source, openIdx, openCh, closeCh) {
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
        const c = source[i];
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < source.length && source[i] !== q) {
                if (source[i] === '\\') i++;
                i++;
            }
            continue;
        }
        if (c === openCh) depth++;
        else if (c === closeCh) {
            depth--;
            if (depth === 0) return i;
        }
    }
    throw new Error('unbalanced ' + openCh);
}

const calcAnchor = html.indexOf('this.calcJSUtils = {');
if (calcAnchor < 0) throw new Error('calcJSUtils not found');
const calcOpen = html.indexOf('{', calcAnchor);
const calcClose = extractBalanced(html, calcOpen, '{', '}');
const calcJSUtils = new Function(`return (${html.slice(calcOpen, calcClose + 1)});`)();

// ---- improvedTokenize (engine method ported for the harness, cf. calcjs-diff)
function improvedTokenize(expression, knownSymbolsSet) {
    if (!expression) return [];
    let expr = expression.toLowerCase().replace(/\s+/g, '');
    const staticTokens = ['sum', 'prod', 'int', 'diff', 'diffat', 'x', 'y', 'z', 't'];
    const allSymbols = Array.from(new Set([...knownSymbolsSet, ...staticTokens]));
    allSymbols.sort((a, b) => (b.length !== a.length ? b.length - a.length : a.localeCompare(b)));
    let segments = [expr];
    for (const sym of allSymbols) {
        const newSegments = [];
        for (const seg of segments) {
            if (typeof seg !== 'string') { newSegments.push(seg); continue; }
            let remaining = seg;
            while (true) {
                const idx = remaining.indexOf(sym);
                if (idx === -1) { if (remaining.length > 0) newSegments.push(remaining); break; }
                if (idx > 0) newSegments.push(remaining.substring(0, idx));
                newSegments.push({ type: 'token', value: sym });
                remaining = remaining.substring(idx + sym.length);
            }
        }
        segments = newSegments;
    }
    const finalTokens = [];
    for (const seg of segments) {
        if (typeof seg !== 'string') { finalTokens.push(seg.value); continue; }
        let i = 0;
        const len = seg.length;
        while (i < len) {
            const char = seg[i];
            if (/[0-9.]/.test(char)) {
                let numStr = char;
                let j = i + 1;
                while (j < len && /[0-9.]/.test(seg[j])) { numStr += seg[j]; j++; }
                if ((numStr.match(/\./g) || []).length > 1) { finalTokens.push(char); i++; continue; }
                finalTokens.push(numStr);
                i = j;
            } else if (['+', '-', '*', '/', '^', ',', '(', ')', '=', '<', '>'].includes(char)) {
                finalTokens.push(char);
                i++;
            } else if (/[a-z_]/.test(char)) {
                let id = char;
                let j = i + 1;
                while (j < len && /[a-z0-9_]/.test(seg[j])) { id += seg[j]; j++; }
                finalTokens.push(id);
                i = j;
            } else {
                finalTokens.push(char);
                i++;
            }
        }
    }
    return finalTokens;
}

// ---- register advanced functions exactly like the page does ----------------
const adv = extractAdvancedFunctions(html);
for (const name of Object.keys(adv)) {
    if (name === '__defs') continue;
    const def = adv.__defs.find((d) => d.name === name);
    calcJSUtils.advancedCustomFunctions[name] = {
        params: def.params,
        bodyJsString: def.bodyJsString,
        compiledFunc: adv[name],
    };
    calcJSUtils.advancedCustomFunctionNames.push(name);
}
calcJSUtils.advancedCustomFunctionNames.sort((a, b) => b.length - a.length);

// ---- simple custom functions (page defineCalcJSFunction, simple branch) ----
function defineCalcJSFunction(defString) {
    const m = defString.match(/^([a-zA-Z_][\w]*)\s*\(([^)]*)\)\s*=\s*(.+)$/s);
    if (!m) throw new Error('bad def: ' + defString);
    const name = m[1];
    const params = m[2].split(',').map((p) => p.trim()).filter(Boolean);
    const paramsLower = params.map((p) => p.toLowerCase());
    const contextSymbols = new Set([
        ...calcJSUtils.calc1, ...calcJSUtils.calc3, ...calcJSUtils.advancedCustomFunctionNames,
        ...Object.keys(calcJSUtils.constants), ...params,
    ].filter(Boolean).map((n) => n.toLowerCase()));
    const bodyTokens = improvedTokenize(m[3], contextSymbols);
    calcJSUtils.customFunctions[name.toLowerCase()] = { params: paramsLower, bodyTokens, rawBodyString: m[3] };
    const nameLower = name.toLowerCase();
    if (!calcJSUtils.calc3.includes(nameLower)) {
        calcJSUtils.calc3.push(nameLower);
        calcJSUtils.calc3.sort((a, b) => b.length - a.length);
    }
}

{
    const anchor = html.indexOf('const builtinfunc = [');
    if (anchor < 0) throw new Error('builtinfunc not found');
    const open = html.indexOf('[', anchor);
    const close = extractBalanced(html, open, '[', ']');
    const builtinfunc = new Function(`return ${html.slice(open, close + 1)};`)();
    for (const def of builtinfunc) defineCalcJSFunction(def);
}

// Test-only simple custom functions (parse-time expansion inlines them into
// the stored root tokens; the joined source must re-expand idempotently).
defineCalcJSFunction('f(a)=a^2+1');
defineCalcJSFunction('g(b)=f(b)*2');
defineCalcJSFunction('w(t)=t^3-2t-5');

function encodeUserFns() {
    const parts = [];
    for (const name of Object.keys(calcJSUtils.customFunctions)) {
        const f = calcJSUtils.customFunctions[name];
        parts.push(name + '|' + f.params.join(',') + '|' + f.bodyTokens.join(' '));
    }
    parts.sort();
    return parts.join('\n');
}

// ---- page-faithful parse of a root entry part (parseInputInternal.processPart)
function pageParseTokens(src, rootVar, scopeNames) {
    const known = new Set([
        ...calcJSUtils.calc1, ...calcJSUtils.calc3, ...calcJSUtils.advancedCustomFunctionNames,
        ...Object.keys(calcJSUtils.constants), ...scopeNames, rootVar,
    ].filter(Boolean).map((n) => String(n).toLowerCase()));
    const tokens = improvedTokenize(src, known);
    return calcJSUtils.expandDiffOperations.call(calcJSUtils,
        calcJSUtils.expandCustomFunctions.call(calcJSUtils, tokens, calcJSUtils.customFunctions, calcJSUtils.calc3, calcJSUtils.advancedCustomFunctions, calcJSUtils.advancedCustomFunctionNames),
        calcJSUtils.customFunctions, calcJSUtils.calc3, calcJSUtils.constants, calcJSUtils.calc1, calcJSUtils.advancedCustomFunctions, calcJSUtils.advancedCustomFunctionNames);
}

function jsEvalTokens(tokens, scope) {
    return calcJSUtils.evaluateScopedExpression.call(
        calcJSUtils, tokens, { ...scope },
        calcJSUtils.customFunctions, calcJSUtils.calc3, calcJSUtils.constants, calcJSUtils.calc1,
        INTEGRAL_STEPS, calcJSUtils.advancedCustomFunctions, calcJSUtils.advancedCustomFunctionNames,
        calcJSUtils.getAdvancedFuncsMap());
}

// ---- verbatim copy of the page's root algorithm (isRootFinding branch) -----
// arch-current.html, the block opened by `if (entry.isRootFinding) {`: same
// statements, same order. Only adaptations: the entry/scope arrive as
// arguments, `newValue = ...` becomes `return ...`, and a `path` tag is added
// (observability only; it never feeds back into the computation).
function jsRootFind(rootExprTokens, rootInitTokens, rootVar, scope) {
    const evalF = (v) => {
        const fullScope = { ...scope, [rootVar]: v };
        return calcJSUtils.evaluateScopedExpression.call(calcJSUtils, rootExprTokens, fullScope, calcJSUtils.customFunctions, calcJSUtils.calc3, calcJSUtils.constants, calcJSUtils.calc1, INTEGRAL_STEPS, calcJSUtils.advancedCustomFunctions, calcJSUtils.advancedCustomFunctionNames, calcJSUtils.getAdvancedFuncsMap());
    };

    let x0;
    try { x0 = jsEvalTokens(rootInitTokens, scope); } catch (e) { x0 = NaN; }
    if (Number.isFinite(x0)) {
        let x = x0, y0 = evalF(x0), found = false;
        let path = 'notfound';

        if (Math.abs(y0) < 1e-3) {
            x = x0;
            found = true;
            path = 'direct';
        } else {
            let step = 0.1;
            let maxSteps = 1000;
            for (let i = 1; i <= maxSteps; i++) {
                let xL = x0 - i * step, yL = evalF(xL);
                if (Number.isFinite(yL) && yL * y0 <= 0) { x = xL; found = true; break; }
                let xR = x0 + i * step, yR = evalF(xR);
                if (Number.isFinite(yR) && yR * y0 <= 0) { x = xR; found = true; break; }

                if (i > 100) step = 0.5;
            }
        }

        if (found) {
            let currentStep = (Math.abs(x - x0) > 100 * 0.1) ? 0.5 : 0.1;
            let low = x, high = (x < x0) ? x + currentStep : x - currentStep;

            if (evalF(low) * evalF(high) > 0) {
                path = 'direct-newton';
                for (let j = 0; j < 5; j++) {
                    let y = evalF(x);

                    if (Math.abs(y) < 1e-3) break;

                    let dy = (evalF(x + 1e-4) - evalF(x - 1e-4)) / 2e-4;
                    if (Math.abs(dy) < 1e-9) break;
                    x = x - y / dy;
                }
            } else {
                path = (path === 'direct' ? 'direct-bisect' : 'bisect');
                for (let j = 0; j < 15; j++) {
                    let mid = (low + high) / 2, fMid = evalF(mid);

                    if (Math.abs(high - low) < 1e-3 || Math.abs(fMid) < 1e-3) break;
                    if (evalF(low) * fMid <= 0) high = mid; else low = mid;
                }
                x = (low + high) / 2;
            }
            return { value: x, path };
        }
        return { value: NaN, path };
    }
    return { value: NaN, path: 'badinit' };
}

// ---- comparison ------------------------------------------------------------
const INTEGRAL_STEPS = 100;

function same(a, b, tol = 1e-9) {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    if (a === b) return true;
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

// ---- corpus ----------------------------------------------------------------
// Each case: expr/init are raw calcJS sources (as they would appear inside
// root[...]); vars lists scope variables with value grids; inits is the init
// grid (init sources). The full cartesian product vars-grid x inits runs.
const STD_INITS = ['-123.5', '-50', '-10', '-2', '-0.5', '0', '0.3', '1', '2', '5', '10', '50', '123.5'];
const NEAR_INITS = ['-5', '-1', '-0.2', '0', '0.0005', '0.5', '1', '3'];

const cases = [];
const add = (expr, init, opts = {}) => cases.push({
    expr,
    inits: Array.isArray(init) ? init : [init],
    rootVar: 'x',
    vars: [],
    ...opts,
});

// polynomials: single / double / multiple roots
add('x^2-2', STD_INITS);
add('(x-1)^2', NEAR_INITS);                       // double root: scan cannot bracket (touches zero)
add('(x-1)(x-3)(x+2)', STD_INITS);                // multiple roots, different inits find different roots
add('x^3-x-1', ['-2', '0', '1', '30']);           // single real root ~1.3249
// always positive / always negative: no root anywhere (1000-step scan)
add('x^2+1', STD_INITS);
add('-x^2-1', STD_INITS);
add('x^4+3x^2+10', ['-77', '0', '41']);
// transcendental
add('sin(x)+cos(x)-0.5', STD_INITS);
add('exp(x)-3', ['-9', '0', '2', '60']);
add('lg(x)-1', ['0.001', '-5', '3', '80']);       // domain x>0: left scan points non-finite
add('e^x-4x', ['-1', '0', '2', '25']);            // two roots
add('sin(10x)', ['-30', '0.05', '7']);            // many close roots; 0.1 scan grid may skip dips
add('x*sin(x)-1', ['-40', '0.5', '12']);
add('1/(x-1)-0.5', ['-20', '0', '4']);            // sign change across the pole: bisects into the pole
add('1/(x-1)', ['1', '-3']);                      // y0 = Infinity at the pole: never brackets -> NaN
// large operators and diff inside the root expression (expanded at parse time,
// so the joined source carries the page's own '0.00001'/'50000' tokens)
add('sum(k*x,k,1,3)-10', ['-15', '0', '9']);      // 6x-10
add('int(t,t,0,x)-1', ['-30', '-0.2', '0.2', '30']);
add('diff(x^3+x,x)-4', ['-8', '0.1', '0.5']);     // 3x^2+1-4 -> +-1
add('diffat(sin(x)*x,x,2)-3', ['-6', '1', '5']);
add('prod(k,k,1,5)-120', ['-3', '0', '4']);       // f identically zero: direct hit, bisection on zeros
add('sum(k*x,k,1,3)-2x-8', ['-25', '0', '14']);   // 4x-8 with the root var also as loop var elsewhere
// slider variables
add('x^2-a', ['-30', '-1', '0.4', '40'], { vars: [{ name: 'a', grid: [0.5, 2, 13.7, NaN] }] });
add('sin(x)+a-0.3', ['-30', '0', '5'], { vars: [{ name: 'a', grid: [-1.5, 0, 2] }] }); // a=2: no root
add('exp(x)-a*x', ['-12', '1', '55'], { vars: [{ name: 'a', grid: [1, 3, 10] }] });
add('x-a', ['a/2+0.1'], { vars: [{ name: 'a', grid: [0.5, 2, 13.7] }] });            // init depends on slider
add('t^3-2t-5', ['2', '-40', '60'], { rootVar: 't' });                              // Wallis equation
add('x^2-a', ['3'], { vars: [{ name: 'a', grid: [2, 13.7] }, { name: 'x', grid: [0.5, -7] }] }); // slider named like rootVar: shadowed by the root variable
add('gamma(x)-1', ['-5', '0.4', '3', '40']);      // pristine advanced function
add('erf(x)-0.5', ['-9', '0', '6']);
add('f(x)-3', STD_INITS);                         // simple custom function inlined at parse time
add('g(x)', ['-30', '0', '50']);                  // 2x^2+2 > 0: no root
add('w(t)-1', ['-5', '0', '3'], { rootVar: 't' });
// |f(x0)| < 1e-3 direct hits (init at/near a root)
add('x^2+0.0001', ['0']);                         // direct, neighbor same sign -> Newton branch (breaks at once)
add('-x^2-0.0001', ['0']);                        // same, negative
add('x-0.0005', ['0']);                           // direct, neighbor opposite sign -> bisection
add('x+0.0005', ['0']);
add('sin(x)', ['3.14159']);                       // direct hit near pi
add('(x-1)^2', ['1']);                            // exact root at init: direct, bisection with f(low)==0
// bracket boundary: the scan lands exactly on the root (y*y0 == 0)
add('x-0.5', ['0']);                              // xR = 5*0.1 === 0.5 exactly; then high < low on purpose
add('x+0.5', ['0']);                              // left side mirror
// non-finite / non-numeric init
add('x-1', ['1/0']);
add('x-1', ['0/0']);
add('x-1', ['sqrt(-1)']);
add('x^2-2', ['x+3']);                            // init references the rootVar: unknown to the init program
add('x^2-2', ['x+3'], { vars: [{ name: 'x', grid: [0.7] }] }); // ...or shadowed by a slider, page uses the slider
// rejection path: unknown advanced function name must fail ac_calc_compile
add('gamma2(x)-1', ['1'], { expectReject: true });

// ---- part 1: wasm-direct differential --------------------------------------
const userFns = encodeUserFns();
let checks = 0, failures = 0, fallbacks = 0, rejects = 0;
const pathCounts = {};

function notePath(p) { pathCounts[p] = (pathCounts[p] || 0) + 1; }

function runCase(c) {
    const varNames = (c.vars || []).map((v) => v.name);
    const grids = (c.vars || []).map((v) => v.grid);
    const indices = grids.map(() => 0);
    for (;;) {
        const scope = {};
        varNames.forEach((n, k) => { scope[n] = grids[k][indices[k]]; });
        const scopeNames = Object.keys(scope).sort();

        const exprTokens = pageParseTokens(c.expr, c.rootVar, scopeNames);
        const exprSrc = exprTokens.join('');
        const names = [c.rootVar].concat(scopeNames.filter((n) => n !== c.rootVar));

        const h = core.compileCalcArgs(exprSrc, names, 1, userFns, INTEGRAL_STEPS);
        if (!h) {
            if (c.expectReject) { rejects++; }
            else {
                failures++;
                console.log(`UNEXPECTED COMPILE FAIL ${c.expr} @${JSON.stringify(scope)}: ${core.lastError()}`);
            }
            // advance indices
            let k = grids.length - 1;
            for (; k >= 0; k--) { indices[k]++; if (indices[k] < grids[k].length) break; indices[k] = 0; }
            if (k < 0) break;
            continue;
        }
        if (c.expectReject) {
            failures++;
            console.log(`SHOULD REJECT ${c.expr} @${JSON.stringify(scope)}`);
            core.ex.ac_release(h);
            return;
        }

        const initList = c.inits;
        for (const initSrcRaw of initList) {
            const initTokens = pageParseTokens(initSrcRaw, c.rootVar, scopeNames);
            const initSrc = initTokens.join('');

            // The init value both sides must agree on (the kernel obtains it
            // from the same joined source through the scalar path). The init
            // program sees the whole scope — including a slider that happens
            // to be named like the rootVar (the page evaluates the init
            // against the scope, where the root variable is not present).
            const hInit = core.compileCalc(initSrc, scopeNames, userFns, INTEGRAL_STEPS);
            let x0wasm = NaN;
            if (hInit) {
                const values0 = scopeNames.map((n) => scope[n]);
                try { x0wasm = core.evalCalcOne(hInit, values0); } catch (e) { x0wasm = NaN; }
                core.ex.ac_release(hInit);
            }
            let x0js;
            try { x0js = jsEvalTokens(initTokens, scope); } catch (e) { x0js = NaN; }
            // NaN-ness of x0 must agree; if wasm cannot even evaluate the
            // init (fallback case) there is nothing to compare further.
            checks++;
            if (!((Number.isNaN(x0wasm) && Number.isNaN(x0js)) || same(x0wasm, x0js))) {
                failures++;
                if (failures <= 40) console.log(`INIT MISMATCH ${c.expr} init=${initSrcRaw} @${JSON.stringify(scope)}: wasm=${x0wasm} js=${x0js}`);
            }
            if (!hInit) { fallbacks++; continue; }
            if (!(Number.isFinite(x0js))) {
                // bad-init: the page algorithm never runs and yields NaN;
                // ac_root_run must agree for a non-finite x0.
                notePath('badinit');
                const valuesBad = scopeNames.filter((n) => n !== c.rootVar).map((n) => scope[n]);
                core.setParams(h, valuesBad);
                let gotBad;
                try { gotBad = core.acRootRun(h, x0js); } catch (e) { gotBad = 0; }
                checks++;
                if (!Number.isNaN(gotBad)) {
                    failures++;
                    console.log(`BADINIT ${c.expr} init=${initSrcRaw}: wasm=${gotBad}, expected NaN`);
                }
                continue;
            }

            let ref;
            try { ref = jsRootFind(exprTokens, initTokens, c.rootVar, scope); } catch (e) { ref = { value: NaN, path: 'threw' }; }
            notePath(ref.path);

            const values = scopeNames.filter((n) => n !== c.rootVar).map((n) => scope[n]);
            core.setParams(h, values);
            let got;
            try { got = core.acRootRun(h, x0js); } catch (e) { got = NaN; }
            checks++;
            if (!same(got, ref.value)) {
                failures++;
                if (failures <= 40) {
                    console.log(`MISMATCH ${c.expr} [${c.rootVar}] init=${initSrcRaw} @${JSON.stringify(scope)}: wasm=${got} js=${ref.value} (${ref.path})`);
                }
            }
        }
        core.ex.ac_release(h);

        let k = grids.length - 1;
        for (; k >= 0; k--) { indices[k]++; if (indices[k] < grids[k].length) break; indices[k] = 0; }
        if (k < 0) break;
    }
}

for (const c of cases) runCase(c);

// path coverage: the corpus must exercise every branch of the page algorithm
const REQUIRED_PATHS = ['direct-newton', 'direct-bisect', 'bisect', 'notfound', 'badinit'];
for (const p of REQUIRED_PATHS) {
    if (!pathCounts[p]) {
        failures++;
        console.log(`PATH NOT COVERED: ${p}`);
    }
}

// ---- part 2: kernel-level contract via a shim ArchCore ----------------------
function loadKernelJs(shim, file) {
    const src = fs.readFileSync(path.join(here, '../js/kernels', file), 'utf8');
    new Function('ArchCore', src)(shim);
}

function makeShim(redefined) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const scratch = new Map();
    const shim = {
        active: true,
        kernels: {},
        exports: core.ex,
        advancedIsPristine: (engine, name) => !redefined.has(name),
    };
    shim.writeString = (name, str) => {
        const bytes = encoder.encode(str);
        let s = scratch.get(name);
        if (!s || s.bytes < bytes.length + 1) {
            if (s) core.ex.ac_free(s.ptr);
            s = { ptr: core.ex.ac_alloc(Math.max(bytes.length + 1, 4096)), bytes: Math.max(bytes.length + 1, 4096) };
            scratch.set(name, s);
        }
        new Uint8Array(core.memory.buffer).set(bytes, s.ptr);
        new Uint8Array(core.memory.buffer)[s.ptr + bytes.length] = 0;
        return { ptr: s.ptr, len: bytes.length };
    };
    shim.f64Scratch = (name, count) => {
        let s = scratch.get(name);
        const bytes = Math.max(count * 8, 8);
        if (!s || s.bytes < bytes) {
            if (s) core.ex.ac_free(s.ptr);
            s = { ptr: core.ex.ac_alloc(Math.max(bytes, 4096)), bytes: Math.max(bytes, 4096) };
            scratch.set(name, s);
        }
        return { ptr: s.ptr, view: new Float64Array(core.memory.buffer, s.ptr, count) };
    };
    shim.lastError = () => {
        const p = core.ex.ac_error_ptr();
        return decoder.decode(new Uint8Array(core.memory.buffer, p, core.ex.ac_error_len()));
    };
    return shim;
}

let kernelChecks = 0, kernelFailures = 0;
const kexpect = (cond, msg) => { kernelChecks++; if (!cond) { kernelFailures++; console.log(`KERNEL ${msg}`); } };

{
    const redefined = new Set();
    const shim = makeShim(redefined);
    loadKernelJs(shim, 'calc.js');
    loadKernelJs(shim, 'rootfind.js');
    const rootFind = shim.kernels.rootFind;
    kexpect(typeof rootFind === 'function', 'rootFind registered');
    if (typeof rootFind === 'function') {
        const engine = {
            calcJSUtils,
            integralNumSteps: INTEGRAL_STEPS,
            evaluateExpressionWithCalcJS: (tokens, scopeVars) => jsEvalTokens(tokens, { ...scopeVars }),
        };
        const makeEntry = (expr, rootVar, init) => ({
            rootVar,
            rootExprTokens: pageParseTokens(expr, rootVar, []),
            rootInitTokens: pageParseTokens(init, rootVar, []),
        });
        const fallbackFor = (entry, scope) => () => jsRootFind(entry.rootExprTokens, entry.rootInitTokens, entry.rootVar, scope).value;

        // normal path: probe accepted on first call, sticky verified cache after
        {
            const entry = makeEntry('x^2-2', 'x', '3');
            const scope = {};
            const want = jsRootFind(entry.rootExprTokens, entry.rootInitTokens, 'x', scope).value;
            const v1 = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            const v2 = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(typeof v1 === 'number' && same(v1, want), `normal path matches JS (${v1} vs ${want})`);
            kexpect(typeof v2 === 'number' && same(v2, want), `verified cache path matches JS (${v2})`);
        }
        // scope variable upload
        {
            const entry = makeEntry('x^2-a', 'x', '1');
            const scope = { a: 13.7 };
            const want = jsRootFind(entry.rootExprTokens, entry.rootInitTokens, 'x', scope).value;
            const v1 = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(typeof v1 === 'number' && same(v1, want), `slider scope matches JS (${v1} vs ${want})`);
        }
        // non-pristine advanced function -> null (rejection path)
        {
            redefined.add('gamma');
            const entry = makeEntry('gamma(x)-1', 'x', '0.4');
            const scope = {};
            const v = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(v === null, `non-pristine advanced returns null (got ${v})`);
            redefined.delete('gamma');
        }
        // unknown advanced name -> ac_calc_compile fails -> null
        {
            const entry = makeEntry('gamma2(x)-1', 'x', '1');
            const scope = {};
            const v = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(v === null, `unknown advanced returns null (got ${v})`);
        }
        // non-finite init -> null (page yields NaN through its own guard)
        {
            const entry = makeEntry('x-1', 'x', '1/0');
            const scope = {};
            const v = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(v === null, `non-finite init returns null (got ${v})`);
        }
        // probe mismatch -> null, and permanently rejected afterwards
        // (distinct expression: the program cache is keyed per source, so a
        // previously verified program would not re-probe)
        {
            const entry = makeEntry('x^2-5', 'x', '3');
            const scope = {};
            const v1 = rootFind(engine, entry, scope, () => 12345.678);
            const v2 = rootFind(engine, entry, scope, fallbackFor(entry, scope));
            kexpect(v1 === null, `probe mismatch returns null (got ${v1})`);
            kexpect(v2 === null, `rejected program stays rejected (got ${v2})`);
        }
    }
}

console.log(`${checks} checks, paths=${JSON.stringify(pathCounts)}, ${fallbacks} init-fallbacks, ${rejects} compile-rejects, kernel ${kernelChecks - kernelFailures}/${kernelChecks} ok`);
console.log(`${failures + kernelFailures} failures`);
process.exitCode = failures + kernelFailures;
