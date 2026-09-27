// ArchCore adapter for the "implicit2d" kernel: per-block 2D implicit
// curve/inequality rasterization (marching squares), backed by
// wasm/core/kernels/implicit2d.cpp. Hooked at the top of
// ArchEngine.processSingleBlockForImplicit.
//
// Functions whose compiled Program is not available (ArchCore.programFor
// returns null - unsupported syntax, a modified "advanced" function, a
// failed differential probe, ...) are evaluated with a plain JS loop, using
// the exact same call shapes as the original method, straight into the wasm
// value buffer ("hybrid" mode); the C++ marching-squares/fill pass then runs
// over the whole buffer regardless of how each slice was filled.
(function () {
    // entry.plotType -> PlotTypeCode (must match implicit2d.cpp's PlotTypeCode).
    function plotTypeCode(pt) {
        if (pt === 'implicit') return 0;      // kImplicit
        if (pt === 'implicit3d' || pt === 'z') return 1; // kImplicit3D
        if (pt === 'x3d') return 2;           // kX3D
        if (pt === 'y3d') return 3;           // kY3D
        return 0;
    }
    // entry.sign -> SignCode (must match implicit2d.cpp's SignCode). The C++
    // side ignores this for non-'implicit' plot types (effectiveSign '=').
    function signCode(sign) {
        switch (sign) {
            case '=': return 0;  // kEq
            case '>=': return 1; // kGe
            case '<=': return 2; // kLe
            case '>': return 3;  // kGt
            case '<': return 4;  // kLt
            default: return 0;
        }
    }

    function implicitBlock(engine, cellCenterXMath, cellCenterYMath, unitStep) {
        if (!ArchCore.active) return false;
        const ex = ArchCore.exports;

        // Mirror the side effects the JS method performs unconditionally
        // before its own early-return (implictjump is a real engine field).
        engine.implicttempdata.length = 0;
        const cellSizeInPixels = unitStep * engine.scale;
        let implictjump = Math.ceil(cellSizeInPixels / engine.implicitPrecisionStep);
        if (implictjump <= 0) implictjump = 1;
        engine.implictjump = implictjump;
        const numPoints1D = implictjump + 1;
        const subCellStepMath = unitStep / implictjump;
        const cellMinXMath = cellCenterXMath - unitStep / 2;
        const cellMaxYMath = cellCenterYMath + unitStep / 2;

        const implicitFunctions = engine.entries.filter(e =>
            e.type === 'function' &&
            (e.plotType === 'implicit' || e.plotType === 'implicit3d' || e.plotType === 'z' || e.plotType === 'x3d' || e.plotType === 'y3d') &&
            e.func && !e.compilationError && (e.visible || engine.showHiddenMath) &&
            (engine.overlayDrawingEnabled || !['implicit3d', 'z', 'x3d', 'y3d'].includes(e.plotType))
        );
        if (implicitFunctions.length === 0) return true;

        const nFuncs = implicitFunctions.length;
        const origIndex = new Array(nFuncs);
        const handlesArr = new Int32Array(nFuncs);
        const plotTypesArr = new Int32Array(nFuncs);
        const signsArr = new Int32Array(nFuncs);
        const hybrid = []; // { f, entry, plotType }

        for (let f = 0; f < nFuncs; f++) {
            const entry = implicitFunctions[f];
            origIndex[f] = engine.entries.indexOf(entry);
            plotTypesArr[f] = plotTypeCode(entry.plotType);
            signsArr[f] = signCode(entry.sign);
            const rec = ArchCore.programFor(engine, entry.func);
            if (rec) {
                handlesArr[f] = rec.handle;
            } else {
                handlesArr[f] = 0;
                hybrid.push({ f: f, entry: entry, plotType: entry.plotType });
            }
        }

        // ---- allocate (each call below may grow wasm memory) ----
        const valuesPtr = ex.ac_implicit2d_values_ptr(nFuncs, numPoints1D);
        if (!valuesPtr) return false;
        const hPtr = ArchCore.scratchPtr('implicit2d-handles', nFuncs * 4);
        const ptPtr = ArchCore.scratchPtr('implicit2d-plotTypes', nFuncs * 4);
        const snPtr = ArchCore.scratchPtr('implicit2d-signs', nFuncs * 4);

        // Refresh once after every allocation above, then do all direct
        // writes before the next wasm call (stale-view hazard).
        let views = ArchCore.views();
        views.i32.set(handlesArr, hPtr >> 2);
        views.i32.set(plotTypesArr, ptPtr >> 2);
        views.i32.set(signsArr, snPtr >> 2);

        // ---- hybrid grid fill: functions that must stay on the JS path ----
        if (hybrid.length > 0) {
            const xs = new Float64Array(numPoints1D);
            const ys = new Float64Array(numPoints1D);
            for (let i = 0; i < numPoints1D; i++) {
                xs[i] = cellMinXMath + i * subCellStepMath;
                ys[i] = cellMaxYMath - i * subCellStepMath;
            }
            // Same local pow override as the original method's advancedFuncsMap
            // (real-domain restriction: NaN for negative base, non-integer exp).
            const baseMap = engine.calcJSUtils.getAdvancedFuncsMap();
            const advancedFuncsMap = Object.assign({}, baseMap);
            const originalPow = advancedFuncsMap.pow;
            advancedFuncsMap.pow = (a, b) => {
                if (a < 0 && Math.abs(b - Math.round(b)) > 1e-10) return NaN;
                return originalPow(a, b);
            };
            const gN = numPoints1D * numPoints1D;
            const f64 = views.f64; // valid: no allocation happens in this loop
            const base = valuesPtr >> 3;
            for (let h = 0; h < hybrid.length; h++) {
                const funcEntry = hybrid[h].entry;
                const plotType = hybrid[h].plotType;
                const sliceBase = base + hybrid[h].f * gN;
                for (let iy = 0; iy < numPoints1D; iy++) {
                    const y = ys[iy];
                    const rowBase = sliceBase + iy * numPoints1D;
                    for (let ix = 0; ix < numPoints1D; ix++) {
                        const x = xs[ix];
                        let value = NaN;
                        try {
                            if (plotType === 'implicit3d' || plotType === 'z') {
                                value = funcEntry.func(x, y, 0, engine.variables, Math, advancedFuncsMap);
                            } else if (plotType === 'x3d') {
                                const val = funcEntry.func(0, y, 0, engine.variables, Math, advancedFuncsMap);
                                value = x - val;
                            } else if (plotType === 'y3d') {
                                const val = funcEntry.func(x, 0, 0, engine.variables, Math, advancedFuncsMap);
                                value = y - val;
                            } else {
                                value = funcEntry.func(x, y, engine.variables, Math, advancedFuncsMap);
                            }
                        } catch (e) { value = NaN; }
                        f64[rowBase + ix] = Number.isFinite(value) ? value : NaN;
                    }
                }
            }
        }

        // ---- run marching squares + fill triangulation in wasm ----
        const ok = ex.ac_implicit2d_run(
            nFuncs, numPoints1D,
            subCellStepMath, cellMinXMath, cellMaxYMath,
            unitStep, engine.scale, engine.implicitPrecisionStep,
            engine.autoBreakpointDetectionEnabled ? 1 : 0,
            hPtr, ptPtr, snPtr,
            ArchCore.FLAG_STRICT_POW
        );
        if (!ok) return false;

        views = ArchCore.views(); // refresh AFTER the run call, before reading

        const segCount = ex.ac_implicit2d_seg_count();
        if (segCount > 0) {
            const segCoordsPtr = ex.ac_implicit2d_seg_coords_ptr();
            const segFuncPtr = ex.ac_implicit2d_seg_func_ptr();
            const coords = views.f64.subarray(segCoordsPtr >> 3, (segCoordsPtr >> 3) + segCount * 4);
            const funcs = views.i32.subarray(segFuncPtr >> 2, (segFuncPtr >> 2) + segCount);
            const plotData = engine.implictplotdata;
            const points = engine.plottedFunctionPoints;
            for (let i = 0; i < segCount; i++) {
                const o = i * 4;
                const x1 = coords[o], y1 = coords[o + 1], x2 = coords[o + 2], y2 = coords[o + 3];
                const oi = origIndex[funcs[i]];
                plotData.push([x1, y1, x2, y2, oi]);
                points.push({ x: x1, y: y1 });
                points.push({ x: x2, y: y2 });
            }
        }

        // Triangles arrive tagged per-triangle, in the exact raster-scan
        // (cell, funcIdx) emission order the JS marching-squares pass uses;
        // replaying them in that order reproduces engine.implicitFillData's
        // Map key insertion order (a function's key is created the first
        // time ANY cell yields a triangle for it) as well as each key's
        // array content order, not just its final contents.
        const fillCount = ex.ac_implicit2d_fill_count();
        if (fillCount > 0) {
            const fillCoordsPtr = ex.ac_implicit2d_fill_coords_ptr();
            const fillFuncPtr = ex.ac_implicit2d_fill_func_ptr();
            const coords = views.f64.subarray(fillCoordsPtr >> 3, (fillCoordsPtr >> 3) + fillCount * 6);
            const funcs = views.i32.subarray(fillFuncPtr >> 2, (fillFuncPtr >> 2) + fillCount);
            for (let i = 0; i < fillCount; i++) {
                const oi = origIndex[funcs[i]];
                let arr = engine.implicitFillData.get(oi);
                if (!arr) { arr = []; engine.implicitFillData.set(oi, arr); }
                const o = i * 6;
                arr.push(coords[o], coords[o + 1], coords[o + 2], coords[o + 3], coords[o + 4], coords[o + 5]);
            }
        }

        return true;
    }

    ArchCore.kernels.implicitBlock = implicitBlock;
})();
