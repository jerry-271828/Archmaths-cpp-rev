// NO-BENCH variant of explicit2d.js (benchmark pushes stripped; slow environments).: plotExplicitFunctionGL
// (plotType 'y'/'x', all three sampling branches x thick/thin) and
// recalculateParametricCache. Run via:
//   node $SP/cdp.js run k-explicit2d/ @wasm/tests/browser/explicit2d.js 120000
// against a tab open on a build embedding ONLY the explicit2d kernel.
// Resolves to a JSON summary; also logs progress via console.log (visible in
// the tab, harmless if unread).
(async () => {
    const A = window.archInstance;
    const yieldNow = () => (Promise.resolve());

    function toPlainVerts(f32) { return f32 ? Array.from(f32) : []; }
    function toPlainPoints(pts) { return pts.map(p => [p.x, p.y]); }

    function compareArrays(a, b, tol, label) {
        if (a.length !== b.length) return { ok: false, reason: `${label} length ${a.length} vs ${b.length}` };
        let maxRel = 0, mismatches = [];
        for (let i = 0; i < a.length; i++) {
            const av = a[i], bv = b[i];
            const aNaN = Number.isNaN(av), bNaN = Number.isNaN(bv);
            if (aNaN || bNaN) { if (aNaN !== bNaN) mismatches.push([i, av, bv]); continue; }
            const rel = Math.abs(av - bv) / Math.max(1, Math.abs(av), Math.abs(bv));
            if (rel > tol) mismatches.push([i, av, bv]);
            if (rel > maxRel) maxRel = rel;
        }
        return { ok: mismatches.length === 0, maxRel, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) };
    }

    function comparePoints(a, b, tol) {
        if (a.length !== b.length) return { ok: false, reason: `points length ${a.length} vs ${b.length}` };
        let maxRel = 0, mismatches = [];
        for (let i = 0; i < a.length; i++) {
            for (let k = 0; k < 2; k++) {
                const av = a[i][k], bv = b[i][k];
                const rel = Math.abs(av - bv) / Math.max(1, Math.abs(av), Math.abs(bv));
                if (rel > tol) mismatches.push([i, k, av, bv]);
                if (rel > maxRel) maxRel = rel;
            }
        }
        return { ok: mismatches.length === 0, maxRel, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) };
    }

    function compareCachedPoints(a, b, tol) {
        if (a.length !== b.length) return { ok: false, reason: `cachedPoints length ${a.length} vs ${b.length}` };
        let mismatches = [];
        for (let i = 0; i < a.length; i++) {
            const av = a[i], bv = b[i];
            if (av === null || bv === null) { if (av !== bv) mismatches.push([i, av, bv]); continue; }
            const relX = Math.abs(av[0] - bv[0]) / Math.max(1, Math.abs(av[0]), Math.abs(bv[0]));
            const relY = Math.abs(av[1] - bv[1]) / Math.max(1, Math.abs(av[1]), Math.abs(bv[1]));
            if (relX > tol || relY > tol) mismatches.push([i, av, bv]);
        }
        return { ok: mismatches.length === 0, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) };
    }

    function runExplicitOnce(setup, flags, wasmEnabled) {
        A.clearAllEntries();
        setup(A);
        const entry = A.entries.find(e => e.type === 'function');
        A.adaptivePlottingEnabled = !!flags.adaptive;
        A.autoBreakpointDetectionEnabled = !!flags.autoBreak;
        A.adaptiveExtendEnabled = !!flags.adaptiveExtend;
        A.highPerformancePlottingEnabled = !!flags.thin;
        ArchCore.state.enabled = wasmEnabled;
        A.clearPlotData();
        A.draw();
        const rec = wasmEnabled ? ArchCore.programFor(A, entry.func) : null;
        const usedWasm = wasmEnabled && !!rec && rec.argNames.length === 1;
        return {
            verts: toPlainVerts(entry.webglVertices),
            points: toPlainPoints(A.plottedFunctionPoints),
            usedWasm,
            plotType: entry.plotType,
            compilationError: entry.compilationError || null,
        };
    }

    const EXPRS = [
        ['y=sin(x)', A => A.addEntry('y=sin(x)')],
        ['y=tan(x)', A => A.addEntry('y=tan(x)')],
        ['y=1/x', A => A.addEntry('y=1/x')],
        ['y=x^(1/3)', A => A.addEntry('y=x^(1/3)')],
        ['y=sqrt(x)', A => A.addEntry('y=sqrt(x)')],
        ['y=floor(x)', A => A.addEntry('y=floor(x)')],
        ['y=log(x)', A => A.addEntry('y=log(x)')],
        ['y=a*sin(b*x)', A => { A.addEntry('a=2'); A.addEntry('b=3'); A.addEntry('y=a*sin(b*x)'); }],
        ['x=sin(y)', A => A.addEntry('x=sin(y)')],
        ['x=y^2', A => A.addEntry('x=y^2')],
    ];

    const BRANCHES = [
        { name: 'naive', adaptive: false, autoBreak: false },
        { name: 'autoBreak', adaptive: false, autoBreak: true },
        { name: 'adaptive', adaptive: true, autoBreak: false },
        { name: 'adaptive+extend', adaptive: true, autoBreak: false, adaptiveExtend: true },
    ];
    const THICKNESS = [{ name: 'thin', thin: true }, { name: 'thick', thin: false }];

    const explicitCases = [];
    let idx = 0;
    for (const [exprName, setup] of EXPRS) {
        for (const branch of BRANCHES) {
            for (const thick of THICKNESS) {
                const flags = { adaptive: branch.adaptive, autoBreak: branch.autoBreak, adaptiveExtend: branch.adaptiveExtend, thin: thick.thin };
                const js = runExplicitOnce(setup, flags, false);
                const wasm = runExplicitOnce(setup, flags, true);
                const vc = compareArrays(js.verts, wasm.verts, 1e-6, 'verts');
                const pc = comparePoints(js.points, wasm.points, 1e-9);
                explicitCases.push({
                    expr: exprName, branch: branch.name, thickness: thick.name, plotType: js.plotType,
                    usedWasm: wasm.usedWasm,
                    vertsLenJS: js.verts.length, vertsLenWasm: wasm.verts.length, vertsOk: vc.ok, vertsMaxRel: vc.maxRel, vertsMismatch: vc.mismatchCount, vertsSample: vc.sample, vertsReason: vc.reason || null,
                    pointsLenJS: js.points.length, pointsLenWasm: wasm.points.length, pointsOk: pc.ok, pointsMaxRel: pc.maxRel, pointsMismatch: pc.mismatchCount, pointsSample: pc.sample, pointsReason: pc.reason || null,
                });
                idx++;
                console.log('[exp2d] case', idx, exprName, branch.name, thick.name);
                if (idx % 4 === 0) await yieldNow();
            }
        }
    }

    // ---- int(...) integral plot: must fall back to the JS path (JsSubset
    // grammar has no loop/statement support), output identical either way.
    // int(...) bodies reach the wasm VM as Math.__archint (see loops.js).
    // Compared on the uniform-sampling branches: the adaptive branch turns
    // last-ulp differences of the 100-term sum into slightly different step
    // sizes, which loops.js documents separately.
    function runIntLoop(wasmEnabled, autoBreak) {
        A.clearAllEntries();
        A.addEntry('y=int(exp(-t^2),t,0,x)');
        const entry = A.entries.find(e => e.type === 'function');
        A.adaptivePlottingEnabled = false;
        A.adaptiveExtendEnabled = false;
        A.autoBreakpointDetectionEnabled = autoBreak;
        ArchCore.state.enabled = wasmEnabled;
        A.clearPlotData();
        A.draw();
        const rec = wasmEnabled ? ArchCore.programFor(A, entry.func) : null;
        return { verts: toPlainVerts(entry.webglVertices), points: toPlainPoints(A.plottedFunctionPoints), wasmProgram: !!rec };
    }
    console.log('[exp2d] cases done');
    const intLoop = [false, true].map((autoBreak) => {
        const js = runIntLoop(false, autoBreak);
        const wasm = runIntLoop(true, autoBreak);
        return {
            branch: autoBreak ? 'autoBreak' : 'naive',
            verts: compareArrays(js.verts, wasm.verts, 1e-12, 'int-verts'),
            points: comparePoints(js.points, wasm.points, 1e-15),
            wasmProgramCompiled: wasm.wasmProgram,
        };
    });
    await yieldNow();

    console.log('[exp2d] int done');
    // ---- parametric cache: circle + spiral ----
    function runParametricOnce(setup, wasmEnabled) {
        A.clearAllEntries();
        setup(A);
        const entry = A.entries.find(e => e.type === 'function' && (e.plotType === 'parametric' || e.plotType === 'parametric3d'));
        ArchCore.state.enabled = wasmEnabled;
        A.clearPlotData();
        entry.cachedPoints = [];
        A.recalculateParametricCache(entry);
        return {
            cachedPoints: (entry.cachedPoints || []).map(p => (p === null ? null : [p.x, p.y])),
            plottedPoints: toPlainPoints(A.plottedFunctionPoints),
            plotType: entry.plotType,
        };
    }
    const PARAM_CASES = [
        ['circle', A => A.addEntry('x=cos(t),y=sin(t)')],
        ['spiral', A => { A.tmin = -20; A.tmax = 20; A.addEntry('x=t*cos(t),y=t*sin(t)'); }],
    ];
    const parametricCases = [];
    for (const [name, setup] of PARAM_CASES) {
        const js = runParametricOnce(setup, false);
        const wasm = runParametricOnce(setup, true);
        const cc = compareCachedPoints(js.cachedPoints, wasm.cachedPoints, 1e-9);
        const pc = comparePoints(js.plottedPoints, wasm.plottedPoints, 1e-9);
        parametricCases.push({
            name, plotType: js.plotType,
            cachedLenJS: js.cachedPoints.length, cachedLenWasm: wasm.cachedPoints.length, cachedOk: cc.ok, cachedMismatch: cc.mismatchCount, cachedSample: cc.sample, cachedReason: cc.reason || null,
            plottedLenJS: js.plottedPoints.length, plottedLenWasm: wasm.plottedPoints.length, plottedOk: pc.ok, plottedMaxRel: pc.maxRel, plottedMismatch: pc.mismatchCount, plottedReason: pc.reason || null,
        });
        A.tmin = -2 * Math.PI; A.tmax = 2 * Math.PI;
    }
    await yieldNow();

    // ---- benchmark: A.clearPlotData(); A.draw() per recompute, interleaved medians ----
    function benchOnce(setup, flags, wasmEnabled) {
        A.clearAllEntries();
        setup(A);
        A.adaptivePlottingEnabled = !!flags.adaptive;
        A.autoBreakpointDetectionEnabled = !!flags.autoBreak;
        A.adaptiveExtendEnabled = !!flags.adaptiveExtend;
        A.highPerformancePlottingEnabled = !!flags.thin;
        if (flags.precision) {
            A.explicitPrecisionStep = flags.precision;
            if (A.explicitPrecisionSlider) A.explicitPrecisionSlider.setValue(flags.precision, true);
        }
        ArchCore.state.enabled = wasmEnabled;
        A.clearPlotData();
        const t0 = performance.now();
        A.draw();
        return performance.now() - t0;
    }
    function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

    async function benchmarkCase(name, setup, flags, reps) {
        const js = [], wasm = [];
        for (let i = 0; i < reps; i++) {
            js.push(benchOnce(setup, flags, false));
            wasm.push(benchOnce(setup, flags, true));
            await yieldNow();
        }
        return { name, jsMedianMs: +median(js).toFixed(3), wasmMedianMs: +median(wasm).toFixed(3), reps };
    }

    const benchmarks = [];
            
    A.explicitPrecisionStep = 2;
    if (A.explicitPrecisionSlider) A.explicitPrecisionSlider.setValue(2, true);

    console.log('[exp2d] parametric done');
    // ---- cache-reuse regression guard: plotExplicitFunctionGL is called from
    // draw() on EVERY render (pan/animation/unrelated redraws), not just on
    // real invalidations. The original JS only resamples and re-pushes into
    // plottedFunctionPoints when `!funcEntry.webglVertices`; a wasm hook placed
    // outside that guard would bypass the cache and duplicate points on every
    // redraw. This does NOT use clearPlotData()-before-every-draw() like the
    // cases above, specifically so it exercises that guard.
    function probeCacheReuse(wasmEnabled) {
        A.clearAllEntries();
        A.addEntry('y=sin(x)');
        const entry = A.entries.find(e => e.type === 'function');
        A.adaptivePlottingEnabled = true;
        A.adaptiveExtendEnabled = true;
        ArchCore.state.enabled = wasmEnabled;
        A.clearPlotData();
        A.draw();
        const vertsRef1 = entry.webglVertices;
        const pointsLen1 = A.plottedFunctionPoints.length;
        A.draw();
        A.draw();
        return {
            sameRef: entry.webglVertices === vertsRef1,
            pointsLenStable: A.plottedFunctionPoints.length === pointsLen1,
            pointsLen1, pointsLenAfter: A.plottedFunctionPoints.length,
        };
    }
    const cacheJs = probeCacheReuse(false);
    const cacheWasm = probeCacheReuse(true);
    const cacheReuseOk = cacheWasm.sameRef === cacheJs.sameRef && cacheWasm.pointsLenStable === cacheJs.pointsLenStable
        && cacheWasm.pointsLenAfter === cacheJs.pointsLenAfter;
    await yieldNow();

    console.log('[exp2d] cache done');
    const mismatches = [];
    if (!cacheReuseOk) mismatches.push(`cache-reuse regression: repeated draw() without invalidation diverges from JS (js=${JSON.stringify(cacheJs)}, wasm=${JSON.stringify(cacheWasm)})`);
    for (const c of explicitCases) {
        if (!c.usedWasm) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: kernel did not activate (usedWasm=false)`);
        if (!c.vertsOk) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: verts mismatch (${c.vertsReason || c.vertsMismatch + ' diffs, maxRel=' + c.vertsMaxRel})`);
        if (!c.pointsOk) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: points mismatch (${c.pointsReason || c.pointsMismatch + ' diffs, maxRel=' + c.pointsMaxRel})`);
    }
    for (const c of intLoop) {
        if (!c.verts.ok) mismatches.push(`int(...)/${c.branch}: verts mismatch: ${JSON.stringify(c.verts)}`);
        if (!c.points.ok) mismatches.push(`int(...)/${c.branch}: points mismatch: ${JSON.stringify(c.points)}`);
        if (!c.wasmProgramCompiled) mismatches.push(`int(...)/${c.branch}: did not compile to a wasm program`);
    }
    for (const c of parametricCases) {
        if (!c.cachedOk) mismatches.push(`parametric/${c.name}: cachedPoints mismatch (${c.cachedReason || c.cachedMismatch + ' diffs'})`);
        if (!c.plottedOk) mismatches.push(`parametric/${c.name}: plottedPoints mismatch (${c.plottedReason || c.plottedMismatch + ' diffs, maxRel=' + c.plottedMaxRel})`);
    }

    return {
        totalExplicitCases: explicitCases.length,
        explicitCases,
        intLoop,
        parametricCases,
        cacheReuse: { js: cacheJs, wasm: cacheWasm, ok: cacheReuseOk },
        benchmarks,
        mismatches,
        summary: `${explicitCases.length} explicit cases, ${mismatches.length} mismatches, ${parametricCases.length} parametric cases`,
    };
})()
