// ArchCore kernel "geometry" - MEASURE group.
//
// Line-by-line ports of the measure switch cases of the page's
// recalculateGeometryObjects() (arch-current.html; ranges verified 2026-09-26).
// See GEOMETRY_CONTRACT.md for the full protocol and the hard porting rules.
// This group owns:
//   GeoType::Polygon  'polygon'  case 17033-17038, parse 16130-16137
//   GeoType::Length   'length'   case 17039-17046, parse 16138-16144
//   GeoType::Angle    'angle'    case 17047-17065, parse 16145-16153
//   GeoType::Area     'area'     case 17066-17079, parse 16154-16161
//   GeoType::IsParallel      case 17080-17088, parse 16162-16176
//   GeoType::IsPerpendicular case 17089-17097, parse 16177-16191
//   GeoType::IsConcyclic     case 17098-17132, parse 16192-16206
//   GeoType::Fitline  'fitline'  case 17133-17166, parse 16240-16247
//
// Math.* -> JsMath/std mappings follow the contract: Math.hypot ->
// JsMath::hypot, Math.min/max -> JsMath::min/max (NaN semantics), `**2` ->
// JsMath::pow(v, 2.0), sqrt/acos/abs/atan2 -> std::. JS "property never
// assigned" (!obj.dir / !pN / missing point ref) -> NaN slot / ref index -1
// (contract section 9.3). detailsString text is adapter-side; the kernel only
// writes the GeoTermA/GeoTermB intermediates the adapter cannot rebuild
// (fitline m/b) and sets isMeaningful exactly where the JS case does.
#include "geometry_common.h"

#include <cmath>

namespace ArchMaths {
namespace Core {

namespace {

// Math.PI as a double literal (same constant as the other kernels).
constexpr double kPI = 3.141592653589793;

// 'polygon' (17033-17038): entry.points = pointNames.map(objectMap.get...);
// if (entry.points.some(p => !p)) newMeaningful = false;
// Unlike the other cases the page does NOT break after the failure - it still
// sets detailsString = ""; the driver reproduces that flag for Polygon
// unconditionally, so this port only decides isMeaningful. entry.points itself
// is adapter-side (contract section 9.7) and is not written here.
void evalPolygon(GeoState& state, GeoEntry& entry, double* st) {
    (void)state;
    bool newMeaningful = true;
    for (int idx : entry.pointRefs) {
        if (idx < 0) { newMeaningful = false; break; }   // some(p => !p)
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'length' (17039-17046):
//   entry.value = Math.hypot(p2.x_val - p1.x_val, p2.y_val - p1.y_val);
void evalLength(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int i1 = entry.refSlots[GeoRefA];
    const int i2 = entry.refSlots[GeoRefB];
    if (i1 < 0 || i2 < 0) { newMeaningful = false; }
    else {
        const double* r1 = state.row(i1);
        const double* r2 = state.row(i2);
        st[GeoValue] = JsMath::hypot(r2[GeoX] - r1[GeoX], r2[GeoY] - r1[GeoY]);
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'angle' (17047-17065): angle p1-vertex-p3 in degrees.
void evalAngle(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int i1 = entry.refSlots[GeoRefA];    // p1Name
    const int iv = entry.refSlots[GeoRefC];    // vertexName
    const int i3 = entry.refSlots[GeoRefB];    // p3Name
    if (i1 < 0 || iv < 0 || i3 < 0) { newMeaningful = false; }
    else {
        const double* r1 = state.row(i1);
        const double* rv = state.row(iv);
        const double* r3 = state.row(i3);
        const double vBAx = r1[GeoX] - rv[GeoX];
        const double vBAy = r1[GeoY] - rv[GeoY];
        const double vBCx = r3[GeoX] - rv[GeoX];
        const double vBCy = r3[GeoY] - rv[GeoY];
        const double lenBA = JsMath::hypot(vBAx, vBAy);
        const double lenBC = JsMath::hypot(vBCx, vBCy);
        if (lenBA < 1e-9 || lenBC < 1e-9) { newMeaningful = false; }
        else {
            const double dot = vBAx * vBCx + vBAy * vBCy;
            const double cosTheta = dot / (lenBA * lenBC);
            st[GeoValue] =
                std::acos(JsMath::max(-1.0, JsMath::min(1.0, cosTheta))) * (180.0 / kPI);
        }
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'area' (17066-17079): shoelace formula over entry.points.
void evalArea(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    for (int idx : entry.pointRefs) {
        if (idx < 0) { newMeaningful = false; break; }
    }
    if (newMeaningful) {
        double areaVal = 0.0;   // let area_val = 0
        const int n = entry.numPoints;
        for (int i = 0; i < n; ++i) {
            const double* p1 = state.row(entry.pointRefs[static_cast<size_t>(i)]);
            const double* p2 = state.row(entry.pointRefs[static_cast<size_t>((i + 1) % n)]);
            areaVal += (p1[GeoX] * p2[GeoY] - p2[GeoX] * p1[GeoY]);
        }
        st[GeoValue] = std::fabs(areaVal) / 2.0;
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'isparallel' (17080-17088): cross product of the two lines' normalized dirs.
// JS `!l1.dir` means the dir property was never assigned -> GeoDirX is NaN.
void evalIsParallel(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int i1 = entry.refSlots[GeoRefA];
    const int i2 = entry.refSlots[GeoRefB];
    if (i1 < 0 || i2 < 0 ||
        JsMath::isNaN(state.row(i1)[GeoDirX]) || JsMath::isNaN(state.row(i2)[GeoDirX])) {
        newMeaningful = false;
    } else {
        const double* r1 = state.row(i1);
        const double* r2 = state.row(i2);
        const double crossZ = r1[GeoDirX] * r2[GeoDirY] - r1[GeoDirY] * r2[GeoDirX];
        st[GeoValue] = std::fabs(crossZ) < 1e-9 ? 1.0 : 0.0;
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'isperpendicular' (17089-17097): dot product of the two lines' dirs.
void evalIsPerpendicular(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int i1 = entry.refSlots[GeoRefA];
    const int i2 = entry.refSlots[GeoRefB];
    if (i1 < 0 || i2 < 0 ||
        JsMath::isNaN(state.row(i1)[GeoDirX]) || JsMath::isNaN(state.row(i2)[GeoDirX])) {
        newMeaningful = false;
    } else {
        const double* r1 = state.row(i1);
        const double* r2 = state.row(i2);
        const double dotProduct = r1[GeoDirX] * r2[GeoDirX] + r1[GeoDirY] * r2[GeoDirY];
        st[GeoValue] = std::fabs(dotProduct) < 1e-9 ? 1.0 : 0.0;
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'isconcyclic' (17098-17132): circumcircle of p1,p2,p3 vs p4; the
// |D| < 1e-9 branch reproduces the page's collinear-point quirk verbatim.
void evalIsConcyclic(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int i1 = entry.refSlots[GeoRefA];
    const int i2 = entry.refSlots[GeoRefB];
    const int i3 = entry.refSlots[GeoRefC];
    const int i4 = entry.refSlots[GeoRefD];
    if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0) { newMeaningful = false; }
    else {
        const double* r1 = state.row(i1);
        const double* r2 = state.row(i2);
        const double* r3 = state.row(i3);
        const double* r4 = state.row(i4);
        const double x1 = r1[GeoX], y1 = r1[GeoY];
        const double x2 = r2[GeoX], y2 = r2[GeoY];
        const double x3 = r3[GeoX], y3 = r3[GeoY];
        const double x4 = r4[GeoX], y4 = r4[GeoY];

        const double ax = x2 - x1, ay = y2 - y1;
        const double bx = x3 - x1, by = y3 - y1;
        const double D = 2 * (ax * by - ay * bx);

        if (std::fabs(D) < 1e-9) {
            const double aX = x2 - x1, aY = y2 - y1;   // the JS recomputes these
            const double bX = x3 - x1, bY = y3 - y1;
            const double cX = x4 - x1, cY = y4 - y1;
            const double crossAb = aX * bY - aY * bX;
            const double crossAc = aX * cY - aY * cX;
            st[GeoValue] =
                (std::fabs(crossAb) < 1e-9 && std::fabs(crossAc) < 1e-9) ? 1.0 : 0.0;
        } else {
            const double sqA = ax * ax + ay * ay;
            const double sqB = bx * bx + by * by;
            const double centerX = x1 + (sqA * by - sqB * ay) / D;
            const double centerY = y1 + (sqB * ax - sqA * bx) / D;
            const double radiusSq = JsMath::pow(x1 - centerX, 2.0) + JsMath::pow(y1 - centerY, 2.0);
            const double distP4Sq = JsMath::pow(x4 - centerX, 2.0) + JsMath::pow(y4 - centerY, 2.0);
            st[GeoValue] = std::fabs(distP4Sq - radiusSq) < 1e-7 ? 1.0 : 0.0;
        }
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

// 'fitline' (17133-17166): least-squares line. GeoTermA/GeoTermB carry the
// m/b intermediates for the adapter's detailsString (contract section 6):
// vertical branch -> GeoTermA = avg_x, GeoTermB stays NaN (never assigned).
void evalFitline(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    for (int idx : entry.pointRefs) {
        if (idx < 0) { newMeaningful = false; break; }
    }
    if (newMeaningful) {
        const double n = static_cast<double>(entry.numPoints);
        if (n < 2) { newMeaningful = false; }
        else {
            double sumX = 0.0, sumY = 0.0, sumXY = 0.0, sumX2 = 0.0;
            for (int idx : entry.pointRefs) {
                const double* r = state.row(idx);
                sumX += r[GeoX];
                sumY += r[GeoY];
                sumXY += r[GeoX] * r[GeoY];
                sumX2 += r[GeoX] * r[GeoX];
            }

            const double denominator = n * sumX2 - sumX * sumX;
            if (std::fabs(denominator) < 1e-9) {
                const double avgX = sumX / n;
                st[GeoP1X] = avgX; st[GeoP1Y] = 0.0;
                st[GeoP2X] = avgX; st[GeoP2Y] = 1.0;
                st[GeoDirX] = 0.0; st[GeoDirY] = 1.0;
                st[GeoTermA] = avgX;   // adapter: `x = ${GeoP1X.toPrecision(4)}`
            } else {
                const double m = (n * sumXY - sumX * sumY) / denominator;
                const double b = (sumY - m * sumX) / n;
                st[GeoP1X] = 0.0; st[GeoP1Y] = b;
                st[GeoP2X] = 1.0; st[GeoP2Y] = m + b;
                const double dirLen = JsMath::hypot(1.0, m);
                st[GeoDirX] = 1.0 / dirLen;
                st[GeoDirY] = m / dirLen;
                st[GeoTermA] = m;
                st[GeoTermB] = b;
            }
        }
    }
    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
}

} // namespace

bool geoEvalMeasure(GeoState& state, GeoEntry& entry, double* st) {
    switch (entry.type) {
        case GeoType::Polygon:           evalPolygon(state, entry, st); break;
        case GeoType::Length:            evalLength(state, entry, st); break;
        case GeoType::Angle:             evalAngle(state, entry, st); break;
        case GeoType::Area:              evalArea(state, entry, st); break;
        case GeoType::IsParallel:        evalIsParallel(state, entry, st); break;
        case GeoType::IsPerpendicular:   evalIsPerpendicular(state, entry, st); break;
        case GeoType::IsConcyclic:       evalIsConcyclic(state, entry, st); break;
        case GeoType::Fitline:           evalFitline(state, entry, st); break;
        default:
            return false;   // not owned by this group -> driver aborts -> JS fallback
    }
    return true;
}

} // namespace Core
} // namespace ArchMaths
