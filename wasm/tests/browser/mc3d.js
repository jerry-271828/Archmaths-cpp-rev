// Differential correctness + benchmark test for the "mc3d" ArchCore kernel:
// recalculate3D()'s two marching-cubes volumetric mesh blocks -- the true
// implicit3d surface (plotType==='implicit3d') and the implicit-curve
// extruded-to-3D "wall" (is2D && entry.extendTo3D && plotType==='implicit').
//
// Correctness: monkeypatches gl.bufferData (keyed by the bound WebGLBuffer,
// via gl.bindBuffer) to capture the Float32Array payload uploaded for each
// vbo/nbo, runs recalculate3D() once with ArchCore.state.enabled=false (JS
// path) and once with =true (wasm path) from identical engine state, and
// compares cache3D.meshes: mesh count, per-entry vertex count, color, and
// every vertex/normal component (relative tolerance, NaN-aware).
//
// Benchmark: interleaved-ish (JS block then wasm block) median-of-N timing
// of recalculate3D() for sphere/gyroid/extrusion cases at several
// implicitPrecisionStep values. The JS path at mcRes160 is >3s/call (see
// KERNEL_GUIDE.md baselines) so that size only times the wasm path, to stay
// well under the ~5s single-step budget enforced by the CDP bridge.
//
// Run with `node cdp.js run <tab> @wasm/tests/browser/mc3d.js <maxWaitMs>`.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    if (typeof ArchCore === 'undefined') return { error: 'no ArchCore' };
    await new Promise((r) => ArchCore.onReady(r));

    // ---- shared gl.bufferData capture harness -----------------------------
    const gl = A.gl;
    const realBufferData = gl.bufferData.bind(gl);
    const realBindBuffer = gl.bindBuffer.bind(gl);
    let captureOn = false;
    let lastBoundBuffer = null;
    const bufferPayload = new WeakMap();
    gl.bindBuffer = function (target, buf) {
        if (target === gl.ARRAY_BUFFER) lastBoundBuffer = buf;
        return realBindBuffer(target, buf);
    };
    gl.bufferData = function (target, data, usage) {
        if (captureOn && target === gl.ARRAY_BUFFER && lastBoundBuffer && data && data.buffer instanceof ArrayBuffer) {
            bufferPayload.set(lastBoundBuffer, Array.from(data));
        }
        return realBufferData(target, data, usage);
    };
    function restoreGl() { gl.bufferData = realBufferData; gl.bindBuffer = realBindBuffer; }

    function snapshotMeshes() {
        const out = [];
        for (const [index, mesh] of A.cache3D.meshes.entries()) {
            out.push({
                index, count: mesh.count,
                color: mesh.color ? { h: mesh.color.h, s: mesh.color.s, b: mesh.color.b, a: mesh.color.a } : null,
                vbo: bufferPayload.get(mesh.vbo) || null,
                nbo: bufferPayload.get(mesh.nbo) || null,
            });
        }
        return out;
    }

    function almostEqual(a, b, tol) {
        if (Number.isNaN(a) && Number.isNaN(b)) return true;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    }

    function compareMeshList(jsList, wasmList, label, results) {
        if (jsList.length !== wasmList.length) {
            results.push(`${label}: mesh count mismatch js=${jsList.length} wasm=${wasmList.length}`);
            return;
        }
        for (let i = 0; i < jsList.length; i++) {
            const a = jsList[i], b = wasmList[i];
            if (a.index !== b.index) { results.push(`${label}[${i}]: index mismatch ${a.index} vs ${b.index}`); continue; }
            if (a.count !== b.count) { results.push(`${label} entry${a.index}: vertex count mismatch js=${a.count} wasm=${b.count}`); continue; }
            if (JSON.stringify(a.color) !== JSON.stringify(b.color)) {
                results.push(`${label} entry${a.index}: color mismatch ${JSON.stringify(a.color)} vs ${JSON.stringify(b.color)}`);
            }
            if (!a.vbo || !b.vbo || a.vbo.length !== b.vbo.length) {
                results.push(`${label} entry${a.index}: vbo shape mismatch (js=${a.vbo && a.vbo.length} wasm=${b.vbo && b.vbo.length})`);
                continue;
            }
            for (let k = 0; k < a.vbo.length; k++) {
                if (!almostEqual(a.vbo[k], b.vbo[k], 1e-5)) {
                    results.push(`${label} entry${a.index}: vertex[${k}] js=${a.vbo[k]} wasm=${b.vbo[k]}`);
                    break;
                }
            }
            if (a.nbo && b.nbo) {
                if (a.nbo.length !== b.nbo.length) { results.push(`${label} entry${a.index}: nbo length mismatch`); continue; }
                for (let k = 0; k < a.nbo.length; k++) {
                    if (!almostEqual(a.nbo[k], b.nbo[k], 1e-4)) {
                        results.push(`${label} entry${a.index}: normal[${k}] js=${a.nbo[k]} wasm=${b.nbo[k]}`);
                        break;
                    }
                }
            }
        }
    }

    async function diffImplicit3d(name, exprs, step, varsObj) {
        A.clearAllEntries();
        A.is3DMode = true;
        for (const e of exprs) A.addEntry(e);
        if (varsObj) for (const k in varsObj) A.variables.set(k, varsObj[k]);
        A.recalculateAll();
        A.implicitPrecisionStep = step;
        A.originalImplicitPrecision = step;
        await yieldNow();

        ArchCore.state.enabled = false; captureOn = true;
        A.recalculate3D();
        const jsList = snapshotMeshes();
        captureOn = false; await yieldNow();

        ArchCore.state.enabled = true; captureOn = true;
        A.recalculate3D();
        const wasmList = snapshotMeshes();
        captureOn = false; await yieldNow();

        const mismatches = [];
        compareMeshList(jsList, wasmList, name, mismatches);
        if (varsObj) for (const k in varsObj) A.variables.delete(k);
        return { name, step, jsCounts: jsList.map(m => m.count), wasmCounts: wasmList.map(m => m.count), mismatches };
    }

    async function diffExtrusion(name, expr, step) {
        A.clearAllEntries();
        A.is3DMode = false;
        A.addEntry(expr);
        A.recalculateAll();
        for (const entry of A.entries) if (entry.type === 'function' && entry.plotType === 'implicit') entry.extendTo3D = true;
        A.is3DMode = true;
        A.implicitPrecisionStep = step;
        A.originalImplicitPrecision = step;
        A.recalculateAll();
        await yieldNow();

        ArchCore.state.enabled = false; captureOn = true;
        A.recalculate3D();
        const jsList = snapshotMeshes();
        captureOn = false; await yieldNow();

        ArchCore.state.enabled = true; captureOn = true;
        A.recalculate3D();
        const wasmList = snapshotMeshes();
        captureOn = false; await yieldNow();

        const mismatches = [];
        compareMeshList(jsList, wasmList, name, mismatches);
        return { name, step, jsCounts: jsList.map(m => m.count), wasmCounts: wasmList.map(m => m.count), mismatches };
    }

    const correctness = { caseResults: [] };
    const implicit3dCases = [
        ['sphere x^2+y^2+z^2=4, step5 (mcRes40)', ['x^2+y^2+z^2=4'], 5],
        ['sphere x^2+y^2+z^2=4, step2.5 (mcRes80)', ['x^2+y^2+z^2=4'], 2.5],
        ['torus (x^2+y^2+z^2+9-1)^2=36(x^2+y^2), step5', ['(x^2+y^2+z^2+9-1)^2=36*(x^2+y^2)'], 5],
        ['gyroid sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0, step5', ['sin(x)*cos(y)+sin(y)*cos(z)+sin(z)*cos(x)=0'], 5],
        ['NaN-region sqrt(x)+y^2+z^2=4, step5', ['sqrt(x)+y^2+z^2=4'], 5],
        ['fractional-power-of-negative x^(2/3)+y^2+z^2=4, step5', ['x^(2/3)+y^2+z^2=4'], 5],
        ['negative-base odd-root x^(1/3)+y^2+z^2=1, step5', ['x^(1/3)+y^2+z^2=1'], 5],
        ['sphere step10 (mcRes20, coarse)', ['x^2+y^2+z^2=4'], 10],
        ['ellipsoid-ish x^2+2*y^2+0.5*z^2=4, step4', ['x^2+2*y^2+0.5*z^2=4'], 4],
        ['pole 1/x+y^2+z^2=4', ['1/x+y^2+z^2=4'], 5],
        ['pole tan(x)+y^2+z^2=4', ['tan(x)+y^2+z^2=4'], 5],
        ['two entries at once', ['x^2+y^2+z^2=4', 'x^2+y^2+z^2=1'], 6],
        ['sphere step 3.7 (odd, mcRes~54)', ['x^2+y^2+z^2=4'], 3.7],
        ['sphere step 1.5 (near mcRes133)', ['x^2+y^2+z^2=4'], 1.5],
    ];
    for (const [name, exprs, step] of implicit3dCases) {
        correctness.caseResults.push(await diffImplicit3d(name, exprs, step));
        await yieldNow();
    }
    correctness.caseResults.push(await diffImplicit3d('slider a*x^2+y^2+z^2=4 (a=1.7)', ['a*x^2+y^2+z^2=4'], 5, { a: 1.7 }));
    await yieldNow();
    correctness.caseResults.push(await diffImplicit3d('slider a*x^2+y^2+z^2=4 (a=0.3)', ['a*x^2+y^2+z^2=4'], 5, { a: 0.3 }));
    await yieldNow();

    const extrusionCases = [
        ['extrusion circle x^2+y^2=4, step5', 'x^2+y^2=4', 5],
        ['extrusion x^2+y^2<=4 (fill-style relational)', 'x^2+y^2<=4', 5],
        ['extrusion x^2+y^2>1 (fill relational, outer)', 'x^2+y^2>1', 5],
        ['extrusion step2.5 (finer)', 'x^2+y^2=4', 2.5],
        ['extrusion step 3.3 (odd)', 'x^2+y^2=4', 3.3],
        ['extrusion elliptic curve y^2=x^3-x', 'y^2=x^3-x', 5],
        ['extrusion sin(x*y)=0.3', 'sin(x*y)=0.3', 5],
    ];
    for (const [name, expr, step] of extrusionCases) {
        correctness.caseResults.push(await diffExtrusion(name, expr, step));
        await yieldNow();
    }

    correctness.totalMismatches = correctness.caseResults.reduce((s, c) => s + c.mismatches.length, 0);
    correctness.summary = correctness.caseResults.map(c =>
        `${c.name}: js=${JSON.stringify(c.jsCounts)} wasm=${JSON.stringify(c.wasmCounts)} mism=${c.mismatches.length}` +
        (c.mismatches.length ? ' :: ' + c.mismatches.slice(0, 3).join(' | ') : ''));

    restoreGl();

    // ---- benchmark ---------------------------------------------------------
    const setupImplicit3d = (exprs, step) => {
        A.clearAllEntries();
        A.is3DMode = true;
        for (const e of exprs) A.addEntry(e);
        A.recalculateAll();
        A.implicitPrecisionStep = step;
        A.originalImplicitPrecision = step;
    };
    const setupExtrusion = (expr, step) => {
        A.clearAllEntries();
        A.is3DMode = false;
        A.addEntry(expr);
        A.recalculateAll();
        for (const entry of A.entries) if (entry.type === 'function' && entry.plotType === 'implicit') entry.extendTo3D = true;
        A.is3DMode = true;
        A.implicitPrecisionStep = step;
        A.originalImplicitPrecision = step;
        A.recalculateAll();
    };

    async function medianTimed(fn, runs) {
        const ts = [];
        for (let i = 0; i < runs; i++) {
            const t0 = performance.now();
            fn();
            ts.push(performance.now() - t0);
            await yieldNow();
        }
        ts.sort((a, b) => a - b);
        return { median: +ts[Math.floor(ts.length / 2)].toFixed(1), all: ts.map(x => +x.toFixed(1)) };
    }
    async function benchBoth(name, setupFn, runs) {
        setupFn();
        await yieldNow();
        ArchCore.state.enabled = false;
        const js = await medianTimed(() => A.recalculate3D(), runs);
        await yieldNow();
        ArchCore.state.enabled = true;
        const wasm = await medianTimed(() => A.recalculate3D(), runs);
        await yieldNow();
        return { name, jsMs: js.median, wasmMs: wasm.median, ratio: +(js.median / wasm.median).toFixed(2) };
    }
    async function benchWasmOnly(name, setupFn, runs, note) {
        setupFn();
        await yieldNow();
        ArchCore.state.enabled = true;
        const wasm = await medianTimed(() => A.recalculate3D(), runs);
        await yieldNow();
        return { name, jsMs: null, wasmMs: wasm.median, note };
    }

    const benchmarks = [];
    benchmarks.push(await benchBoth('implicit3d sphere mcRes40 (step5)', () => setupImplicit3d(['x^2+y^2+z^2=4'], 5), 7));
    benchmarks.push(await benchBoth('implicit3d sphere mcRes80 (step2.5)', () => setupImplicit3d(['x^2+y^2+z^2=4'], 2.5), 7));
    benchmarks.push(await benchBoth('implicit3d gyroid mcRes40 (step5)', () => setupImplicit3d(['sin(x)*cos(y)+sin(y)*cos(z)+sin(z)*cos(x)=0'], 5), 5));
    benchmarks.push(await benchWasmOnly('implicit3d sphere mcRes160 (step1.25)', () => setupImplicit3d(['x^2+y^2+z^2=4'], 1.25), 7,
        'JS path skipped: baseline ~3.3s/call at this size (KERNEL_GUIDE.md), too close to the 5s CDP step budget'));
    benchmarks.push(await benchBoth('extrusion circle mcRes40 (step5)', () => setupExtrusion('x^2+y^2=4', 5), 7));
    benchmarks.push(await benchBoth('extrusion sin(xy)=0.3 mcRes40 (step5, dense)', () => setupExtrusion('sin(x*y)=0.3', 5), 5));

    A.is3DMode = false;
    A.clearAllEntries();
    ArchCore.state.enabled = true;

    return { correctness, benchmarks };
})()
