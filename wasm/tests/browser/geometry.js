// Differential test for the "geometry" ArchCore kernel: recalculateGeometryObjects
// (arch-current.html), backed by wasm/core/kernels/geometry*.cpp.
//
// Five scenarios, all comparing the JS path (ArchCore.state.enabled=false +
// recalculateAll) against the wasm path (enabled=true + recalculateAll) on
// IDENTICAL entry sets built through the page's own addEntry():
//   1. all 28 geometryTypes in one big scene, deep-comparing every numeric /
//      structural output field of every geometry entry (NaN-consistent,
//      finite values within 1e-9 relative);
//   2. variables using [A,x] point-coordinate refs together with root[...];
//   3. custom-function compatibility: simple f(x)=x^2+1 inside geometry
//      expressions and root[] (kernel must handle), advanced JS f(x)={...}
//      (kernel must decline and the original JS body must produce equal
//      values), and a re-defined advanced function (non-pristine decline);
//   4. "drag" emulation: edit a free point's coordinate expressions, then
//      re-run the diff;
//   5. localStorage archcore-enabled toggle: persistence + disabled-state
//      recalculateAll equals enabled-state recalculateAll.
//
// Run with `node cdp.js run <tab> @wasm/tests/browser/geometry.js <maxWaitMs>`.
(async () => {
    const A = window.archInstance;
    // Hidden tabs get intensive timer throttling (setTimeout clamped to ~1/min
    // after 5 min), which freezes setTimeout-based yields between phases.
    // MessageChannel posts are not throttled, so yields resolve immediately.
    const yieldChannel = new MessageChannel();
    const yieldNow = () => new Promise(r => { yieldChannel.port1.onmessage = r; yieldChannel.port2.postMessage(0); });
    if (typeof ArchCore === 'undefined') return { error: 'no ArchCore' };
    await new Promise(r => ArchCore.onReady(r));

    // The diff only exercises recalculation; neutralize rendering so queued
    // draws of a ~45-object scene cannot congest the page's event loop.
    const origRequestDraw = A.requestDraw;
    A.requestDraw = () => {};
    // addEntry() runs a full recalculateAll + DOM list rebuild per call; that
    // is ~50x slower under the CDP bridge than the parsing we actually need.
    // Stub them during construction and pay ONE real recalculateAll per path.
    const origRecalc = A.recalculateAll;
    const origUpdateList = A.updateEntryList;
    const origPrompt = A.showTopPrompt;
    A.recalculateAll = () => {};
    A.updateEntryList = () => {};
    A.showTopPrompt = () => {};
    console.log('[geo] start');

    let checkCount = 0, failCount = 0;
    const mismatches = [];
    const check = (ok, label, detail) => {
        checkCount++;
        if (!ok) { failCount++; mismatches.push(detail ? `${label}: ${detail}` : label); }
    };

    const TOL = 1e-9;
    const eq = (a, b) => {
        const an = Number.isNaN(a), bn = Number.isNaN(b);
        if (an || bn) return an === bn;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b));
    };
    const N = v => typeof v === 'number' ? v : NaN;

    // ---- snapshots -------------------------------------------------------
    // Object fields the case never wrote read back as all-NaN rows; the
    // contract (GEOMETRY_CONTRACT.md §3) sanctions the adapter writing those
    // back as {NaN,..} objects, which is numerically identical to the JS
    // property being absent. Normalize all-NaN object fields to null so the
    // comparison is presence-insensitive for never-set fields only.
    const allNaN = (arr) => arr.every(v => Number.isNaN(v));
    const vecSnap = (o) => {
        if (o == null) return null;
        const v = [N(o.x), N(o.y)];
        return allNaN(v) ? null : v;
    };
    const ptSnap = (o) => {
        if (o == null) return null;
        if (o.name) return { ref: String(o.name), x: N(o.x_val), y: N(o.y_val) };  // live entry ref
        const v = { ref: '', x: N(o.x !== undefined ? o.x : o.x_val), y: N(o.y !== undefined ? o.y : o.y_val) };
        return (v.ref === '' && Number.isNaN(v.x) && Number.isNaN(v.y)) ? null : v;
    };
    function snapEntry(e) {
        return {
            t: e.geometryType,
            m: !!e.isMeaningful,
            err: e.compilationError === undefined ? null : String(e.compilationError),
            det: e.detailsString === undefined ? null : String(e.detailsString),
            x: N(e.x_val), y: N(e.y_val), r: N(e.radius), a: N(e.a), b: N(e.b),
            rot: N(e.rotation),
            p: typeof e.p === 'number' ? { n: N(e.p) } : (e.p && e.p.name ? { ref: String(e.p.name) } : null),
            val: N(e.value), sa: N(e.startAngle), ea: N(e.endAngle),
            dsum: N(e.dist_sum), ddiff: N(e.dist_diff),
            dir: vecSnap(e.dir),
            dvec: vecSnap(e.dir_vec),
            c: ptSnap(e.center),
            vtx: e.vertex ? (allNaN([N(e.vertex.x), N(e.vertex.y)]) ? null : [N(e.vertex.x), N(e.vertex.y)]) : null,
            f1: ptSnap(e.f1),
            f2: ptSnap(e.f2),
            p1: ptSnap(e.p1),
            p2s: ptSnap(e.p2),
            pts: e.points ? e.points.map(p => (p ? String(p.name || '?') : null)) : null,
        };
    }
    const snapAll = () => {
        const out = {};
        for (const e of A.entries) if (e.type === 'geometry') out[String(e.name).toLowerCase()] = snapEntry(e);
        return out;
    };
    const snapVars = () => {
        const out = {};
        for (const [k, v] of A.variables) out[k] = N(v);
        return out;
    };

    const OUT_FIELDS = ['x_val', 'y_val', 'radius', 'a', 'b', 'rotation', 'p', 'value',
        'startAngle', 'endAngle', 'dist_sum', 'dist_diff', 'dir', 'dir_vec',
        'center', 'vertex', 'f1', 'f2', 'p1', 'p2', 'points', 'compilationError', 'detailsString'];
    function resetOutputs() {
        for (const e of A.entries) {
            if (e.type !== 'geometry') continue;
            for (const f of OUT_FIELDS) delete e[f];
            e.isMeaningful = false;
        }
    }

    function runPath(enabled, tag) {
        ArchCore.state.enabled = enabled;
        resetOutputs();
        if (tag) console.log('[geo] recalc ' + tag + ' enabled=' + enabled + ' ...');
        origRecalc.call(A);   // the REAL recalculateAll (A.recalculateAll is stubbed)
        if (tag) console.log('[geo] recalc ' + tag + ' enabled=' + enabled + ' done');
        return { geo: snapAll(), vars: snapVars() };
    }

    const eqPt = (a, b) => {
        if (a === null || b === null) return a === b;
        if ((a.ref || '') !== (b.ref || '')) return false;
        return eq(a.x, b.x) && eq(a.y, b.y);
    };
    function cmpSnap(js, wasm, label) {
        const keys = new Set([...Object.keys(js), ...Object.keys(wasm)]);
        check(keys.size > 0, `${label}: entries present`);
        for (const k of keys) {
            const a = js[k], b = wasm[k];
            if (!a || !b) { check(false, `${label}:${k} presence`, `js=${!!a} wasm=${!!b}`); continue; }
            check(a.t === b.t, `${label}:${k}.type`, `${a.t} vs ${b.t}`);
            check(a.m === b.m, `${label}:${k}.meaningful`, `${a.m} vs ${b.m}`);
            check(a.err === b.err, `${label}:${k}.err`, `${a.err} vs ${b.err}`);
            check(a.det === b.det, `${label}:${k}.details`, `${JSON.stringify(a.det)} vs ${JSON.stringify(b.det)}`);
            for (const f of ['x', 'y', 'r', 'a', 'b', 'rot', 'val', 'sa', 'ea', 'dsum', 'ddiff']) {
                if (!eq(a[f], b[f])) check(false, `${label}:${k}.${f}`, `${a[f]} vs ${b[f]}`);
            }
            if (a.p === null || b.p === null) {
                if (a.p !== b.p) check(false, `${label}:${k}.p`, JSON.stringify(a.p) + ' vs ' + JSON.stringify(b.p));
            } else if (a.p.ref !== undefined || b.p.ref !== undefined) {
                if ((a.p.ref || '') !== (b.p.ref || '')) check(false, `${label}:${k}.pref`, `${a.p.ref} vs ${b.p.ref}`);
            } else if (!eq(a.p.n, b.p.n)) {
                check(false, `${label}:${k}.p`, `${a.p.n} vs ${b.p.n}`);
            }
            for (const f of ['dir', 'dvec', 'vtx']) {
                const u = a[f], v = b[f];
                if (u === null || v === null) { if (u !== v) check(false, `${label}:${k}.${f} presence`); continue; }
                for (let i = 0; i < u.length; i++) if (!eq(u[i], v[i])) check(false, `${label}:${k}.${f}[${i}]`, `${u[i]} vs ${v[i]}`);
            }
            for (const f of ['c', 'f1', 'f2', 'p1', 'p2s']) {
                if (!eqPt(a[f], b[f])) check(false, `${label}:${k}.${f}`, JSON.stringify(a[f]) + ' vs ' + JSON.stringify(b[f]));
            }
            const pa = a.pts, pb = b.pts;
            if (pa === null || pb === null) {
                if (pa !== pb) check(false, `${label}:${k}.pts presence`);
            } else if (pa.length !== pb.length || !pa.every((x, i) => x === pb[i])) {
                check(false, `${label}:${k}.pts`, JSON.stringify(pa) + ' vs ' + JSON.stringify(pb));
            }
        }
    }
    function cmpVars(js, wasm, label) {
        for (const k of new Set([...Object.keys(js), ...Object.keys(wasm)])) {
            if (!eq(js[k], wasm[k])) check(false, `${label}:var ${k}`, `${js[k]} vs ${wasm[k]}`);
        }
    }

    const GEO_KEYWORDS = new Set(['point', 'midpoint', 'intersect', 'segment', 'ray', 'line', 'vector',
        'perpendicularline', 'parallelline', 'anglebisector', 'circle', 'ellipse', 'hyperbola', 'parabola',
        'polygon', 'length', 'angle', 'area', 'isparallel', 'isperpendicular', 'isconcyclic', 'rotate',
        'reflect', 'translate', 'fitline', 'circulararc', 'tangent']);

    function build(list) {
        A.clearAllEntries();
        ArchCore.state.enabled = false;   // plain-JS build; addEntry rolls back on error
        for (const s of list) A.addEntry(s);
        const missing = [];
        for (const s of list) {
            // parseInputInternal strips ALL whitespace before storing entry.expr
            const norm = s.replace(/\s+/g, '');
            const kw = s.match(/^([a-zA-Z_][\w]*)\(/);
            if (kw && GEO_KEYWORDS.has(kw[1].toLowerCase())) {
                if (!A.entries.some(e => e.type === 'geometry' && e.expr === norm)) missing.push(s);
            } else if (/^([a-zA-Z_][\w]*)=root\[/.test(s)) {
                if (!A.entries.some(e => e.type === 'variable' && e.isRootFinding && e.expr === norm)) missing.push(s);
            } else if (/^([a-zA-Z_][\w]*)=/.test(s)) {
                if (!A.entries.some(e => (e.type === 'variable' || e.type === 'constant') && e.expr === norm)) missing.push(s);
            } else {
                const fn = s.match(/^([a-zA-Z_][\w]*)\s*\(/);
                const nm = fn ? fn[1].toLowerCase() : s;
                const cf = A.calcJSUtils.customFunctions[nm], af = A.calcJSUtils.advancedCustomFunctions[nm];
                if (!cf && !af) missing.push(s);
            }
        }
        return missing;
    }

    // =====================================================================
    // Scenario 1: every geometryType in one scene.
    // =====================================================================
    const SCENE1 = [
        'a=2',
        'point(A, 1, 2)', 'point(B, -2, 1)', 'point(C, 0, -1)', 'point(D, 2.5, 0.5)',
        'midpoint(M, A, B)',
        'line(L1, A, B)', 'line(L2, C, D)',
        'segment(S1, A, C)', 'ray(Y1, B, D)', 'vector(V1, A, D)',
        'perpendicularline(PL1, L1, C)', 'parallelline(PA1, L1, D)',
        'anglebisector(AB1, A, M, B)',
        'circle(C1, M, 2)', 'circle(C2, M, A)',
        'ellipse(E1, A, B, C)', 'ellipse(E2, 3, 2)',
        'hyperbola(H1, A, B, C)',
        'parabola(PB1, C, L1)',
        'polygon(PG1, 4, A, B, C, D)',
        'circulararc(CA1, M, A, B)',
        'intersect(X1, L1, L2, 1)',
        'intersect(X2, L1, C1, 1)', 'intersect(X3, L1, C1, -1)',
        'intersect(X4, C1, C2, 1)', 'intersect(X5, C1, C2, -1)',
        'rotate(R1, M, A, pi/2)',
        'reflect(RF1, L1, A)', 'reflect(RF2, M, B)',
        'translate(T1, A, 1, 2)', 'translate(T2, V1, A)',
        'point(POL, L1, 0.3)', 'point(POC, C1, 0.5)', 'point(POE, E1, 0.25)',
        'length(LEN1, A, B)', 'angle(AN1, A, M, B)', 'area(AR1, 3, A, B, C)',
        'isparallel(ISP, L1, PA1)', 'isperpendicular(ISPE, L1, PL1)',
        'isconcyclic(ISC, A, B, C, M)',
        'fitline(FL1, 4, A, B, C, D)',
        'tangent(TG1, C1, D, 1)', 'tangent(TG2, C1, D, -1)',
    ];
    console.log('[geo] scene1 build start (' + SCENE1.length + ' inputs)');
    const missing1 = build(SCENE1);
    console.log('[geo] scene1 build done, entries=' + A.entries.length);
    check(missing1.length === 0, 'scene1: all inputs accepted', missing1.join(' ; '));
    await yieldNow();

    console.log('[geo] scene1 JS path');
    const js1 = runPath(false);
    await yieldNow();
    console.log('[geo] scene1 wasm path');
    const wasm1 = runPath(true);
    await yieldNow();
    console.log('[geo] scene1 both paths done');
    cmpSnap(js1.geo, wasm1.geo, 'scene1');
    cmpVars(js1.vars, wasm1.vars, 'scene1');

    const typesSeen = new Set(Object.values(wasm1.geo).map(s => s.t));
    check(typesSeen.size === 28, 'scene1: 28 geometryTypes covered', [...typesSeen].sort().join(','));
    const meaningfulCount = Object.values(wasm1.geo).filter(s => s.m).length;
    const kernelProbe1 = ArchCore.kernels.geometry(A);   // true = wasm handled the whole set
    check(kernelProbe1 === true, 'scene1: geometry kernel handled the set', String(kernelProbe1));
    await yieldNow();

    // =====================================================================
    // Scenario 4: emulate a drag — edit the free point's coordinate
    // expressions, then re-diff both paths.
    // =====================================================================
    console.log('[geo] scene4 drag-emulation');
    const pA = A.entries.find(e => e.type === 'geometry' && String(e.name).toLowerCase() === 'a');
    check(!!pA, 'scene4: free point A exists');
    if (pA) {
        pA.x_expr = '3'; pA.y_expr = '-1';
        const js4 = runPath(false, 'scene4');
        await yieldNow();
        const wasm4 = runPath(true, 'scene4');
        await yieldNow();
        cmpSnap(js4.geo, wasm4.geo, 'scene4');
        cmpVars(js4.vars, wasm4.vars, 'scene4');
        check(eq(wasm4.geo['a'].x, 3) && eq(wasm4.geo['a'].y, -1), 'scene4: edited coords took effect', JSON.stringify(wasm4.geo['a']));
    }

    // =====================================================================
    // Scenario 2: [A,x] coordinate refs + root[...] variables.
    // =====================================================================
    console.log('[geo] scene2 root+coords');
    const missing2 = build(['point(A, 1, 2)', 'a=2', 'b=root[x^3-[A,x]*x-a, x, 1]', 'c=b^2+1']);
    check(missing2.length === 0, 'scene2: all inputs accepted', missing2.join(' ; '));
    const js2 = runPath(false);
    await yieldNow();
    const wasm2 = runPath(true);
    await yieldNow();
    cmpSnap(js2.geo, wasm2.geo, 'scene2');
    cmpVars(js2.vars, wasm2.vars, 'scene2');
    check(Number.isFinite(wasm2.vars['b']), 'scene2: root found a finite value', String(wasm2.vars['b']));

    // =====================================================================
    // Scenario 3: custom-function compatibility.
    // =====================================================================
    // (a) simple custom function inside geometry expressions and root[]:
    //     the kernel must handle the set itself.
    console.log('[geo] scene3a simple custom fn');
    const missing3a = build([
        'point(O, 0, 0)',
        'f(x)=x^2+1',
        'point(P, f(1), f(2))',
        'circle(C, O, f(2))',
        'd=root[f(x)-10, x, 3]',
        'k=f(3)*2',
    ]);
    check(missing3a.length === 0, 'scene3a: all inputs accepted', missing3a.join(' ; '));
    const js3a = runPath(false);
    await yieldNow();
    const wasm3a = runPath(true);
    await yieldNow();
    cmpSnap(js3a.geo, wasm3a.geo, 'scene3a');
    cmpVars(js3a.vars, wasm3a.vars, 'scene3a');
    const probe3a = ArchCore.kernels.geometry(A);
    check(probe3a === true, 'scene3a: kernel handled simple-custom-function set', String(probe3a));
    await yieldNow();

    // (b) advanced JS function in a geometry expression: user-defined
    //     advanced functions are never "pristine", so the kernel must
    //     decline and the page's JS body must still produce equal values.
    console.log('[geo] scene3b advanced fn');
    const missing3b = build([
        'g(x)={return x*x+1;}',
        'point(Q, g(1), g(2))',
        'circle(C2, Q, g(2))',
        'h=root[g(x)-10, x, 3]',
    ]);
    check(missing3b.length === 0, 'scene3b: all inputs accepted', missing3b.join(' ; '));
    const js3b = runPath(false);
    await yieldNow();
    const wasm3b = runPath(true);
    await yieldNow();
    cmpSnap(js3b.geo, wasm3b.geo, 'scene3b');
    cmpVars(js3b.vars, wasm3b.vars, 'scene3b');
    const probe3b = ArchCore.kernels.geometry(A);
    check(probe3b === false, 'scene3b: kernel declined advanced-function set (JS fallback)', String(probe3b));
    check(Number.isFinite(wasm3b.vars['h']) && Math.abs(wasm3b.vars['h'] - 3) < 5e-3, 'scene3b: root via advanced fn solved near 3', String(wasm3b.vars['h']));
    await yieldNow();

    // (c) re-define the advanced function (non-pristine edit): still declines,
    //     still consistent.
    console.log('[geo] scene3c redefined advanced fn');
    A.addEntry('g(x)={return x*x+2;}');
    const js3c = runPath(false);
    await yieldNow();
    const wasm3c = runPath(true);
    await yieldNow();
    cmpSnap(js3c.geo, wasm3c.geo, 'scene3c');
    cmpVars(js3c.vars, wasm3c.vars, 'scene3c');
    const probe3c = ArchCore.kernels.geometry(A);
    check(probe3c === false, 'scene3c: kernel declined re-defined advanced fn', String(probe3c));
    await yieldNow();

    // =====================================================================
    // Scenario 5: archcore-enabled toggle.
    // =====================================================================
    console.log('[geo] scene5 toggle');
    // setEnabled is the page-level toggle: it persists to localStorage and is
    // honored at load time (archcore-enabled === '0' -> core starts off).
    ArchCore.setEnabled(false);
    const ls0 = localStorage.getItem('archcore-enabled');
    const activeWhenOff = ArchCore.active;
    const stateOff = ArchCore.state.enabled;
    const js5 = runPath(false);
    ArchCore.setEnabled(true);
    const ls1 = localStorage.getItem('archcore-enabled');
    const wasm5 = runPath(true);
    check(ls0 === '0', 'scene5: localStorage archcore-enabled=0 when off', String(ls0));
    check(ls1 === '1', 'scene5: localStorage archcore-enabled=1 when on', String(ls1));
    check(activeWhenOff === false && stateOff === false, 'scene5: ArchCore.active false when disabled', `active=${activeWhenOff} state=${stateOff}`);
    cmpSnap(js5.geo, wasm5.geo, 'scene5');
    cmpVars(js5.vars, wasm5.vars, 'scene5');

    // Leave the page in a clean wasm-on state.
    A.recalculateAll = origRecalc;
    A.updateEntryList = origUpdateList;
    A.showTopPrompt = origPrompt;
    A.clearAllEntries();
    A.addEntry('y=sin(x)');
    ArchCore.state.enabled = true;
    A.requestDraw = origRequestDraw;
    A.requestDraw();
    console.log('[geo] done');

    return {
        checks: checkCount,
        failures: failCount,
        scene1: { entries: Object.keys(wasm1.geo).length, meaningful: meaningfulCount, kernelHandled: kernelProbe1 === true, typesCovered: typesSeen.size },
        kernelProbes: { scene1: kernelProbe1, scene3a: probe3a, scene3b: probe3b, scene3c: probe3c },
        localStorageToggle: { off: ls0, on: ls1, activeWhenOff },
        mismatches,
        summary: `${checkCount} checks, ${failCount} failures`,
    };
})()
