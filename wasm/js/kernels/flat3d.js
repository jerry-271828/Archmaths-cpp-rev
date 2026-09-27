// ArchCore adapter for the "flat3d" kernel: recalculate3D()'s sliceAxis
// marching-squares outline, the flat 2D-implicit-at-z=0 overlay (outline +
// fill), and the parametric/parametric3d + plain x/y curve-shown-flat-at-z=0
// line blocks. Backed by wasm/core/kernels/flat3d.cpp.
(function () {
    // entry.plotType -> plotTypeCode for ac_flat3d_slice_run.
    function slicePlotTypeCode(plotType) {
        if (plotType === 'z') return 0;
        if (plotType === 'x3d') return 1;
        if (plotType === 'y3d') return 2;
        if (plotType === 'implicit3d') return 3;
        return -1;
    }
    function sliceAxisCode(axis) {
        if (axis === 'x') return 0;
        if (axis === 'y') return 1;
        if (axis === 'z') return 2;
        return -1;
    }
    function signCode(sign) {
        switch (sign) {
            case '=': return 0;
            case '>=': return 1;
            case '<=': return 2;
            case '>': return 3;
            case '<': return 4;
            default: return 0;
        }
    }

    // ---- sliceAxis marching-squares outline (is3D && entry.sliceAxis !== 'none') ----
    function slice3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        const plotTypeCode = slicePlotTypeCode(entry.plotType);
        const axisCode = sliceAxisCode(entry.sliceAxis);
        if (plotTypeCode < 0 || axisCode < 0) return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 3) return false;

        const mcRes = Math.max(10, Math.min(200, Math.floor(250 / engine.implicitPrecisionStep)));
        const entryThickness = engine.highPerformancePlottingEnabled ? 1 : (entry.thickness || 3);
        const useThickLines = entryThickness > 1.5;

        const ex = ArchCore.exports;
        const floatLen = ex.ac_flat3d_slice_run(
            rec.handle, plotTypeCode, mcRes, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            axisCode, entry.sliceVal,
            useThickLines ? 1 : 0, ArchCore.FLAG_STRICT_POW
        );
        if (floatLen < 0) return false; // invalid handle (programFor should prevent this)

        const stride = useThickLines ? 7 : 3;
        const count = floatLen / stride;
        if (count > 0) {
            const ptr = ex.ac_flat3d_slice_verts_ptr();
            const f32 = ArchCore.views().f32; // refresh AFTER the run+ptr calls, before use
            const verts = f32.subarray(ptr >> 2, (ptr >> 2) + floatLen);
            const gl = engine.gl;
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
            engine.cache3D.lines.set(index, {
                vbo, count, color: entry.color,
                mode: useThickLines ? gl.TRIANGLES : gl.LINES,
                thickness: entryThickness, isThick: useThickLines,
            });
        }
        return true;
    }

    // ---- flat 2D-implicit overlay at z=0 (plotType 'implicit', overlay in 3D) ----
    function flatImplicit3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        if (entry.plotType !== 'implicit') return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 2) return false;

        const mcRes = Math.max(10, Math.min(200, Math.floor(250 / engine.implicitPrecisionStep)));
        const entryThickness = engine.highPerformancePlottingEnabled ? 1 : (entry.thickness || 3);
        const useThickLines = entryThickness > 1.5;
        const effectiveSign = entry.sign || '=';
        const sCode = signCode(effectiveSign);
        const autoBreak = engine.autoBreakpointDetectionEnabled ? 1 : 0;

        const ex = ArchCore.exports;
        const ok = ex.ac_flat3d_implicit_run(
            rec.handle, mcRes, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            sCode, autoBreak, useThickLines ? 1 : 0, ArchCore.FLAG_STRICT_POW
        );
        if (ok < 0) return false;

        // Read every output's ptr/len BEFORE refreshing views (none of these
        // getters allocate), then refresh once and slice both payloads.
        const lineLen = ex.ac_flat3d_implicit_lines_len();
        const linePtr = ex.ac_flat3d_implicit_lines_ptr();
        const fillLen = ex.ac_flat3d_implicit_fill_verts_len();
        const fillPtr = ex.ac_flat3d_implicit_fill_verts_ptr();
        const normLen = ex.ac_flat3d_implicit_fill_norms_len();
        const normPtr = ex.ac_flat3d_implicit_fill_norms_ptr();
        const f32 = ArchCore.views().f32;
        const gl = engine.gl;

        // The page's shared tail after its parametric/x-y/implicit dispatch
        // unconditionally calls cache3D.lines.set (even for an empty
        // buffer, e.g. when autoBreakpointDetection's skipOutline heuristic
        // suppresses every cell) -- no `if (count > 0)` guard, unlike the
        // sliceAxis block. Mirror that exactly.
        {
            const verts = f32.subarray(linePtr >> 2, (linePtr >> 2) + lineLen);
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
            const stride = useThickLines ? 7 : 3;
            engine.cache3D.lines.set(index, {
                vbo, count: lineLen / stride, color: entry.color,
                mode: useThickLines ? gl.TRIANGLES : gl.LINES,
                thickness: entryThickness, isThick: useThickLines,
            });
        }

        if (fillLen > 0) {
            const verts = f32.subarray(fillPtr >> 2, (fillPtr >> 2) + fillLen);
            const norms = f32.subarray(normPtr >> 2, (normPtr >> 2) + normLen);
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
            const nbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
            gl.bufferData(gl.ARRAY_BUFFER, norms, gl.STATIC_DRAW);
            engine.cache3D.meshes.set(index, { vbo, nbo, count: fillLen / 3, color: entry.color });
        }

        return true;
    }

    // ---- parametric/parametric3d curve, and plain x/y curve at z=0 ----
    function curves3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        const plotType = entry.plotType;
        const entryThickness = engine.highPerformancePlottingEnabled ? 1 : (entry.thickness || 3);
        const useThickLines = entryThickness > 1.5;
        const ex = ArchCore.exports;
        let floatLen;
        let getPtr;

        if (plotType === 'parametric' || plotType === 'parametric3d') {
            const recX = ArchCore.programFor(engine, entry.funcX);
            const recY = ArchCore.programFor(engine, entry.funcY);
            if (!recX || !recY || recX.argNames.length !== 1 || recY.argNames.length !== 1) return false;
            let handleZ = 0;
            if (plotType === 'parametric3d') {
                const recZ = ArchCore.programFor(engine, entry.funcZ);
                if (!recZ || recZ.argNames.length !== 1) return false;
                handleZ = recZ.handle;
            }
            const numSteps = Math.max(100, Math.floor(engine.explicitPrecisionStep * 200));
            floatLen = ex.ac_flat3d_parametric_run(
                recX.handle, recY.handle, handleZ, numSteps, engine.tmin, engine.tmax,
                range, engine.offset3D.x, engine.offset3D.y, engine.scale3D,
                useThickLines ? 1 : 0, ArchCore.FLAG_STRICT_POW
            );
            if (floatLen < 0) return false;
            getPtr = ex.ac_flat3d_parametric_verts_ptr;
        } else if (plotType === 'y' || plotType === 'x') {
            const rec = ArchCore.programFor(engine, entry.func);
            if (!rec || rec.argNames.length !== 1) return false;
            const numSteps = Math.max(100, Math.floor(engine.explicitPrecisionStep * 200));
            const isYType = plotType === 'y' ? 1 : 0;
            floatLen = ex.ac_flat3d_xy_run(
                rec.handle, isYType, numSteps, range,
                engine.offset3D.x, engine.offset3D.y, engine.scale3D,
                useThickLines ? 1 : 0, ArchCore.FLAG_STRICT_POW
            );
            if (floatLen < 0) return false;
            getPtr = ex.ac_flat3d_xy_verts_ptr;
        } else {
            return false;
        }

        const stride = useThickLines ? 7 : 3;
        const count = floatLen / stride;
        // The page's shared tail after its parametric/x-y/implicit dispatch
        // (arch-current.html's `const count = lineVerts.length / (...); ...
        // this.cache3D.lines.set(index, {...})`) sits OUTSIDE and AFTER the
        // whole if/else-if chain, so it runs unconditionally for these two
        // branches too -- even when floatLen is 0 (e.g. every sample was
        // non-finite or out of range). No `if (count > 0)` guard, unlike the
        // sliceAxis block. Mirror that exactly (see flatImplicit3d() above).
        {
            const ptr = getPtr();
            const f32 = ArchCore.views().f32; // refresh AFTER the run+ptr calls, before use
            const verts = f32.subarray(ptr >> 2, (ptr >> 2) + floatLen);
            const gl = engine.gl;
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
            engine.cache3D.lines.set(index, {
                vbo, count, color: entry.color,
                mode: useThickLines ? gl.TRIANGLES : gl.LINES,
                thickness: entryThickness, isThick: useThickLines,
            });
        }
        return true;
    }

    ArchCore.kernels.slice3d = slice3d;
    ArchCore.kernels.flatImplicit3d = flatImplicit3d;
    ArchCore.kernels.curves3d = curves3d;
})();
