// ArchCore adapter for the page's scalar calcJS evaluation: the expression
// engine (calcJSUtils dialect) for interactive input and dependent variable
// entries, compiled through the CalcJs dialect front-end of the wasm core
// (ac_calc_compile / ac_set_params / ac_calc_eval1, ABI v2).
//
// Guard + fallback contract (see arch-current.html): returns a number when
// the wasm program is compiled, probe-verified against the page's own JS
// evaluation on first use, and evaluated; returns null in every other case
// (compile failure, probe mismatch, non-pristine advanced function, non-number
// scope value, any exception) so the caller runs its original JS path.
(function () {
    const MAX_PROGRAMS = 256;
    // key -> { handle, names, verified, rejected }
    const programs = new Map();

    function probeMatches(a, b) {
        if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }

    // calcJS tokens are lower-case [a-z_][a-z0-9_]* runs (multi-letter names
    // included); uppercase names can never match a token on the page, so they
    // are excluded here as well (keeping them would evaluate where the page
    // errors, and the probe would reject the program anyway).
    function namesFromScope(scopeObj) {
        const names = [];
        for (const k of Object.keys(scopeObj || {})) {
            if (/^[a-z_][a-z0-9_]*$/.test(k) && !names.includes(k)) names.push(k);
        }
        names.sort();
        return names;
    }

    // Page's simple custom functions, encoded for ac_calc_compile: one record
    // per line "name|p1,p2|body" where body is the page's stored bodyTokens
    // joined by single spaces (tokens never contain whitespace).
    function encodeUserFns(engine) {
        const cf = engine.calcJSUtils && engine.calcJSUtils.customFunctions;
        if (!cf) return '';
        const parts = [];
        for (const name of Object.keys(cf)) {
            const f = cf[name];
            if (!f || !Array.isArray(f.params) || !Array.isArray(f.bodyTokens)) continue;
            parts.push(name + '|' + f.params.join(',') + '|' + f.bodyTokens.join(' '));
        }
        parts.sort();
        return parts.join('\n');
    }

    // Advanced functions only run on wasm while their JS body is still the
    // built-in one; anything else (or unknown to the wasm ports) must fall
    // back, mirroring programFor()'s pristine gate. Returns a signature of
    // the referenced definitions for the cache key, so redefining one later
    // never serves a stale program.
    function scanAdvanced(engine, tokens) {
        const advNames = (engine.calcJSUtils && engine.calcJSUtils.advancedCustomFunctionNames) || [];
        let reject = false;
        let sig = '';
        if (tokens && tokens.length && advNames.length) {
            for (const t of tokens) {
                if (!advNames.includes(t)) continue;
                if (!ArchCore.advancedIsPristine(engine, t)) reject = true;
                const live = engine.calcJSUtils.advancedCustomFunctions[t];
                const body = live ? String(live.bodyJsString) : '';
                let h = 0;
                for (let i = 0; i < body.length; i++) h = (h * 33 + body.charCodeAt(i)) | 0;
                sig += t + '#' + h + ';';
            }
        }
        return { reject, sig };
    }

    function scanPreprocessedAdv(engine, src) {
        const re = /__advanced__\.([A-Za-z_$][\w$]*)/g;
        let m;
        let sig = '';
        while ((m = re.exec(src)) !== null) {
            if (!ArchCore.advancedIsPristine(engine, m[1])) return { reject: true, sig: '' };
            const live = engine.calcJSUtils.advancedCustomFunctions[m[1]];
            const body = live ? String(live.bodyJsString) : '';
            let h = 0;
            for (let i = 0; i < body.length; i++) h = (h * 33 + body.charCodeAt(i)) | 0;
            sig += m[1] + '#' + h + ';';
        }
        return { reject: false, sig };
    }

    function compileCalc(source, names, userFns, integralSteps, nArgs = 0) {
        const src = ArchCore.writeString('calc-src', source);
        const nm = ArchCore.writeString('calc-names', names.join('\n'));
        const uf = ArchCore.writeString('calc-userfns', userFns);
        const handle = ArchCore.exports.ac_calc_compile(
            src.ptr, src.len, nm.ptr, nm.len, nArgs, uf.ptr, uf.len, integralSteps);
        return { handle, error: handle ? null : ArchCore.lastError() };
    }

    function evalScalar(handle, values) {
        if (values.length > 0) {
            const { ptr, view } = ArchCore.f64Scratch('calc-params', values.length);
            view.set(values);
            ArchCore.exports.ac_set_params(handle, ptr, values.length);
        }
        return ArchCore.exports.ac_calc_eval1(handle);
    }

    // engine: the page's engine instance (calcJSUtils, integralNumSteps).
    // srcString: raw calcJS source (already resolvePointCoords'd by the caller)
    // or, with opts.preprocessed, a processTokensForEval'd JS expression.
    // scopeObj: the merged variable scope. jsFallbackFn: the caller's own JS
    // evaluation of the very same input (used by the first-use probe).
    function calcExpr(engine, srcString, scopeObj, jsFallbackFn, opts) {
        if (!ArchCore.active || typeof srcString !== 'string' || srcString.trim() === '') return null;
        try {
            const preprocessed = !!(opts && opts.preprocessed);
            let advSig = '';
            if (preprocessed) {
                const scan = scanPreprocessedAdv(engine, srcString);
                if (scan.reject) return null;
                advSig = scan.sig;
            } else {
                const tokens = engine.calcJSUtils.tokenize.call(engine.calcJSUtils, srcString);
                const scan = scanAdvanced(engine, tokens);
                if (scan.reject) return null;
                advSig = scan.sig;
                // A simple custom function whose body calls a redefined
                // advanced function expands to the same call; keep it on JS.
                const cf = engine.calcJSUtils.customFunctions || {};
                for (const name of Object.keys(cf)) {
                    const f = cf[name];
                    if (!f || !Array.isArray(f.bodyTokens)) continue;
                    const bodyScan = scanAdvanced(engine, f.bodyTokens);
                    if (bodyScan.reject) return null;
                    advSig += bodyScan.sig;
                }
            }

            const names = namesFromScope(scopeObj);
            const userFns = preprocessed ? '' : encodeUserFns(engine);
            const integralSteps = engine.integralNumSteps || 100;
            const key = (preprocessed ? 'P|' : 'C|') + integralSteps + '|' + advSig + '|' +
                names.join(',') + '|' + userFns + '|' + srcString;
            let rec = programs.get(key);
            if (rec) {
                programs.delete(key);
                programs.set(key, rec);
                if (rec.rejected) return null;
            } else {
                const compiled = compileCalc(srcString, names, userFns, integralSteps);
                rec = { handle: compiled.handle, names, verified: false, rejected: false };
                programs.set(key, rec);
                while (programs.size > MAX_PROGRAMS) {
                    const [oldKey, old] = programs.entries().next().value;
                    programs.delete(oldKey);
                    if (old.handle) ArchCore.exports.ac_release(old.handle);
                }
                if (!rec.handle) return null; // page path reports the error
            }

            const values = rec.names.map((k) => scopeObj[k]);
            for (const v of values) {
                if (typeof v !== 'number') return null; // page would substitute a non-number
            }

            if (!rec.verified) {
                let want;
                try { want = jsFallbackFn(); } catch (e) { want = NaN; }
                const got = evalScalar(rec.handle, values);
                if (typeof want !== 'number' || !probeMatches(got, want)) {
                    rec.rejected = true;
                    return null;
                }
                rec.verified = true;
                return got;
            }
            return evalScalar(rec.handle, values);
        } catch (e) {
            return null;
        }
    }

    ArchCore.kernels.calcExpr = calcExpr;

    // Shared helpers for sibling kernels (rootfind) so they reuse the same
    // scope-name/userFns/pristine-scan/compile conventions.
    ArchCore.kernels.calcShared = {
        probeMatches,
        namesFromScope,
        encodeUserFns,
        scanAdvanced,
        compileCalc,
        calcExpr,
    };
})();
