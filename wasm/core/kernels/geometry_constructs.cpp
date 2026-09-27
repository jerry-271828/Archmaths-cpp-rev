// ArchCore kernel "geometry" - CONSTRUCTS group.
//
// Line-by-line ports of the recalculateGeometryObjects() case bodies
// (arch-current.html:16829-17032, 17167-17190): same floating-point operation
// order, same field write moments (including write-then-fail paths), same
// branch conditions and thresholds. See GEOMETRY_CONTRACT.md.
//
// This group owns:
//   GeoType::Segment .. GeoType::Vector   'segment'/'ray'/'line'/'vector'
//                       case 16829-16888 (shared point-to-point body),
//                       parse 16053-16059
//   GeoType::PerpendicularLine  case 16840-16845, parse 16060-16066
//   GeoType::ParallelLine       case 16846-16851, parse 16067-16073
//   GeoType::AngleBisector      case 16852-16864, parse 16074-16082
//   GeoType::Circle     'circle' case 16889-16909, parse 16083-16095
//   GeoType::EllipseAb  'ellipse_ab' case 16910-16939, parse 16096-16113
//   GeoType::Ellipse    'ellipse'  case 16940-16972, parse 16096-16113
//   GeoType::Hyperbola  'hyperbola' case 16973-17005, parse 16114-16122
//   GeoType::Parabola   'parabola'  case 17006-17032, parse 16123-16129
//   GeoType::CircularArc 'circulararc' case 17167-17190, parse 16248-16256
#include "geometry_common.h"

namespace ArchMaths {
namespace Core {

namespace {

// JS `v ** 2` (the ** operator / Math.pow semantics; JsMath::pow keeps the
// NaN/Infinity edge cases identical to V8).
inline double jsSq(double v) { return JsMath::pow(v, 2.0); }

// JS `entry.p1.x_val` / `entry.p1.y_val` for a line-like entry: p1 is a
// compile-time object ref for point-to-point lines / perp / parallel /
// anglebisector (the page stores the referenced point object in entry.p1)
// and a literal {x_val, y_val} for fitline / tangent. Returns false when p1
// was never assigned — the JS case would throw on the undefined read and the
// enclosing catch maps to newMeaningful = false.
bool lineP1XY(const GeoState& state, int lineIdx, double& x, double& y) {
    const GeoEntry& e = state.entries[static_cast<size_t>(lineIdx)];
    int ref = -1;
    switch (e.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
            ref = e.refSlots[GeoRefA];
            break;
        case GeoType::PerpendicularLine: case GeoType::ParallelLine:
            ref = e.refSlots[GeoRefB];   // pointName
            break;
        case GeoType::AngleBisector:
            ref = e.refSlots[GeoRefC];   // vertexName
            break;
        case GeoType::Fitline: case GeoType::Tangent: {
            const double* r = state.row(lineIdx);
            if (JsMath::isNaN(r[GeoP1X])) return false;   // !entry.p1
            x = r[GeoP1X];
            y = r[GeoP1Y];
            return true;
        }
        default:
            return false;
    }
    if (ref < 0) return false;
    x = state.row(ref)[GeoX];
    y = state.row(ref)[GeoY];
    return true;
}

// Shared line body, arch-current.html:16831-16874. p1/p2 are object refs for
// point-to-point lines; for perp/parallel/anglebisector p2 is the synthesized
// literal { x_val: p1.x_val + dir.x, y_val: p1.y_val + dir.y } (raw dir).
bool evalLineConstruct(GeoState& state, GeoEntry& entry, double* st) {
    double p1x = 0.0, p1y = 0.0;    // p1.x_val / p1.y_val
    double dirx = 0.0, diry = 0.0;  // raw dir
    bool isPointToPointLine = false;

    switch (entry.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector: {
            // p1 = objectMap.get(entry.p1Name); p2 = objectMap.get(entry.p2Name);
            const int p1 = entry.refSlots[GeoRefA];
            const int p2 = entry.refSlots[GeoRefB];
            if (p1 < 0 || p2 < 0) { st[GeoMeaningful] = 0.0; return true; }   // !p1 || !p2
            p1x = state.row(p1)[GeoX];
            p1y = state.row(p1)[GeoY];
            dirx = state.row(p2)[GeoX] - p1x;
            diry = state.row(p2)[GeoY] - p1y;
            isPointToPointLine = true;
            break;
        }
        case GeoType::PerpendicularLine: {
            const int line = entry.refSlots[GeoRefA];
            const int pt = entry.refSlots[GeoRefB];
            if (line < 0 || pt < 0) { st[GeoMeaningful] = 0.0; return true; }  // !line || !p1
            const double* lr = state.row(line);
            if (JsMath::isNaN(lr[GeoDirX])) { st[GeoMeaningful] = 0.0; return true; }  // !line.dir
            p1x = state.row(pt)[GeoX];
            p1y = state.row(pt)[GeoY];
            dirx = -lr[GeoDirY];
            diry = lr[GeoDirX];
            break;
        }
        case GeoType::ParallelLine: {
            const int line = entry.refSlots[GeoRefA];
            const int pt = entry.refSlots[GeoRefB];
            if (line < 0 || pt < 0) { st[GeoMeaningful] = 0.0; return true; }  // !line || !p1
            const double* lr = state.row(line);
            if (JsMath::isNaN(lr[GeoDirX])) { st[GeoMeaningful] = 0.0; return true; }  // !line.dir
            p1x = state.row(pt)[GeoX];
            p1y = state.row(pt)[GeoY];
            dirx = lr[GeoDirX];
            diry = lr[GeoDirY];
            break;
        }
        case GeoType::AngleBisector: {
            const int pa = entry.refSlots[GeoRefA];    // p1Name
            const int vertex = entry.refSlots[GeoRefC];
            const int pc = entry.refSlots[GeoRefB];    // p3Name
            if (pa < 0 || vertex < 0 || pc < 0) { st[GeoMeaningful] = 0.0; return true; }
            p1x = state.row(vertex)[GeoX];
            p1y = state.row(vertex)[GeoY];
            const double bax = state.row(pa)[GeoX] - p1x;
            const double bay = state.row(pa)[GeoY] - p1y;
            const double bcx = state.row(pc)[GeoX] - p1x;
            const double bcy = state.row(pc)[GeoY] - p1y;
            const double len_ba = std::sqrt(bax * bax + bay * bay);
            const double len_bc = std::sqrt(bcx * bcx + bcy * bcy);
            if (len_ba < 1e-9 || len_bc < 1e-9) { st[GeoMeaningful] = 0.0; return true; }
            dirx = bax / len_ba + bcx / len_bc;
            diry = bay / len_ba + bcy / len_bc;
            break;
        }
        default:
            return false;   // not a line construct
    }

    // entry.p1 = p1; entry.p2 = p2; (p1 is a ref -> adapter-resolved; p2 is a
    // literal only for perp/parallel/anglebisector)
    if (!isPointToPointLine) {
        st[GeoP2X] = p1x + dirx;
        st[GeoP2Y] = p1y + diry;
    }
    if (isPointToPointLine) {
        st[GeoDirVecX] = dirx;   // entry.dir_vec = dir
        st[GeoDirVecY] = diry;
    }

    const double dirLen = std::sqrt(dirx * dirx + diry * diry);
    if (dirLen < 1e-9) { st[GeoMeaningful] = 0.0; return true; }
    st[GeoDirX] = dirx / dirLen;   // entry.dir = { x: dir.x / dirLen, ... }
    st[GeoDirY] = diry / dirLen;
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'circle', arch-current.html:16889-16909.
bool evalCircle(GeoState& state, GeoEntry& entry, double* st) {
    const int center = entry.refSlots[GeoRefA];
    if (center < 0) { st[GeoMeaningful] = 0.0; return true; }   // !entry.center
    double radius;
    if (!entry.exprSlots.empty() && entry.exprSlots[0]) {
        // radius_expr form: entry.radius = evaluateExpressionWithCalcJS(radius_expr, ...)
        radius = state.evalExpr(entry, 0);
    } else {
        // pointOnCircle form (a compiled radius_expr slot means the name slot
        // was empty; an unresolvable point name lands at ref -1, the page's
        // !pOn branch)
        const int pOn = entry.refSlots[GeoRefB];
        if (pOn < 0) { st[GeoMeaningful] = 0.0; return true; }
        const double* cr = state.row(center);
        const double* pr = state.row(pOn);
        radius = std::sqrt(jsSq(pr[GeoX] - cr[GeoX]) + jsSq(pr[GeoY] - cr[GeoY]));
    }
    st[GeoRadius] = radius;   // written BEFORE the finiteness check (write-then-fail)
    if (!JsMath::isFinite(radius) || radius <= 1e-9) { st[GeoMeaningful] = 0.0; return true; }
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'ellipse_ab', arch-current.html:16910-16939.
bool evalEllipseAb(GeoState& state, GeoEntry& entry, double* st) {
    const double a = state.evalExpr(entry, 0);
    const double b = state.evalExpr(entry, 1);
    if (!JsMath::isFinite(a) || !JsMath::isFinite(b) || a <= 0 || b <= 0) {
        st[GeoMeaningful] = 0.0;
        return true;
    }
    st[GeoA] = a;
    st[GeoB] = b;
    st[GeoCenterX] = 0.0;   // entry.center = { x: 0, y: 0 }
    st[GeoCenterY] = 0.0;
    st[GeoRotation] = 0.0;
    const double c = std::sqrt(std::fabs(a * a - b * b));
    if (a > b) {
        st[GeoF1X] = -c;
        st[GeoF1Y] = 0.0;
        st[GeoF2X] = c;
        st[GeoF2Y] = 0.0;
    } else {
        st[GeoF1X] = 0.0;
        st[GeoF1Y] = -c;
        st[GeoF2X] = 0.0;
        st[GeoF2Y] = c;
    }
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'ellipse', arch-current.html:16940-16972.
bool evalEllipse(GeoState& state, GeoEntry& entry, double* st) {
    const int f1 = entry.refSlots[GeoRefA];
    const int f2 = entry.refSlots[GeoRefB];
    const int p = entry.refSlots[GeoRefC];
    if (f1 < 0 || f2 < 0 || p < 0) { st[GeoMeaningful] = 0.0; return true; }
    const double* f1r = state.row(f1);
    const double* f2r = state.row(f2);
    const double* pr = state.row(p);
    const double dist_sum =
        std::sqrt(jsSq(pr[GeoX] - f1r[GeoX]) + jsSq(pr[GeoY] - f1r[GeoY])) +
        std::sqrt(jsSq(pr[GeoX] - f2r[GeoX]) + jsSq(pr[GeoY] - f2r[GeoY]));
    st[GeoDistSum] = dist_sum;
    const double f1x = f1r[GeoX], f1y = f1r[GeoY];
    const double f2x = f2r[GeoX], f2y = f2r[GeoY];
    const double c = std::sqrt(jsSq(f1x - f2x) + jsSq(f1y - f2y)) / 2;
    if (dist_sum <= 2 * c + 1e-9) { st[GeoMeaningful] = 0.0; return true; }
    st[GeoCenterX] = (f1x + f2x) / 2;
    st[GeoCenterY] = (f1y + f2y) / 2;
    const double a = dist_sum / 2;
    st[GeoA] = a;
    const double b = std::sqrt(a * a - c * c);
    st[GeoB] = b;
    const double rotation = JsMath::atan2(f2y - f1y, f2x - f1x);
    st[GeoRotation] = rotation;
    // detailsString intermediates: formatConicEquation(term1_A..term3_F)
    // (16956-16967), computed from the just-written entry fields.
    const double cos_r = std::cos(rotation), sin_r = std::sin(rotation);
    const double h = st[GeoCenterX], k = st[GeoCenterY];
    const double a2 = a * a, b2 = b * b;
    const double term1_A = cos_r * cos_r / a2 + sin_r * sin_r / b2;
    const double term1_B = 2 * cos_r * sin_r / a2 - 2 * cos_r * sin_r / b2;
    const double term1_C = sin_r * sin_r / a2 + cos_r * cos_r / b2;
    const double term2_D = -2 * h * term1_A - k * term1_B;
    const double term2_E = -2 * k * term1_C - h * term1_B;
    const double term3_F = h * h * term1_A + k * k * term1_C + h * k * term1_B - 1;
    st[GeoTermA] = term1_A;
    st[GeoTermB] = term1_B;
    st[GeoTermC] = term1_C;
    st[GeoTermD] = term2_D;
    st[GeoTermE] = term2_E;
    st[GeoTermF] = term3_F;
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'hyperbola', arch-current.html:16973-17005.
bool evalHyperbola(GeoState& state, GeoEntry& entry, double* st) {
    const int f1 = entry.refSlots[GeoRefA];
    const int f2 = entry.refSlots[GeoRefB];
    const int p = entry.refSlots[GeoRefC];
    if (f1 < 0 || f2 < 0 || p < 0) { st[GeoMeaningful] = 0.0; return true; }
    const double* f1r = state.row(f1);
    const double* f2r = state.row(f2);
    const double* pr = state.row(p);
    const double dist_diff = std::fabs(
        std::sqrt(jsSq(pr[GeoX] - f1r[GeoX]) + jsSq(pr[GeoY] - f1r[GeoY])) -
        std::sqrt(jsSq(pr[GeoX] - f2r[GeoX]) + jsSq(pr[GeoY] - f2r[GeoY])));
    st[GeoDistDiff] = dist_diff;
    const double f1x = f1r[GeoX], f1y = f1r[GeoY];
    const double f2x = f2r[GeoX], f2y = f2r[GeoY];
    const double c = std::sqrt(jsSq(f1x - f2x) + jsSq(f1y - f2y)) / 2;
    if (dist_diff >= 2 * c - 1e-9 || dist_diff < 1e-9) { st[GeoMeaningful] = 0.0; return true; }
    st[GeoCenterX] = (f1x + f2x) / 2;
    st[GeoCenterY] = (f1y + f2y) / 2;
    const double a = dist_diff / 2;
    st[GeoA] = a;
    const double b = std::sqrt(c * c - a * a);
    st[GeoB] = b;
    const double rotation = JsMath::atan2(f2y - f1y, f2x - f1x);
    st[GeoRotation] = rotation;
    // detailsString intermediates: formatConicEquation(term1_A..term3_F)
    // (16989-17000), computed from the just-written entry fields.
    const double cos_r = std::cos(rotation), sin_r = std::sin(rotation);
    const double h = st[GeoCenterX], k = st[GeoCenterY];
    const double a2 = a * a, b2 = b * b;
    const double term1_A = cos_r * cos_r / a2 - sin_r * sin_r / b2;
    const double term1_B = 2 * cos_r * sin_r / a2 + 2 * cos_r * sin_r / b2;
    const double term1_C = sin_r * sin_r / a2 - cos_r * cos_r / b2;
    const double term2_D = -2 * h * term1_A - k * term1_B;
    const double term2_E = -2 * k * term1_C - h * term1_B;
    const double term3_F = h * h * term1_A + k * k * term1_C + h * k * term1_B - 1;
    st[GeoTermA] = term1_A;
    st[GeoTermB] = term1_B;
    st[GeoTermC] = term1_C;
    st[GeoTermD] = term2_D;
    st[GeoTermE] = term2_E;
    st[GeoTermF] = term3_F;
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'parabola', arch-current.html:17006-17032.
bool evalParabola(GeoState& state, GeoEntry& entry, double* st) {
    const int focus = entry.refSlots[GeoRefA];
    const int directrix = entry.refSlots[GeoRefB];
    if (focus < 0 || directrix < 0) { st[GeoMeaningful] = 0.0; return true; }
    const double* dr = state.row(directrix);
    if (JsMath::isNaN(dr[GeoDirX])) { st[GeoMeaningful] = 0.0; return true; }  // !directrix.dir
    const double fx = state.row(focus)[GeoX];
    const double fy = state.row(focus)[GeoY];
    double p1x, p1y;
    if (!lineP1XY(state, directrix, p1x, p1y)) { st[GeoMeaningful] = 0.0; return true; }
    const double dirx = dr[GeoDirX];
    const double diry = dr[GeoDirY];
    const double p2x = p1x + dirx, p2y = p1y + diry;
    const double k = ((p2y - p1y) * (fx - p1x) - (p2x - p1x) * (fy - p1y)) /
                     (jsSq(p2y - p1y) + jsSq(p2x - p1x));
    const double proj_x = fx - k * (p2y - p1y);
    const double proj_y = fy + k * (p2x - p1x);
    st[GeoVertexX] = (fx + proj_x) / 2;
    st[GeoVertexY] = (fy + proj_y) / 2;
    st[GeoPFocal] = std::sqrt(jsSq(fx - st[GeoVertexX]) + jsSq(fy - st[GeoVertexY]));
    const double rotation = JsMath::atan2(fy - proj_y, fx - proj_x);
    st[GeoRotation] = rotation;
    // detailsString intermediates: formatConicEquation(term1_A..term3_F)
    // (17022-17028), computed from the just-written entry fields.
    const double h = st[GeoVertexX], v_k = st[GeoVertexY];
    const double p = st[GeoPFocal];
    const double c = std::cos(rotation), s = std::sin(rotation);
    const double term1_A = s * s;
    const double term1_B = -2 * c * s;
    const double term1_C = c * c;
    const double term2_D = -4 * p * c - 2 * h * s * s + 2 * v_k * c * s;
    const double term2_E = -4 * p * s + 2 * h * c * s - 2 * v_k * c * c;
    const double term3_F = h * h * s * s + v_k * v_k * c * c - 2 * h * v_k * c * s +
                           4 * p * h * c + 4 * p * v_k * s;
    st[GeoTermA] = term1_A;
    st[GeoTermB] = term1_B;
    st[GeoTermC] = term1_C;
    st[GeoTermD] = term2_D;
    st[GeoTermE] = term2_E;
    st[GeoTermF] = term3_F;
    st[GeoMeaningful] = 1.0;
    return true;
}

// case 'circulararc', arch-current.html:17167-17190. (The JS
// !entry.centerName/... guard covers empty names; they compile to ref -1 here,
// same outcome: newMeaningful = false with nothing written.)
bool evalCircularArc(GeoState& state, GeoEntry& entry, double* st) {
    const int center = entry.refSlots[GeoRefA];
    const int startPoint = entry.refSlots[GeoRefB];
    const int endPoint = entry.refSlots[GeoRefC];
    if (center < 0 || startPoint < 0 || endPoint < 0) { st[GeoMeaningful] = 0.0; return true; }
    const double* cr = state.row(center);
    const double* sr = state.row(startPoint);
    const double* er = state.row(endPoint);
    st[GeoRadius] = JsMath::hypot(sr[GeoX] - cr[GeoX], sr[GeoY] - cr[GeoY]);
    if (st[GeoRadius] < 1e-9) { st[GeoMeaningful] = 0.0; return true; }   // radius written first
    st[GeoStartAngle] = JsMath::atan2(sr[GeoY] - cr[GeoY], sr[GeoX] - cr[GeoX]);
    const double dir_vec_x = er[GeoX] - cr[GeoX];
    const double dir_vec_y = er[GeoY] - cr[GeoY];
    const double len = JsMath::hypot(dir_vec_x, dir_vec_y);
    if (len < 1e-9) { st[GeoMeaningful] = 0.0; return true; }   // startAngle written first
    st[GeoEndAngle] = JsMath::atan2(dir_vec_y, dir_vec_x);
    st[GeoMeaningful] = 1.0;
    return true;
}

} // namespace

bool geoEvalConstructs(GeoState& state, GeoEntry& entry, double* st) {
    switch (entry.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
        case GeoType::PerpendicularLine: case GeoType::ParallelLine: case GeoType::AngleBisector:
            return evalLineConstruct(state, entry, st);
        case GeoType::Circle:
            return evalCircle(state, entry, st);
        case GeoType::EllipseAb:
            return evalEllipseAb(state, entry, st);
        case GeoType::Ellipse:
            return evalEllipse(state, entry, st);
        case GeoType::Hyperbola:
            return evalHyperbola(state, entry, st);
        case GeoType::Parabola:
            return evalParabola(state, entry, st);
        case GeoType::CircularArc:
            return evalCircularArc(state, entry, st);
        default:
            return false;   // not this group
    }
}

} // namespace Core
} // namespace ArchMaths
