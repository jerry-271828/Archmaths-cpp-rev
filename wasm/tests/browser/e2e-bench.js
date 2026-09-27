// End-to-end timing of the page's heavy paths. Runs in the page (via CDP
// Runtime.evaluate) on either the original page or the ArchCore build; set
// window.__benchWasm = false beforehand to time the JS paths of an ArchCore build.
// Run with `node cdp.js run <tab> @e2e-bench.js`: it yields between steps so each
// CDP poll stays under the extension's 5 s command limit.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    const hasCore = typeof ArchCore !== 'undefined';
    if (hasCore) {
        await new Promise((r) => ArchCore.onReady(r));
        ArchCore.state.enabled = window.__benchWasm !== false;
    }
    const rect = A.canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const median = async (fn, runs = 5) => {
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
        return +ts[Math.floor(runs / 2)].toFixed(1);
    };
    const setup = (exprs, mode3d) => {
        A.clearAllEntries();
        A.is3DMode = !!mode3d;
        for (const e of exprs) A.addEntry(e);
        A.recalculateAll();
    };
    const savedStep = A.implicitPrecisionStep;
    const out = { page: location.pathname, wasm: hasCore && ArchCore.active, canvas: [Math.round(W), Math.round(H)] };

    const implicit2d = async (exprs) => { setup(exprs, false); await yieldNow(); return median(() => { A.clearPlotData(); A.processImplicitBlocksOnGrid(W, H); }); };
    const explicit2d = async (exprs) => { setup(exprs, false); await yieldNow(); return median(() => { A.clearPlotData(); A.draw(); }); };
    const savedOriginal = A.originalImplicitPrecision;
    const recalc3d = async (exprs, step) => {
        setup(exprs, true);
        // recalculateAll() restores implicitPrecisionStep from originalImplicitPrecision.
        A.implicitPrecisionStep = step;
        A.originalImplicitPrecision = step;
        await yieldNow();
        const t = await median(() => A.recalculate3D(), 3);
        A.implicitPrecisionStep = savedStep;
        A.originalImplicitPrecision = savedOriginal;
        return t;
    };

    out['implicit2d: x^2+y^2+sin(3x)y=4'] = await implicit2d(['x^2+y^2+sin(3x)*y=4']);
    out['implicit2d: sin(x)+cos(y)>0.5 (fill)'] = await implicit2d(['sin(x)+cos(y)>0.5']);
    out['implicit2d: 3 curves'] = await implicit2d(['x^2+y^2=9', 'y^2=x^3-x', 'sin(x*y)=0.3']);
    out['explicit2d: sin(x)x^2+cos(3x)'] = await explicit2d(['y=sin(x)*x^2+cos(3x)']);
    out['explicit2d: tan(x) + 1/x'] = await explicit2d(['y=tan(x)', 'y=1/x']);
    out['explicit2d: int(exp(-t^2),t,0,x)'] = await explicit2d(['y=int(exp(-t^2),t,0,x)']);
    out['3d implicit sphere mcRes40'] = await recalc3d(['x^2+y^2+z^2=4'], 5);
    out['3d implicit sphere mcRes80'] = await recalc3d(['x^2+y^2+z^2=4'], 2.5);
    out['3d implicit sphere mcRes160'] = await recalc3d(['x^2+y^2+z^2=4'], 1.25);
    out['3d gyroid mcRes40'] = await recalc3d(['sin(x)cos(y)+sin(y)cos(z)+sin(z)cos(x)=0'], 5);
    out['3d surface z=sin(x)cos(y)'] = await recalc3d(['z=sin(x)*cos(y)'], 5);
    // One slider-animation step (what runs every frame while a slider plays).
    setup(['a=1', 'x^2+a*y^2=4', 'y=a*sin(x)'], false);
    await yieldNow();
    out['animation frame 2d (implicit+explicit)'] = await median(() => {
        A.variables.set('a', 1 + Math.random());
        A.recalculateForAnimation();
        A.draw();
    });
    setup(['a=1', 'x^2+y^2+a*z^2=4'], true);
    await yieldNow();
    out['animation frame 3d (implicit3d)'] = await median(() => {
        A.variables.set('a', 1 + Math.random());
        A.recalculateForAnimation();
    }, 3);

    A.is3DMode = false;
    A.clearAllEntries();
    if (hasCore) ArchCore.state.enabled = true;
    return out;
})()
