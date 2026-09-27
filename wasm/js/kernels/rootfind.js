// ArchCore adapter for the page's name=root[expr,var,init] numerical root
// finding (recalculateVariableValues' isRootFinding branch).
//
// Guard + fallback contract (see arch-current.html): returns a number when
// the wasm program compiled, probe-verified itself against the page's own JS
// root algorithm on first use, and ran; returns null in every other case
// (compile failure, probe mismatch, non-pristine advanced function,
// non-finite init value, non-number scope value, any exception) so the
// caller runs its original JS path.
//
// The compiled program is f(rootVar) with rootVar as the single lane arg
// (nArgs = 1) and every other in-scope variable as a parameter; ac_root_run
// implements the scan/refine algorithm line-by-line.
(function () {
    const MAX_PROGRAMS = 256;
    // key -> { handle, paramNames, verified, rejected }
    const programs = new Map();

    // engine: the page's engine instance. entry: the parsed root variable
    // entry ({ rootVar, rootExprTokens, rootInitTokens }). scopeObj: the
    // merged variable scope (the page's `scope`). jsFallbackFn: the caller's
    // own JS root algorithm for the very same entry (first-use probe).
    function rootFind(engine, entry, scopeObj, jsFallbackFn) {
        if (!ArchCore.active || !entry || typeof entry.rootVar !== 'string' ||
            !Array.isArray(entry.rootExprTokens) || !Array.isArray(entry.rootInitTokens)) return null;
        try {
            const shared = ArchCore.kernels.calcShared;
            if (!shared) return null;
            const rootVar = entry.rootVar;
            if (!/^[a-z_][a-z0-9_]*$/.test(rootVar)) return null;

            // The stored tokens are the page's expanded token stream; joining
            // them restores a source the CalcJs pipeline tokenizes back to the
            // same stream (identifiers/numbers/parens join losslessly), so the
            // wasm program re-expands exactly like the page's own
            // evaluateScopedExpression re-expands the stored tokens at eval
            // time. There is no raw-source field on the entry.
            const exprSrc = entry.rootExprTokens.join('');
            if (exprSrc.trim() === '') return null;

            // x0 comes from the init expression through the shared scalar
            // kernel (own cache + first-use probe against the page's init
            // evaluation). The page skips everything for non-finite x0 and
            // yields NaN, so let the JS path produce that NaN.
            const initSrc = entry.rootInitTokens.join('');
            const x0 = shared.calcExpr(engine, initSrc, scopeObj, () =>
                engine.evaluateExpressionWithCalcJS(entry.rootInitTokens, scopeObj));
            if (typeof x0 !== 'number' || !Number.isFinite(x0)) return null;

            // Advanced functions: same pristine gate as calcExpr — a
            // redefined advanced body must keep the entry on the JS path. The
            // stored expr tokens still name the advanced calls (expansion
            // keeps them verbatim), so scanning them covers the inlined
            // simple-function bodies too; every live custom body is scanned
            // as well for the late-expansion case (a simple function defined
            // after the entry was parsed expands from these tokens at eval).
            const scan = shared.scanAdvanced(engine, entry.rootExprTokens);
            if (scan.reject) return null;
            let advSig = scan.sig;
            const cf = (engine.calcJSUtils && engine.calcJSUtils.customFunctions) || {};
            for (const name of Object.keys(cf)) {
                const f = cf[name];
                if (!f || !Array.isArray(f.bodyTokens)) continue;
                const bodyScan = shared.scanAdvanced(engine, f.bodyTokens);
                if (bodyScan.reject) return null;
                advSig += bodyScan.sig;
            }

            const names = shared.namesFromScope(scopeObj);
            const userFns = shared.encodeUserFns(engine);
            const integralSteps = engine.integralNumSteps || 100;
            const key = 'R|' + integralSteps + '|' + advSig + '|' +
                names.join(',') + '|' + userFns + '|' + rootVar + '|' + exprSrc;
            let rec = programs.get(key);
            if (rec) {
                programs.delete(key);
                programs.set(key, rec);
                if (rec.rejected) return null;
            } else {
                // names layout: the root variable is the single lane arg,
                // every scope variable is a parameter. A same-named scope
                // variable stays in `names` as a parameter: args resolve
                // before params in the core, matching the page's
                // { ...scope, [rootVar]: v } shadowing.
                const compiled = shared.compileCalc(exprSrc, [rootVar].concat(names), userFns, integralSteps, 1);
                rec = { handle: compiled.handle, paramNames: names, verified: false, rejected: false };
                programs.set(key, rec);
                while (programs.size > MAX_PROGRAMS) {
                    const [oldKey, old] = programs.entries().next().value;
                    programs.delete(oldKey);
                    if (old.handle) ArchCore.exports.ac_release(old.handle);
                }
                if (!rec.handle) return null; // page path reports the error
            }

            const values = rec.paramNames.map((k) => scopeObj[k]);
            for (const v of values) {
                if (typeof v !== 'number') return null; // page would substitute a non-number
            }

            const run = () => {
                if (values.length > 0) {
                    const { ptr, view } = ArchCore.f64Scratch('rootfind-params', values.length);
                    view.set(values);
                    ArchCore.exports.ac_set_params(rec.handle, ptr, values.length);
                }
                return ArchCore.exports.ac_root_run(rec.handle, x0);
            };

            if (!rec.verified) {
                let want;
                try { want = jsFallbackFn(); } catch (e) { want = NaN; }
                const got = run();
                if (typeof want !== 'number' || !shared.probeMatches(got, want)) {
                    rec.rejected = true;
                    return null;
                }
                rec.verified = true;
                return got;
            }
            return run();
        } catch (e) {
            return null;
        }
    }

    ArchCore.kernels.rootFind = rootFind;
})();
