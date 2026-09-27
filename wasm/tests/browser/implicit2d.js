// Differential test + benchmark for the "implicit2d" ArchCore kernel.
// Runs processImplicitBlocksOnGrid (after a clearPlotData()) on the JS path
// and on the wasm path from identical engine state, and compares:
//   - implictplotdata (segments, in order, incl. originalFuncEntryIndex)
//   - implictplotindex (per-block boundaries)
//   - plottedFunctionPoints (endpoint list, in order)
//   - implicitFillData (Map key insertion order + per-key triangle content)
//   - engine.implictjump (side-effect field)
// Run with `node cdp.js run <tab> @implicit2d.js <maxWaitMs>`.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    await new Promise((r) => ArchCore.onReady(r));
    const rect = A.canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;

    const TOL = (a, b) => {
        if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    };

    // Deep-capture the mutable state this subsystem writes.
    function snapshot() {
        return {
            implictjump: A.implictjump,
            plotdata: A.implictplotdata.map(seg => seg.slice()),
            plotindex: A.implictplotindex.slice(),
            points: A.plottedFunctionPoints.map(p => ({ x: p.x, y: p.y })),
            fillKeys: Array.from(A.implicitFillData.keys()),
            fill: new Map(Array.from(A.implicitFillData.entries()).map(([k, v]) => [k, v.slice()])),
        };
    }

    function compare(js, wasm) {
        const mismatches = [];
        if (js.implictjump !== wasm.implictjump) mismatches.push(`implictjump ${js.implictjump} vs ${wasm.implictjump}`);
        if (js.plotindex.length !== wasm.plotindex.length) mismatches.push(`plotindex length ${js.plotindex.length} vs ${wasm.plotindex.length}`);
        else for (let i = 0; i < js.plotindex.length; i++) if (js.plotindex[i] !== wasm.plotindex[i]) mismatches.push(`plotindex[${i}] ${js.plotindex[i]} vs ${wasm.plotindex[i]}`);

        if (js.plotdata.length !== wasm.plotdata.length) {
            mismatches.push(`plotdata length ${js.plotdata.length} vs ${wasm.plotdata.length}`);
        } else {
            for (let i = 0; i < js.plotdata.length; i++) {
                const a = js.plotdata[i], b = wasm.plotdata[i];
                if (a[4] !== b[4]) { mismatches.push(`plotdata[${i}] funcIdx ${a[4]} vs ${b[4]}`); continue; }
                for (let k = 0; k < 4; k++) {
                    if (!TOL(a[k], b[k])) mismatches.push(`plotdata[${i}][${k}] ${a[k]} vs ${b[k]}`);
                }
            }
        }

        if (js.points.length !== wasm.points.length) {
            mismatches.push(`points length ${js.points.length} vs ${wasm.points.length}`);
        } else {
            for (let i = 0; i < js.points.length; i++) {
                if (!TOL(js.points[i].x, wasm.points[i].x) || !TOL(js.points[i].y, wasm.points[i].y)) {
                    mismatches.push(`points[${i}] (${js.points[i].x},${js.points[i].y}) vs (${wasm.points[i].x},${wasm.points[i].y})`);
                }
            }
        }

        if (js.fillKeys.join(',') !== wasm.fillKeys.join(',')) {
            mismatches.push(`implicitFillData key order [${js.fillKeys}] vs [${wasm.fillKeys}]`);
        }
        const allKeys = new Set([...js.fillKeys, ...wasm.fillKeys]);
        for (const k of allKeys) {
            const a = js.fill.get(k) || [], b = wasm.fill.get(k) || [];
            if (a.length !== b.length) { mismatches.push(`fill[${k}] length ${a.length} vs ${b.length}`); continue; }
            for (let i = 0; i < a.length; i++) if (!TOL(a[i], b[i])) mismatches.push(`fill[${k}][${i}] ${a[i]} vs ${b[i]}`);
        }
        return mismatches;
    }

    function setup(exprs, opts) {
        A.clearAllEntries();
        A.is3DMode = false;
        A.scale = opts.scale;
        A.offset = { x: W / 2, y: H / 2 };
        A.implicitPrecisionStep = opts.step;
        A.originalImplicitPrecision = opts.step;
        A.autoBreakpointDetectionEnabled = !!opts.autoBreak;
        for (const e of exprs) A.addEntry(e);
    }

    function runOnce(wasmOn) {
        ArchCore.state.enabled = wasmOn;
        A.clearPlotData();
        A.processImplicitBlocksOnGrid(W, H);
        return snapshot();
    }

    const cases = [
        { name: 'circle =', exprs: ['x^2+y^2=4'], scale: 100, step: 5, autoBreak: true },
        { name: 'circle >=', exprs: ['x^2+y^2>=4'], scale: 100, step: 5, autoBreak: true },
        { name: 'circle <=', exprs: ['x^2+y^2<=4'], scale: 100, step: 5, autoBreak: true },
        { name: 'circle >', exprs: ['x^2+y^2>4'], scale: 100, step: 5, autoBreak: true },
        { name: 'circle <', exprs: ['x^2+y^2<4'], scale: 100, step: 5, autoBreak: true },
        { name: 'transcendental mix', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 100, step: 5, autoBreak: true },
        { name: 'transcendental mix noAutoBreak', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 100, step: 5, autoBreak: false },
        { name: 'inequality fill', exprs: ['sin(x)+cos(y)>0.5'], scale: 100, step: 5, autoBreak: true },
        { name: 'inequality fill <=', exprs: ['sin(x)+cos(y)<=0.5'], scale: 100, step: 5, autoBreak: true },
        { name: 'cubic curve', exprs: ['y^2=x^3-x'], scale: 100, step: 5, autoBreak: true },
        { name: 'discontinuous tan', exprs: ['tan(x)=y'], scale: 100, step: 5, autoBreak: true },
        { name: 'negative fractional pow domain', exprs: ['x^(1/3)+y^(1/3)=2'], scale: 100, step: 5, autoBreak: true },
        { name: 'three curves', exprs: ['x^2+y^2=9', 'y^2=x^3-x', 'sin(x*y)=0.3'], scale: 100, step: 5, autoBreak: true },
        { name: 'three curves noAutoBreak', exprs: ['x^2+y^2=9', 'y^2=x^3-x', 'sin(x*y)=0.3'], scale: 100, step: 5, autoBreak: false },
        { name: 'mixed w/ non-eligible gamma', exprs: ['gamma(x)+y=2', 'x^2+y^2=9', 'sin(x*y)=0.3'], scale: 100, step: 5, autoBreak: true },
        { name: 'mixed inequality + eq + non-eligible', exprs: ['gamma(x)+y=2', 'x^2+y^2>=9', 'y^2=x^3-x'], scale: 100, step: 5, autoBreak: false },
        { name: 'high precision (small step)', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 100, step: 2, autoBreak: true },
        { name: 'low precision (large step)', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 100, step: 10, autoBreak: true },
        { name: 'zoomed in', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 300, step: 5, autoBreak: true },
        { name: 'zoomed out', exprs: ['x^2+y^2+sin(3x)*y=4'], scale: 25, step: 5, autoBreak: true },
        { name: 'slider param', exprs: ['a=1.5', 'x^2+a*y^2=4'], scale: 100, step: 5, autoBreak: true },
        { name: 'implicit3d overlay (z)', exprs: ['z=sin(x)*cos(y)-0.3'], scale: 100, step: 5, autoBreak: true },
        // rhs must literally contain a 'z' token for the parser to classify
        // these as x3d/y3d (a 3-arg surface residual) instead of plain x=/y=.
        { name: 'x3d overlay', exprs: ['x=sin(y)+0*z'], scale: 100, step: 5, autoBreak: true },
        { name: 'y3d overlay', exprs: ['y=sin(x)*x+0*z'], scale: 100, step: 5, autoBreak: true },
    ];

    const results = [];
    for (const c of cases) {
        setup(c.exprs, c);
        await yieldNow();
        const js = runOnce(false);
        await yieldNow();
        const wasm = runOnce(true);
        await yieldNow();
        const mismatches = compare(js, wasm);
        results.push({
            name: c.name,
            jsSegs: js.plotdata.length,
            wasmSegs: wasm.plotdata.length,
            jsFillKeys: js.fillKeys.length,
            wasmFillKeys: wasm.fillKeys.length,
            ok: mismatches.length === 0,
            mismatches: mismatches.slice(0, 8),
        });
    }

    // ---- benchmark: full-grid recompute, median of interleaved A/B runs ----
    function median(arr) {
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    }
    async function benchCase(exprs, opts, runs) {
        setup(exprs, opts);
        await yieldNow();
        const jsT = [], wasmT = [];
        for (let i = 0; i < runs; i++) {
            ArchCore.state.enabled = false;
            A.clearPlotData();
            let t = performance.now();
            A.processImplicitBlocksOnGrid(W, H);
            jsT.push(performance.now() - t);
            await yieldNow();

            ArchCore.state.enabled = true;
            A.clearPlotData();
            t = performance.now();
            A.processImplicitBlocksOnGrid(W, H);
            wasmT.push(performance.now() - t);
            await yieldNow();
        }
        return { jsMs: +median(jsT).toFixed(2), wasmMs: +median(wasmT).toFixed(2) };
    }

    const benchmarks = {};
    benchmarks['x^2+y^2+sin(3x)*y=4 (single)'] = await benchCase(['x^2+y^2+sin(3x)*y=4'], { scale: 100, step: 5, autoBreak: true }, 9);
    benchmarks['3 curves'] = await benchCase(['x^2+y^2=9', 'y^2=x^3-x', 'sin(x*y)=0.3'], { scale: 100, step: 5, autoBreak: true }, 9);
    benchmarks['inequality fill'] = await benchCase(['sin(x)+cos(y)>0.5'], { scale: 100, step: 5, autoBreak: true }, 9);
    benchmarks['high precision (step=2)'] = await benchCase(['x^2+y^2+sin(3x)*y=4'], { scale: 100, step: 2, autoBreak: true }, 7);

    A.clearAllEntries();
    A.is3DMode = false;
    ArchCore.state.enabled = true;

    return {
        canvas: [Math.round(W), Math.round(H)],
        allOk: results.every(r => r.ok),
        results,
        benchmarks,
    };
})()
