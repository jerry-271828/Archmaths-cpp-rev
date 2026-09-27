// ArchCore kernel "geometry": shared contract for porting the page's
// recalculateGeometryObjects() fixed-point evaluation switch
// (arch-current.html:16467-17354) to wasm. This header is the SINGLE SOURCE
// OF TRUTH for the four per-type group translation units:
//   geometry_points.cpp     - point, midpoint, rotate, reflect, translate
//   geometry_intersect.cpp  - intersect, tangent
//   geometry_constructs.cpp - segment, ray, line, vector, perpendicularline,
//                             parallelline, anglebisector, circle, ellipse_ab,
//                             ellipse, hyperbola, parabola, circulararc
//   geometry_measure.cpp    - polygon, length, angle, area, isparallel,
//                             isperpendicular, isconcyclic, fitline
// See GEOMETRY_CONTRACT.md (same directory) for the full protocol spec.
//
// HARD REQUIREMENT: port the JS case bodies LINE BY LINE, preserving the
// exact floating-point operation order, write timing of every state field
// (including "write then fail" paths), branch conditions, and thresholds.
// Any deviation keeps the whole kernel on the JS fallback.

#pragma once

#include "../ExprProgram.h"
#include "../JsMath.h"

#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace ArchMaths {
namespace Core {

// ---- GeoType ---------------------------------------------------------------
// Fixed ids for every geometryType keyword accepted by parseGeometryDefinition
// (arch-current.html:16017-16268). Ids are STABLE: they travel in the text
// protocol, so never renumber. NOTE: there are 28 keywords (ellipse and
// ellipse_ab are distinct types).
enum class GeoType : int {
    Unknown = -1,
    Point = 0,               // 'point'
    Midpoint = 1,            // 'midpoint'
    Intersect = 2,           // 'intersect'
    Segment = 3,             // 'segment'
    Ray = 4,                 // 'ray'
    Line = 5,                // 'line'
    Vector = 6,              // 'vector'
    PerpendicularLine = 7,   // 'perpendicularline'
    ParallelLine = 8,        // 'parallelline'
    AngleBisector = 9,       // 'anglebisector'
    Circle = 10,             // 'circle'
    Ellipse = 11,            // 'ellipse'  (foci form)
    EllipseAb = 12,          // 'ellipse_ab' (a,b form; keyword written 'ellipse')
    Hyperbola = 13,          // 'hyperbola'
    Parabola = 14,           // 'parabola'
    Polygon = 15,            // 'polygon'
    Length = 16,             // 'length'
    Angle = 17,              // 'angle'
    Area = 18,               // 'area'
    IsParallel = 19,         // 'isparallel'
    IsPerpendicular = 20,    // 'isperpendicular'
    IsConcyclic = 21,        // 'isconcyclic'
    Rotate = 22,             // 'rotate'
    Reflect = 23,            // 'reflect'
    Translate = 24,          // 'translate'
    Fitline = 25,            // 'fitline'
    CircularArc = 26,        // 'circulararc'
    Tangent = 27,            // 'tangent'
};

// The page's point-like set: the only types that hold (x_val, y_val) as their
// primary output and can be referenced by [name,x]/[name,y] expressions
// (resolvePointCoords, arch-current.html:17698-17708) and rendered as dots.
inline bool isPointLikeType(GeoType t) {
    return t == GeoType::Point || t == GeoType::Midpoint || t == GeoType::Intersect ||
           t == GeoType::Rotate || t == GeoType::Reflect || t == GeoType::Translate;
}

// The page's isLineLike list (recalculateGeometryObjects:16528, 16691, 16747).
inline bool isLineLikeType(GeoType t) {
    return t == GeoType::Segment || t == GeoType::Ray || t == GeoType::Line ||
           t == GeoType::Vector || t == GeoType::PerpendicularLine ||
           t == GeoType::ParallelLine || t == GeoType::AngleBisector ||
           t == GeoType::Fitline || t == GeoType::Tangent;
}

// circle + circulararc (16692).
inline bool isCircleType(GeoType t) {
    return t == GeoType::Circle || t == GeoType::CircularArc;
}

// ellipse + hyperbola + parabola + ellipse_ab (16693).
inline bool isConicType(GeoType t) {
    return t == GeoType::Ellipse || t == GeoType::Hyperbola || t == GeoType::Parabola ||
           t == GeoType::EllipseAb;
}

// ---- Output/state record layout ---------------------------------------------
// The numeric state of one geometry entry is a fixed-stride row of doubles,
// identical for input upload and output readback (40 doubles per entry).
// NaN means "field never set" (mirrors a missing field on the JS entry
// object); groups write fields at exactly the moments the JS case does, so
// NaN round-trips reproduce JS stale-field semantics bit for bit.
//
// JS entry field <-> GeoOutField mapping (JS column = the entry property the
// adapter reads/writes; state column = the kernel-side meaning):
enum GeoOutField : int {
    GeoX = 0,          // x_val          point-like coordinate
    GeoY,              // y_val          point-like coordinate
    GeoRadius,         // radius         circle / circulararc
    GeoA,              // a              ellipse / ellipse_ab / hyperbola semi-axis
    GeoB,              // b              ellipse / ellipse_ab / hyperbola semi-axis
    GeoRotation,       // rotation       conic rotation (radians)
    GeoPFocal,         // p              PARABOLA focal length only (ellipse's p is a ref)
    GeoValue,          // value          measure entries
    GeoStartAngle,     // startAngle     circulararc
    GeoEndAngle,       // endAngle       circulararc
    GeoDistSum,        // dist_sum       ellipse
    GeoDistDiff,       // dist_diff      hyperbola
    GeoDirX,           // dir.x          entry.dir (normalized direction)
    GeoDirY,           // dir.y
    GeoDirVecX,        // dir_vec.x      entry.dir_vec (raw direction; point-to-point lines only)
    GeoDirVecY,        // dir_vec.y
    GeoP1X,            // p1x            LITERAL p1 coords (x_val style); ref p1 slots are compile-time
    GeoP1Y,            // p1y
    GeoP2X,            // p2x            LITERAL p2 coords (x_val style)
    GeoP2Y,            // p2y
    GeoCenterX,        // center.x       LITERAL conic center ({x,y} style); circle/arc center is a ref
    GeoCenterY,        // center.y
    GeoVertexX,        // vertex.x       parabola vertex ({x,y} style)
    GeoVertexY,        // vertex.y
    GeoF1X,            // f1.x_val       ellipse_ab literal foci; ellipse f1 is a ref
    GeoF1Y,            // f1.y_val
    GeoF2X,            // f2.x_val
    GeoF2Y,            // f2.y_val
    GeoErrCode,        // 0 none | 1 "交点求解复杂" (intersect) | 2 "切点不在圆弧范围内" (tangent)
    GeoMeaningful,     // isMeaningful   uploaded per run, iterated, written back (1/0)
    // Display intermediates for the JS adapter's detailsString regeneration
    // (see GEOMETRY_CONTRACT.md "detailsString"). Groups must write these when
    // the adapter cannot rebuild the text bit-exactly from the fields above.
    GeoTermA,          // conic: term1_A | fitline: m (vertical branch: avg_x) | tangent: k (vertical: NaN)
    GeoTermB,          // conic: term1_B | fitline: b (vertical branch: NaN)
    GeoTermC,          // conic: term1_C
    GeoTermD,          // conic: term2_D
    GeoTermE,          // conic: term2_E
    GeoTermF,          // conic: term3_F
    GeoFlags,          // bit0: adapter regenerates detailsString | bit1: adapter applies GeoErrCode
    GeoReserved2,
    GeoReserved3,
    GeoReserved4,
    GeoFieldCount
};

constexpr int kGeoStride = 40;           // doubles per entry row (>= GeoFieldCount; fixed forever)
constexpr double kGeoMeaningfulEps = 1e-9;

// ---- Point-coord references ([A,x] / [A,y] in expressions) ------------------
// resolvePointCoords replaces [name,x]/[name,y] with the referenced point
// entry's CURRENT x_val/y_val at every evaluation. The driver rewrites each
// match to a synthetic program parameter named gpr<j> at compile time and
// refreshes the values before every evalExpr() call, so mid-iteration changes
// are observed exactly like the JS path (variable names starting with "gpr"
// are rejected at compile time to keep the namespace disjoint).
struct GeoPointRef {
    int entryIndex = -1;   // compile-time resolved against the point map; -1 -> value 0
    bool isX = true;       // true -> x_val, false -> y_val
};

// ---- GeoEntry ----------------------------------------------------------------
// One parsed/compiled geometry entry. Object references (names of other
// geometry objects) are resolved to state indices AT COMPILE TIME; -1 means
// the name did not resolve (the case body then follows the JS "object not
// found" branch). Expression slots hold compiled CalcJs programs (0 args,
// params = all variables followed by the slot's synthetic gpr refs).
struct GeoEntry {
    GeoType type = GeoType::Unknown;
    std::string name;                     // raw name (map keys are lowercased)

    // Compile-time object references. Meaning is per type; index with the
    // GeoRefSlot values below (GEOMETRY_CONTRACT.md "ref slots").
    int refSlots[8] = {-1, -1, -1, -1, -1, -1, -1, -1};
    // polygon / area / fitline vertex references (state indices, -1 allowed).
    std::vector<int> pointRefs;

    // Expression slots, one compiled Program per slot the type owns
    // (GeoExprSlot indices; nullptr for absent slots).
    std::vector<std::unique_ptr<Program>> exprSlots;

    // Per expression slot: the [name,x]/[name,y] refs it contains (parallel
    // to exprSlots; empty vector for slots without refs).
    std::vector<std::vector<GeoPointRef>> exprRefs;

    // Per expression slot: param staging buffer (varValues followed by the
    // slot's synthetic ref values), uploaded before each evaluation.
    std::vector<std::vector<double>> paramBufs;

    // Numeric parameters parsed from the protocol.
    double sign = 1.0;                    // intersect / tangent
    int numPoints = 0;                    // polygon / area / fitline vertex count

    // Per-entry dependency lists (variableDependencies / objectDependencies
    // from parseGeometryDefinition), driving the depsMeaningful pre-check.
    std::vector<std::string> varDeps;     // names as stored (lower-case on the page)
    std::vector<std::string> objDeps;     // lower-case object names
};

// refSlots indices (shared vocabulary for the group ports).
enum GeoRefSlot : int {
    GeoRefA = 0,      // p1Name | onObjectName | obj1Name | centerName | lineName | f1Name |
                      // focusName | l1Name | axisName | vectorName | conicName (per type)
    GeoRefB = 1,      // p2Name | obj2Name | pointName(on perp/parallel) | pointOnCircleName |
                      // f2Name | directrixName | l2Name | rotatedPointName | reflectedPointName |
                      // translatedPointName | startPointName
    GeoRefC = 2,      // vertexName | pName(ellipse/hyperbola) | p3Name | endPointName |
                      // (pointOnObject uses GeoRefA as the object)
    GeoRefD = 3,      // p4Name (isconcyclic)
    // polygon/area/fitline point lists live in pointRefs (variable length).
    GeoRefPointList = 4   // -> std::vector<int> pointRefs (state indices, -1 allowed)
};

// exprSlots indices (shared vocabulary).
enum GeoExprSlot : int {
    GeoExprA = 0,     // x_expr | parameter_expr | radius_expr | a_expr | angle_expr |
                      // dx_expr | obj order fixed by type (per GEOMETRY_CONTRACT.md)
    GeoExprB = 1      // y_expr | b_expr | dy_expr
};

// ---- GeoState -----------------------------------------------------------------
struct GeoState {
    std::vector<GeoEntry> entries;        // same order as the JS geometryEntries array
    std::unordered_map<std::string, int> objectMap;   // lower-case name -> index; LAST wins
                                                      // (mirrors JS Map.set over entries order)
    std::unordered_map<std::string, int> pointMap;    // lower-case name -> index, FIRST wins,
                                                      // point-like types only (resolvePointCoords find())
    std::vector<std::string> varNames;    // uploaded variable names, setvars value order
    std::vector<double> varValues;
    double integralSteps = 100.0;
    std::vector<double> state;            // entries.size() * kGeoStride working copy

    double* row(int index) { return &state[static_cast<size_t>(index) * kGeoStride]; }
    const double* row(int index) const {
        return &state[static_cast<size_t>(index) * kGeoStride];
    }
    static double get(const double* r, GeoOutField f) { return r[static_cast<int>(f)]; }
    static void set(double* r, GeoOutField f, double v) { r[static_cast<int>(f)] = v; }

    bool isMeaningful(int index) const { return row(index)[GeoMeaningful] != 0.0; }

    // Value of a [name,x]/[name,y] reference, matching resolvePointCoords:
    // the referenced point entry's current coordinate, 0 when the entry is
    // missing or the coordinate is not finite.
    double resolvePointRef(const GeoPointRef& ref) const {
        if (ref.entryIndex < 0) return 0.0;
        const double v = row(ref.entryIndex)[ref.isX ? GeoX : GeoY];
        return JsMath::isFinite(v) ? v : 0.0;
    }

    // Evaluate one compiled expression slot of one entry: refreshes the
    // variable and point-ref params, then runs the program (flags 0, no args).
    // Returns NaN when the slot holds no program.
    double evalExpr(GeoEntry& entry, int slot) {
        if (slot < 0 || slot >= static_cast<int>(entry.exprSlots.size())) return JsMath::kNaN;
        Program* prog = entry.exprSlots[static_cast<size_t>(slot)].get();
        if (!prog) return JsMath::kNaN;
        std::vector<double>& buf = entry.paramBufs[static_cast<size_t>(slot)];
        const size_t nvars = varNames.size();
        for (size_t k = 0; k < nvars; ++k) buf[k] = varValues[k];
        const std::vector<GeoPointRef>& refs = entry.exprRefs[static_cast<size_t>(slot)];
        for (size_t j = 0; j < refs.size(); ++j) buf[nvars + j] = resolvePointRef(refs[j]);
        prog->setParams(buf.data(), static_cast<int>(buf.size()));
        return prog->evaluateOne(nullptr, 0);
    }
};

// ---- Group functions ----------------------------------------------------------
// Each group function ports the switch-case bodies of its types for ONE entry
// and ONE evaluation pass. The driver has already:
//   * verified depsMeaningful (variable + object pre-check, 16504-16527),
//   * cleared GeoErrCode and GeoFlags,
// and passes st = the entry's state row (NaN-initialised fields mirror JS
// fields that were never set).
//
// Contract for implementations:
//   * Return false ONLY when the type is not (fully) ported -> the driver
//     aborts the whole run with 0 and the page keeps its JS path.
//   * On success return true and set st[GeoMeaningful] to 1/0 (the JS
//     newMeaningful), write output fields at EXACTLY the moments the JS case
//     writes them (verbatim port, same operation order), set st[GeoErrCode]
//     for the two known error strings, and write GeoTermA..GeoTermF for the
//     detailsString intermediates listed in GEOMETRY_CONTRACT.md.
bool geoEvalPoints(GeoState& state, GeoEntry& entry, double* st);
bool geoEvalIntersect(GeoState& state, GeoEntry& entry, double* st);
bool geoEvalConstructs(GeoState& state, GeoEntry& entry, double* st);
bool geoEvalMeasure(GeoState& state, GeoEntry& entry, double* st);

// Driver-side dispatch (geometry.cpp): which group owns which type.
inline bool geoDispatch(GeoType t, GeoState& s, GeoEntry& e, double* st) {
    switch (t) {
        case GeoType::Point: case GeoType::Midpoint:
        case GeoType::Rotate: case GeoType::Reflect: case GeoType::Translate:
            return geoEvalPoints(s, e, st);
        case GeoType::Intersect: case GeoType::Tangent:
            return geoEvalIntersect(s, e, st);
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
        case GeoType::PerpendicularLine: case GeoType::ParallelLine: case GeoType::AngleBisector:
        case GeoType::Circle: case GeoType::Ellipse: case GeoType::EllipseAb:
        case GeoType::Hyperbola: case GeoType::Parabola: case GeoType::CircularArc:
            return geoEvalConstructs(s, e, st);
        case GeoType::Polygon: case GeoType::Length: case GeoType::Angle: case GeoType::Area:
        case GeoType::IsParallel: case GeoType::IsPerpendicular: case GeoType::IsConcyclic:
        case GeoType::Fitline:
            return geoEvalMeasure(s, e, st);
        default:
            return false;   // Unknown -> unported -> JS fallback
    }
}

// ---- Fixed-point iteration (the driver, geometry.cpp) ------------------------
// Verbatim port of recalculateGeometryObjects' outer loop (16492-17366):
//
//   maxIterations = 20; iteration = 0; changedInIteration = true
//   while (changedInIteration && iteration < maxIterations):
//     changedInIteration = false; iteration++
//     for each entry i (in state order = JS geometryEntries order):
//       oldMeaningful = st[GeoMeaningful] != 0
//       oldValues = {x: st[GeoX], y: st[GeoY], r: st[GeoRadius]}
//       depsMeaningful = all entry.varDeps present & finite in varValues
//                        && all entry.objDeps resolve & st[dep][GeoMeaningful] != 0
//       if !depsMeaningful:
//         st[GeoMeaningful] = 0            // compilationError untouched, like JS
//         if oldMeaningful: changedInIteration = true
//         continue
//       st[GeoErrCode] = 0; st[GeoFlags] = 0
//       if !geoDispatch(type, state, entry, st): return false   // group declined -> JS fallback
//       newMeaningful = st[GeoMeaningful] != 0
//       st[GeoFlags] = GeoFlagErrTouched | (details ? GeoFlagDetails : 0)
//         where details = newMeaningful || type == Polygon   // polygon sets "" unconditionally
//       if newMeaningful != oldMeaningful: changedInIteration = true
//       else if newMeaningful:
//         if type in {point, midpoint, intersect}
//            && (|st[GeoX]-old.x| > 1e-9 || |st[GeoY]-old.y| > 1e-9): changedInIteration = true
//         else if type == Circle && |st[GeoRadius]-old.r| > 1e-9: changedInIteration = true
//   return true
//
// (JS comparison with a never-set field is Math.abs(x - undefined) = NaN,
// which never exceeds 1e-9 - NaN-initialised rows reproduce this.)

enum GeoRunFlags : int {
    GeoFlagDetails = 1,      // adapter regenerates detailsString from contract templates
    GeoFlagErrTouched = 2    // adapter applies GeoErrCode (0 -> compilationError = undefined)
};

} // namespace Core
} // namespace ArchMaths
