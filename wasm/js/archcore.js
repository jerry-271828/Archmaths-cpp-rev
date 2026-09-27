// ArchCore: loader and thin wrapper around the C++ compute core (archcore.wasm).
// Inlined into arch-current.html by wasm/embed.py; the binary itself travels as
// base64 in <script type="application/wasm-base64" id="archcore-wasm">.
//
// Everything degrades gracefully: until ArchCore.ready is true (or if loading
// fails, or the user disables it) the page keeps using its JS code paths.
const ArchCore = (() => {
    const ABI_VERSION = 2;  // v2: adds the CalcJs scalar ABI (ac_calc_compile / ac_calc_eval1)
    const FLAG_STRICT_POW = 1;

    const state = {
        ready: false,
        failed: false,
        error: null,
        enabled: true,
        ex: null,
        memory: null,
        buffer: null,
        f64: null,
        f32: null,
        i32: null,
        u8: null,
    };
    const readyCallbacks = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    try {
        const stored = localStorage.getItem('archcore-enabled');
        if (stored === '0') state.enabled = false;
    } catch (e) { /* storage unavailable */ }

    function refreshViews() {
        const buf = state.memory.buffer;
        if (state.buffer !== buf) {
            state.buffer = buf;
            state.f64 = new Float64Array(buf);
            state.f32 = new Float32Array(buf);
            state.i32 = new Int32Array(buf);
            state.u8 = new Uint8Array(buf);
        }
    }

    function wasiImports() {
        let pending = '';
        return {
            fd_write(fd, iovs, iovsLen, nwrittenPtr) {
                refreshViews();
                let written = 0;
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = state.i32[(iovs >> 2) + i * 2];
                    const len = state.i32[(iovs >> 2) + i * 2 + 1];
                    pending += decoder.decode(state.u8.subarray(ptr, ptr + len));
                    written += len;
                }
                let nl;
                while ((nl = pending.indexOf('\n')) >= 0) {
                    console.warn('[archcore]', pending.slice(0, nl));
                    pending = pending.slice(nl + 1);
                }
                state.i32[nwrittenPtr >> 2] = written;
                return 0;
            },
            fd_close() { return 0; },
            fd_seek() { return 0; },
            proc_exit(code) { throw new Error('archcore exited with code ' + code); },
        };
    }

    function decodeBase64(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    async function init() {
        try {
            if (typeof WebAssembly !== 'object') throw new Error('WebAssembly unavailable');
            const el = document.getElementById('archcore-wasm');
            const b64 = el ? el.textContent.replace(/\s+/g, '') : '';
            if (!b64) throw new Error('embedded archcore.wasm missing');
            const { instance } = await WebAssembly.instantiate(decodeBase64(b64), {
                wasi_snapshot_preview1: wasiImports(),
            });
            const ex = instance.exports;
            if (typeof ex._initialize === 'function') ex._initialize();
            if (ex.ac_abi_version() !== ABI_VERSION) throw new Error('archcore ABI mismatch');
            state.ex = ex;
            state.memory = ex.memory;
            refreshViews();
            state.ready = true;
        } catch (e) {
            state.failed = true;
            state.error = e;
            console.warn('[archcore] disabled, using JS paths:', e);
        }
        const callbacks = readyCallbacks.splice(0);
        for (const cb of callbacks) {
            try { cb(state.ready); } catch (e) { console.error(e); }
        }
    }

    // ---- scratch memory -------------------------------------------------
    // Named growable buffers in wasm memory, reused across calls.
    const scratch = new Map();
    function scratchPtr(name, bytes) {
        let s = scratch.get(name);
        if (!s || s.bytes < bytes) {
            if (s) state.ex.ac_free(s.ptr);
            const cap = Math.max(bytes, s ? s.bytes * 2 : 0, 4096);
            s = { ptr: state.ex.ac_alloc(cap), bytes: cap };
            if (!s.ptr) throw new Error('archcore out of memory');
            scratch.set(name, s);
        }
        return s.ptr;
    }
    // Float64 scratch array; returns { ptr, view } (view valid until next alloc).
    function f64Scratch(name, count) {
        const ptr = scratchPtr(name, count * 8);
        refreshViews();
        return { ptr, view: state.f64.subarray(ptr >> 3, (ptr >> 3) + count) };
    }
    function writeString(name, str) {
        const bytes = encoder.encode(str);
        const ptr = scratchPtr(name, bytes.length + 1);
        refreshViews();
        state.u8.set(bytes, ptr);
        state.u8[ptr + bytes.length] = 0;
        return { ptr, len: bytes.length };
    }
    function lastError() {
        const ex = state.ex;
        refreshViews();
        const ptr = ex.ac_error_ptr();
        return decoder.decode(state.u8.subarray(ptr, ptr + ex.ac_error_len()));
    }

    // ---- program cache ----------------------------------------------------
    // recompileFunctions() rebuilds every entry's JS closure on each animation
    // frame, so programs are cached by (source, args, params) and shared.
    const MAX_PROGRAMS = 512;
    const programs = new Map(); // key -> record (Map keeps LRU order)

    function compileProgram(source, argNames, paramNames) {
        const key = argNames.join(',') + '|' + paramNames.join(',') + '|' + source;
        let rec = programs.get(key);
        if (rec) {
            programs.delete(key);
            programs.set(key, rec);
            return rec.handle ? rec : null;
        }
        const src = writeString('src', source);
        const names = writeString('names', argNames.concat(paramNames).join('\n'));
        const handle = state.ex.ac_compile(src.ptr, src.len, names.ptr, names.len, argNames.length);
        rec = {
            key,
            handle,
            source,
            argNames: argNames.slice(),
            paramNames: paramNames.slice(),
            error: handle ? null : lastError(),
            verified: false,     // set by the engine's differential probe
            rejected: false,
            paramValues: new Float64Array(paramNames.length),
        };
        programs.set(key, rec);
        while (programs.size > MAX_PROGRAMS) {
            const [oldKey, old] = programs.entries().next().value;
            programs.delete(oldKey);
            if (old.handle) state.ex.ac_release(old.handle);
            old.handle = 0;
        }
        return handle ? rec : null;
    }

    // Upload parameter values (slider variables) for a program. Returns false
    // when a variable holds a non-number (JS arithmetic on it would not be
    // plain float math), in which case the caller must use the JS path.
    function setParams(rec, variables) {
        const names = rec.paramNames;
        const n = names.length;
        if (n === 0) return true;
        const { ptr, view } = f64Scratch('params', n);
        for (let i = 0; i < n; i++) {
            const k = names[i];
            const v = variables && variables.has(k) ? variables.get(k) : NaN;
            if (typeof v !== 'number') return false;
            view[i] = v;
        }
        state.ex.ac_set_params(rec.handle, ptr, n);
        return true;
    }

    // ---- entry functions -> programs --------------------------------------
    // recompileFunctions() tags every compiled closure with
    //   fn.archSource = { args, body, params }
    // (args: positional lane names, body: the transpiled JS expression,
    // params: slider variables read from the `variables` Map).
    // Advanced functions are only offloaded while their JS body is the
    // built-in one; the wasm compile itself rejects names it has no port for.
    let pristineAdvanced = null;

    function advancedIsPristine(engine, name) {
        if (!pristineAdvanced) {
            pristineAdvanced = new Map();
            if (typeof ADVANCED_FUNCTION_DEFINITIONS !== 'undefined') {
                for (const d of ADVANCED_FUNCTION_DEFINITIONS) pristineAdvanced.set(d.name, d);
            }
        }
        const def = pristineAdvanced.get(name);
        const live = engine.calcJSUtils && engine.calcJSUtils.advancedCustomFunctions
            ? engine.calcJSUtils.advancedCustomFunctions[name] : null;
        if (!def || !live) return false;
        return live.bodyJsString === def.bodyJsString &&
            JSON.stringify(live.params) === JSON.stringify(def.params);
    }
    const PROBE_VALUES = [-7.3, -2, -1, -0.5, 0, 0.3, 0.5, 1, 1.7, 2, 3.14159, 10, -55.5, 2.5, 0.25, -3.9];
    const PROBE_COUNT = 24;

    function probeMatches(a, b) {
        if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }

    // Evaluate both implementations on fixed probe points; any disagreement
    // keeps this program on the JS path for good.
    function verifyProgram(engine, fn, rec) {
        const argc = rec.argNames.length;
        const lanes = [];
        for (let k = 0; k < argc; k++) {
            const lane = f64Scratch('probe-arg' + k, PROBE_COUNT);
            for (let i = 0; i < PROBE_COUNT; i++) {
                lane.view[i] = PROBE_VALUES[(i * (k + 1) * 7 + k * 3) % PROBE_VALUES.length];
            }
            lanes.push(lane.ptr);
        }
        const out = f64Scratch('probe-out', PROBE_COUNT);
        evalPtrs(rec, lanes, PROBE_COUNT, out.ptr, 0);
        refreshViews();
        const advMap = engine.calcJSUtils.getAdvancedFuncsMap();
        for (let i = 0; i < PROBE_COUNT; i++) {
            const argv = [];
            for (let k = 0; k < argc; k++) argv.push(state.f64[(lanes[k] >> 3) + i]);
            let want;
            try { want = fn(...argv, engine.variables, Math, advMap); } catch (e) { want = NaN; }
            const got = state.f64[(out.ptr >> 3) + i];
            if (typeof want !== 'number' || !probeMatches(got, want)) {
                console.debug('[archcore] probe mismatch, keeping JS path:', rec.source, argv, got, want);
                return false;
            }
        }
        return true;
    }

    // Program for a compiled entry closure (entry.func / funcX / funcY / funcZ),
    // with its parameters uploaded; null when that closure must stay on JS.
    function programFor(engine, fn) {
        if (!state.ready || !state.enabled || typeof fn !== 'function') return null;
        const meta = fn.archSource;
        if (!meta) return null;
        let rec = fn.archProgram;
        if (rec === undefined) {
            rec = null;
            const advRe = /__advanced__\.([A-Za-z_$][\w$]*)/g;
            let m;
            let ok = true;
            while ((m = advRe.exec(meta.body)) !== null) {
                if (!advancedIsPristine(engine, m[1])) { ok = false; break; }
            }
            if (ok) {
                try {
                    rec = compileProgram(meta.body, meta.args, meta.params);
                } catch (e) {
                    console.warn('[archcore] compile failed:', e);
                    rec = null;
                }
            }
            try { fn.archProgram = rec; } catch (e) { /* frozen */ }
        }
        if (!rec || !rec.handle || rec.rejected) return null;
        if (!setParams(rec, engine.variables)) return null;
        if (!rec.verified) {
            if (!verifyProgram(engine, fn, rec)) {
                rec.rejected = true;
                return null;
            }
            rec.verified = true;
            setParams(rec, engine.variables);
        }
        return rec;
    }

    // Evaluate over explicit lane arrays already living in wasm memory.
    // argPtrs: array of byte pointers (one per program arg, 0 if unused).
    function evalPtrs(rec, argPtrs, n, outPtr, flags) {
        const tablePtr = scratchPtr('argtable', 32);
        refreshViews();
        for (let k = 0; k < 8; k++) state.i32[(tablePtr >> 2) + k] = argPtrs[k] || 0;
        return state.ex.ac_eval(rec.handle, tablePtr, n, outPtr, flags);
    }

    // Evaluate on an affine lattice: spec is [[base, step, div, mod], ...] per arg.
    // Returns a Float64Array view into scratch memory named `outName`.
    function evalAffine(rec, spec, n, flags, outName) {
        const argc = rec.argNames.length;
        const specBuf = f64Scratch('affine-spec', Math.max(argc, 1) * 4);
        for (let k = 0; k < argc; k++) {
            const s = spec[k] || [0, 0, 1, 0];
            specBuf.view[k * 4] = s[0];
            specBuf.view[k * 4 + 1] = s[1];
            specBuf.view[k * 4 + 2] = s[2] || 1;
            specBuf.view[k * 4 + 3] = s[3] || 0;
        }
        const out = f64Scratch(outName || 'affine-out', Math.max(n, 1));
        state.ex.ac_eval_affine(rec.handle, specBuf.ptr, n, out.ptr, flags);
        refreshViews();
        return state.f64.subarray(out.ptr >> 3, (out.ptr >> 3) + n);
    }

    return {
        FLAG_STRICT_POW,
        state,
        init,
        get ready() { return state.ready; },
        get active() { return state.ready && state.enabled; },
        get enabled() { return state.enabled; },
        setEnabled(on) {
            state.enabled = !!on;
            try { localStorage.setItem('archcore-enabled', on ? '1' : '0'); } catch (e) { /* ignore */ }
        },
        onReady(cb) {
            if (state.ready || state.failed) cb(state.ready);
            else readyCallbacks.push(cb);
        },
        get exports() { return state.ex; },
        refreshViews,
        views() { refreshViews(); return state; },
        scratchPtr,
        f64Scratch,
        writeString,
        compileProgram,
        setParams,
        programFor,
        evalPtrs,
        evalAffine,
        lastError,
        programCount() { return programs.size; },
        // True when the named advanced function still has its built-in
        // definition (wasm ports must not silently shadow user redefinitions).
        advancedIsPristine,
        // Algorithm kernels register here (see wasm/js/kernels/*.js). Each
        // takes the engine instance and returns true when it fully handled
        // the call, false to let the original JS code run.
        kernels: {},
    };
})();
// `const` globals are not properties of window; expose it for guards/debugging.
window.ArchCore = ArchCore;
