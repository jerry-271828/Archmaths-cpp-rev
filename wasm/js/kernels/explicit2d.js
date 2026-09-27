// ArchCore adapter for the "explicit2d" kernel: plotExplicitFunctionGL()'s
// point-sampling for plotType 'y'/'x' (ac_explicit2d_run), and
// recalculateParametricCache()'s 2D parametric sampling (ac_parametric_cache_run).
// Backed by wasm/core/kernels/explicit2d.cpp.
(function () {
    // Builds funcEntry.webglVertices + appends to engine.plottedFunctionPoints
    // from the kernel's sampling of funcEntry.func (plotType 'y' or 'x').
    // Returns true when handled (mirroring the original method's own
    // `if (!funcEntry.webglVertices) { ...; funcEntry.webglVertices = ...; }`
    // block); false to let that original block run.
    function explicitSamples(engine, funcEntry, cssWidth, cssHeight) {
        if (!ArchCore.active) return false;
        if (funcEntry.plotType !== 'y' && funcEntry.plotType !== 'x') return false;
        const rec = ArchCore.programFor(engine, funcEntry.func);
        if (!rec || rec.argNames.length !== 1) return false;

        const entryThickness = engine.highPerformancePlottingEnabled ? 1 : (funcEntry.thickness || 3);
        const useQuads = entryThickness > 1.5;
        const lineThicknessMath = useQuads ? (entryThickness / engine.scale) : (1.5 / engine.scale);
        const isYType = funcEntry.plotType === 'y';
        const explicitPrecisionSliderValue = engine.explicitPrecisionSlider
            ? engine.explicitPrecisionSlider.options.value : 2;

        const ex = ArchCore.exports;
        const count = ex.ac_explicit2d_run(
            rec.handle, isYType ? 0 : 1,
            cssWidth, cssHeight,
            engine.offset.x, engine.offset.y, engine.scale,
            engine.canvas.clientWidth, engine.canvas.clientHeight,
            engine.adaptivePlottingEnabled ? 1 : 0,
            engine.autoBreakpointDetectionEnabled ? 1 : 0,
            engine.adaptiveExtendEnabled ? 1 : 0,
            engine.explicitPrecisionStep, explicitPrecisionSliderValue,
            lineThicknessMath, useQuads ? 1 : 0,
            0 // flags: explicit plots use the non-strict pow
        );
        if (count < 0) return false; // wrong-arity/invalid handle (programFor should prevent this)

        const vptr = ex.ac_explicit2d_vertices_ptr();
        const vlen = ex.ac_explicit2d_vertices_len();
        const pptr = ex.ac_explicit2d_points_ptr();
        const plen = ex.ac_explicit2d_points_len();
        const views = ArchCore.views(); // refresh AFTER the run call, before use
        funcEntry.webglVertices = new Float32Array(views.f32.subarray(vptr >> 2, (vptr >> 2) + vlen));
        const f64 = views.f64;
        for (let i = 0; i < plen; i += 2) {
            engine.plottedFunctionPoints.push({ x: f64[(pptr >> 3) + i], y: f64[(pptr >> 3) + i + 1] });
        }
        return true;
    }

    // Fills funcEntry.cachedPoints (with null discontinuity sentinels) and
    // appends to engine.plottedFunctionPoints, for both 'parametric' and
    // 'parametric3d' (funcZ is never evaluated -- see the .cpp header comment).
    function parametricCache(engine, funcEntry) {
        if (!ArchCore.active) return false;
        const recX = ArchCore.programFor(engine, funcEntry.funcX);
        if (!recX || recX.argNames.length !== 1) return false;
        const recY = ArchCore.programFor(engine, funcEntry.funcY);
        if (!recY || recY.argNames.length !== 1) return false;

        const ex = ArchCore.exports;
        const count = ex.ac_parametric_cache_run(
            recX.handle, recY.handle,
            engine.tmin, engine.tmax, engine.explicitPrecisionStep,
            0 // flags: parametric plots use the non-strict pow
        );
        if (count < 0) return false;

        const cptr = ex.ac_parametric_cache_ptr();
        const clen = ex.ac_parametric_cache_len();
        const pptr = ex.ac_parametric_cache_plotted_ptr();
        const plen = ex.ac_parametric_cache_plotted_len();
        const { f64 } = ArchCore.views(); // refresh AFTER the run call, before use

        const cachedPoints = new Array(clen / 2);
        for (let i = 0, j = 0; i < clen; i += 2, j++) {
            const x = f64[(cptr >> 3) + i];
            const y = f64[(cptr >> 3) + i + 1];
            cachedPoints[j] = Number.isNaN(x) ? null : { x, y };
        }
        funcEntry.cachedPoints = cachedPoints;
        for (let i = 0; i < plen; i += 2) {
            engine.plottedFunctionPoints.push({ x: f64[(pptr >> 3) + i], y: f64[(pptr >> 3) + i + 1] });
        }
        return true;
    }

    ArchCore.kernels.explicitSamples = explicitSamples;
    ArchCore.kernels.parametricCache = parametricCache;
})();
