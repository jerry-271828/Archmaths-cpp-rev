// Differential correctness + benchmark test for the ArchCore "flat3d" kernel:
// recalculate3D()'s sliceAxis marching-squares outline (ac_flat3d_slice_run),
// the flat 2D-implicit-at-z=0 overlay (ac_flat3d_implicit_run), and the
// parametric/parametric3d + plain x/y curve-at-z=0 line blocks
// (ac_flat3d_parametric_run / ac_flat3d_xy_run).
//
// Correctness: monkeypatches gl.bindBuffer/bufferData to capture the
// Float32Array payload uploaded for each vbo/nbo, runs recalculate3D() once
// with ArchCore.state.enabled=false (JS path) and once with =true (wasm
// path) from identical engine state, and compares cache3D.lines AND
// cache3D.meshes: entry count, per-entry vertex count, mode/thickness/
// isThick, color, and every vertex/normal component (relative tolerance,
// NaN-aware).
//
// Run with `node cdp.js run <tab> @wasm/tests/browser/flat3d.js <maxWaitMs>`.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    if (typeof ArchCore === 'undefined') return { error: 'no ArchCore' };
    await new Promise((r) => ArchCore.onReady(r));

    // ---- shared gl.bufferData capture harness ------------------------------
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

    function snapshot() {
        const lines = [];
        for (const [index, l] of A.cache3D.lines.entries()) {
            lines.push({
                index, count: l.count,
                mode: l.mode === gl.TRIANGLES ? 'TRIANGLES' : (l.mode === gl.LINES ? 'LINES' : l.mode),
                thickness: l.thickness, isThick: l.isThick,
                color: l.color ? { h: l.color.h, s: l.color.s, b: l.color.b, a: l.color.a } : null,
                verts: bufferPayload.get(l.vbo) || null,
            });
        }
        const meshes = [];
        for (const [index, m] of A.cache3D.meshes.entries()) {
            meshes.push({
                index, count: m.count,
                color: m.color ? { h: m.color.h, s: m.color.s, b: m.color.b, a: m.color.a } : null,
                verts: bufferPayload.get(m.vbo) || null,
                norms: bufferPayload.get(m.nbo) || null,
            });
        }
        return { lines, meshes };
    }

    function almostEqual(a, b, tol) {
        if (Number.isNaN(a) && Number.isNaN(b)) return true;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    }

    function compareArray(a, b, tol, label, issues) {
        if (!a || !b || a.length !== b.length) {
            issues.push(`${label}: shape mismatch (a=${a && a.length} b=${b && b.length})`);
            return;
        }
        for (let i = 0; i < a.length; i++) {
            if (!almostEqual(a[i], b[i], tol)) {
                issues.push(`${label}: value[${i}] js=${a[i]} wasm=${b[i]}`);
                return;
            }
        }
    }

    function compareSnaps(js, wasm) {
        const issues = [];
        if (js.lines.length !== wasm.lines.length) {
            issues.push(`line entry count differs: js=${js.lines.length} wasm=${wasm.lines.length}`);
        } else {
            for (let i = 0; i < js.lines.length; i++) {
                const a = js.lines[i], b = wasm.lines[i];
                const label = `lines[idx=${a.index}]`;
                if (a.index !== b.index) { issues.push(`${label}: index mismatch vs ${b.index}`); continue; }
                if (a.count !== b.count) { issues.push(`${label}: count js=${a.count} wasm=${b.count}`); continue; }
                if (a.mode !== b.mode || a.isThick !== b.isThick) issues.push(`${label}: mode/isThick mismatch js=${a.mode}/${a.isThick} wasm=${b.mode}/${b.isThick}`);
                if (a.thickness !== b.thickness) issues.push(`${label}: thickness js=${a.thickness} wasm=${b.thickness}`);
                if (JSON.stringify(a.color) !== JSON.stringify(b.color)) issues.push(`${label}: color mismatch`);
                compareArray(a.verts, b.verts, 1e-9, `${label}.verts`, issues);
            }
        }
        if (js.meshes.length !== wasm.meshes.length) {
            issues.push(`mesh entry count differs: js=${js.meshes.length} wasm=${wasm.meshes.length}`);
        } else {
            for (let i = 0; i < js.meshes.length; i++) {
                const a = js.meshes[i], b = wasm.meshes[i];
                const label = `meshes[idx=${a.index}]`;
                if (a.index !== b.index) { issues.push(`${label}: index mismatch vs ${b.index}`); continue; }
                if (a.count !== b.count) { issues.push(`${label}: count js=${a.count} wasm=${b.count}`); continue; }
                if (JSON.stringify(a.color) !== JSON.stringify(b.color)) issues.push(`${label}: color mismatch`);
                compareArray(a.verts, b.verts, 1e-9, `${label}.verts`, issues);
                compareArray(a.norms, b.norms, 1e-9, `${label}.norms`, issues);
            }
        }
        return issues;
    }

    // ---- saved state / setup helper ----------------------------------------
    const saved = {
        step: A.explicitPrecisionStep, origStep: A.originalExplicitPrecision,
        implicitStep: A.implicitPrecisionStep, autoBreak: A.autoBreakpointDetectionEnabled,
        is3D: A.is3DMode, offset: { x: A.offset3D.x, y: A.offset3D.y }, scale: A.scale3D,
        bounds: A.bounds3D, overlay: A.overlayDrawingEnabled, hpp: A.highPerformancePlottingEnabled,
        tmin: A.tmin, tmax: A.tmax,
    };

    function setup(exprs, opts) {
        A.clearAllEntries();
        A.is3DMode = true;
        A.offset3D = { x: opts.offset ? opts.offset[0] : 0, y: opts.offset ? opts.offset[1] : 0 };
        A.scale3D = opts.scale ?? 1.0;
        A.bounds3D = opts.bounds ?? 8;
        A.explicitPrecisionStep = opts.step ?? 2;
        A.originalExplicitPrecision = A.explicitPrecisionStep;
        A.implicitPrecisionStep = opts.implicitStep ?? 5;
        A.autoBreakpointDetectionEnabled = opts.autoBreak !== undefined ? opts.autoBreak : true;
        A.overlayDrawingEnabled = opts.overlay !== undefined ? opts.overlay : true;
        A.highPerformancePlottingEnabled = !!opts.hpp;
        if (opts.tmin !== undefined) A.tmin = opts.tmin;
        if (opts.tmax !== undefined) A.tmax = opts.tmax;
        for (const e of exprs) A.addEntry(e);
        if (opts.thickness !== undefined) {
            for (const e of A.entries) e.thickness = opts.thickness;
        }
        if (opts.slice) {
            // opts.slice: [{index, axis, val}, ...]; index counts function
            // entries only (a slider expression also adds a variable entry).
            const fns = A.entries.filter((e) => e.type === 'function');
            for (const s of opts.slice) {
                fns[s.index].sliceAxis = s.axis;
                fns[s.index].sliceVal = s.val;
            }
        }
        if (opts.vars) {
            for (const [k, v] of Object.entries(opts.vars)) A.variables.set(k, v);
        }
    }

    function runCase(exprs, opts) {
        setup(exprs, opts);
        ArchCore.state.enabled = false;
        A.recalculate3D();
        const js = snapshot();
        ArchCore.state.enabled = true;
        A.recalculate3D();
        const wasm = snapshot();
        const issues = compareSnaps(js, wasm);
        return {
            issues,
            jsLineCount: js.lines.reduce((s, l) => s + l.count, 0),
            wasmLineCount: wasm.lines.reduce((s, l) => s + l.count, 0),
            jsMeshCount: js.meshes.reduce((s, m) => s + m.count, 0),
            wasmMeshCount: wasm.meshes.reduce((s, m) => s + m.count, 0),
        };
    }

    const results = {};
    const cases = [
        // --- sliceAxis: slices through 3D fields ---
        ['slice z=sin(x)*cos(y) axis=z val=0', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0 }] }],
        ['slice z=sin(x)*cos(y) axis=x val=1.5', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'x', val: 1.5 }] }],
        ['slice z=sin(x)*cos(y) axis=y val=-2', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'y', val: -2 }] }],
        ['slice implicit3d sphere axis=z val=1 thin', ['x^2+y^2+z^2=4'], { slice: [{ index: 0, axis: 'z', val: 1 }], thickness: 1 }],
        ['slice implicit3d sphere axis=x val=0 thick', ['x^2+y^2+z^2=4'], { slice: [{ index: 0, axis: 'x', val: 0 }], thickness: 5 }],
        ['slice x3d: x=y*z axis=y val=0.5', ['x=y*z'], { slice: [{ index: 0, axis: 'y', val: 0.5 }] }],
        ['slice y3d: y=x*z axis=z val=1', ['y=x*z'], { slice: [{ index: 0, axis: 'z', val: 1 }] }],
        ['slice with offset/scale', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0.3 }], offset: [1.2, -0.7], scale: 1.5 }],
        ['slice slider z=a*x^2+y^2 a=2', ['z=a*x^2+y^2'], { slice: [{ index: 0, axis: 'z', val: 2 }], vars: { a: 2 } }],
        ['slice discontinuous z=1/(x*y) axis=z val=0.2', ['z=1/(x*y)'], { slice: [{ index: 0, axis: 'z', val: 0.2 }] }],

        // --- flat implicit overlay (2D implicit/inequality shown in 3D) ---
        ['flat implicit = circle', ['x^2+y^2=4'], {}],
        ['flat implicit > (fill) x^2+y^2>4', ['x^2+y^2>4'], {}],
        ['flat implicit >= x^2+y^2>=4', ['x^2+y^2>=4'], {}],
        ['flat implicit < x^2+y^2<4', ['x^2+y^2<4'], {}],
        ['flat implicit <= x^2+y^2<=4', ['x^2+y^2<=4'], {}],
        ['flat implicit y=x^2 (as implicit residual? actually y=)', ['y-x^2=0'], {}],
        ['flat implicit thin lines', ['x^2+y^2=4'], { thickness: 1 }],
        ['flat implicit thick lines', ['x^2+y^2=4'], { thickness: 6 }],
        ['flat implicit autoBreak off', ['x^2+y^2=4'], { autoBreak: false }],
        ['flat implicit sin(x*y)=0.5 (many components)', ['sin(x*y)=0.5'], {}],
        ['flat implicit slider a*x^2+y^2=4 a=0.5', ['a*x^2+y^2=4'], { vars: { a: 0.5 } }],
        ['flat implicit offset/scale', ['x^2+y^2=4'], { offset: [0.6, -0.4], scale: 1.3 }],
        ['flat implicit high precision', ['x^2+y^2=4'], { implicitStep: 20 }],

        // --- parametric curves (2D and 3D) ---
        ['parametric circle x=cos(t),y=sin(t)', ['x=cos(t),y=sin(t)'], {}],
        ['parametric helix x=cos(t),y=sin(t),z=t/5', ['x=cos(t),y=sin(t),z=t/5'], {}],
        ['parametric3d thin', ['x=cos(t),y=sin(t),z=t/5'], { thickness: 1 }],
        ['parametric3d thick', ['x=cos(t),y=sin(t),z=t/5'], { thickness: 6 }],
        ['parametric with out-of-range breaks: x=t,y=1/sin(t)', ['x=t,y=1/sin(t)'], { tmin: -10, tmax: 10 }],
        ['parametric3d discontinuous x=t,y=t,z=1/t', ['x=t,y=t,z=1/t'], { tmin: -5, tmax: 5 }],
        ['parametric slider x=a*cos(t),y=sin(t) a=2', ['x=a*cos(t),y=sin(t)'], { vars: { a: 2 } }],
        ['parametric offset/scale', ['x=cos(t),y=sin(t)'], { offset: [0.5, -0.3], scale: 1.4 }],

        // --- plain y=f(x) / x=f(y) curves shown flat in 3D ---
        ['plain y=sin(x)', ['y=sin(x)'], {}],
        ['plain x=cos(y)', ['x=cos(y)'], {}],
        ['plain y=1/x (discontinuity)', ['y=1/x'], {}],
        ['plain y=sqrt(x) (NaN half)', ['y=sqrt(x)'], {}],
        ['plain y=tan(x) (many discontinuities)', ['y=tan(x)'], {}],
        ['plain y=x^2 thin', ['y=x^2'], { thickness: 1 }],
        ['plain y=x^2 thick', ['y=x^2'], { thickness: 6 }],
        ['plain y=x^0.5 negative-base fractional pow', ['y=x^0.5'], {}],
        ['plain slider y=a*sin(x) a=-1.7', ['y=a*sin(x)'], { vars: { a: -1.7 } }],
        ['plain offset/scale y=sin(x)', ['y=sin(x)'], { offset: [0.4, 0.2], scale: 1.6 }],
        ['plain high precision y=sin(x)', ['y=sin(x)'], { step: 10 }],

        // --- zero-valid-segment curves: the shared JS tail after the
        // parametric/x-y/implicit dispatch (arch-current.html's
        // `const count = lineVerts.length / (...); ...
        // this.cache3D.lines.set(index, {...})`) sits OUTSIDE the if/else-if
        // chain and runs unconditionally, so cache3D.lines still gets a
        // {count:0,...} entry even when every sample was non-finite or out
        // of range. Regression coverage for that (previously missed; the
        // wasm adapter used to gate this on `count > 0`). ---
        ['zero-seg parametric: constant point always out of range', ['x=100,y=100'], {}],
        ['zero-seg parametric3d: constant point always out of range', ['x=100,y=100,z=100'], {}],
        ['zero-seg xy (y=): constant value always out of range', ['y=1000'], {}],
        ['zero-seg xy (x=): constant value always out of range', ['x=1000'], {}],
        ['zero-seg xy (y=): always-NaN domain sqrt(-1-x^2)', ['y=sqrt(-1-x^2)'], {}],
        ['zero-seg parametric: always-NaN x=sqrt(-1-t^2),y=t', ['x=sqrt(-1-t^2),y=t'], {}],
        ['zero-seg xy thick: constant value always out of range, thick', ['y=1000'], { thickness: 6 }],
        ['zero-seg parametric thick: constant point out of range, thick', ['x=100,y=100'], { thickness: 6 }],
        // multi-entry: a zero-segment entry sandwiched between/before normal
        // ones, so a missing Map entry would misalign every later index.
        ['zero-seg multi: normal, zero-seg, normal (index alignment)',
            ['y=sin(x)', 'x=100,y=100', 'x=cos(t),y=sin(t)'], {}],
        ['zero-seg multi: zero-seg first entry', ['y=1000', 'y=sin(x)'], {}],

        // --- multi-entry mixed case ---
        ['multi: slice + flat implicit + parametric + plain', ['z=sin(x)*cos(y)', 'x^2+y^2=4', 'x=cos(t),y=sin(t)', 'y=sin(x)'], { slice: [{ index: 0, axis: 'z', val: 0 }] }],
    ];

    for (const [name, exprs, opts] of cases) {
        try {
            results[name] = runCase(exprs, opts);
        } catch (e) {
            results[name] = { error: String((e && e.stack) || e) };
        }
        await yieldNow();
    }

    // ---- benchmarks ----------------------------------------------------
    const median = async (fn, runs = 7) => {
        fn();
        await yieldNow();
        const ts = [];
        for (let i = 0; i < runs; i++) {
            const t = performance.now();
            fn();
            ts.push(performance.now() - t);
            await yieldNow();
        }
        ts.sort((a, b) => a - b);
        return +ts[Math.floor(runs / 2)].toFixed(3);
    };

    const bench = {};
    async function benchCase(name, exprs, opts) {
        setup(exprs, opts);
        await yieldNow();
        ArchCore.state.enabled = false;
        const js = await median(() => A.recalculate3D());
        await yieldNow();
        ArchCore.state.enabled = true;
        const wasm = await median(() => A.recalculate3D());
        bench[name] = { js, wasm, speedup: +(js / wasm).toFixed(2) };
        await yieldNow();
    }

    await benchCase('slice z=sin(x)*cos(y) implicitStep=5 (mcRes=50)', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0 }] });
    await benchCase('slice implicitStep=25 (mcRes=10 floor)', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0 }], implicitStep: 25 });
    await benchCase('slice implicitStep=1 (mcRes=200 cap)', ['z=sin(x)*cos(y)'], { slice: [{ index: 0, axis: 'z', val: 0 }], implicitStep: 1 });
    await benchCase('flat implicit x^2+y^2=4 implicitStep=5', ['x^2+y^2=4'], {});
    await benchCase('flat implicit fill x^2+y^2>4 implicitStep=1 (mcRes=200)', ['x^2+y^2>4'], { implicitStep: 1 });
    await benchCase('parametric3d step=2 (numSteps=400)', ['x=cos(t),y=sin(t),z=t/5'], {});
    await benchCase('parametric3d step=20 (numSteps=4000)', ['x=cos(t),y=sin(t),z=t/5'], { step: 20 });
    await benchCase('plain y=sin(x) step=2 (numSteps=400)', ['y=sin(x)'], {});
    await benchCase('plain y=sin(x) step=20 (numSteps=4000)', ['y=sin(x)'], { step: 20 });

    // ---- restore ----------------------------------------------------
    A.explicitPrecisionStep = saved.step;
    A.originalExplicitPrecision = saved.origStep;
    A.implicitPrecisionStep = saved.implicitStep;
    A.autoBreakpointDetectionEnabled = saved.autoBreak;
    A.is3DMode = saved.is3D;
    A.offset3D = saved.offset;
    A.scale3D = saved.scale;
    A.bounds3D = saved.bounds;
    A.overlayDrawingEnabled = saved.overlay;
    A.highPerformancePlottingEnabled = saved.hpp;
    A.tmin = saved.tmin;
    A.tmax = saved.tmax;
    A.clearAllEntries();
    ArchCore.state.enabled = true;
    gl.bufferData = realBufferData;
    gl.bindBuffer = realBindBuffer;

    const summary = {};
    let failCount = 0;
    for (const [name, r] of Object.entries(results)) {
        if (r.error) { summary[name] = { error: r.error }; failCount++; continue; }
        summary[name] = {
            issues: r.issues, jsLineCount: r.jsLineCount, wasmLineCount: r.wasmLineCount,
            jsMeshCount: r.jsMeshCount, wasmMeshCount: r.wasmMeshCount,
        };
        if (r.issues.length) failCount++;
    }
    return { totalCases: cases.length, failCount, results: summary, bench };
})()
