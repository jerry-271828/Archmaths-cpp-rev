// ArchCore kernel "geometry": driver + ABI for the recalculateGeometryObjects
// port (arch-current.html:16467-17354). Owns the text-protocol parser, the
// compile-time name resolution, the [A,x]/[A,y] point-ref rewriting, the
// fixed-point iteration loop, and the C ABI. The per-type case bodies live in
// the four group translation units (see geometry_common.h / GEOMETRY_CONTRACT.md).
//
// ABI (all additive on v2; JS adapter wasm/js/kernels/geometry.js):
//   ac_geometry_compile(entries, entriesLen, vars, varsLen,
//                       userFns, userFnsLen, integralSteps) -> handle | 0
//       entries: one per line, see GEOMETRY_CONTRACT.md "text protocol".
//       vars: variable names, '\n'-separated (setvars upload order).
//       userFns: same encoding as ac_calc_compile ("name|p1,p2|bodyTokens").
//       Any parse/compile failure -> 0 (page keeps its JS path).
//   ac_geometry_release(handle)
//   ac_geometry_setvars(handle, values, count)   // count == vars count
//   ac_geometry_run(handle, stateIn, stateCount) // stateCount = entries*40
//       -> 1 and ac_geometry_out_* holds entries*40 doubles, or 0 on any
//          failure (bad handle/count, or a group function declining a type).
//   ac_geometry_out_ptr() / ac_geometry_out_len()
//   ac_geometry_error_ptr() / ac_geometry_error_len()
#include "geometry_common.h"
#include "../CoreApi.h"
#include "../CalcJsCompiler.h"

#include <algorithm>
#include <string>
#include <vector>

namespace ArchMaths {
namespace Core {

namespace {

std::vector<std::unique_ptr<GeoState>> g_geometries;
std::vector<int> g_freeGeoHandles;
std::string g_geoError;
OutBuffer<double> g_geoOut;

GeoState* geoFromHandle(int handle) {
    if (handle <= 0 || handle > static_cast<int>(g_geometries.size())) return nullptr;
    return g_geometries[static_cast<size_t>(handle) - 1].get();
}

int geoFail(const std::string& message) {
    g_geoError = message;
    return 0;
}

std::vector<std::string> splitChar(const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t pos = 0;
    while (pos <= s.size()) {
        size_t next = s.find(sep, pos);
        out.push_back(s.substr(pos, next == std::string::npos ? std::string::npos : next - pos));
        if (next == std::string::npos) break;
        pos = next + 1;
    }
    return out;
}

std::string toLowerAscii(const std::string& s) {
    std::string out = s;
    for (auto& c : out) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return out;
}

bool isSpaceChar(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

// ---- userFns (same encoding as ac_calc_compile) ------------------------------
bool parseUserFns(const std::string& fnsText, std::vector<CalcJsUserFn>& out) {
    size_t pos = 0;
    while (pos < fnsText.size()) {
        size_t nl = fnsText.find('\n', pos);
        std::string record = fnsText.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
        pos = nl == std::string::npos ? fnsText.size() : nl + 1;
        if (record.empty()) continue;
        size_t p1 = record.find('|');
        size_t p2 = p1 == std::string::npos ? std::string::npos : record.find('|', p1 + 1);
        if (p1 == std::string::npos || p2 == std::string::npos) {
            g_geoError = "bad userFns record";
            return false;
        }
        CalcJsUserFn fn;
        fn.name = record.substr(0, p1);
        std::string plist = record.substr(p1 + 1, p2 - p1 - 1);
        std::string body = record.substr(p2 + 1);
        size_t q = 0;
        while (q < plist.size()) {
            size_t comma = plist.find(',', q);
            fn.params.push_back(plist.substr(q, comma == std::string::npos ? std::string::npos : comma - q));
            if (comma == std::string::npos) break;
            q = comma + 1;
        }
        std::string tok;   // bodyTokens joined by single spaces
        for (size_t k = 0; k <= body.size(); ++k) {
            if (k == body.size() || body[k] == ' ' || body[k] == '\t') {
                if (!tok.empty()) {
                    fn.bodyTokens.push_back(tok);
                    tok.clear();
                }
            } else {
                tok += body[k];
            }
        }
        out.push_back(std::move(fn));
    }
    return true;
}

// ---- [name,x]/[name,y] rewriting ---------------------------------------------
// Port of resolvePointCoords' regex /\[\s*([^,\]\s]+)\s*,\s*(x|y)\s*\]/g
// (arch-current.html:17700): left-to-right, non-overlapping; each match becomes
// the synthetic parameter gpr<j> (leading-underscore ids do not survive the
// CalcJs pipeline; "gpr" colliding variable names are rejected at compile).
// Names resolve against the point map at compile time; unresolvable names keep
// entryIndex -1 (the page's `(0)` fallback). Returns the rewritten source.
std::string rewritePointRefs(const std::string& src, const GeoState& state,
                             std::vector<GeoPointRef>& refsOut) {
    std::string out;
    size_t i = 0;
    while (i < src.size()) {
        if (src[i] != '[') {
            out += src[i++];
            continue;
        }
        size_t j = i + 1;
        while (j < src.size() && isSpaceChar(src[j])) ++j;
        const size_t nameStart = j;
        while (j < src.size() && src[j] != ',' && src[j] != ']' && !isSpaceChar(src[j])) ++j;
        const size_t nameEnd = j;
        while (j < src.size() && isSpaceChar(src[j])) ++j;
        bool matched = nameEnd > nameStart;
        bool isX = true;
        if (matched && (j >= src.size() || src[j] != ',')) matched = false;
        if (matched) {
            ++j;
            while (j < src.size() && isSpaceChar(src[j])) ++j;
            if (j >= src.size() || (src[j] != 'x' && src[j] != 'y')) {
                matched = false;
            } else {
                isX = src[j] == 'x';
            }
        }
        if (matched) {
            ++j;
            while (j < src.size() && isSpaceChar(src[j])) ++j;
            if (j >= src.size() || src[j] != ']') matched = false;
        }
        if (!matched) {
            out += src[i++];
            continue;
        }
        ++j;   // consume ']'
        GeoPointRef r;
        r.isX = isX;
        const std::string name = toLowerAscii(src.substr(nameStart, nameEnd - nameStart));
        auto it = state.pointMap.find(name);
        r.entryIndex = it == state.pointMap.end() ? -1 : it->second;
        refsOut.push_back(r);
        out += "gpr";
        out += std::to_string(refsOut.size() - 1);
        i = j;
    }
    return out;
}

// Compile one expression slot; failure -> false (whole kernel compile fails).
bool compileExprSlot(GeoState& state, GeoEntry& entry, int slot, const std::string& source,
                     const std::vector<CalcJsUserFn>& userFns) {
    if (source.empty()) return true;   // absent slot stays nullptr
    entry.exprRefs[static_cast<size_t>(slot)].clear();
    std::vector<GeoPointRef> refs;
    const std::string rewritten = rewritePointRefs(source, state, refs);
    entry.exprRefs[static_cast<size_t>(slot)] = std::move(refs);

    std::vector<std::string> params = state.varNames;
    const size_t nrefs = entry.exprRefs[static_cast<size_t>(slot)].size();
    for (size_t k = 0; k < nrefs; ++k) params.push_back("gpr" + std::to_string(k));

    auto prog = std::make_unique<Program>();
    if (!prog->compileCalcJs(rewritten, /*args=*/{}, params, userFns, state.integralSteps)) {
        g_geoError = prog->error();
        return false;
    }
    std::vector<double>& buf = entry.paramBufs[static_cast<size_t>(slot)];
    buf.assign(state.varNames.size() + nrefs, JsMath::kNaN);
    entry.exprSlots[static_cast<size_t>(slot)] = std::move(prog);
    return true;
}

int resolveRef(const GeoState& state, const std::string& name) {
    if (name.empty()) return -1;
    auto it = state.objectMap.find(toLowerAscii(name));
    return it == state.objectMap.end() ? -1 : it->second;
}

} // namespace

// ---- fixed-point iteration ---------------------------------------------------
// Verbatim port of recalculateGeometryObjects' outer loop (16492-17366); the
// pseudocode in geometry_common.h is the contract. Returns false when a group
// function declines its type (unported stub) so the ABI run fails and the page
// falls back to JS.
bool geoRunFixedPoint(GeoState& s) {
    const int n = static_cast<int>(s.entries.size());
    const int maxIterations = 20;
    int iteration = 0;
    bool changedInIteration = true;
    while (changedInIteration && iteration < maxIterations) {
        changedInIteration = false;
        iteration++;
        for (int i = 0; i < n; ++i) {
            GeoEntry& e = s.entries[static_cast<size_t>(i)];
            double* st = s.row(i);
            const bool oldMeaningful = st[GeoMeaningful] != 0.0;
            const double oldX = st[GeoX];
            const double oldY = st[GeoY];
            const double oldR = st[GeoRadius];

            bool depsMeaningful = true;
            for (const std::string& dep : e.varDeps) {
                auto it = std::find(s.varNames.begin(), s.varNames.end(), dep);
                if (it == s.varNames.end() ||
                    !JsMath::isFinite(s.varValues[static_cast<size_t>(it - s.varNames.begin())])) {
                    depsMeaningful = false;
                    break;
                }
            }
            if (depsMeaningful) {
                for (const std::string& dep : e.objDeps) {
                    auto it = s.objectMap.find(dep);
                    if (it == s.objectMap.end() || !s.isMeaningful(it->second)) {
                        depsMeaningful = false;
                        break;
                    }
                }
            }

            if (!depsMeaningful) {
                st[GeoMeaningful] = 0.0;   // compilationError untouched, like JS
                if (oldMeaningful) changedInIteration = true;
                continue;
            }

            st[GeoErrCode] = 0.0;
            st[GeoFlags] = 0.0;
            if (!geoDispatch(e.type, s, e, st)) return false;   // group declined -> JS fallback
            const bool newMeaningful = st[GeoMeaningful] != 0.0;
            int flags = GeoFlagErrTouched;
            if (newMeaningful || e.type == GeoType::Polygon) flags |= GeoFlagDetails;
            st[GeoFlags] = static_cast<double>(flags);

            if (newMeaningful != oldMeaningful) {
                changedInIteration = true;
            } else if (newMeaningful) {
                const bool xyTracked = e.type == GeoType::Point || e.type == GeoType::Midpoint ||
                                       e.type == GeoType::Intersect;
                if (xyTracked && (std::fabs(st[GeoX] - oldX) > kGeoMeaningfulEps ||
                                  std::fabs(st[GeoY] - oldY) > kGeoMeaningfulEps)) {
                    changedInIteration = true;
                } else if (e.type == GeoType::Circle &&
                           std::fabs(st[GeoRadius] - oldR) > kGeoMeaningfulEps) {
                    changedInIteration = true;
                }
            }
        }
    }
    return true;
}

} // namespace Core
} // namespace ArchMaths

using namespace ArchMaths::Core;

// ---- ABI ----------------------------------------------------------------------

// entriesText: one entry per line,
//   typeId|name|varDepsCsv|objDepsCsv|<type-specific fields...>
// See GEOMETRY_CONTRACT.md for the per-type field table. Any structural error
// or expression compile failure returns 0.
ARCHCORE_EXPORT(ac_geometry_compile)
int ac_geometry_compile(const char* entries, int entriesLen,
                        const char* vars, int varsLen,
                        const char* userFns, int userFnsLen,
                        double integralSteps) {
    auto state = std::make_unique<GeoState>();
    state->integralSteps = integralSteps;

    const std::string varsText(vars ? vars : "", vars ? static_cast<size_t>(varsLen) : 0);
    for (const std::string& name : splitChar(varsText, '\n')) {
        if (name.empty()) continue;
        if (name.compare(0, 3, "gpr") == 0) {
            return geoFail("variable name collides with gpr prefix");
        }
        state->varNames.push_back(name);
    }
    state->varValues.assign(state->varNames.size(), ArchMaths::JsMath::kNaN);

    std::vector<CalcJsUserFn> userFnList;
    if (!parseUserFns(std::string(userFns ? userFns : "", userFns ? static_cast<size_t>(userFnsLen) : 0),
                      userFnList)) {
        return 0;
    }

    // -- pass 1: parse lines into entries (names first; refs resolved in pass 3)
    const std::string entriesText(entries ? entries : "", entries ? static_cast<size_t>(entriesLen) : 0);
    struct ParsedLine {
        GeoEntry entry;
        std::vector<std::string> fields;   // after the 4 header fields
    };
    std::vector<ParsedLine> parsed;
    {
        size_t pos = 0;
        while (pos < entriesText.size()) {
            size_t nl = entriesText.find('\n', pos);
            std::string line = entriesText.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
            pos = nl == std::string::npos ? entriesText.size() : nl + 1;
            if (line.empty()) continue;
            std::vector<std::string> header = splitChar(line, '|');
            if (header.size() < 5) return geoFail("bad entry line (header)");
            ParsedLine pl;
            pl.entry.type = static_cast<GeoType>(std::atoi(header[0].c_str()));
            if (static_cast<int>(pl.entry.type) < 0 ||
                static_cast<int>(pl.entry.type) > static_cast<int>(GeoType::Tangent)) {
                return geoFail("unknown geometry type id");
            }
            pl.entry.name = header[1];
            for (const std::string& v : splitChar(header[2], ',')) {
                if (!v.empty()) pl.entry.varDeps.push_back(v);
            }
            for (const std::string& v : splitChar(header[3], ',')) {
                if (!v.empty()) pl.entry.objDeps.push_back(toLowerAscii(v));
            }
            pl.fields.assign(header.begin() + 4, header.end());
            parsed.push_back(std::move(pl));
        }
    }

    // -- pass 2: build maps and install entries into the state
    for (size_t i = 0; i < parsed.size(); ++i) {
        state->entries.push_back(std::move(parsed[i].entry));
    }
    for (size_t i = 0; i < state->entries.size(); ++i) {
        const std::string key = toLowerAscii(state->entries[i].name);
        state->objectMap[key] = static_cast<int>(i);              // LAST wins (JS Map.set)
        if (isPointLikeType(state->entries[i].type) &&
            state->pointMap.find(key) == state->pointMap.end()) {
            state->pointMap[key] = static_cast<int>(i);           // FIRST wins (JS Array.find)
        }
    }

    // -- pass 3: per-type field mapping (refs resolved, exprs compiled)
    auto needFields = [&](const ParsedLine& pl, size_t n) -> bool {
        return pl.fields.size() == n;
    };
    for (size_t i = 0; i < parsed.size(); ++i) {
        ParsedLine& pl = parsed[i];
        GeoEntry& e = state->entries[i];
        const GeoType t = e.type;
        auto ref = [&](size_t idx) { return resolveRef(*state, pl.fields[idx]); };
        auto exprCount = [&](size_t n) {
            e.exprSlots.resize(n);
            e.exprRefs.resize(n);
            e.paramBufs.resize(n);
        };
        bool ok = true;
        switch (t) {
            case GeoType::Point:
                if (!needFields(pl, 4)) { geoFail("point needs 4 fields"); ok = false; break; }
                exprCount(2);
                if (pl.fields[0] == "1") {
                    e.refSlots[GeoRefA] = ref(1);
                    ok = compileExprSlot(*state, e, 0, pl.fields[2], userFnList);
                } else {
                    ok = compileExprSlot(*state, e, 0, pl.fields[2], userFnList) &&
                         compileExprSlot(*state, e, 1, pl.fields[3], userFnList);
                }
                break;
            case GeoType::Midpoint:
                if (!needFields(pl, 2)) { geoFail("midpoint needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::Intersect:
                if (!needFields(pl, 3)) { geoFail("intersect needs 3 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                e.sign = std::atof(pl.fields[2].c_str());
                break;
            case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
            case GeoType::Length:
                if (!needFields(pl, 2)) { geoFail("line needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::PerpendicularLine: case GeoType::ParallelLine:
                if (!needFields(pl, 2)) { geoFail("perpline needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::AngleBisector: case GeoType::Angle:
                if (!needFields(pl, 3)) { geoFail("anglebisector needs 3 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefC] = ref(1);
                e.refSlots[GeoRefB] = ref(2);
                break;
            case GeoType::Circle:
                if (!needFields(pl, 3)) { geoFail("circle needs 3 fields"); ok = false; break; }
                exprCount(1);
                e.refSlots[GeoRefA] = ref(0);
                ok = compileExprSlot(*state, e, 0, pl.fields[1], userFnList);
                e.refSlots[GeoRefB] = ref(2);
                break;
            case GeoType::Ellipse: case GeoType::Hyperbola:
                if (!needFields(pl, 3)) { geoFail("ellipse needs 3 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                e.refSlots[GeoRefC] = ref(2);
                break;
            case GeoType::EllipseAb:
                if (!needFields(pl, 2)) { geoFail("ellipse_ab needs 2 fields"); ok = false; break; }
                exprCount(2);
                ok = compileExprSlot(*state, e, 0, pl.fields[0], userFnList) &&
                     compileExprSlot(*state, e, 1, pl.fields[1], userFnList);
                break;
            case GeoType::Parabola:
                if (!needFields(pl, 2)) { geoFail("parabola needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::Polygon: case GeoType::Area: case GeoType::Fitline: {
                if (pl.fields.size() < 1) { geoFail("polygon needs count"); ok = false; break; }
                e.numPoints = std::atoi(pl.fields[0].c_str());
                if (e.numPoints < 0 || pl.fields.size() != static_cast<size_t>(e.numPoints) + 1) {
                    geoFail("polygon point count mismatch");
                    ok = false;
                    break;
                }
                for (int k = 0; k < e.numPoints; ++k) {
                    e.pointRefs.push_back(ref(static_cast<size_t>(k) + 1));
                }
                break;
            }
            case GeoType::IsParallel: case GeoType::IsPerpendicular:
                if (!needFields(pl, 2)) { geoFail("isparallel needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::IsConcyclic:
                if (!needFields(pl, 4)) { geoFail("isconcyclic needs 4 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                e.refSlots[GeoRefC] = ref(2);
                e.refSlots[GeoRefD] = ref(3);
                break;
            case GeoType::Rotate:
                if (!needFields(pl, 3)) { geoFail("rotate needs 3 fields"); ok = false; break; }
                exprCount(1);
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                ok = compileExprSlot(*state, e, 0, pl.fields[2], userFnList);
                break;
            case GeoType::Reflect:
                if (!needFields(pl, 2)) { geoFail("reflect needs 2 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                break;
            case GeoType::Translate:
                if (!needFields(pl, 4)) { geoFail("translate needs 4 fields"); ok = false; break; }
                exprCount(2);
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                ok = compileExprSlot(*state, e, 0, pl.fields[2], userFnList) &&
                     compileExprSlot(*state, e, 1, pl.fields[3], userFnList);
                break;
            case GeoType::CircularArc:
                if (!needFields(pl, 3)) { geoFail("circulararc needs 3 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                e.refSlots[GeoRefC] = ref(2);
                break;
            case GeoType::Tangent:
                if (!needFields(pl, 3)) { geoFail("tangent needs 3 fields"); ok = false; break; }
                e.refSlots[GeoRefA] = ref(0);
                e.refSlots[GeoRefB] = ref(1);
                e.sign = std::atof(pl.fields[2].c_str());
                break;
            default:
                geoFail("unknown geometry type id");
                ok = false;
                break;
        }
        if (!ok) {
            if (g_geoError.empty()) g_geoError = "geometry entry parse/compile failure";
            return 0;
        }
    }

    state->state.assign(state->entries.size() * kGeoStride, ArchMaths::JsMath::kNaN);

    g_geoError.clear();
    if (!g_freeGeoHandles.empty()) {
        int h = g_freeGeoHandles.back();
        g_freeGeoHandles.pop_back();
        g_geometries[static_cast<size_t>(h) - 1] = std::move(state);
        return h;
    }
    g_geometries.push_back(std::move(state));
    return static_cast<int>(g_geometries.size());
}

ARCHCORE_EXPORT(ac_geometry_release)
void ac_geometry_release(int handle) {
    if (!geoFromHandle(handle)) return;
    g_geometries[static_cast<size_t>(handle) - 1].reset();
    g_freeGeoHandles.push_back(handle);
}

ARCHCORE_EXPORT(ac_geometry_setvars)
void ac_geometry_setvars(int handle, const double* values, int count) {
    GeoState* s = geoFromHandle(handle);
    if (!s || count != static_cast<int>(s->varNames.size()) || !values) return;
    std::copy(values, values + count, s->varValues.begin());
}

ARCHCORE_EXPORT(ac_geometry_run)
int ac_geometry_run(int handle, const double* stateIn, int stateCount) {
    g_geoOut.clear();
    GeoState* s = geoFromHandle(handle);
    if (!s || !stateIn) return 0;
    const int n = static_cast<int>(s->entries.size());
    if (stateCount != n * kGeoStride) return 0;
    std::copy(stateIn, stateIn + stateCount, s->state.begin());
    if (!geoRunFixedPoint(*s)) return 0;   // group declined -> page keeps JS path
    g_geoOut.data = s->state;
    return 1;
}

ARCHCORE_EXPORT(ac_geometry_out_ptr) double* ac_geometry_out_ptr() { return g_geoOut.ptr(); }
ARCHCORE_EXPORT(ac_geometry_out_len) int ac_geometry_out_len() { return g_geoOut.size(); }

ARCHCORE_EXPORT(ac_geometry_error_ptr) const char* ac_geometry_error_ptr() { return g_geoError.c_str(); }
ARCHCORE_EXPORT(ac_geometry_error_len) int ac_geometry_error_len() { return static_cast<int>(g_geoError.size()); }
