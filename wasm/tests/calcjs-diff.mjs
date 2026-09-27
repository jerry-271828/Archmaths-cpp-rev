// Differential test for the CalcJs dialect (ac_calc_compile / ac_calc_eval1)
// vs the page's own calcJSUtils pipeline (extracted from arch-current.html and
// instantiated with this. = the extracted object).
//
// Usage: node wasm/tests/calcjs-diff.mjs [archcore.wasm] [arch-current.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, extractAdvancedFunctions } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await loadCore(process.argv[2] || path.join(here, '../dist/archcore.wasm'));
const html = fs.readFileSync(process.argv[3] || path.join(here, '../../arch-current.html'), 'utf8');

// ---- extract the calcJSUtils object literal --------------------------------
function extractBalanced(source, openIdx, openCh, closeCh) {
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
        const c = source[i];
        if (c === "'" || c === '"' || c === '`') {
            // skip string/template literal (handles escapes; no brace-heavy
            // regex literals occur inside calcJSUtils)
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

// ---- improvedTokenize (engine method, ported for the test harness) ---------
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

// The page's built-in simple custom functions.
{
    const anchor = html.indexOf('const builtinfunc = [');
    if (anchor < 0) throw new Error('builtinfunc not found');
    const open = html.indexOf('[', anchor);
    const close = extractBalanced(html, open, '[', ']');
    const builtinfunc = new Function(`return ${html.slice(open, close + 1)};`)();
    for (const def of builtinfunc) defineCalcJSFunction(def);
}

// Test-only simple custom functions (recursive + shadowing coverage).
defineCalcJSFunction('f(a)=a^2+1');
defineCalcJSFunction('g(b)=f(b)*2');
defineCalcJSFunction('dist2(ax,ay)=ax*ax+ay*ay');
defineCalcJSFunction('sq(a)=a a');
defineCalcJSFunction('fsum(n)=sum(k,k,1,n)');
defineCalcJSFunction('fc(k)=sum(j*k,j,1,2)');
defineCalcJSFunction('fd(k)=sum(k,k,1,2)');
defineCalcJSFunction('rec(n)=rec(n-1)+1');

// userFns encoding shared with wasm/js/kernels/calc.js: "name|p1,p2|body"
// with body = stored bodyTokens joined by single spaces.
function encodeUserFns() {
    const parts = [];
    for (const name of Object.keys(calcJSUtils.customFunctions)) {
        const f = calcJSUtils.customFunctions[name];
        parts.push(name + '|' + f.params.join(',') + '|' + f.bodyTokens.join(' '));
    }
    parts.sort();
    return parts.join('\n');
}

// ---- JS reference evaluation (page path) -----------------------------------
function jsEval(src, scope) {
    try {
        const tokens = calcJSUtils.tokenize(src);
        return calcJSUtils.evaluateScopedExpression(
            tokens,
            { ...scope },
            calcJSUtils.customFunctions,
            calcJSUtils.calc3,
            calcJSUtils.constants,
            calcJSUtils.calc1,
            100, // integralNumSteps, matching the wasm compile below
            calcJSUtils.advancedCustomFunctions,
            calcJSUtils.advancedCustomFunctionNames,
            calcJSUtils.getAdvancedFuncsMap()
        );
    } catch (e) {
        return NaN; // thrown pipeline errors surface as NaN at the call sites
    }
}

// ---- corpus ----------------------------------------------------------------
const G = [-7.3, -2, -1, -0.5, 0, 0.5, 1, 2.5, 3.14159, 10,
    Infinity, -Infinity, NaN, 1e-300, -1e-300, 1e300];
const H = [-2, -0.5, 0, 0.5, 2, 10];

const cases = [];
const add = (src, vars = [], opts = {}) => cases.push({ src, vars, ...opts });

// arithmetic / implicit multiplication
add('1+2*3'); add('(1+2)*3'); add('2(3+4)'); add('(2)(3)');
add('2pi'); add('epi'); add('pi*x', ['x']); add('2x', ['x']); add('xy', ['xy']);
add('2sin(x)', ['x']); add('(x+1)(y+1)', ['x', 'y']); add('x(y+1)', ['x', 'y']);
add('x2', ['x2']); add('_a+1', ['_a'], { expectFallback: true }); // page tokenize loops forever on '_' -> NaN
add('a_b', ['a'], { expectFallback: true });
add('x+y*2-z/3', ['x', 'y', 'z']);
// powers (AdvPow semantics)
add('x^2', ['x']); add('2^x', ['x']); add('x^y', ['x', 'y']); add('2^3^2', [], { expectFallback: true }); // page: pow-rewrite syntax error -> NaN
add('-x^2', ['x']); add('x^0.5', ['x']); add('(-x)^2', ['x']); add('x^(-2)', ['x']);
add('(-x)^(1/3)', ['x']); add('x^(2/3)', ['x']); add('8^(1/3)'); add('(-8)^(1/3)');
add('x^2+y^2', ['x', 'y']); add('(x+y)^2', ['x', 'y']); add('sin(x)^2', ['x']);
add('x^-2', ['x'], { expectFallback: true });      // page: JS syntax error -> NaN
add('2^-3', [], { expectFallback: true });
add('e^2'); add('x^pi', ['x']);
// constants
add('π'); add('Π'); add('e'); add('e*pi'); add('2e');
// calc1 function sweep
for (const fn of ['ln(x)', 'lg(x)', 'log(x)', 'exp(x)', 'sqrt(x)', 'cbrt(x)', 'abs(x)',
    'floor(x)', 'ceil(x)', 'round(x)', 'sin(x)', 'cos(x)', 'tan(x)', 'asin(x/10)',
    'acos(x/10)', 'atan(x)', 'sinh(x)', 'cosh(x)', 'tanh(x)', 'asinh(x)', 'acosh(x)',
    'atanh(x/10)']) add(fn, ['x']);
add('ln(x)+lg(x)', ['x']); add('log(x*y)', ['x', 'y']);
// large operators
add('sum(k,k,1,5)'); add('sum(2k,k,1,3)'); add('sum(k^2,k,1,10)');
add('sum(k,k,5,1)'); add('sum(k,k,-0.3,3)'); add('sum(k,k,1,3.5)');
add('sum(k,k,1,1000000)'); add('sum(k,k,1,1000002)');
add('prod(k,k,1,5)'); add('prod(k,k,0,5)'); add('prod(k,k,5,1)');
add('sum(k*x,k,1,3)', ['x']); add('sum(x,x,1,3)+x', ['x']);
add('sum(a*x,a,1,3)*a', ['x', 'a']);
add('sum(sum(j,j,1,k),k,1,4)', [], { expectFallback: true }); // inner bounds ref enclosing var
add('sum(sum(j,j,1,3),k,1,2)');
add('sum(sum(k,k,1,j),j,1,3)', [], { expectFallback: true }); // bounds reference enclosing var
add('sum(int(t,t,0,k),k,1,3)', [], { expectFallback: true }); // ditto
add('sum(x,x,1,3.7)', ['x']); // round(3.7) = 4
// int (trapezoid, integralNumSteps = 100)
add('int(t,t,0,1)'); add('int(t^2,t,0,1)'); add('int(sin(t),t,0,pi)');
add('int(1/t,t,-1,1)'); add('int(t,t,x,x)', ['x']); add('int(t,t,0,x)', ['x']);
add('int(t,t,x,1)', ['x']); add('int(e^t,t,0,1)'); add('int(t*t,t,-x,x)', ['x']);
add('int(cos(t),t,0,2*pi)'); add('int(sqrt(t),t,0,x)', ['x']);
add('int(t,t,0,0.0000000000000000000000001)', []); // |h| < 1e-15 -> 0
add('int(t,t,0/0,1)', [], { expectFallback: false }); // NaN bounds -> NaN both
// diff / diffat (central difference, h = 1e-5). The (f(x+h)-f(x-h)) subtraction
// amplifies libm 1-ulp noise (JS fdlibm vs C libm) by ~1e4-1e5, so these use
// the probe tolerance (1e-9) instead of 1e-12.
add('diff(x^2,x)', ['x'], { tol: 1e-9 }); add('diff(x^3+x,x)', ['x'], { tol: 1e-9 });
add('diffat(x^2,x,3)', ['x'], { tol: 1e-9 });
add('diffat(sin(x),x,0)', ['x'], { tol: 1e-9 }); add('diffat(x^2,x,x+1)', ['x'], { tol: 1e-9 });
add('diff(x^2,(x))', ['x'], { tol: 1e-9 });
add('sum(diff(x^2,x),x,1,3)', [], { tol: 1e-9 }); add('diff(sin(2x),x)', ['x'], { tol: 1e-9 });
add('diffat(x^3,x,x*x)', ['x'], { tol: 1e-9 });
add('diff(x^2*diff(x^3,x),x)', ['x'], { tol: 1e-9 }); // nested diff
add('diffat(x^2,sin,3)', [], { expectFallback: true }); // invalid var -> page throws
// min/max via the page's built-in simple custom functions
add('max(x,y)', ['x', 'y']); add('min(x,y)', ['x', 'y']); add('max(3x,x^2)', ['x']);
add('min(3,x)', ['x']);
// built-in simple custom functions
add('sec(x)', ['x']); add('csc(x)', ['x']); add('cot(x)', ['x']); add('acot(x)', ['x']);
add('csch(x+2)', ['x']); add('sech(x)', ['x']); add('asec(2x)', ['x']); add('acsc(x+2)', ['x']);
add('beta(x,2)', ['x']); add('root(1,2,1,0)'); add('normdist(0,1,x,1)', ['x']);
// advanced functions (pristine registry ports)
add('gamma(x+5)', ['x']); add('erf(x)', ['x']); add('sign(x)', ['x']);
add('heaviside(x)', ['x']); add('sgn(x)', ['x']); add('llim(x,1)', ['x']);
add('ulim(x,0)', ['x']); add('range(x,0,1)', ['x']); add('pow(x,2)', ['x']);
add('2gamma(x)', ['x']); add('gamma(x)*sin(x)', ['x']);
add('elliptick(x/10)', ['x']); add('lambertw(x)', ['x']); add('zeta(x+2)', ['x']);
// simple custom functions
add('f(3)'); add('f(x)', ['x']); add('sum(f(k),k,1,3)'); add('g(2)'); add('g(x)', ['x']);
add('dist2(3,4)'); add('dist2(x,y)', ['x', 'y']); add('sq(3)'); add('sq(x)', ['x']);
add('fsum(3)'); add('fsum(x)', ['x']); add('fc(3)'); add('fd(3)'); add('fd(x)', ['x']);
add('f(g(x))', ['x']); add('f(f(x))', ['x']);
add('rec(1)', [], { expectFallback: true }); // recursion depth > 50 -> page throws
// reject-at-compile cases (page keeps its JS path, values must still match)
add('x>1', ['x'], { expectReject: true });   // tokenize throws on '<'... '>' actually
add('gamma2(x)', ['x'], { expectReject: true }); // unknown advanced name
add('sum(x,sin,1,2)', [], { expectFallback: true }); // binder shadows calc1
add('psi(x)', ['x'], { expectReject: true }); // deliberately unregistered
add('', [], { expectFallback: true });        // page returns 0 via empty-string check
add('sin', [], { expectFallback: true });     // bare function name -> page: undefined
add('sqrt(-1)', ['x'], {});
add('1/0'); add('0/0'); add('-1/0');
add('x', ['x']); add('x+y', ['x', 'y']);

// ---- comparison ------------------------------------------------------------
function same(a, b, tol) {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
    if (a === b) return true;
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

const userFns = encodeUserFns();
let checks = 0, exact = 0, failures = 0, fallbacks = 0, rejects = 0;

function runCase(c) {
    const h = core.compileCalc(c.src, c.vars, userFns, 100);
    if (!h) {
        if (c.expectReject) { rejects++; return; }
        fallbacks++;
        // The page path must still agree (it produces the reference value).
        const sample = {};
        for (const v of c.vars) sample[v] = 1.5;
        const want = jsEval(c.src, sample);
        const refNote = Number.isNaN(want) ? 'NaN' : want;
        console.log(`FALLBACK ${c.src} -> page=${refNote} err=${core.lastError()}`);
        if (!c.expectFallback) failures++;
        return;
    }
    if (c.expectReject) {
        failures++;
        console.log(`SHOULD REJECT ${c.src}`);
        core.ex.ac_release(h);
        return;
    }
    const grid = c.vars.length >= 2 ? H : (c.vars.length === 1 ? G : [null]);
    const indices = c.vars.map(() => 0);
    // iterate the full cross product
    for (;;) {
        const scope = {};
        c.vars.forEach((v, k) => { scope[v] = grid === H ? H[indices[k]] : G[indices[k]]; });
        const values = c.vars.map((v) => scope[v]);
        const want = jsEval(c.src, scope);
        let got;
        try { got = core.evalCalcOne(h, values); } catch (e) { got = NaN; }
        checks++;
        if (Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want))) exact++;
        if (!same(got, want, c.tol || 1e-12)) {
            failures++;
            if (failures <= 30) {
                console.log(`MISMATCH ${c.src} @${JSON.stringify(scope)}: wasm=${got} js=${want}`);
            }
        }
        // advance indices
        let k = c.vars.length - 1;
        for (; k >= 0; k--) {
            indices[k]++;
            const lim = grid === H ? H.length : G.length;
            if (indices[k] < lim) break;
            indices[k] = 0;
        }
        if (k < 0) break;
    }
    core.ex.ac_release(h);
}

for (const c of cases) runCase(c);

console.log(`${checks} checks, ${exact} bit-exact, ${fallbacks} fallbacks, ${rejects} compile-rejects, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
