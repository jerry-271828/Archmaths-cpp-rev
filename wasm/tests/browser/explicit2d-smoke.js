// Scoped regression smoke for the explicit2d kernel on a full-kernel page.
// Same differential approach as explicit2d.js (deep compare of
// webglVertices + plottedFunctionPoints, JS vs wasm path, plus the
// cache-reuse guard), reduced to representative branches so it finishes on
// slow CDP bridges. Run with `node cdp.js run <tab> @explicit2d-smoke.js`.
(async () => {
    const A = window.archInstance;
    const yieldNow = () => (window.__yield ? window.__yield() : new Promise(r => setTimeout(r, 0)));

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
        let mismatches = [];
        for (let i = 0; i < a.length; i++) {
            for (let k = 0; k < 2; k++) {
                const av = a[i][k], bv = b[i][k];
                const rel = Math.abs(av - bv) / Math.max(1, Math.abs(av), Math.abs(bv));
                if (rel > tol) mismatches.push([i, k, av, bv]);
            }
        }
        return { ok: mismatches.length === 0, mismatchCount: mismatches.length, sample: mismatches.slice(0, 5) };
    }
    function runOnce(setup, flags, wasmEnabled) {
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
        return {
            verts: toPlainVerts(entry.webglVertices),
            points: toPlainPoints(A.plottedFunctionPoints),
            usedWasm: wasmEnabled && !!rec && rec.argNames.length === 1,
            plotType: entry.plotType,
        };
    }
    const EXPRS = [
        ['y=sin(x)', A => A.addEntry('y=sin(x)')],
        ['y=tan(x)', A => A.addEntry('y=tan(x)')],
        ['y=1/x', A => A.addEntry('y=1/x')],
    ];
    const BRANCHES = [
        { name: 'naive', adaptive: false, autoBreak: false },
        { name: 'adaptive+extend', adaptive: true, autoBreak: false, adaptiveExtend: true },
    ];
    const THICKNESS = [{ name: 'thin', thin: true }, { name: 'thick', thin: false }];
    const cases = [];
    let idx = 0;
    for (const [exprName, setup] of EXPRS) {
        for (const branch of BRANCHES) {
            for (const thick of THICKNESS) {
                const flags = { adaptive: branch.adaptive, autoBreak: branch.autoBreak, adaptiveExtend: branch.adaptiveExtend, thin: thick.thin };
                const js = runOnce(setup, flags, false);
                const wasm = runOnce(setup, flags, true);
                const vc = compareArrays(js.verts, wasm.verts, 1e-6, 'verts');
                const pc = comparePoints(js.points, wasm.points, 1e-9);
                cases.push({ expr: exprName, branch: branch.name, thickness: thick.name, usedWasm: wasm.usedWasm,
                    vertsOk: vc.ok, vertsReason: vc.reason || null, vertsMaxRel: vc.maxRel,
                    pointsOk: pc.ok, pointsReason: pc.reason || null, pointsSample: pc.sample });
                idx++;
                if (idx % 2 === 0) await yieldNow();
            }
        }
    }
    // cache-reuse guard (same as explicit2d.js)
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
        return { sameRef: entry.webglVertices === vertsRef1,
            pointsLenStable: A.plottedFunctionPoints.length === pointsLen1,
            pointsLenAfter: A.plottedFunctionPoints.length };
    }
    const cacheJs = probeCacheReuse(false);
    const cacheWasm = probeCacheReuse(true);
    const cacheOk = cacheWasm.sameRef === cacheJs.sameRef && cacheWasm.pointsLenStable === cacheJs.pointsLenStable
        && cacheWasm.pointsLenAfter === cacheJs.pointsLenAfter;
    await yieldNow();

    const mismatches = [];
    for (const c of cases) {
        if (!c.usedWasm) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: kernel did not activate`);
        if (!c.vertsOk) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: verts mismatch (${c.vertsReason || 'see sample'})`);
        if (!c.pointsOk) mismatches.push(`${c.expr}/${c.branch}/${c.thickness}: points mismatch (${JSON.stringify(c.pointsSample)})`);
    }
    if (!cacheOk) mismatches.push(`cache-reuse regression: js=${JSON.stringify(cacheJs)} wasm=${JSON.stringify(cacheWasm)}`);

    return {
        smokeCases: cases.length,
        cacheReuse: { js: cacheJs, wasm: cacheWasm, ok: cacheOk },
        mismatches,
        summary: `${cases.length} smoke cases, ${mismatches.length} mismatches`,
    };
})()
