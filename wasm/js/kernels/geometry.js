// ArchCore adapter for the "geometry" kernel: recalculateGeometryObjects()
// (arch-current.html:16467-17354), backed by wasm/core/kernels/geometry*.cpp.
//
// Guard + fallback contract: returns true only when the ENTIRE call was
// computed by the wasm kernel (every geometry entry compiled and every group
// accepted every entry); any serialization/compile/run problem returns false
// so the original JS body runs. All output rows are read back BEFORE anything
// is written to the entries, and apply order matches the kernel's entry order
// so detailsString generation observes the same mid-loop staleness as JS.
(function () {
    const GEO_STRIDE = 40;
    const MAX_CACHED = 8;

    // GeoType ids, mirroring geometry_common.h.
    const T = {
        point: 0, midpoint: 1, intersect: 2, segment: 3, ray: 4, line: 5, vector: 6,
        perpendicularline: 7, parallelline: 8, anglebisector: 9, circle: 10,
        ellipse: 11, ellipse_ab: 12, hyperbola: 13, parabola: 14, polygon: 15,
        length: 16, angle: 17, area: 18, isparallel: 19, isperpendicular: 20,
        isconcyclic: 21, rotate: 22, reflect: 23, translate: 24, fitline: 25,
        circulararc: 26, tangent: 27
    };

    const cache = new Map();   // key -> { handle, n } (handle 0 = rejected)

    function num(v) { return typeof v === 'number' ? v : NaN; }
    function litXVal(o) { return o && typeof o.x_val === 'number' ? o.x_val : NaN; }
    function litYVal(o) { return o && typeof o.y_val === 'number' ? o.y_val : NaN; }
    function litX(o) { return o && typeof o.x === 'number' ? o.x : NaN; }
    function litY(o) { return o && typeof o.y === 'number' ? o.y : NaN; }

    // Names travel in the '|'-separated protocol; anything outside printable
    // ASCII (or containing a delimiter) must fall back rather than risk a
    // name-resolution divergence with the kernel's ASCII lowercasing.
    function badName(s) {
        return typeof s !== 'string' || s === '' || /[^\x20-\x7e]/.test(s) ||
               s.indexOf('|') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0 ||
               s.indexOf(',') >= 0;
    }
    function badText(s) {
        return typeof s !== 'string' || s.indexOf('|') >= 0 ||
               s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0;
    }

    // Serialize one entry's type-specific fields (after the 4 header fields);
    // null -> cannot serialize -> whole call falls back.
    function serializeFields(entry) {
        const g = entry.geometryType;
        switch (g) {
            case 'point':
                if (entry.pointOnObject) {
                    if (badName(entry.onObjectName) || badText(entry.parameter_expr)) return null;
                    return ['1', entry.onObjectName, entry.parameter_expr || '', ''];
                }
                if (badText(entry.x_expr) || badText(entry.y_expr)) return null;
                return ['0', '', entry.x_expr || '', entry.y_expr || ''];
            case 'midpoint': return [entry.p1Name, entry.p2Name];
            case 'intersect': return [entry.obj1Name, entry.obj2Name, String(entry.sign == null ? 1 : entry.sign)];
            case 'segment': case 'ray': case 'line': case 'vector':
            case 'length': return [entry.p1Name, entry.p2Name];
            case 'perpendicularline': case 'parallelline': return [entry.lineName, entry.pointName];
            case 'anglebisector': case 'angle': return [entry.p1Name, entry.vertexName, entry.p3Name];
            case 'circle':
                if (badText(entry.radius_expr || '')) return null;
                return [entry.centerName, entry.radius_expr || '', entry.pointOnCircleName || ''];
            case 'ellipse': case 'hyperbola': return [entry.f1Name, entry.f2Name, entry.pName];
            case 'ellipse_ab':
                if (badText(entry.a_expr || '') || badText(entry.b_expr || '')) return null;
                return [entry.a_expr || '', entry.b_expr || ''];
            case 'parabola': return [entry.focusName, entry.directrixName];
            case 'polygon': case 'area': case 'fitline': {
                const names = entry.pointNames;
                if (!Array.isArray(names)) return null;
                return [String(names.length)].concat(names);
            }
            case 'isparallel': case 'isperpendicular': return [entry.l1Name, entry.l2Name];
            case 'isconcyclic': return [entry.p1Name, entry.p2Name, entry.p3Name, entry.p4Name];
            case 'rotate':
                if (badText(entry.angle_expr || '')) return null;
                return [entry.centerName, entry.rotatedPointName, entry.angle_expr || ''];
            case 'reflect': return [entry.axisName, entry.reflectedPointName];
            case 'translate':
                if (badText(entry.dx_expr || '') || badText(entry.dy_expr || '')) return null;
                return [entry.vectorName || '', entry.translatedPointName, entry.dx_expr || '', entry.dy_expr || ''];
            case 'circulararc': return [entry.centerName, entry.startPointName, entry.endPointName];
            case 'tangent': return [entry.conicName, entry.pointName, String(entry.sign == null ? 1 : entry.sign)];
            default: return null;
        }
    }

    // Page's simple custom functions, encoded for ac_geometry_compile; identical
    // to calc.js encodeUserFns.
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

    // Port of calc.js scanAdvanced: advanced functions only run on wasm while
    // pristine; the signature feeds the cache key.
    function scanAdvanced(engine, tokens, advNames) {
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

    function buildLines(engine, geom) {
        const lines = [];
        for (const entry of geom) {
            const fields = serializeFields(entry);
            if (fields === null) return null;
            const g = entry.geometryType;
            const exprsForType = [];
            if (g === 'point') exprsForType.push(entry.pointOnObject ? entry.parameter_expr : entry.x_expr, entry.pointOnObject ? '' : entry.y_expr);
            else if (g === 'circle') exprsForType.push(entry.radius_expr || '');
            else if (g === 'ellipse_ab') exprsForType.push(entry.a_expr || '', entry.b_expr || '');
            else if (g === 'rotate') exprsForType.push(entry.angle_expr || '');
            else if (g === 'translate') exprsForType.push(entry.dx_expr || '', entry.dy_expr || '');
            for (const e of exprsForType) {
                if (badText(e || '')) return null;
            }
            const header = [
                String(T[g]),
                entry.name,
                (entry.variableDependencies || []).join(','),
                (entry.objectDependencies || []).join(',')
            ];
            if (badName(entry.name)) return null;
            lines.push(header.concat(fields).join('|'));
        }
        return lines;
    }

    // Validate name fields per type (called separately so buildLines stays readable).
    function namesOk(geom) {
        for (const entry of geom) {
            const names = [];
            const g = entry.geometryType;
            switch (g) {
                case 'point': names.push(entry.pointOnObject ? entry.onObjectName : ''); break;
                case 'midpoint': case 'segment': case 'ray': case 'line': case 'vector':
                case 'length': names.push(entry.p1Name, entry.p2Name); break;
                case 'intersect': names.push(entry.obj1Name, entry.obj2Name); break;
                case 'perpendicularline': case 'parallelline': names.push(entry.lineName, entry.pointName); break;
                case 'anglebisector': names.push(entry.p1Name, entry.vertexName, entry.p3Name); break;
                case 'angle': names.push(entry.p1Name, entry.vertexName, entry.p3Name); break;
                case 'circle': names.push(entry.centerName, entry.pointOnCircleName || ''); break;
                case 'ellipse': case 'hyperbola': names.push(entry.f1Name, entry.f2Name, entry.pName); break;
                case 'ellipse_ab': break;   // a/b form: no object-name slots
                case 'parabola': names.push(entry.focusName, entry.directrixName); break;
                case 'polygon': case 'area': case 'fitline':
                    if (!Array.isArray(entry.pointNames)) return false;
                    names.push.apply(names, entry.pointNames);
                    break;
                case 'isparallel': case 'isperpendicular': names.push(entry.l1Name, entry.l2Name); break;
                case 'isconcyclic': names.push(entry.p1Name, entry.p2Name, entry.p3Name, entry.p4Name); break;
                case 'rotate': names.push(entry.centerName, entry.rotatedPointName); break;
                case 'reflect': names.push(entry.axisName, entry.reflectedPointName); break;
                case 'translate': names.push(entry.vectorName || '', entry.translatedPointName); break;
                case 'circulararc': names.push(entry.centerName, entry.startPointName, entry.endPointName); break;
                case 'tangent': names.push(entry.conicName, entry.pointName); break;
                default: return false;
            }
            for (const n of names) {
                if (n === '' || n === undefined || n === null) {
                    if (n === '') continue;   // optional slot
                    return false;
                }
                if (badName(n)) return false;
            }
        }
        return true;
    }

    function packRow(entry, row) {
        row.fill(NaN);
        row[28] = 0;   // errCode upload
        row[36] = 0;   // flags upload
        row[0] = num(entry.x_val);
        row[1] = num(entry.y_val);
        row[2] = num(entry.radius);
        row[3] = num(entry.a);
        row[4] = num(entry.b);
        row[5] = num(entry.rotation);
        row[6] = typeof entry.p === 'number' ? entry.p : NaN;   // parabola focal; ellipse p is a ref object
        row[7] = num(entry.value);
        row[8] = num(entry.startAngle);
        row[9] = num(entry.endAngle);
        row[10] = num(entry.dist_sum);
        row[11] = num(entry.dist_diff);
        if (entry.dir) { row[12] = num(entry.dir.x); row[13] = num(entry.dir.y); }
        if (entry.dir_vec) { row[14] = num(entry.dir_vec.x); row[15] = num(entry.dir_vec.y); }
        switch (entry.geometryType) {
            case 'perpendicularline': case 'parallelline': case 'anglebisector':
                row[18] = litXVal(entry.p2);
                row[19] = litYVal(entry.p2);
                break;
            case 'fitline': case 'tangent':
                row[16] = litXVal(entry.p1);
                row[17] = litYVal(entry.p1);
                row[18] = litXVal(entry.p2);
                row[19] = litYVal(entry.p2);
                break;
        }
        const g = entry.geometryType;
        if (g === 'ellipse' || g === 'ellipse_ab' || g === 'hyperbola') {
            row[20] = litX(entry.center);
            row[21] = litY(entry.center);
        }
        if (g === 'parabola') {
            row[22] = litX(entry.vertex);
            row[23] = litY(entry.vertex);
        }
        if (g === 'ellipse_ab') {
            row[24] = litXVal(entry.f1);
            row[25] = litYVal(entry.f1);
            row[26] = litXVal(entry.f2);
            row[27] = litYVal(entry.f2);
        }
        row[29] = entry.isMeaningful ? 1 : 0;
    }

    // detailsString templates, transcribed from the case tails (only runs when
    // the kernel's flags say the JS case would have set detailsString). Reads
    // referenced entries' CURRENT fields, matching JS mid-loop reads because
    // apply() runs in entry order.
    function regenDetails(engine, entry, row, objectMap) {
        const g = entry.geometryType;
        switch (g) {
            case 'point': case 'midpoint': case 'intersect': case 'rotate': case 'reflect': case 'translate':
                entry.detailsString = `(${row[0].toPrecision(4)}, ${row[1].toPrecision(4)})`;
                break;
            case 'segment': case 'ray': case 'line': case 'vector':
            case 'perpendicularline': case 'parallelline': case 'anglebisector': {
                const p1 = entry.p1, dir = entry.dir;
                if (Math.abs(dir.x) < 1e-9) {
                    entry.detailsString = `x = ${p1.x_val.toPrecision(4)}`;
                } else {
                    const m = dir.y / dir.x;
                    const b = p1.y_val - m * p1.x_val;
                    entry.detailsString = `y = ${m.toPrecision(3)}x ${b >= 0 ? '+' : '-'} ${Math.abs(b).toPrecision(3)}`;
                }
                break;
            }
            case 'circle': {
                const h = entry.center.x_val, k = entry.center.y_val;
                const r2 = row[2] * row[2];
                const x_part = `(x ${h > 0 ? '-' : '+'} ${Math.abs(h).toPrecision(3)})²`;
                const y_part = `(y ${k > 0 ? '-' : '+'} ${Math.abs(k).toPrecision(3)})²`;
                entry.detailsString = `${x_part} + ${y_part} = ${r2.toPrecision(3)}`;
                break;
            }
            case 'ellipse_ab':
                entry.detailsString = `x²/${(row[3] * row[3]).toPrecision(3)} + y²/${(row[4] * row[4]).toPrecision(3)} = 1`;
                break;
            case 'ellipse': case 'hyperbola': case 'parabola':
                entry.detailsString = engine.formatConicEquation(row[30], row[31], row[32], row[33], row[34], row[35]);
                break;
            case 'polygon':
                entry.detailsString = "";
                break;
            case 'length':
                entry.detailsString = `l(${entry.p1Name}, ${entry.p2Name}) = ${row[7].toPrecision(4)}`;
                break;
            case 'angle':
                entry.detailsString = `∠(${entry.p1Name}, ${entry.vertexName}, ${entry.p3Name}) = ${row[7].toPrecision(3)}°`;
                break;
            case 'area':
                entry.detailsString = `S(${entry.pointNames.join(', ')}) = ${row[7].toPrecision(4)}`;
                break;
            case 'isparallel': case 'isperpendicular':
                entry.detailsString = `${entry.name}(${entry.l1Name}, ${entry.l2Name}) = ${row[7]}`;
                break;
            case 'isconcyclic':
                entry.detailsString = `${entry.name}(${entry.p1Name}, ${entry.p2Name}, ${entry.p3Name}, ${entry.p4Name}) = ${row[7]}`;
                break;
            case 'fitline':
                if (row[12] === 0) {
                    entry.detailsString = `x = ${row[16].toPrecision(4)}`;
                } else {
                    const m = row[30], b = row[31];
                    entry.detailsString = `y = ${m.toPrecision(3)}x ${b >= 0 ? '+' : '-'} ${Math.abs(b).toPrecision(3)}`;
                }
                break;
            case 'circulararc':
                entry.detailsString = `圆心: ${entry.centerName}, 半径: ${row[2].toPrecision(4)}`;
                break;
            case 'tangent':
                if (row[12] === 0 && row[13] === 1) {
                    entry.detailsString = `x = ${row[16].toPrecision(4)}`;
                } else {
                    const k = row[30];
                    const b = row[17] - k * row[16];
                    entry.detailsString = `y = ${k.toPrecision(3)}x ${b >= 0 ? '+' : '-'} ${Math.abs(b).toPrecision(3)}`;
                }
                break;
        }
    }

    function applyRow(engine, entry, row, objectMap) {
        entry.isMeaningful = row[29] !== 0;
        const flags = row[36];
        if (flags & 2) {
            const code = row[28];
            entry.compilationError = code === 1 ? '交点求解复杂' :
                                     code === 2 ? '切点不在圆弧范围内' : undefined;
        }
        if (!(flags & 2)) return;   // deps-unmeaningful on the last iteration: JS touched nothing
        const g = entry.geometryType;
        const refFor = (name) => objectMap.get(String(name).toLowerCase());
        switch (g) {
            case 'point': case 'midpoint': case 'intersect': case 'rotate': case 'reflect': case 'translate':
                entry.x_val = row[0];
                entry.y_val = row[1];
                break;
            case 'segment': case 'ray': case 'line': case 'vector':
                entry.p1 = refFor(entry.p1Name);
                entry.p2 = refFor(entry.p2Name);
                entry.dir_vec = { x: row[14], y: row[15] };
                entry.dir = { x: row[12], y: row[13] };
                break;
            case 'perpendicularline': case 'parallelline':
                entry.p1 = refFor(entry.pointName);
                entry.p2 = { x_val: row[18], y_val: row[19] };
                entry.dir = { x: row[12], y: row[13] };
                break;
            case 'anglebisector':
                entry.p1 = refFor(entry.vertexName);
                entry.p2 = { x_val: row[18], y_val: row[19] };
                entry.dir = { x: row[12], y: row[13] };
                break;
            case 'circle':
                entry.center = refFor(entry.centerName);
                entry.radius = row[2];
                break;
            case 'circulararc':
                entry.center = refFor(entry.centerName);
                entry.radius = row[2];
                entry.startAngle = row[8];
                entry.endAngle = row[9];
                break;
            case 'ellipse_ab':
                entry.a = row[3];
                entry.b = row[4];
                entry.center = { x: row[20], y: row[21] };
                entry.rotation = row[5];
                entry.f1 = { x_val: row[24], y_val: row[25] };
                entry.f2 = { x_val: row[26], y_val: row[27] };
                break;
            case 'ellipse':
                entry.f1 = refFor(entry.f1Name);
                entry.f2 = refFor(entry.f2Name);
                entry.p = refFor(entry.pName);
                entry.dist_sum = row[10];
                entry.center = { x: row[20], y: row[21] };
                entry.a = row[3];
                entry.b = row[4];
                entry.rotation = row[5];
                break;
            case 'hyperbola':
                entry.f1 = refFor(entry.f1Name);
                entry.f2 = refFor(entry.f2Name);
                entry.p = refFor(entry.pName);
                entry.dist_diff = row[11];
                entry.center = { x: row[20], y: row[21] };
                entry.a = row[3];
                entry.b = row[4];
                entry.rotation = row[5];
                break;
            case 'parabola':
                entry.focus = refFor(entry.focusName);
                entry.directrix = refFor(entry.directrixName);
                entry.vertex = { x: row[22], y: row[23] };
                entry.p = row[6];
                entry.rotation = row[5];
                break;
            case 'polygon': case 'area': case 'fitline':
                entry.points = entry.pointNames.map((nm) => objectMap.get(String(nm).toLowerCase()));
                if (g === 'fitline') {
                    entry.p1 = { x_val: row[16], y_val: row[17] };
                    entry.p2 = { x_val: row[18], y_val: row[19] };
                    entry.dir = { x: row[12], y: row[13] };
                } else if (g === 'area') {
                    entry.value = row[7];
                }
                break;
            case 'tangent':
                entry.p1 = { x_val: row[16], y_val: row[17] };
                entry.p2 = { x_val: row[18], y_val: row[19] };
                entry.dir = { x: row[12], y: row[13] };
                break;
            case 'length': case 'angle': case 'isparallel':
            case 'isperpendicular': case 'isconcyclic':
                entry.value = row[7];
                break;
        }
        if (flags & 1) regenDetails(engine, entry, row, objectMap);
    }

    function geometryKernel(engine) {
        if (!ArchCore.active) return false;
        try {
            const geom = engine.entries.filter((e) => e.type === 'geometry');
            if (geom.length === 0) return false;
            if (!namesOk(geom)) return false;
            const lines = buildLines(engine, geom);
            if (lines === null) return false;

            const vars = [];
            for (const k of (engine.variables ? engine.variables.keys() : [])) {
                if (/^[a-z_][a-z0-9_]*$/.test(k) && !vars.includes(k)) vars.push(k);
            }

            // Advanced-function gate (same policy as calc.js): expressions and
            // user-function bodies may only reference pristine definitions.
            const advNames = (engine.calcJSUtils && engine.calcJSUtils.advancedCustomFunctionNames) || [];
            let advSig = '';
            if (advNames.length) {
                const scan = (tokens) => {
                    const r = scanAdvanced(engine, tokens, advNames);
                    if (r.reject) return null;
                    advSig += r.sig;
                    return true;
                };
                for (const entry of geom) {
                    const exprs = [];
                    if (entry.geometryType === 'point') {
                        exprs.push(entry.pointOnObject ? entry.parameter_expr : entry.x_expr);
                        if (!entry.pointOnObject) exprs.push(entry.y_expr);
                    } else if (entry.geometryType === 'circle') exprs.push(entry.radius_expr);
                    else if (entry.geometryType === 'ellipse_ab') { exprs.push(entry.a_expr); exprs.push(entry.b_expr); }
                    else if (entry.geometryType === 'rotate') exprs.push(entry.angle_expr);
                    else if (entry.geometryType === 'translate') { exprs.push(entry.dx_expr); exprs.push(entry.dy_expr); }
                    for (const src of exprs) {
                        if (typeof src !== 'string' || src === '') continue;
                        if (scan(engine.calcJSUtils.tokenize.call(engine.calcJSUtils, src)) === null) return false;
                    }
                }
                const cf = (engine.calcJSUtils && engine.calcJSUtils.customFunctions) || {};
                for (const name of Object.keys(cf)) {
                    const f = cf[name];
                    if (!f || !Array.isArray(f.bodyTokens)) continue;
                    if (scan(f.bodyTokens) === null) return false;
                }
            }

            const userFns = encodeUserFns(engine);
            const integralSteps = engine.integralNumSteps || 100;
            const entriesText = lines.join('\n');
            const key = integralSteps + '|' + advSig + '|' + vars.join(',') + '|' +
                        userFns + '|' + entriesText;
            let rec = cache.get(key);
            if (rec) {
                cache.delete(key);
                cache.set(key, rec);
                if (!rec.handle) return false;   // previously rejected
            } else {
                const ent = ArchCore.writeString('geo-entries', entriesText);
                const varStr = ArchCore.writeString('geo-vars', vars.join('\n'));
                const uf = ArchCore.writeString('geo-userfns', userFns);
                const handle = ArchCore.exports.ac_geometry_compile(
                    ent.ptr, ent.len, varStr.ptr, varStr.len, uf.ptr, uf.len, integralSteps);
                rec = { handle, n: geom.length };
                cache.set(key, rec);
                while (cache.size > MAX_CACHED) {
                    const [oldKey, old] = cache.entries().next().value;
                    cache.delete(oldKey);
                    if (old.handle) ArchCore.exports.ac_geometry_release(old.handle);
                }
                if (!rec.handle) return false;
            }

            // Variable values (NaN for missing/non-number, mirroring the page's
            // "dependency not in variables map / not finite" semantics).
            if (vars.length > 0) {
                const vb = ArchCore.f64Scratch('geo-var-values', vars.length);
                for (let i = 0; i < vars.length; i++) {
                    const v = engine.variables.get(vars[i]);
                    vb.view[i] = typeof v === 'number' ? v : NaN;
                }
                ArchCore.exports.ac_geometry_setvars(rec.handle, vb.ptr, vars.length);
            }

            const sb = ArchCore.f64Scratch('geo-state', rec.n * GEO_STRIDE);
            for (let i = 0; i < rec.n; i++) {
                packRow(geom[i], sb.view.subarray(i * GEO_STRIDE, (i + 1) * GEO_STRIDE));
            }
            const ok = ArchCore.exports.ac_geometry_run(rec.handle, sb.ptr, rec.n * GEO_STRIDE);
            if (!ok) return false;   // e.g. an unported group (stub) declined

            const ex = ArchCore.exports;
            const { f64 } = ArchCore.views();   // refresh AFTER the run call
            const outPtr = ex.ac_geometry_out_ptr();
            const outLen = ex.ac_geometry_out_len();
            if (outLen !== rec.n * GEO_STRIDE) return false;
            const base = outPtr >> 3;

            // Apply in entry order (see header comment).
            const objectMap = new Map();
            for (const e of engine.entries) {
                if (e.type === 'geometry' && e.name) objectMap.set(e.name.toLowerCase(), e);
            }
            for (let i = 0; i < rec.n; i++) {
                applyRow(engine, geom[i], f64.subarray(base + i * GEO_STRIDE, base + (i + 1) * GEO_STRIDE), objectMap);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    ArchCore.kernels.geometry = geometryKernel;
})();
