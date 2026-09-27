// Node helpers shared by the archcore tests: load the wasm with WASI stubs and
// pull the page's built-in advanced function definitions out of the HTML.
import fs from 'node:fs';

export async function loadCore(wasmPath) {
    let memory;
    const decoder = new TextDecoder();
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {
        wasi_snapshot_preview1: {
            fd_write(fd, iovs, n, nw) {
                const i32 = new Int32Array(memory.buffer);
                let s = '';
                let w = 0;
                for (let i = 0; i < n; i++) {
                    const p = i32[(iovs >> 2) + i * 2];
                    const l = i32[(iovs >> 2) + i * 2 + 1];
                    s += decoder.decode(new Uint8Array(memory.buffer, p, l));
                    w += l;
                }
                process.stderr.write('[archcore] ' + s);
                i32[nw >> 2] = w;
                return 0;
            },
            fd_close: () => 0,
            fd_seek: () => 0,
            proc_exit: (c) => { throw new Error('exit ' + c); },
        },
    });
    const ex = instance.exports;
    memory = ex.memory;
    ex._initialize();
    const enc = new TextEncoder();
    const f64 = () => new Float64Array(memory.buffer);
    const u8 = () => new Uint8Array(memory.buffer);
    const i32 = () => new Int32Array(memory.buffer);
    function str(s) {
        const b = enc.encode(s);
        const p = ex.ac_alloc(b.length + 1);
        u8().set(b, p);
        u8()[p + b.length] = 0;
        return [p, b.length];
    }
    return {
        ex,
        memory,
        f64,
        i32,
        u8,
        compile(src, args, params) {
            const [sp, sl] = str(src);
            const [np, nl] = str(args.concat(params).join('\n'));
            const h = ex.ac_compile(sp, sl, np, nl, args.length);
            ex.ac_free(sp);
            ex.ac_free(np);
            return h;
        },
        lastError() {
            const p = ex.ac_error_ptr();
            return decoder.decode(new Uint8Array(memory.buffer, p, ex.ac_error_len()));
        },
        setParams(h, values) {
            const p = ex.ac_alloc(Math.max(values.length, 1) * 8);
            f64().set(values, p >> 3);
            ex.ac_set_params(h, p, values.length);
            ex.ac_free(p);
        },
        evalLanes(h, lanes, n, flags = 0) {
            const ptrs = lanes.map((lane) => {
                const p = ex.ac_alloc(n * 8);
                f64().set(lane.subarray(0, n), p >> 3);
                return p;
            });
            const table = ex.ac_alloc(32);
            ptrs.forEach((p, k) => { i32()[(table >> 2) + k] = p; });
            const out = ex.ac_alloc(Math.max(n, 1) * 8);
            ex.ac_eval(h, table, n, out, flags);
            const result = f64().slice(out >> 3, (out >> 3) + n);
            ptrs.forEach((p) => ex.ac_free(p));
            ex.ac_free(table);
            ex.ac_free(out);
            return result;
        },
        evalOne(h, args, flags = 0) {
            return this.evalLanes(h, args.map((v) => Float64Array.of(v)), 1, flags)[0];
        },
        // CalcJs scalar ABI (v2): nArgs = 0, all names are params.
        compileCalc(src, params, userFns = '', steps = 100) {
            const [sp, sl] = str(src);
            const [np, nl] = str(params.join('\n'));
            const [up, ul] = str(userFns);
            const h = ex.ac_calc_compile(sp, sl, np, nl, 0, up, ul, steps);
            ex.ac_free(sp);
            ex.ac_free(np);
            ex.ac_free(up);
            return h;
        },
        // CalcJs ABI with explicit lane args: names = arg names followed by
        // param names, the first nArgs are lane inputs (root-finding kernel).
        compileCalcArgs(src, names, nArgs, userFns = '', steps = 100) {
            const [sp, sl] = str(src);
            const [np, nl] = str(names.join('\n'));
            const [up, ul] = str(userFns);
            const h = ex.ac_calc_compile(sp, sl, np, nl, nArgs, up, ul, steps);
            ex.ac_free(sp);
            ex.ac_free(np);
            ex.ac_free(up);
            return h;
        },
        acRootRun(h, x0) { return ex.ac_root_run(h, x0); },
        evalCalcOne(h, values) {
            if (values.length > 0) {
                const p = ex.ac_alloc(values.length * 8);
                f64().set(values, p >> 3);
                ex.ac_set_params(h, p, values.length);
                ex.ac_free(p);
            }
            return ex.ac_calc_eval1(h);
        },
    };
}

// Returns { name: compiledFunction } for ADVANCED_FUNCTION_DEFINITIONS in the page.
export function extractAdvancedFunctions(html) {
    const start = html.indexOf('const ADVANCED_FUNCTION_DEFINITIONS = [');
    if (start < 0) throw new Error('ADVANCED_FUNCTION_DEFINITIONS not found');
    // Walk to the matching closing bracket, skipping template literals.
    let i = html.indexOf('[', start);
    let depth = 0;
    let inTpl = false;
    for (; i < html.length; i++) {
        const c = html[i];
        if (inTpl) {
            if (c === '\\') { i++; continue; }
            if (c === '`') inTpl = false;
            continue;
        }
        if (c === '`') { inTpl = true; continue; }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) break; }
    }
    const literal = html.slice(html.indexOf('[', start), i + 1);
    const defs = new Function(`return ${literal};`)();
    const out = {};
    for (const d of defs) out[d.name] = new Function(...d.params, d.bodyJsString);
    out.__defs = defs;
    return out;
}
