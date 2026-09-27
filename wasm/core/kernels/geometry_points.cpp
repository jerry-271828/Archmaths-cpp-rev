// ArchCore kernel "geometry" - POINT group.
//
// Ports the recalculateGeometryObjects() switch cases for the point-construct
// types, line by line from arch-current.html (line numbers as of 2026-09-26):
//   GeoType::Point      'point'      case 16534-16622, parse 16018-16036
//                       (free x/y expressions, or pointOnObject with a
//                       parameter_expr over line-like / circle / ellipse /
//                       ellipse_ab / hyperbola / parabola / circulararc)
//   GeoType::Midpoint   'midpoint'   case 16623-16633, parse 16037-16043
//   GeoType::Rotate     'rotate'     case 16634-16651, parse 16207-16215
//   GeoType::Reflect    'reflect'    case 16652-16676, parse 16216-16222
//                                    (axis in ['point','midpoint','intersect']
//                                    -> point reflection, else line-like axis)
//   GeoType::Translate  'translate'  case 16677-16697, parse 16223-16239
//                                    (vector entry, or dx/dy expressions)
//
// Verbatim port: same operation order and grouping, same field write moments,
// same gates and thresholds. See GEOMETRY_CONTRACT.md / geometry_common.h.
#include "geometry_common.h"

namespace ArchMaths {
namespace Core {

namespace {

constexpr double kPI = 3.141592653589793;   // Math.PI (same literal as advfuncs.cpp)

// ---- JS property reads on line-like entries ---------------------------------
// The page's line-like cases store entry.p1/entry.p2 as LIVE refs for
// point-to-point lines (segment/ray/line/vector), as the through-point ref for
// perpendicularline/parallelline, the vertex ref for anglebisector, and as
// literal {x_val,y_val} objects for fitline/tangent (arch-current.html
// 16829-16888, 17133-17166, 17191+; the adapter packs the literals into
// GeoP1X/Y and GeoP2X/Y). These helpers reproduce the JS `!entry.p1` /
// `!entry.p2` property-existence checks: a ref that never resolved, or a
// literal slot that was never written (NaN), means "property missing".

bool lineLikeP1(const GeoState& state, int objIdx, double& x, double& y) {
    const GeoEntry& e = state.entries[static_cast<size_t>(objIdx)];
    int refIdx = -1;
    switch (e.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
            refIdx = e.refSlots[GeoRefA];
            break;
        case GeoType::PerpendicularLine: case GeoType::ParallelLine:
            refIdx = e.refSlots[GeoRefB];   // pointName (the through-point)
            break;
        case GeoType::AngleBisector:
            refIdx = e.refSlots[GeoRefC];   // vertexName
            break;
        case GeoType::Fitline: case GeoType::Tangent: {
            const double* r = state.row(objIdx);
            x = r[GeoP1X];
            y = r[GeoP1Y];
            return !JsMath::isNaN(x);   // p1/p2 are written together
        }
        default:
            return false;
    }
    if (refIdx < 0) return false;
    const double* r = state.row(refIdx);
    x = r[GeoX];
    y = r[GeoY];
    return true;
}

bool lineLikeP2(const GeoState& state, int objIdx, double& x, double& y) {
    const GeoEntry& e = state.entries[static_cast<size_t>(objIdx)];
    int refIdx = -1;
    switch (e.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
            refIdx = e.refSlots[GeoRefB];
            break;
        case GeoType::PerpendicularLine: case GeoType::ParallelLine:
        case GeoType::AngleBisector: case GeoType::Fitline: case GeoType::Tangent: {
            const double* r = state.row(objIdx);
            x = r[GeoP2X];
            y = r[GeoP2Y];
            return !JsMath::isNaN(x);
        }
        default:
            return false;
    }
    if (refIdx < 0) return false;
    const double* r = state.row(refIdx);
    x = r[GeoX];
    y = r[GeoY];
    return true;
}

// ---- point (arch-current.html 16534-16622) ----------------------------------

bool evalPoint(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    // entry.pointOnObject ⇔ the driver left the y_expr slot uncompiled
    // (protocol po="1" compiles only parameter_expr into slot 0; po="0"
    // compiles x_expr/y_expr into slots 0/1).
    const bool pointOnObject = entry.exprSlots.size() > GeoExprB &&
                               entry.exprSlots[static_cast<size_t>(GeoExprB)] == nullptr;
    if (pointOnObject) {
        const int onIdx = entry.refSlots[GeoRefA];
        // if (!onObject || !onObject.isMeaningful)
        if (onIdx < 0 || !state.isMeaningful(onIdx)) {
            newMeaningful = false;
        } else {
            const double* onRow = state.row(onIdx);
            const GeoType onType = state.entries[static_cast<size_t>(onIdx)].type;
            const double param = state.evalExpr(entry, GeoExprA);
            if (!JsMath::isFinite(param)) {
                newMeaningful = false;
            } else if (isLineLikeType(onType)) {
                if ((onType == GeoType::Segment || onType == GeoType::Vector) &&
                    (param < 0.0 || param > 1.0)) {
                    newMeaningful = false;
                } else if (onType == GeoType::Ray && param < 0.0) {
                    newMeaningful = false;
                }
                if (newMeaningful) {
                    // if (onObject.p1 && (onObject.dir_vec || onObject.dir))
                    double p1x = 0.0, p1y = 0.0;
                    const bool hasP1 = lineLikeP1(state, onIdx, p1x, p1y);
                    double dirx = 0.0, diry = 0.0;
                    bool hasDir = false;
                    if (!JsMath::isNaN(onRow[GeoDirVecX]) && !JsMath::isNaN(onRow[GeoDirVecY])) {
                        dirx = onRow[GeoDirVecX];
                        diry = onRow[GeoDirVecY];
                        hasDir = true;
                    } else if (!JsMath::isNaN(onRow[GeoDirX]) && !JsMath::isNaN(onRow[GeoDirY])) {
                        dirx = onRow[GeoDirX];
                        diry = onRow[GeoDirY];
                        hasDir = true;
                    }
                    if (hasP1 && hasDir) {
                        st[GeoX] = p1x + param * dirx;
                        st[GeoY] = p1y + param * diry;
                    } else {
                        newMeaningful = false;
                    }
                }
            } else if (onType == GeoType::Circle) {
                const int cIdx = state.entries[static_cast<size_t>(onIdx)].refSlots[GeoRefA];
                if (cIdx < 0) {
                    // onObject.center undefined -> TypeError in the page -> catch
                    newMeaningful = false;
                } else {
                    const double* cRow = state.row(cIdx);
                    const double angle = param * 2.0 * kPI;
                    st[GeoX] = cRow[GeoX] + onRow[GeoRadius] * std::cos(angle);
                    st[GeoY] = cRow[GeoY] + onRow[GeoRadius] * std::sin(angle);
                }
            } else if (onType == GeoType::Ellipse || onType == GeoType::EllipseAb) {
                // if (!onObject.center || onObject.rotation === undefined)
                if (JsMath::isNaN(onRow[GeoCenterX]) || JsMath::isNaN(onRow[GeoRotation])) {
                    newMeaningful = false;
                } else {
                    const double t = param * 2.0 * kPI;
                    const double localX = onRow[GeoA] * std::cos(t);
                    const double localY = onRow[GeoB] * std::sin(t);
                    const double rot = onRow[GeoRotation];
                    st[GeoX] = onRow[GeoCenterX] + localX * std::cos(rot) - localY * std::sin(rot);
                    st[GeoY] = onRow[GeoCenterY] + localX * std::sin(rot) + localY * std::cos(rot);
                }
            } else if (onType == GeoType::Hyperbola) {
                if (JsMath::isNaN(onRow[GeoCenterX]) || JsMath::isNaN(onRow[GeoRotation])) {
                    newMeaningful = false;
                } else {
                    const double magic_offset = 100000;
                    double branch_sign = 1.0;
                    double t = param;
                    if (param < -magic_offset / 2.0) {
                        branch_sign = -1.0;
                        t = param + magic_offset;
                    }
                    const double localX = branch_sign * onRow[GeoA] * std::cosh(t);
                    const double localY = onRow[GeoB] * std::sinh(t);
                    const double rot = onRow[GeoRotation];
                    st[GeoX] = onRow[GeoCenterX] + localX * std::cos(rot) - localY * std::sin(rot);
                    st[GeoY] = onRow[GeoCenterY] + localX * std::sin(rot) + localY * std::cos(rot);
                }
            } else if (onType == GeoType::Parabola) {
                if (JsMath::isNaN(onRow[GeoVertexX]) || JsMath::isNaN(onRow[GeoRotation])) {
                    newMeaningful = false;
                } else {
                    const double t = param;
                    const double localX = (t * t) / (4.0 * onRow[GeoPFocal]);
                    const double localY = t;
                    const double rot = onRow[GeoRotation];
                    const double rotatedLocalX = localX * std::cos(rot) - localY * std::sin(rot);
                    const double rotatedLocalY = localX * std::sin(rot) + localY * std::cos(rot);
                    st[GeoX] = onRow[GeoVertexX] + rotatedLocalX;
                    st[GeoY] = onRow[GeoVertexY] + rotatedLocalY;
                }
            } else if (onType == GeoType::CircularArc) {
                const int cIdx = state.entries[static_cast<size_t>(onIdx)].refSlots[GeoRefA];
                // if (!onObject.center || onObject.radius === undefined)
                if (cIdx < 0 || JsMath::isNaN(onRow[GeoRadius])) {
                    newMeaningful = false;
                } else {
                    const double* cRow = state.row(cIdx);
                    double startAngle = onRow[GeoStartAngle];
                    double endAngle = onRow[GeoEndAngle];
                    if (endAngle < startAngle) endAngle += 2.0 * kPI;
                    const double angle = startAngle + param * (endAngle - startAngle);
                    st[GeoX] = cRow[GeoX] + onRow[GeoRadius] * std::cos(angle);
                    st[GeoY] = cRow[GeoY] + onRow[GeoRadius] * std::sin(angle);
                }
            }
            // Any other onObject type (point-like rotate/reflect/translate,
            // polygon, ...): no branch matches; the page leaves newMeaningful
            // true and does not touch x_val/y_val. Keep that quirk.
        }
    } else {
        const double x = state.evalExpr(entry, GeoExprA);
        const double y = state.evalExpr(entry, GeoExprB);
        if (JsMath::isFinite(x) && JsMath::isFinite(y)) {
            st[GeoX] = x;
            st[GeoY] = y;
        } else {
            newMeaningful = false;
        }
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
    return true;
}

// ---- midpoint (16623-16633) -------------------------------------------------

bool evalMidpoint(GeoState& state, GeoEntry& entry, double* st) {
    const int p1Idx = entry.refSlots[GeoRefA];
    const int p2Idx = entry.refSlots[GeoRefB];
    if (p1Idx < 0 || p2Idx < 0) {   // if (!p1 || !p2)
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const double* p1 = state.row(p1Idx);
    const double* p2 = state.row(p2Idx);
    st[GeoX] = (p1[GeoX] + p2[GeoX]) / 2.0;
    st[GeoY] = (p1[GeoY] + p2[GeoY]) / 2.0;
    st[GeoMeaningful] = 1.0;
    return true;
}

// ---- rotate (16634-16651) ---------------------------------------------------

bool evalRotate(GeoState& state, GeoEntry& entry, double* st) {
    const int cIdx = entry.refSlots[GeoRefA];
    const int pIdx = entry.refSlots[GeoRefB];
    if (cIdx < 0 || pIdx < 0) {   // if (!center || !p)
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const double angle_deg = state.evalExpr(entry, GeoExprA);
    if (!JsMath::isFinite(angle_deg)) {
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const double* center = state.row(cIdx);
    const double* p = state.row(pIdx);
    const double angle_rad = angle_deg * (kPI / 180.0);
    const double cos_a = std::cos(angle_rad);
    const double sin_a = std::sin(angle_rad);
    const double rel_x = p[GeoX] - center[GeoX];
    const double rel_y = p[GeoY] - center[GeoY];
    st[GeoX] = center[GeoX] + rel_x * cos_a - rel_y * sin_a;
    st[GeoY] = center[GeoY] + rel_x * sin_a + rel_y * cos_a;
    st[GeoMeaningful] = 1.0;
    return true;
}

// ---- reflect (16652-16676) --------------------------------------------------

bool evalReflect(GeoState& state, GeoEntry& entry, double* st) {
    const int aIdx = entry.refSlots[GeoRefA];
    const int pIdx = entry.refSlots[GeoRefB];
    if (aIdx < 0 || pIdx < 0) {   // if (!axis || !p)
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const GeoType aType = state.entries[static_cast<size_t>(aIdx)].type;
    const double* p = state.row(pIdx);
    // ['point', 'midpoint', 'intersect'].includes(axis.geometryType)
    if (aType == GeoType::Point || aType == GeoType::Midpoint || aType == GeoType::Intersect) {
        const double* axis = state.row(aIdx);
        st[GeoX] = 2.0 * axis[GeoX] - p[GeoX];
        st[GeoY] = 2.0 * axis[GeoY] - p[GeoY];
    } else {
        // if (!lineLike.includes(axis.geometryType) || !axis.p1 || !axis.dir)
        if (!isLineLikeType(aType)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        double p1x = 0.0, p1y = 0.0;
        if (!lineLikeP1(state, aIdx, p1x, p1y)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        const double* aRow = state.row(aIdx);
        if (JsMath::isNaN(aRow[GeoDirX]) || JsMath::isNaN(aRow[GeoDirY])) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        const double dirx = aRow[GeoDirX];
        const double diry = aRow[GeoDirY];
        const double vec_ap_x = p[GeoX] - p1x;
        const double vec_ap_y = p[GeoY] - p1y;
        const double t = vec_ap_x * dirx + vec_ap_y * diry;
        const double proj_x = p1x + t * dirx;
        const double proj_y = p1y + t * diry;
        st[GeoX] = 2.0 * proj_x - p[GeoX];
        st[GeoY] = 2.0 * proj_y - p[GeoY];
    }
    st[GeoMeaningful] = 1.0;
    return true;
}

// ---- translate (16677-16697) ------------------------------------------------

bool evalTranslate(GeoState& state, GeoEntry& entry, double* st) {
    const int pIdx = entry.refSlots[GeoRefB];
    if (pIdx < 0) {   // if (!p)
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const double* p = state.row(pIdx);
    double dx = 0.0, dy = 0.0;
    const int vIdx = entry.refSlots[GeoRefA];   // entry.vectorName; empty in the dx/dy form
    if (vIdx >= 0) {
        // if (!v || !v.p1 || !v.p2) - only the nine line-like types ever
        // assign both p1 and p2 (their cases write entry.p1/entry.p2).
        const GeoType vType = state.entries[static_cast<size_t>(vIdx)].type;
        if (!isLineLikeType(vType)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        double p1x = 0.0, p1y = 0.0, p2x = 0.0, p2y = 0.0;
        if (!lineLikeP1(state, vIdx, p1x, p1y)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        if (!lineLikeP2(state, vIdx, p2x, p2y)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
        dx = p2x - p1x;
        dy = p2y - p1y;
    } else {
        dx = state.evalExpr(entry, GeoExprA);
        dy = state.evalExpr(entry, GeoExprB);
        if (!JsMath::isFinite(dx) || !JsMath::isFinite(dy)) {
            st[GeoMeaningful] = 0.0;
            return true;
        }
    }
    st[GeoX] = p[GeoX] + dx;
    st[GeoY] = p[GeoY] + dy;
    st[GeoMeaningful] = 1.0;
    return true;
}

} // namespace

bool geoEvalPoints(GeoState& state, GeoEntry& entry, double* st) {
    switch (entry.type) {
        case GeoType::Point:     return evalPoint(state, entry, st);
        case GeoType::Midpoint:  return evalMidpoint(state, entry, st);
        case GeoType::Rotate:    return evalRotate(state, entry, st);
        case GeoType::Reflect:   return evalReflect(state, entry, st);
        case GeoType::Translate: return evalTranslate(state, entry, st);
        default:                 return false;   // not this group's type
    }
}

} // namespace Core
} // namespace ArchMaths
