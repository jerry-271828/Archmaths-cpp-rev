// Differential test + benchmark for the ArchCore "surface3d" kernel
// (ac_surface3d_run / ac_ribbon3d_run vs recalculate3D()'s original JS
// blocks for plotType z/x3d/y3d and the extendTo3D explicit-curve ribbon).
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    const hasCore = typeof ArchCore !== 'undefined';
    if (!hasCore) return { error: 'ArchCore missing' };
    await new Promise((r) => ArchCore.onReady(r));

    // ---- gl buffer capture (createBuffer/bindBuffer/bufferData monkeypatch) ----
    const gl = A.gl;
    const captured = new WeakMap();
    const currentBinding = {};
    if (!gl.__diffPatched) {
        const origBindBuffer = gl.bindBuffer.bind(gl);
        const origBufferData = gl.bufferData.bind(gl);
        gl.bindBuffer = function (target, buffer) {
            currentBinding[target] = buffer;
            return origBindBuffer(target, buffer);
        };
        gl.bufferData = function (target, data, usage) {
            const buf = currentBinding[target];
            if (buf && data && ArrayBuffer.isView(data)) {
                captured.set(buf, Float32Array.from(data));
            }
            return origBufferData(target, data, usage);
        };
        gl.__diffPatched = true;
        gl.__captured = captured;
    }
    const cap = gl.__captured;

    function snapshotMeshes() {
        const out = {};
        for (const [index, mesh] of A.cache3D.meshes) {
            const v = cap.get(mesh.vbo);
            const n = cap.get(mesh.nbo);
            out[index] = {
                count: mesh.count,
                color: mesh.color ? { h: mesh.color.h, s: mesh.color.s, b: mesh.color.b, a: mesh.color.a } : null,
                vlen: v ? v.length : -1,
                nlen: n ? n.length : -1,
                verts: v || null,
                norms: n || null,
            };
        }
        return out;
    }

    function relClose(a, b, tol) {
        if (Number.isNaN(a) && Number.isNaN(b)) return true;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    }

    function compareSnaps(js, wasm, tol) {
        const issues = [];
        const jsKeys = Object.keys(js), wKeys = Object.keys(wasm);
        if (jsKeys.length !== wKeys.length) issues.push(`mesh count differs: js=${jsKeys.length} wasm=${wKeys.length} (js keys ${jsKeys}, wasm keys ${wKeys})`);
        for (const k of new Set([...jsKeys, ...wKeys])) {
            const a = js[k], b = wasm[k];
            if (!a || !b) { issues.push(`index ${k}: present in ${a ? 'js only' : 'wasm only'}`); continue; }
            if (a.count !== b.count) { issues.push(`index ${k}: count js=${a.count} wasm=${b.count}`); continue; }
            if (a.vlen !== b.vlen || a.nlen !== b.nlen) { issues.push(`index ${k}: vlen/nlen js=${a.vlen}/${a.nlen} wasm=${b.vlen}/${b.nlen}`); continue; }
            let maxDiffV = 0, maxDiffN = 0, badV = -1, badN = -1;
            for (let i = 0; i < a.vlen; i++) {
                if (!relClose(a.verts[i], b.verts[i], tol)) { const d = Math.abs(a.verts[i] - b.verts[i]); if (d > maxDiffV) { maxDiffV = d; badV = i; } }
            }
            for (let i = 0; i < a.nlen; i++) {
                if (!relClose(a.norms[i], b.norms[i], tol)) { const d = Math.abs(a.norms[i] - b.norms[i]); if (d > maxDiffN) { maxDiffN = d; badN = i; } }
            }
            if (badV >= 0) issues.push(`index ${k}: vertex mismatch at [${badV}] js=${a.verts[badV]} wasm=${b.verts[badV]} (maxDiff=${maxDiffV})`);
            if (badN >= 0) issues.push(`index ${k}: normal mismatch at [${badN}] js=${a.norms[badN]} wasm=${b.norms[badN]} (maxDiff=${maxDiffN})`);
            if (a.color && b.color) {
                if (a.color.h !== b.color.h || a.color.s !== b.color.s || a.color.b !== b.color.b || a.color.a !== b.color.a) {
                    issues.push(`index ${k}: color differs js=${JSON.stringify(a.color)} wasm=${JSON.stringify(b.color)}`);
                }
            }
        }
        return issues;
    }

    const savedStep = A.explicitPrecisionStep;
    const savedOrigStep = A.originalExplicitPrecision;
    const savedAutoBreak = A.autoBreakpointDetectionEnabled;
    const savedIs3D = A.is3DMode;
    const savedOffset = { x: A.offset3D.x, y: A.offset3D.y };
    const savedScale = A.scale3D;
    const savedBounds = A.bounds3D;

    function setup(exprs, opts) {
        A.clearAllEntries();
        A.is3DMode = true;
        A.offset3D = { x: 0, y: 0 };
        A.scale3D = 1.0;
        A.bounds3D = 8;
        A.explicitPrecisionStep = opts.step ?? 2;
        A.originalExplicitPrecision = A.explicitPrecisionStep;
        A.autoBreakpointDetectionEnabled = opts.autoBreak !== undefined ? opts.autoBreak : true;
        for (const e of exprs) A.addEntry(e);
        if (opts.extend3D) {
            for (const idx of opts.extend3D) A.entries[idx].extendTo3D = true;
        }
        if (opts.vars) {
            for (const [k, v] of Object.entries(opts.vars)) A.variables.set(k, v);
        }
    }

    function runCase(exprs, opts) {
        setup(exprs, opts);
        ArchCore.state.enabled = false;
        A.recalculate3D();
        const js = snapshotMeshes();
        ArchCore.state.enabled = true;
        A.recalculate3D();
        const wasm = snapshotMeshes();
        const issues = compareSnaps(js, wasm, 1e-9);
        const jsCount = Object.values(js).reduce((s, m) => s + m.count, 0);
        const wasmCount = Object.values(wasm).reduce((s, m) => s + m.count, 0);
        return { issues, jsCount, wasmCount, meshIdx: Object.keys(js) };
    }

    const results = {};
    const cases = [
        ['z=sin(x)*cos(y) default', ['z=sin(x)*cos(y)'], { step: 2, autoBreak: true }],
        ['z=sin(x)*cos(y) autoBreak off', ['z=sin(x)*cos(y)'], { step: 2, autoBreak: false }],
        ['z=x^2-y^2', ['z=x^2-y^2'], { step: 2, autoBreak: true }],
        ['z=1/(x*y) autoBreak on', ['z=1/(x*y)'], { step: 2, autoBreak: true }],
        ['z=1/(x*y) autoBreak off', ['z=1/(x*y)'], { step: 2, autoBreak: false }],
        ['z=sqrt(4-x^2-y^2) NaN regions', ['z=sqrt(4-x^2-y^2)'], { step: 2, autoBreak: true }],
        ['z=tan(x)*tan(y) discontinuities', ['z=tan(x)*tan(y)'], { step: 2, autoBreak: true }],
        ['x3d: x=y*z', ['x=y*z'], { step: 2, autoBreak: true }],
        ['y3d: y=x*z', ['y=x*z'], { step: 2, autoBreak: true }],
        ['x3d: x=sin(y+z)', ['x=sin(y+z)'], { step: 2, autoBreak: true }],
        ['y3d: y=cos(x-z)', ['y=cos(x-z)'], { step: 2, autoBreak: true }],
        ['slider: z=a*sin(x)*cos(y) a=2.5', ['z=a*sin(x)*cos(y)'], { step: 2, autoBreak: true, vars: { a: 2.5 } }],
        ['slider: z=a*sin(x)*cos(y) a=-1.7', ['z=a*sin(x)*cos(y)'], { step: 2, autoBreak: true, vars: { a: -1.7 } }],
        ['ribbon y=sin(x) extend3D', ['y=sin(x)'], { step: 2, extend3D: [0] }],
        ['ribbon x=cos(y) extend3D', ['x=cos(y)'], { step: 2, extend3D: [0] }],
        ['ribbon y=1/x extend3D (discont)', ['y=1/x'], { step: 2, extend3D: [0] }],
        ['ribbon y=sqrt(x) extend3D (NaN half)', ['y=sqrt(x)'], { step: 2, extend3D: [0] }],
        ['multi: z=sin(x)*cos(y), x=y*z', ['z=sin(x)*cos(y)', 'x=y*z'], { step: 2, autoBreak: true }],
        ['high precision step=10', ['z=sin(x)*cos(y)'], { step: 10, autoBreak: true }],
        ['negative fractional pow: z=x^0.5-y', ['z=x^0.5-y'], { step: 2, autoBreak: true }],
    ];

    for (const [name, exprs, opts] of cases) {
        try {
            results[name] = runCase(exprs, opts);
        } catch (e) {
            results[name] = { error: String(e && e.stack || e) };
        }
        await yieldNow();
    }

    // ---- benchmarks ----
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

    await benchCase('z=sin(x)*cos(y) step=2 (res=30)', ['z=sin(x)*cos(y)'], { step: 2, autoBreak: true });
    await benchCase('z=sin(x)*cos(y) step=20 (res=300, max)', ['z=sin(x)*cos(y)'], { step: 20, autoBreak: true });
    await benchCase('z=x^2-y^2 step=20 (res=300)', ['z=x^2-y^2'], { step: 20, autoBreak: true });
    await benchCase('ribbon y=sin(x) step=20 (res=300)', ['y=sin(x)'], { step: 20, extend3D: [0] });

    A.explicitPrecisionStep = savedStep;
    A.originalExplicitPrecision = savedOrigStep;
    A.autoBreakpointDetectionEnabled = savedAutoBreak;
    A.is3DMode = savedIs3D;
    A.offset3D = savedOffset;
    A.scale3D = savedScale;
    A.bounds3D = savedBounds;
    A.clearAllEntries();
    ArchCore.state.enabled = true;

    const summary = {};
    for (const [name, r] of Object.entries(results)) {
        if (r.error) { summary[name] = { error: r.error }; continue; }
        summary[name] = { issues: r.issues, jsCount: r.jsCount, wasmCount: r.wasmCount, meshIdx: r.meshIdx };
    }
    return { results: summary, bench };
})()
