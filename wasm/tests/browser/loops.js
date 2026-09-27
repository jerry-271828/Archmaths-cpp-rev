// Differential test + benchmark for making large-operator (sum/prod/int)
// entries eligible for the ArchCore wasm path. Before this hook,
// recompileFunctions() tagged every compiled closure's archSource.body with
// the same JS IIFE string the closure itself runs; that IIFE is not
// wasm-parseable, so ArchCore.programFor() always returned null for entries
// using sum(...)/prod(...)/int(...) and they silently stayed on JS forever.
// The hook makes archSource.body an equivalent Math.__archsum/__archprod/
// __archint expression (which wasm/core/ExprProgram.cpp lowers to Op::Loop)
// while leaving the JS closure that actually runs byte-for-byte unchanged.
//
// This script re-checks the five existing kernels (explicit2d, implicit2d,
// surface3d, mc3d, flat3d) now that they receive non-null programs for
// large-operator entries, using each kernel's own diff approach (deep-copied
// output comparison; gl.bindBuffer/bufferData capture for 3D meshes/lines),
// plus explicit ArchCore.programFor() eligibility checks and a couple of
// interleaved-median benchmarks.
//
// Run with `node cdp.js run <tab> @wasm/tests/browser/loops.js <maxWaitMs>`.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    if (typeof ArchCore === 'undefined') return { error: 'no ArchCore' };
    await new Promise((r) => ArchCore.onReady(r));

    const TOL = (a, b, tol) => {
        tol = tol || 1e-9;
        if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    };
    function compareNumArrays(a, b, tol, label) {
        if (!a || !b || a.length !== b.length) return { ok: false, reason: `${label}: length ${a && a.length} vs ${b && b.length}`, mismatches: Math.abs((a ? a.length : 0) - (b ? b.length : 0)), sample: [] };
        let maxDiff = 0, mismatches = 0, sample = [];
        for (let i = 0; i < a.length; i++) {
            if (!TOL(a[i], b[i], tol)) {
                mismatches++;
                if (sample.length < 5) sample.push([i, a[i], b[i]]);
            }
            const d = Number.isFinite(a[i]) && Number.isFinite(b[i]) ? Math.abs(a[i] - b[i]) : 0;
            if (d > maxDiff) maxDiff = d;
        }
        return { ok: mismatches === 0, maxDiff, mismatches, sample };
    }
    function toPlainVerts(f32) { return f32 ? Array.from(f32) : []; }
    function toPlainPoints(pts) { return pts.map((p) => [p.x, p.y]); }
    function comparePoints(a, b, tol) {
        if (a.length !== b.length) return { ok: false, reason: `points length ${a.length} vs ${b.length}` };
        let mismatches = 0, sample = [];
        for (let i = 0; i < a.length; i++) {
            for (let k = 0; k < 2; k++) {
                if (!TOL(a[i][k], b[i][k], tol)) { mismatches++; if (sample.length < 5) sample.push([i, k, a[i][k], b[i][k]]); }
            }
        }
        return { ok: mismatches === 0, mismatches, sample };
    }

    const allIssues = [];
    const sections = {};

    // =====================================================================
    // Section A: explicit2d -- y=f(x)/x=f(y), across the adaptive/autoBreak/
    // naive branches and thin/thick lines, for a battery of large-operator
    // expressions covering every scenario the task calls out.
    // =====================================================================
    {
        function runExplicitOnce(setup, flags, wasmEnabled) {
            A.clearAllEntries();
            A.is3DMode = false;
            setup(A);
            const entry = A.entries.find((e) => e.type === 'function');
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
                usedWasm, plotType: entry.plotType,
                compilationError: entry.compilationError || null,
                archBody: entry.func && entry.func.archSource ? entry.func.archSource.body : null,
            };
        }

        // [name, setup, expectWasm] -- expectWasm false only for cases that
        // must legitimately stay on JS (none expected here; kept explicit).
        const EXPRS = [
            ['int basic: y=int(exp(-t^2),t,0,x)', (A) => A.addEntry('y=int(exp(-t^2),t,0,x)')],
            ['sum basic: y=sum(sin(k*x)/k,k,1,25)', (A) => A.addEntry('y=sum(sin(k*x)/k,k,1,25)')],
            ['prod basic: y=prod(1+x/k,k,1,10)', (A) => A.addEntry('y=prod(1+x/k,k,1,10)')],
            ['x-form int: x=int(sin(u),u,0,y)', (A) => A.addEntry('x=int(sin(u),u,0,y)')],
            ['empty range: y=sum(k,k,5,1)', (A) => A.addEntry('y=sum(k,k,5,1)+0*x')],
            ['cap >50000: y=sum(k,k,0,60000)', (A) => A.addEntry('y=sum(k,k,0,60000)+0*x')],
            ['prod cap >50000: y=prod(k,k,0,60000)', (A) => A.addEntry('y=prod(k,k,0,60000)+0*x')],
            ['non-integer bound: y=sum(1/k,k,-0.3,3)', (A) => A.addEntry('y=sum(1/k,k,-0.3,3)+0*x')],
            ['reversed int bounds: y=int(t,t,x,x)', (A) => A.addEntry('y=int(t,t,x,x)')],
            ['non-finite samples: y=int(1/t,t,-1,1)', (A) => A.addEntry('y=int(1/t,t,-1,1)+0*x')],
            ['loop var shadows lane x: y=sum(x,x,1,3)+x', (A) => A.addEntry('y=sum(x,x,1,3)+x')],
            ['loop var shadows slider a: y=sum(a*x,a,1,3)*a', (A) => { A.addEntry('a=2'); A.addEntry('y=sum(a*x,a,1,3)*a'); }],
            ['slider in body+bounds: y=sum(sin(k*x)/k,k,1,a)', (A) => { A.addEntry('a=6'); A.addEntry('y=sum(sin(k*x)/k,k,1,a)'); }],
            ['slider only in bound: y=int(sin(t),t,0,a)', (A) => { A.addEntry('a=3.5'); A.addEntry('y=int(sin(t),t,0,a)'); }],
            ['nested sum in int: y=int(sum(cos(k*u),k,1,3),u,0,x)', (A) => A.addEntry('y=int(sum(cos(k*u),k,1,3),u,0,x)')],
            ['nested int in sum: y=sum(int(sin(u),u,0,k),k,1,4)', (A) => A.addEntry('y=sum(int(sin(u),u,0,k),k,1,4)+0*x')],
            ['advanced fn in body: y=sum(gamma(k)/20,k,1,5)', (A) => A.addEntry('y=sum(gamma(k)/20,k,1,5)+0*x')],
            ['pow negative base: y=prod((-x)^k,k,1,4)', (A) => A.addEntry('y=prod((-x)^k,k,1,4)')],
            ['loop var named like slider k: y=sum(k,k,1,5)+0*k (k slider)', (A) => { A.addEntry('k=9'); A.addEntry('y=sum(k,k,1,5)+0*k'); }],
            ['bound depends on x AND slider: y=sum(k,k,1,x+a)', (A) => { A.addEntry('a=2'); A.addEntry('y=sum(k,k,1,x+a)'); }],
            ['non-integer int step count (7.5): y=int(a*t+x,t,0,1)', (A) => { A.addEntry('a=1.5'); A.integralNumSteps = 7.5; A.addEntry('y=int(a*t+x,t,0,1)'); A.integralNumSteps = 100; }],
        ];

        const BRANCHES = [
            { name: 'naive', adaptive: false, autoBreak: false },
            { name: 'autoBreak', adaptive: false, autoBreak: true },
            { name: 'adaptive', adaptive: true, autoBreak: false },
            { name: 'adaptive+extend', adaptive: true, autoBreak: false, adaptiveExtend: true },
        ];
        const THICKNESS = [{ name: 'thin', thin: true }, { name: 'thick', thin: false }];

        const cases = [];
        let idx = 0;
        for (const [exprName, setup] of EXPRS) {
            for (const branch of BRANCHES) {
                for (const thick of THICKNESS) {
                    const flags = { adaptive: branch.adaptive, autoBreak: branch.autoBreak, adaptiveExtend: branch.adaptiveExtend, thin: thick.thin };
                    const js = runExplicitOnce(setup, flags, false);
                    const wasm = runExplicitOnce(setup, flags, true);
                    const vc = compareNumArrays(js.verts, wasm.verts, 1e-6, 'verts');
                    const pc = comparePoints(js.points, wasm.points, 1e-9);
                    cases.push({
                        expr: exprName, branch: branch.name, thickness: thick.name, plotType: js.plotType,
                        usedWasm: wasm.usedWasm, archBody: wasm.archBody,
                        compilationError: js.compilationError,
                        vertsLenJS: js.verts.length, vertsLenWasm: wasm.verts.length, vertsOk: vc.ok, vertsMismatch: vc.mismatches, vertsSample: vc.sample,
                        pointsLenJS: js.points.length, pointsLenWasm: wasm.points.length, pointsOk: pc.ok, pointsMismatch: pc.mismatches, pointsSample: pc.sample,
                    });
                    idx++;
                    if (idx % 6 === 0) await yieldNow();
                }
            }
        }
        await yieldNow();

        for (const c of cases) {
            if (c.compilationError) { allIssues.push(`explicit2d ${c.expr}/${c.branch}/${c.thickness}: compilationError ${c.compilationError}`); continue; }
            if (!c.usedWasm) allIssues.push(`explicit2d ${c.expr}/${c.branch}/${c.thickness}: wasm kernel did not activate (programFor null or wrong arity)`);
            if (!c.vertsOk) allIssues.push(`explicit2d ${c.expr}/${c.branch}/${c.thickness}: verts mismatch (${c.vertsMismatch} diffs) sample=${JSON.stringify(c.vertsSample)}`);
            if (!c.pointsOk) allIssues.push(`explicit2d ${c.expr}/${c.branch}/${c.thickness}: points mismatch (${c.pointsMismatch} diffs) sample=${JSON.stringify(c.pointsSample)}`);
        }
        sections.explicit2d = { total: cases.length, usedWasmCount: cases.filter((c) => c.usedWasm).length, byExpr: cases };
    }

    // =====================================================================
    // Section B: 2D parametric cache, with int(...) in funcX/funcY.
    // =====================================================================
    {
        function runParametricOnce(setup, wasmEnabled) {
            A.clearAllEntries();
            A.is3DMode = false;
            setup(A);
            const entry = A.entries.find((e) => e.type === 'function' && (e.plotType === 'parametric' || e.plotType === 'parametric3d'));
            ArchCore.state.enabled = wasmEnabled;
            A.clearPlotData();
            entry.cachedPoints = [];
            A.recalculateParametricCache(entry);
            const recX = wasmEnabled ? ArchCore.programFor(A, entry.funcX) : null;
            const recY = wasmEnabled ? ArchCore.programFor(A, entry.funcY) : null;
            return {
                cachedPoints: (entry.cachedPoints || []).map((p) => (p === null ? null : [p.x, p.y])),
                plottedPoints: toPlainPoints(A.plottedFunctionPoints),
                plotType: entry.plotType,
                usedWasm: wasmEnabled && !!recX && !!recY && recX.argNames.length === 1 && recY.argNames.length === 1,
                archX: entry.funcX && entry.funcX.archSource ? entry.funcX.archSource.body : null,
                archY: entry.funcY && entry.funcY.archSource ? entry.funcY.archSource.body : null,
            };
        }
        function compareCachedPoints(a, b, tol) {
            if (a.length !== b.length) return { ok: false, reason: `len ${a.length} vs ${b.length}` };
            let mismatches = 0;
            for (let i = 0; i < a.length; i++) {
                const av = a[i], bv = b[i];
                if (av === null || bv === null) { if (av !== bv) mismatches++; continue; }
                if (!TOL(av[0], bv[0], tol) || !TOL(av[1], bv[1], tol)) mismatches++;
            }
            return { ok: mismatches === 0, mismatches };
        }

        const PARAM_CASES = [
            ['int in y: x=cos(t),y=int(exp(-u^2),u,0,t)', (A) => A.addEntry('x=cos(t),y=int(exp(-u^2),u,0,t)')],
            ['int in x: x=int(cos(u),u,0,t),y=sin(t)', (A) => A.addEntry('x=int(cos(u),u,0,t),y=sin(t)')],
            ['sum in both: x=sum(cos(k*t),k,1,3),y=sum(sin(k*t),k,1,3)', (A) => A.addEntry('x=sum(cos(k*t),k,1,3),y=sum(sin(k*t),k,1,3)')],
            ['int with slider: x=cos(t),y=int(sin(u),u,0,a*t) a=1.3', (A) => { A.addEntry('a=1.3'); A.addEntry('x=cos(t),y=int(sin(u),u,0,a*t)'); }],
        ];
        const cases = [];
        for (const [name, setup] of PARAM_CASES) {
            const js = runParametricOnce(setup, false);
            const wasm = runParametricOnce(setup, true);
            const cc = compareCachedPoints(js.cachedPoints, wasm.cachedPoints, 1e-9);
            const pc = comparePoints(js.plottedPoints, wasm.plottedPoints, 1e-9);
            cases.push({ name, plotType: js.plotType, usedWasm: wasm.usedWasm, archX: wasm.archX, archY: wasm.archY, cachedLenJS: js.cachedPoints.length, cachedOk: cc.ok, cachedMismatch: cc.mismatches, plottedOk: pc.ok, plottedMismatch: pc.mismatches });
            await yieldNow();
        }
        for (const c of cases) {
            if (!c.usedWasm) allIssues.push(`parametric ${c.name}: wasm kernel did not activate`);
            if (!c.cachedOk) allIssues.push(`parametric ${c.name}: cachedPoints mismatch (${c.cachedMismatch})`);
            if (!c.plottedOk) allIssues.push(`parametric ${c.name}: plottedPoints mismatch (${c.plottedMismatch})`);
        }
        sections.parametric2d = cases;
    }

    // =====================================================================
    // Section C: implicit2d -- curves/inequalities with sum/prod, via
    // processImplicitBlocksOnGrid (mirrors wasm/tests/browser/implicit2d.js).
    // =====================================================================
    {
        const rect = A.canvas.getBoundingClientRect();
        const W = rect.width, H = rect.height;

        function snapshot() {
            return {
                implictjump: A.implictjump,
                plotdata: A.implictplotdata.map((seg) => seg.slice()),
                plotindex: A.implictplotindex.slice(),
                points: A.plottedFunctionPoints.map((p) => ({ x: p.x, y: p.y })),
                fillKeys: Array.from(A.implicitFillData.keys()),
                fill: new Map(Array.from(A.implicitFillData.entries()).map(([k, v]) => [k, v.slice()])),
            };
        }
        function compare(js, wasm) {
            const mismatches = [];
            if (js.implictjump !== wasm.implictjump) mismatches.push(`implictjump ${js.implictjump} vs ${wasm.implictjump}`);
            if (js.plotindex.length !== wasm.plotindex.length) mismatches.push(`plotindex length`);
            if (js.plotdata.length !== wasm.plotdata.length) {
                mismatches.push(`plotdata length ${js.plotdata.length} vs ${wasm.plotdata.length}`);
            } else {
                for (let i = 0; i < js.plotdata.length; i++) {
                    const a = js.plotdata[i], b = wasm.plotdata[i];
                    if (a[4] !== b[4]) { mismatches.push(`plotdata[${i}] funcIdx`); continue; }
                    for (let k = 0; k < 4; k++) if (!TOL(a[k], b[k])) mismatches.push(`plotdata[${i}][${k}] ${a[k]} vs ${b[k]}`);
                }
            }
            if (js.points.length !== wasm.points.length) {
                mismatches.push(`points length ${js.points.length} vs ${wasm.points.length}`);
            } else {
                for (let i = 0; i < js.points.length; i++) {
                    if (!TOL(js.points[i].x, wasm.points[i].x) || !TOL(js.points[i].y, wasm.points[i].y)) mismatches.push(`points[${i}]`);
                }
            }
            if (js.fillKeys.join(',') !== wasm.fillKeys.join(',')) mismatches.push(`fillKeys order`);
            const allKeys = new Set([...js.fillKeys, ...wasm.fillKeys]);
            for (const k of allKeys) {
                const a = js.fill.get(k) || [], b = wasm.fill.get(k) || [];
                if (a.length !== b.length) { mismatches.push(`fill[${k}] length ${a.length} vs ${b.length}`); continue; }
                for (let i = 0; i < a.length; i++) if (!TOL(a[i], b[i])) mismatches.push(`fill[${k}][${i}]`);
            }
            return mismatches;
        }
        function setup(exprs, opts) {
            A.clearAllEntries();
            A.is3DMode = false;
            A.scale = opts.scale ?? 100;
            A.offset = { x: W / 2, y: H / 2 };
            A.implicitPrecisionStep = opts.step ?? 5;
            A.originalImplicitPrecision = A.implicitPrecisionStep;
            A.autoBreakpointDetectionEnabled = opts.autoBreak !== undefined ? opts.autoBreak : true;
            for (const e of exprs) A.addEntry(e);
            if (opts.vars) for (const [k, v] of Object.entries(opts.vars)) A.variables.set(k, v);
        }
        function runOnce(wasmOn) {
            ArchCore.state.enabled = wasmOn;
            A.clearPlotData();
            A.processImplicitBlocksOnGrid(W, H);
            return snapshot();
        }
        // NOTE: sum/prod bounds below are deliberately perturbed off round
        // numbers (e.g. `-0.37`, `*1.7`) so the implicit-curve radius does
        // not land exactly on a grid line. `x^2+y^2=10` (and `=9`, `=36`, ...)
        // independently mismatch JS vs wasm even with NO large operator
        // involved (confirmed: `x^2+y^2=9` alone -> 480 vs 476 segments,
        // `x^2+y^2=10` alone -> hundreds of segment mismatches at cell 206,
        // identical to `x^2+y^2=sum(k,k,1,4)`'s mismatches) -- a pre-existing
        // marching-squares topology tie-break difference in the "implicit2d"
        // kernel (wasm/core/kernels/implicit2d.cpp) when a level value sits
        // exactly on a cell boundary, unrelated to this task; see caveats.
        const CASES = [
            ['circle with sum radius: x^2+y^2=sum(k,k,1,4)-0.37', ['x^2+y^2=sum(k,k,1,4)-0.37'], {}],
            ['inequality with sum: x^2+y^2>=sum(k,k,1,4)-0.37', ['x^2+y^2>=sum(k,k,1,4)-0.37'], {}],
            ['inequality <= with prod: x^2+y^2<=prod(1+1/k,k,1,5)*1.7', ['x^2+y^2<=prod(1+1/k,k,1,5)*1.7'], {}],
            ['sign > : x^2+y^2>sum(k,k,1,4)-0.37', ['x^2+y^2>sum(k,k,1,4)-0.37'], {}],
            ['sign < : x^2+y^2<sum(k,k,1,4)-0.37', ['x^2+y^2<sum(k,k,1,4)-0.37'], {}],
            ['sum mixed w/ x,y in body: sin(x)+sum(cos(k*y)/k,k,1,6)=0.2', ['sin(x)+sum(cos(k*y)/k,k,1,6)=0.2'], {}],
            ['slider bound: x^2+a*y^2=sum(k,k,1,a)+0.3', ['a=2.7'], {}],
            ['3 curves incl one large-op', ['x^2+y^2=8.7', 'y^2=x^3-x', 'x^2+y^2=sum(k,k,1,4)-0.37'], {}],
            ['x3d overlay with sum', ['x=sum(sin(k*y)/k,k,1,5)+0*z'], {}],
            ['y3d overlay with prod', ['y=prod(1+x/k,k,1,5)*0.2+0*z'], {}],
        ];
        const results = [];
        for (const [name, exprs, opts] of CASES) {
            const realExprs = name.startsWith('slider bound') ? ['a=2.7', 'x^2+a*y^2=sum(k,k,1,a)+0.3'] : exprs;
            setup(realExprs, opts);
            const js = runOnce(false);
            const funcEntries = A.entries.filter((e) => e.type === 'function');
            const recs = ArchCore.state.enabled === false ? null : null; // computed below after wasm run
            const wasm = runOnce(true);
            const wasmRecs = funcEntries.map((e) => !!ArchCore.programFor(A, e.func));
            const mismatches = compare(js, wasm);
            results.push({ name, mismatches, wasmEligible: wasmRecs });
            await yieldNow();
        }
        for (const r of results) {
            if (r.mismatches.length) allIssues.push(`implicit2d ${r.name}: ${r.mismatches.slice(0, 3).join('; ')}`);
        }
        sections.implicit2d = results;
    }

    // =====================================================================
    // Section D: 3D kernels (surface3d / mc3d / flat3d) share cache3D.lines
    // and cache3D.meshes, so one combined gl-capture snapshot (mirroring
    // wasm/tests/browser/flat3d.js) exercises all three for large-op entries.
    // =====================================================================
    {
        const gl = A.gl;
        const realBufferData = gl.bufferData.bind(gl);
        const realBindBuffer = gl.bindBuffer.bind(gl);
        let lastBoundBuffer = null;
        const bufferPayload = new WeakMap();
        gl.bindBuffer = function (target, buf) {
            if (target === gl.ARRAY_BUFFER) lastBoundBuffer = buf;
            return realBindBuffer(target, buf);
        };
        gl.bufferData = function (target, data, usage) {
            if (target === gl.ARRAY_BUFFER && lastBoundBuffer && data && ArrayBuffer.isView(data)) {
                bufferPayload.set(lastBoundBuffer, Array.from(data));
            }
            return realBufferData(target, data, usage);
        };

        function snapshot3D() {
            const lines = [];
            for (const [index, l] of A.cache3D.lines.entries()) {
                lines.push({ index, count: l.count, mode: l.mode === gl.TRIANGLES ? 'T' : 'L', thickness: l.thickness, isThick: l.isThick, verts: bufferPayload.get(l.vbo) || null });
            }
            const meshes = [];
            for (const [index, m] of A.cache3D.meshes.entries()) {
                meshes.push({ index, count: m.count, verts: bufferPayload.get(m.vbo) || null, norms: bufferPayload.get(m.nbo) || null });
            }
            return { lines, meshes };
        }
        function compareArr(a, b, tol, label, issues) {
            if (!a || !b || a.length !== b.length) { issues.push(`${label}: shape mismatch (a=${a && a.length} b=${b && b.length})`); return; }
            for (let i = 0; i < a.length; i++) if (!TOL(a[i], b[i], tol)) { issues.push(`${label}: value[${i}] js=${a[i]} wasm=${b[i]}`); return; }
        }
        function compareSnaps(js, wasm) {
            const issues = [];
            if (js.lines.length !== wasm.lines.length) issues.push(`line count ${js.lines.length} vs ${wasm.lines.length}`);
            else for (let i = 0; i < js.lines.length; i++) {
                const a = js.lines[i], b = wasm.lines[i];
                if (a.count !== b.count) { issues.push(`lines[${a.index}] count js=${a.count} wasm=${b.count}`); continue; }
                compareArr(a.verts, b.verts, 1e-6, `lines[${a.index}].verts`, issues);
            }
            if (js.meshes.length !== wasm.meshes.length) issues.push(`mesh count ${js.meshes.length} vs ${wasm.meshes.length}`);
            else for (let i = 0; i < js.meshes.length; i++) {
                const a = js.meshes[i], b = wasm.meshes[i];
                if (a.count !== b.count) { issues.push(`meshes[${a.index}] count js=${a.count} wasm=${b.count}`); continue; }
                compareArr(a.verts, b.verts, 1e-6, `meshes[${a.index}].verts`, issues);
                compareArr(a.norms, b.norms, 1e-6, `meshes[${a.index}].norms`, issues);
            }
            return issues;
        }
        function setup(exprs, opts) {
            A.clearAllEntries();
            A.is3DMode = true;
            A.offset3D = { x: 0, y: 0 };
            A.scale3D = 1.0;
            A.bounds3D = 8;
            A.explicitPrecisionStep = opts.step ?? 2;
            A.originalExplicitPrecision = A.explicitPrecisionStep;
            A.implicitPrecisionStep = opts.implicitStep ?? 8;
            A.originalImplicitPrecision = A.implicitPrecisionStep;
            A.autoBreakpointDetectionEnabled = opts.autoBreak !== undefined ? opts.autoBreak : true;
            A.overlayDrawingEnabled = true;
            for (const e of exprs) A.addEntry(e);
            if (opts.extend3D) for (const i of opts.extend3D) A.entries.filter((e) => e.type === 'function')[i].extendTo3D = true;
            if (opts.slice) {
                const fns = A.entries.filter((e) => e.type === 'function');
                for (const s of opts.slice) { fns[s.index].sliceAxis = s.axis; fns[s.index].sliceVal = s.val; }
            }
            if (opts.vars) for (const [k, v] of Object.entries(opts.vars)) A.variables.set(k, v);
        }
        function runCase(exprs, opts) {
            setup(exprs, opts);
            const funcEntries = A.entries.filter((e) => e.type === 'function');
            ArchCore.state.enabled = false;
            A.recalculate3D();
            const js = snapshot3D();
            ArchCore.state.enabled = true;
            A.recalculate3D();
            const wasm = snapshot3D();
            const wasmEligible = funcEntries.map((e) => {
                const key = e.plotType === 'parametric' || e.plotType === 'parametric3d' ? 'funcX' : 'func';
                return !!ArchCore.programFor(A, e[key]);
            });
            return { issues: compareSnaps(js, wasm), wasmEligible, jsLineCount: js.lines.reduce((s, l) => s + l.count, 0), wasmLineCount: wasm.lines.reduce((s, l) => s + l.count, 0), jsMeshCount: js.meshes.reduce((s, m) => s + m.count, 0), wasmMeshCount: wasm.meshes.reduce((s, m) => s + m.count, 0) };
        }

        const CASES = [
            ['surface3d z=sum(...)', ['z=sum(sin(k*x)/k,k,1,10)+cos(y)'], {}],
            ['surface3d z=prod(...)', ['z=prod(1+x*y/(k*20),k,1,5)'], {}],
            ['surface3d x3d with sum', ['x=sum(cos(k*y)/k,k,1,4)+0*z'], {}],
            ['mc3d implicit3d sphere w/ sum radius', ['x^2+y^2+z^2=sum(k,k,1,4)'], {}],
            ['mc3d implicit3d w/ int', ['x^2+y^2+z^2=int(t,t,0,3.16)'], { implicitStep: 12 }],
            ['mc3d extrusion (implicit extendTo3D) w/ sum', ['x^2+y^2=sum(k,k,1,4)'], { extend3D: [0] }],
            ['flat3d slice z=sum(...) axis=z', ['z=sum(sin(k*x)/k,k,1,10)+cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0 }] }],
            ['flat3d slice implicit3d sum axis=x', ['x^2+y^2+z^2=sum(k,k,1,4)'], { slice: [{ index: 0, axis: 'x', val: 0 }] }],
            ['flat3d flat implicit overlay w/ sum', ['x^2+y^2=sum(k,k,1,4)'], {}],
            ['surface3d ribbon y=sum(...) extendTo3D', ['y=sum(sin(k*x)/k,k,1,10)'], { extend3D: [0] }],
            ['flat3d curves3d plain y=int(...)', ['y=int(exp(-t^2),t,0,x)'], {}],
            ['flat3d curves3d parametric w/ int', ['x=cos(t),y=int(exp(-u^2),u,0,t)'], {}],
            ['flat3d curves3d parametric3d w/ sum', ['x=cos(t),y=sin(t),z=sum(cos(k*t),k,1,3)/3'], {}],
            ['slider in 3D sum: z=a*sum(sin(k*x),k,1,4) a=0.3', ['a=0.3', 'z=a*sum(sin(k*x),k,1,4)'], {}],
        ];
        const results = [];
        for (const [name, exprs, opts] of CASES) {
            let r;
            try { r = runCase(exprs, opts); } catch (e) { r = { issues: [String((e && e.stack) || e)], wasmEligible: [] }; }
            results.push({ name, ...r });
            await yieldNow();
        }
        gl.bufferData = realBufferData;
        gl.bindBuffer = realBindBuffer;
        for (const r of results) {
            if (r.issues.length) allIssues.push(`3d ${r.name}: ${r.issues.slice(0, 3).join('; ')}`);
            if (r.wasmEligible.length && !r.wasmEligible.every(Boolean)) allIssues.push(`3d ${r.name}: not all entries wasm-eligible (${JSON.stringify(r.wasmEligible)})`);
        }
        sections.threeD = results;
        // This section's cases all set is3DMode=true; restore 2D mode so it
        // does not leak into the sections below (programFor/draw() behave
        // very differently in 3D mode).
        A.is3DMode = false;
    }

    // =====================================================================
    // Section E: explicit programFor() eligibility spot-check across every
    // plot type (2D and 3D) mentioned in the task.
    // =====================================================================
    {
        function checkEligible(name, addFn, key) {
            A.clearAllEntries();
            A.is3DMode = false;
            addFn(A);
            const entry = A.entries.find((e) => e.type === 'function');
            ArchCore.state.enabled = true;
            const rec = ArchCore.programFor(A, entry[key || 'func']);
            return { name, eligible: !!rec, body: entry[key || 'func'] && entry[key || 'func'].archSource ? entry[key || 'func'].archSource.body : null };
        }
        const checks = [
            checkEligible('y=sum(...)', (A) => A.addEntry('y=sum(sin(k*x)/k,k,1,25)')),
            checkEligible('x=int(...)', (A) => A.addEntry('x=int(sin(u),u,0,y)')),
            checkEligible('implicit x^2+y^2=sum(...)', (A) => A.addEntry('x^2+y^2=sum(k,k,1,4)')),
            checkEligible('z=sum(...) surface', (A) => A.addEntry('z=sum(sin(k*x)/k,k,1,10)+cos(y)')),
            checkEligible('implicit3d w/ sum', (A) => A.addEntry('x^2+y^2+z^2=sum(k,k,1,4)')),
            checkEligible('parametric funcX w/ int', (A) => A.addEntry('x=int(cos(u),u,0,t),y=sin(t)'), 'funcX'),
            checkEligible('parametric funcY w/ int', (A) => A.addEntry('x=cos(t),y=int(exp(-u^2),u,0,t)'), 'funcY'),
        ];
        for (const c of checks) if (!c.eligible) allIssues.push(`programFor eligibility: ${c.name} -> null (body=${c.body})`);
        sections.eligibility = checks;
    }

    // =====================================================================
    // Section F: benchmarks -- interleaved medians, JS vs wasm.
    // =====================================================================
    const benchmarks = [];
    {
        function benchOnce(setup, flags, wasmEnabled) {
            A.clearAllEntries();
            A.is3DMode = false;
            setup(A);
            A.adaptivePlottingEnabled = !!flags.adaptive;
            A.autoBreakpointDetectionEnabled = !!flags.autoBreak;
            A.adaptiveExtendEnabled = !!flags.adaptiveExtend;
            A.highPerformancePlottingEnabled = !!flags.thin;
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
            return { name, jsMedianMs: +median(js).toFixed(3), wasmMedianMs: +median(wasm).toFixed(3), reps, speedup: +(median(js) / Math.max(median(wasm), 1e-6)).toFixed(2) };
        }
        benchmarks.push(await benchmarkCase('y=int(exp(-t^2),t,0,x) adaptive+extend',
            (A) => A.addEntry('y=int(exp(-t^2),t,0,x)'),
            { adaptive: true, adaptiveExtend: true, thin: false }, 9));
        benchmarks.push(await benchmarkCase('y=sum(sin(k*x)/k,k,1,25) naive thin',
            (A) => A.addEntry('y=sum(sin(k*x)/k,k,1,25)'),
            { adaptive: false, autoBreak: false, thin: true }, 9));
        benchmarks.push(await benchmarkCase('y=prod(1+x/k,k,1,10) autoBreak thick',
            (A) => A.addEntry('y=prod(1+x/k,k,1,10)'),
            { adaptive: false, autoBreak: true, thin: false }, 9));
    }
    {
        // 3D benchmark: implicit3d marching cubes with a sum-based level, at
        // a moderately high resolution (kept below the JS path's multi-second
        // cost per KERNEL_GUIDE.md, since only medians of the wasm side would
        // otherwise be practical within the CDP per-step budget).
        function bench3DOnce(setup, wasmEnabled) {
            A.clearAllEntries();
            A.is3DMode = true;
            A.offset3D = { x: 0, y: 0 };
            A.scale3D = 1.0;
            A.bounds3D = 8;
            A.implicitPrecisionStep = 6;
            A.originalImplicitPrecision = 6;
            setup(A);
            ArchCore.state.enabled = wasmEnabled;
            const t0 = performance.now();
            A.recalculate3D();
            return performance.now() - t0;
        }
        function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
        const js = [], wasm = [];
        for (let i = 0; i < 5; i++) {
            js.push(bench3DOnce((A) => A.addEntry('x^2+y^2+z^2=sum(k,k,1,4)'), false));
            wasm.push(bench3DOnce((A) => A.addEntry('x^2+y^2+z^2=sum(k,k,1,4)'), true));
            await yieldNow();
        }
        benchmarks.push({ name: 'implicit3d x^2+y^2+z^2=sum(k,k,1,4) mc3d step=6', jsMedianMs: +median(js).toFixed(3), wasmMedianMs: +median(wasm).toFixed(3), reps: 5, speedup: +(median(js) / Math.max(median(wasm), 1e-6)).toFixed(2) });
    }

    return {
        issueCount: allIssues.length,
        issues: allIssues.slice(0, 60),
        sectionCounts: {
            explicit2d: sections.explicit2d ? sections.explicit2d.total : 0,
            explicit2dUsedWasm: sections.explicit2d ? sections.explicit2d.usedWasmCount : 0,
            // Sanity signal against vacuous (both-sides-empty) passes: how
            // many explicit2d cases actually produced non-empty JS output.
            explicit2dNonEmptyJS: sections.explicit2d ? sections.explicit2d.byExpr.filter((c) => c.vertsLenJS > 0).length : 0,
            parametric2d: sections.parametric2d ? sections.parametric2d.length : 0,
            parametric2dNonEmptyJS: sections.parametric2d ? sections.parametric2d.filter((c) => c.cachedLenJS > 0).length : 0,
            implicit2d: sections.implicit2d ? sections.implicit2d.length : 0,
            threeD: sections.threeD ? sections.threeD.length : 0,
            threeDNonEmptyJS: sections.threeD ? sections.threeD.filter((r) => (r.jsLineCount || 0) + (r.jsMeshCount || 0) > 0).length : 0,
            eligibility: sections.eligibility ? sections.eligibility.length : 0,
        },
        eligibility: sections.eligibility,
        implicit2d: sections.implicit2d,
        threeD: sections.threeD,
        benchmarks,
    };
})()
