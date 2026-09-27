// Differential test for the ArchCore "advfuncs" kernel, run inside the page.
// Confirms entries using the page's built-in advanced functions become
// wasm-eligible (ArchCore.programFor returns a non-null record) and that the
// wasm and JS evaluation paths agree over a sweep of x values.
(async () => {
    const yieldNow = () => (window.__yield ? window.__yield() : Promise.resolve());
    const A = window.archInstance;
    if (typeof ArchCore === 'undefined') return { error: 'ArchCore missing' };
    await new Promise((r) => ArchCore.onReady(r));

    function relClose(a, b, tol) {
        if (Number.isNaN(a) && Number.isNaN(b)) return true;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
    }

    // NOTE: 'psi' is intentionally excluded from wasm acceleration (advfuncs.cpp
    // no longer registers it - see the comment on fnPsi / in kFunctions there).
    // Its central-difference algorithm amplifies ordinary libm ULP noise by
    // ~5e6x, and the engine's differential probe (24 fixed sample points) does
    // not reliably catch that for every expression shape - shifted/scaled
    // arguments routinely evade it (confirmed by the verifier: psi(x+50) and
    // psi(x-3) passed the probe with real errors up to 1.3e-7 relative). So
    // any use of psi must now make ArchCore.programFor() return null
    // (compilation itself fails), which the checks below assert directly,
    // and it is left out of the "every function at once" sum so that sum can
    // still exercise the other 17 functions via wasm.
    const exprs = [
        'y=gamma(x)',
        'y=erf(x)+zeta(x)',
        'y=lambertw(x)',
        'y=ltw(x)',
        'y=fresnels(x)-fresnelc(x)',
        'y=sinintegral(x)+cosintegral(x)',
        'y=expintegral(x)',
        'y=elliptice(x/2)*elliptick(x/2)',
        'y=sign(x)+sgn(x)+heaviside(x)',
        'y=li(x)',
        'y=llim(x,-5)+ulim(x,5)+range(x,-8,8)',
        'y=erfc(x)*gamma(x/2)',
        'y=gamma(x)+erf(x)+erfc(x)+zeta(x)+lambertw(x)+ltw(x)+fresnels(x)+fresnelc(x)+sinintegral(x)+cosintegral(x)+expintegral(x)+elliptice(x/3)+elliptick(x/3)+sign(x)+sgn(x)+heaviside(x)+li(x)',
    ];
    // psi expressions: every one of these must come back ineligible (rec ==
    // null) - checked explicitly after the main sweep, not mixed into `exprs`
    // (an ineligible entry contributes no wasm/js comparison there).
    const psiExprs = ['y=psi(x)', 'y=psi(x+50)', 'y=psi(x-3)', 'y=psi(2*x)', 'y=gamma(x)+psi(x)'];

    A.clearAllEntries();
    await yieldNow();
    for (const e of exprs) A.addEntry(e);
    A.recalculateAll();
    await yieldNow();

    const results = [];
    const xs = [];
    for (let i = -100; i <= 100; i++) xs.push(i * 0.137); // dense, irrational-ish step
    for (const v of [0, -0, 1, -1, 2, -2, 0.5, -0.5, 6, -6, 0.5000001, 0.4999999, 21.99, 22, 4.59, 4.5901,
        -0.3698, -0.3697, 10000000, -10000000, 1e-9, -1e-9, 1000, -1000]) xs.push(v);

    for (const entry of A.entries) {
        const src = entry.expr;
        const fn = entry.func;
        if (typeof fn !== 'function') { results.push({ src, error: 'no entry.func' }); continue; }
        const rec = ArchCore.programFor(A, fn);
        const advMap = A.calcJSUtils.getAdvancedFuncsMap();
        const eligible = !!rec;
        let mismatches = 0, checked = 0, worst = 0, sampleFails = [];
        if (eligible) {
            // entry.func's positional-arg template is (x[,y[,z]], variables, Math,
            // __advanced__) regardless of how many of x/y/z the body actually
            // references (e.g. any body containing the substring "zeta" gets a
            // 3-arg template - a pre-existing page quirk, unrelated to this
            // kernel); match rec.argNames.length so unused slots still line up
            // with (variables, Math, advancedFuncsMap).
            const extraArgs = rec.argNames.length - 1;
            const lane = ArchCore.f64Scratch('test-x', xs.length);
            lane.view.set(xs);
            const out = ArchCore.f64Scratch('test-out', xs.length);
            ArchCore.evalPtrs(rec, [lane.ptr], xs.length, out.ptr, 0);
            const view = ArchCore.views().f64;
            for (let i = 0; i < xs.length; i++) {
                const x = xs[i];
                let want;
                try { want = fn(x, ...new Array(extraArgs).fill(0), A.variables, Math, advMap); } catch (err) { want = NaN; }
                const got = view[(out.ptr >> 3) + i];
                checked++;
                const rel = Number.isFinite(got) && Number.isFinite(want) && want !== 0
                    ? Math.abs(got - want) / Math.max(1, Math.abs(got), Math.abs(want)) : (Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want)) ? 0 : Infinity);
                if (Number.isFinite(rel)) worst = Math.max(worst, rel);
                if (!relClose(got, want, 1e-6)) {
                    mismatches++;
                    if (sampleFails.length < 5) sampleFails.push({ x, got, want });
                }
            }
        }
        results.push({ src, eligible, checked, mismatches, worst, sampleFails, argNames: rec ? rec.argNames : null });
        await yieldNow();
    }

    // ---- psi must always be wasm-ineligible, including shifted/scaled
    // arguments that the fixed-point probe alone cannot be relied on to catch
    // (see the comment on `psiExprs` above and advfuncs.cpp's kFunctions). ----
    A.clearAllEntries();
    await yieldNow();
    for (const e of psiExprs) A.addEntry(e);
    A.recalculateAll();
    await yieldNow();

    const psiResults = [];
    for (const entry of A.entries) {
        const rec = ArchCore.programFor(A, entry.func);
        psiResults.push({ src: entry.expr, eligible: !!rec });
    }
    const psiExclusionOk = psiResults.every((r) => !r.eligible);

    return { results, psiResults, psiExclusionOk };
})()
