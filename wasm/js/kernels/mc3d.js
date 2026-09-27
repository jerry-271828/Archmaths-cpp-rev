// ArchCore adapter for the "mc3d" kernel: recalculate3D()'s two
// marching-cubes volumetric mesh blocks -- the true implicit3d surface
// (plotType === 'implicit3d') and the implicit-curve-extruded-to-3D "wall"
// (is2D && entry.extendTo3D && plotType === 'implicit'). Backed by
// wasm/core/kernels/mc3d.cpp (shared edgeTable/triTable/getOffset with the
// page, batched grid + gradient evaluation).
(function () {
    // Shared tail: read the kernel's float32 vertex/normal output (views
    // fetched AFTER the run call, per the stale-view hazard) and, if
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

    // Both marching-cubes blocks in the page share this resolution formula.
    function mcResFor(engine) {
        return Math.max(10, Math.min(160, Math.floor(200 / engine.implicitPrecisionStep)));
    }

    // True implicit3d surface: entry.func(x,y,z,...), 3-arg program required.
    // entry: the 'implicit3d' function entry; index: its entries[] index;
    // range: this.bounds3D (already resolved by the caller).
    function mcImplicit3d(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 3) return false;

        const mcRes = mcResFor(engine);
        const ex = ArchCore.exports;
        const ok = ex.ac_mc3d_implicit3d(
            rec.handle, mcRes, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            ArchCore.FLAG_STRICT_POW
        );
        if (!ok) return false; // invalid handle (programFor should prevent this)

        const vptr = ex.ac_mc3d_vertices_ptr();
        const vlen = ex.ac_mc3d_vertices_len();
        const nptr = ex.ac_mc3d_normals_ptr();
        const nlen = ex.ac_mc3d_normals_len();
        uploadMesh(engine, index, entry, vptr, vlen, nptr, nlen);
        return true;
    }

    // Implicit-curve-extruded-to-3D wall: entry.func(x,y,...), 2-arg program
    // required. entry: the 'implicit' function entry with extendTo3D set.
    function mcExtrusion(engine, entry, index, range) {
        if (!ArchCore.active) return false;
        const rec = ArchCore.programFor(engine, entry.func);
        if (!rec || rec.argNames.length !== 2) return false;

        const mcRes = mcResFor(engine);
        const ex = ArchCore.exports;
        const ok = ex.ac_mc3d_extrusion(
            rec.handle, mcRes, range,
            engine.offset3D.x, engine.offset3D.y, engine.scale3D,
            ArchCore.FLAG_STRICT_POW
        );
        if (!ok) return false;

        const vptr = ex.ac_mc3d_vertices_ptr();
        const vlen = ex.ac_mc3d_vertices_len();
        const nptr = ex.ac_mc3d_normals_ptr();
        const nlen = ex.ac_mc3d_normals_len();
        uploadMesh(engine, index, entry, vptr, vlen, nptr, nlen);
        return true;
    }

    ArchCore.kernels.mcImplicit3d = mcImplicit3d;
    ArchCore.kernels.mcExtrusion = mcExtrusion;
})();
