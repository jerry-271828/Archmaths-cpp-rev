// ArchCore adapter for the "surface3d" kernel: recalculate3D()'s true 3D
// explicit-surface block (plotType 'z'/'x3d'/'y3d') and the explicit-curve
// extrusion ("ribbon") block, backed by wasm/core/kernels/surface3d.cpp.
(function () {
    // entry.plotType -> depAxis for ac_surface3d_run (0=z, 1=x3d, 2=y3d).
    function depAxisFor(plotType) {
        if (plotType === 'z') return 0;
        if (plotType === 'x3d') return 1;
        if (plotType === 'y3d') return 2;
        return -1;
    }

    // Shared tail: read the kernel's float32 vertex/normal output (view
    // fetched AFTER every wasm call per the stale-view hazard) and, if
    // non-empty, upload it exactly like the original inline gl calls.
    function uploadMesh(engine, index, entry, vptr, vlen, nptr, nlen) {
        if (vlen <= 0) return;
        const f32 = ArchCore.views().f32; // refresh AFTER the run call, before use
        const vertsView = f32.subarray(vptr >> 2, (vptr >> 2) + vlen);
        const normsView = f32.subarray(nptr >> 2, (nptr >> 2) + nlen);
        const gl = engine.gl;
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, vertsView, gl.STATIC_DRAW);
        const nbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
        gl.bufferData(gl.ARRAY_BUFFER, normsView, gl.STATIC_DRAW);
        engine.cache3D.meshes.set(index, { vbo, nbo, count: vlen / 3, color: entry.color });
    }

    // entry: the 'z'/'x3d'/'y3d' function entry; index: its entries[] index;
    // range: this.bounds3D (already resolved by the caller).
    function surface3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        const depAxis = depAxisFor(entry.plotType);
        if (depAxis < 0) return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 3) return false;

        const resolution = Math.max(10, Math.floor(15 * engine.explicitPrecisionStep));
        const ex = ArchCore.exports;
        const count = ex.ac_surface3d_run(
            rec.handle, depAxis, resolution, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            engine.autoBreakpointDetectionEnabled ? 1 : 0, engine.explicitPrecisionStep,
            ArchCore.FLAG_STRICT_POW
        );
        if (count < 0) return false; // invalid handle (programFor should prevent this)

        const vptr = ex.ac_surface3d_vertices_ptr();
        const vlen = ex.ac_surface3d_vertices_len();
        const nptr = ex.ac_surface3d_normals_ptr();
        const nlen = ex.ac_surface3d_normals_len();
        uploadMesh(engine, index, entry, vptr, vlen, nptr, nlen);
        return true;
    }

    // entry: the 'x'/'y' function entry with extendTo3D set.
    function ribbon3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        let axis;
        if (entry.plotType === 'y') axis = 0;
        else if (entry.plotType === 'x') axis = 1;
        else return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 1) return false;

        const resolution = Math.max(10, Math.floor(15 * engine.explicitPrecisionStep));
        const ex = ArchCore.exports;
        const count = ex.ac_ribbon3d_run(
            rec.handle, axis, resolution, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            ArchCore.FLAG_STRICT_POW
        );
        if (count < 0) return false;

        const vptr = ex.ac_ribbon3d_vertices_ptr();
        const vlen = ex.ac_ribbon3d_vertices_len();
        const nptr = ex.ac_ribbon3d_normals_ptr();
        const nlen = ex.ac_ribbon3d_normals_len();
        uploadMesh(engine, index, entry, vptr, vlen, nptr, nlen);
        return true;
    }

    ArchCore.kernels.surface3d = surface3d;
    ArchCore.kernels.ribbon3d = ribbon3d;
})();
