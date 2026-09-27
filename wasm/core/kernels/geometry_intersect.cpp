// ArchCore kernel "geometry" - INTERSECT group.
//
// Line-by-line port of the page's recalculateGeometryObjects() switch cases
// for the 'intersect' and 'tangent' geometry types (arch-current.html,
// case bodies 16698-16828 / 17191-17349). Floating-point operation order,
// branch conditions, thresholds, write timing and NaN propagation match the
// JS verbatim; see GEOMETRY_CONTRACT.md and geometry_common.h.
//
// This group owns:
//   GeoType::Intersect  'intersect'  case 16698-16828
//                       (line×line determinant, line×circle quadratic with
//                       ±sign root, circle×circle, line×conic quadratic in
//                       the rotated frame, circle×conic & conic×conic ->
//                       "交点求解复杂", inBounds gate 16789-16816)
//                       parse fields 16044-16052 (obj1Name/obj2Name/sign)
//   GeoType::Tangent    'tangent'    case 17191-17349
//                       (conic general equation A..F, polar-line /
//                       Joachimsthal slope quadratic via adjugate entries,
//                       sign selection, circulararc range gate ->
//                       "切点不在圆弧范围内")
//                       parse fields 16257-16265 (conicName/pointName/sign)
#include "geometry_common.h"

namespace ArchMaths {
namespace Core {

namespace {

constexpr double kPI = 3.141592653589793;   // Math.PI (same double literal as advfuncs.cpp)

// ---- cross-entry field readers ------------------------------------------------
// Line-like `p1` (x_val-style), mirroring which JS object the case body reads
// (adapter applyRow, GEOMETRY_CONTRACT.md §7):
//   segment/ray/line/vector      -> live ref p1Name      (refSlots[GeoRefA])
//   perpendicularline/parallelline -> live ref pointName (refSlots[GeoRefB])
//   anglebisector                -> live ref vertexName  (refSlots[GeoRefC])
//   fitline/tangent              -> literal {x_val,y_val} (GeoP1X/GeoP1Y)
// A JS `!obj.p1` (missing object / destructure throw) maps to NaN coords; the
// arithmetic downstream propagates NaN into the same newMeaningful=false.
void lineLikeP1(const GeoState& s, int idx, double& outX, double& outY) {
    const GeoEntry& e = s.entries[static_cast<size_t>(idx)];
    int refIdx = -1;
    switch (e.type) {
        case GeoType::Segment: case GeoType::Ray: case GeoType::Line: case GeoType::Vector:
            refIdx = e.refSlots[GeoRefA];
            break;
        case GeoType::PerpendicularLine: case GeoType::ParallelLine:
            refIdx = e.refSlots[GeoRefB];
            break;
        case GeoType::AngleBisector:
            refIdx = e.refSlots[GeoRefC];
            break;
        case GeoType::Fitline: case GeoType::Tangent: {
            const double* r = s.row(idx);
            outX = r[GeoP1X];
            outY = r[GeoP1Y];
            return;
        }
        default:
            break;
    }
    if (refIdx < 0) {
        outX = JsMath::kNaN;
        outY = JsMath::kNaN;
        return;
    }
    const double* r = s.row(refIdx);
    outX = r[GeoX];
    outY = r[GeoY];
}

// circle/circulararc center (live ref, refSlots[GeoRefA]) x_val/y_val.
void circleCenter(const GeoState& s, int idx, double& outX, double& outY) {
    const int refIdx = s.entries[static_cast<size_t>(idx)].refSlots[GeoRefA];
    if (refIdx < 0) {
        outX = JsMath::kNaN;
        outY = JsMath::kNaN;
        return;
    }
    const double* r = s.row(refIdx);
    outX = r[GeoX];
    outY = r[GeoY];
}

// inBounds lambda (arch-current.html:16789-16816), transcribed verbatim,
// including the circulararc angle wrapping.
bool inBounds(const GeoState& s, int objIdx, double px, double py) {
    const GeoType t = s.entries[static_cast<size_t>(objIdx)].type;
    if (t == GeoType::Line || t == GeoType::PerpendicularLine || t == GeoType::ParallelLine ||
        t == GeoType::AngleBisector || t == GeoType::Circle || t == GeoType::Ellipse ||
        t == GeoType::Hyperbola || t == GeoType::Parabola || t == GeoType::Fitline ||
        t == GeoType::Tangent || t == GeoType::EllipseAb) {
        return true;
    }
    const double* r = s.row(objIdx);
    if (t == GeoType::CircularArc) {
        double cx, cy;
        circleCenter(s, objIdx, cx, cy);
        const double angle = std::atan2(py - cy, px - cx);
        const double sA = r[GeoStartAngle];
        double eA = r[GeoEndAngle];
        if (eA < sA) eA += 2.0 * kPI;
        double checkAngle = angle;
        while (checkAngle < sA - 1e-9) checkAngle += 2.0 * kPI;
        while (checkAngle > sA + 2.0 * kPI - 1e-9) checkAngle -= 2.0 * kPI;
        return checkAngle <= eA + 1e-9;
    }
    // segment / ray / vector: p1/p2 are live refs.
    const GeoEntry& e = s.entries[static_cast<size_t>(objIdx)];
    const int p1Idx = e.refSlots[GeoRefA];
    const int p2Idx = e.refSlots[GeoRefB];
    if (p1Idx < 0 || p2Idx < 0) return false;   // JS: !obj.p1 || !obj.p2
    const double* r1 = s.row(p1Idx);
    const double* r2 = s.row(p2Idx);
    const double x1 = r1[GeoX], y1 = r1[GeoY];
    const double x2 = r2[GeoX], y2 = r2[GeoY];
    const double dot = (px - x1) * (x2 - x1) + (py - y1) * (y2 - y1);
    if (t == GeoType::Ray || t == GeoType::Vector) return dot >= -1e-9;
    if (t == GeoType::Segment) {
        const double len_sq = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
        return dot >= -1e-9 && dot <= len_sq + 1e-9;
    }
    return true;
}

// ---- 'intersect' (16698-16828) ------------------------------------------------
bool evalIntersect(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    double resX = JsMath::kNaN, resY = JsMath::kNaN;   // intersectResult.x/y
    bool haveResult = false;                           // JS: intersectResult != null

    const int obj1Idx = entry.refSlots[GeoRefA];
    const int obj2Idx = entry.refSlots[GeoRefB];
    if (obj1Idx < 0 || obj2Idx < 0 ||
        !state.isMeaningful(obj1Idx) || !state.isMeaningful(obj2Idx)) {
        newMeaningful = false;
    } else {
        const GeoType type1 = state.entries[static_cast<size_t>(obj1Idx)].type;
        const GeoType type2 = state.entries[static_cast<size_t>(obj2Idx)].type;
        const bool line1 = isLineLikeType(type1), line2 = isLineLikeType(type2);
        const bool circ1 = isCircleType(type1), circ2 = isCircleType(type2);
        const bool conic1 = isConicType(type1), conic2 = isConicType(type2);

        if (line1 && line2) {
            // 16711-16718: line × line (determinant).
            double x1, y1, x2, y2;
            lineLikeP1(state, obj1Idx, x1, y1);
            lineLikeP1(state, obj2Idx, x2, y2);
            const double* r1 = state.row(obj1Idx);
            const double* r2 = state.row(obj2Idx);
            const double dx1 = r1[GeoDirX], dy1 = r1[GeoDirY];
            const double dx2 = r2[GeoDirX], dy2 = r2[GeoDirY];
            const double det = dx1 * dy2 - dx2 * dy1;
            if (std::fabs(det) < 1e-9) {
                newMeaningful = false;
            } else {
                const double t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / det;
                resX = x1 + t * dx1;
                resY = y1 + t * dy1;
                haveResult = true;
            }
        } else if ((line1 && circ2) || (circ1 && line2)) {
            // 16719-16732: line × circle (quadratic, ±sign root).
            const int lineIdx = line1 ? obj1Idx : obj2Idx;
            const int circleIdx = circ1 ? obj1Idx : obj2Idx;
            double lx, ly;
            lineLikeP1(state, lineIdx, lx, ly);
            const double* lr = state.row(lineIdx);
            const double dx = lr[GeoDirX], dy = lr[GeoDirY];
            double cx, cy;
            circleCenter(state, circleIdx, cx, cy);
            const double r = state.row(circleIdx)[GeoRadius];
            const double A = dx * dx + dy * dy;
            const double B = 2 * (dx * (lx - cx) + dy * (ly - cy));
            const double lxc = lx - cx, lyc = ly - cy;
            const double C = lxc * lxc + lyc * lyc - r * r;
            const double discriminant = B * B - 4 * A * C;
            if (discriminant < -1e-9) {
                newMeaningful = false;
            } else {
                const double t = (-B + entry.sign * std::sqrt(JsMath::max(0.0, discriminant))) / (2 * A);
                resX = lx + t * dx;
                resY = ly + t * dy;
                haveResult = true;
            }
        } else if (circ1 && circ2) {
            // 16733-16743: circle × circle.
            double cx1, cy1, cx2, cy2;
            circleCenter(state, obj1Idx, cx1, cy1);
            circleCenter(state, obj2Idx, cx2, cy2);
            const double r1 = state.row(obj1Idx)[GeoRadius];
            const double r2 = state.row(obj2Idx)[GeoRadius];
            const double dcx = cx1 - cx2, dcy = cy1 - cy2;
            const double d_sq = dcx * dcx + dcy * dcy;
            const double d = std::sqrt(d_sq);
            if (d > r1 + r2 + 1e-9 || d < std::fabs(r1 - r2) - 1e-9 || d < 1e-9) {
                newMeaningful = false;
            } else {
                const double a = (r1 * r1 - r2 * r2 + d_sq) / (2 * d);
                const double h = std::sqrt(JsMath::max(0.0, r1 * r1 - a * a));
                const double x_mid = cx1 + a * (cx2 - cx1) / d;
                const double y_mid = cy1 + a * (cy2 - cy1) / d;
                resX = x_mid + entry.sign * h * (cy2 - cy1) / d;
                resY = y_mid - entry.sign * h * (cx2 - cx1) / d;
                haveResult = true;
            }
        } else if ((line1 && conic2) || (conic1 && line2)) {
            // 16744-16782: line × conic (general quadratic in the line
            // parameter, built in the conic's rotated frame).
            const int lineIdx = line1 ? obj1Idx : obj2Idx;
            const int conicIdx = conic1 ? obj1Idx : obj2Idx;
            double x1, y1;
            lineLikeP1(state, lineIdx, x1, y1);
            const double* lr = state.row(lineIdx);
            const double dx = lr[GeoDirX], dy = lr[GeoDirY];
            const GeoType conicType = state.entries[static_cast<size_t>(conicIdx)].type;
            const double* cr = state.row(conicIdx);
            double A = 0, B = 0, C = 0;
            if (conicType == GeoType::Ellipse || conicType == GeoType::Hyperbola ||
                conicType == GeoType::EllipseAb) {
                // 16751-16763
                const double h = cr[GeoCenterX], k = cr[GeoCenterY];
                const double a = cr[GeoA], b = cr[GeoB];
                const double rot = cr[GeoRotation];
                const double cos_r = std::cos(rot), sin_r = std::sin(rot);
                const double x1_h = x1 - h, y1_k = y1 - k;
                const double T1 = cos_r * dx + sin_r * dy;
                const double T2 = -sin_r * dx + cos_r * dy;
                const double C1 = cos_r * x1_h + sin_r * y1_k;
                const double C2 = -sin_r * x1_h + cos_r * y1_k;
                const double sign =
                    (conicType == GeoType::Ellipse || conicType == GeoType::EllipseAb) ? 1.0 : -1.0;
                A = T1 * T1 / (a * a) + sign * T2 * T2 / (b * b);
                B = 2 * C1 * T1 / (a * a) + 2 * sign * C2 * T2 / (b * b);
                C = C1 * C1 / (a * a) + sign * C2 * C2 / (b * b) - 1;
            } else if (conicType == GeoType::Parabola) {
                // 16764-16776
                const int focusIdx = state.entries[static_cast<size_t>(conicIdx)].refSlots[GeoRefA];
                const int dirIdx = state.entries[static_cast<size_t>(conicIdx)].refSlots[GeoRefB];
                double fx = JsMath::kNaN, fy = JsMath::kNaN;
                if (focusIdx >= 0) {
                    const double* fr = state.row(focusIdx);
                    fx = fr[GeoX];
                    fy = fr[GeoY];
                }
                double dpx = JsMath::kNaN, dpy = JsMath::kNaN;
                double ddx = JsMath::kNaN, ddy = JsMath::kNaN;
                if (dirIdx >= 0) {
                    lineLikeP1(state, dirIdx, dpx, dpy);
                    const double* dr = state.row(dirIdx);
                    ddx = dr[GeoDirX];
                    ddy = dr[GeoDirY];
                }
                const double A_par = 1, B_par = 0, C_par = -2 * fx, D_par = -2 * fy;
                const double E_par = fx * fx + fy * fy;
                const double A_dir = -ddy, B_dir = ddx, C_dir = ddy * dpx - ddx * dpy;
                const double F_dir = A_dir * A_dir + B_dir * B_dir;
                const double t_sq_coeff = A_par * dx * dx + B_par * dx * dy + ddx * ddx * dy * dy -
                                          2 * ddx * ddy * dx * dy + ddy * ddy * dx * dx;
                const double t_coeff = C_par * dx + D_par * dy + 2 * A_par * x1 * dx +
                                       B_par * (x1 * dy + y1 * dx) -
                                       2 * (A_dir * (x1 * dx + A_dir) + B_dir * (y1 * dy + B_dir) +
                                            C_dir * (A_dir * dx + B_dir * dy));
                const double q = A_dir * x1 + B_dir * y1 + C_dir;   // (A_dir*x1+B_dir*y1+C_dir)**2
                const double const_coeff = A_par * x1 * x1 + B_par * x1 * y1 + C_par * x1 +
                                           D_par * y1 + E_par - q * q;
                A = t_sq_coeff / F_dir - 1;
                B = t_coeff / F_dir;
                C = const_coeff / F_dir;
            }
            const double discriminant = B * B - 4 * A * C;
            if (discriminant < -1e-9) {
                newMeaningful = false;
            } else {
                const double t = (-B + entry.sign * std::sqrt(JsMath::max(0.0, discriminant))) / (2 * A);
                resX = x1 + t * dx;
                resY = y1 + t * dy;
                haveResult = true;
            }
        } else if ((circ1 && conic2) || (conic1 && circ2) || (conic1 && conic2)) {
            // 16784-16786: circle×conic / conic×conic stay unsupported.
            st[GeoErrCode] = 1.0;   // "交点求解复杂"
            newMeaningful = false;
        }

        // 16788-16826: JS runs this whenever the case did not 'break' above;
        // on break paths haveResult stays false, which yields the same
        // newMeaningful=false with no x_val/y_val writes.
        if (haveResult && JsMath::isFinite(resX) && JsMath::isFinite(resY)) {
            if (!inBounds(state, obj1Idx, resX, resY) || !inBounds(state, obj2Idx, resX, resY)) {
                newMeaningful = false;
            } else {
                st[GeoX] = resX;
                st[GeoY] = resY;
            }
        } else {
            newMeaningful = false;
        }
    }

    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
    return true;
}

// ---- 'tangent' (17191-17349) --------------------------------------------------
bool evalTangent(GeoState& state, GeoEntry& entry, double* st) {
    bool newMeaningful = true;
    const int conicIdx = entry.refSlots[GeoRefA];
    const int pointIdx = entry.refSlots[GeoRefB];
    // 17192-17195: !entry.conicName || !entry.pointName || !conic || !point ||
    //              !conic.isMeaningful || !point.isMeaningful
    if (conicIdx < 0 || pointIdx < 0 ||
        !state.isMeaningful(conicIdx) || !state.isMeaningful(pointIdx)) {
        st[GeoMeaningful] = 0.0;
        return true;
    }
    const double* pr = state.row(pointIdx);
    const double x0 = pr[GeoX], y0 = pr[GeoY];
    const GeoType conicType = state.entries[static_cast<size_t>(conicIdx)].type;
    const double* cr = state.row(conicIdx);

    double A = 0, B = 0, C = 0, D = 0, E = 0, F = 0;
    bool isValidConic = false;

    if (conicType == GeoType::Circle || conicType == GeoType::CircularArc) {
        // 17201-17210
        double cx, cy;
        circleCenter(state, conicIdx, cx, cy);
        const double r = cr[GeoRadius];
        A = 1;
        B = 1;
        C = 0;
        D = -2 * cx;
        E = -2 * cy;
        F = cx * cx + cy * cy - r * r;
        isValidConic = true;
    } else if (conicType == GeoType::Ellipse || conicType == GeoType::Hyperbola ||
               conicType == GeoType::EllipseAb) {
        // 17211-17226
        const double h = cr[GeoCenterX], k = cr[GeoCenterY];
        const double a = cr[GeoA], b = cr[GeoB];
        const double rot = cr[GeoRotation];
        const double cos_r = std::cos(rot), sin_r = std::sin(rot);
        const double sign =
            (conicType == GeoType::Ellipse || conicType == GeoType::EllipseAb) ? 1.0 : -1.0;
        const double Qu = 1.0 / (a * a);
        const double Qv = sign / (b * b);
        A = Qu * cos_r * cos_r + Qv * sin_r * sin_r;
        B = Qu * sin_r * sin_r + Qv * cos_r * cos_r;
        C = 2 * (Qu - Qv) * sin_r * cos_r;
        const double U0 = -h * cos_r - k * sin_r;
        const double V0 = h * sin_r - k * cos_r;
        D = 2 * Qu * cos_r * U0 - 2 * Qv * sin_r * V0;
        E = 2 * Qu * sin_r * U0 + 2 * Qv * cos_r * V0;
        F = Qu * U0 * U0 + Qv * V0 * V0 - 1;
        isValidConic = true;
    } else if (conicType == GeoType::Parabola) {
        // 17227-17242
        const double h = cr[GeoVertexX], k = cr[GeoVertexY];
        const double p = cr[GeoPFocal];
        const double rot = cr[GeoRotation];
        const double c = std::cos(rot);
        const double s = std::sin(rot);
        const double V0 = h * s - k * c;
        const double U0 = -h * c - k * s;
        A = s * s;
        B = c * c;
        C = -2 * s * c;
        D = -2 * s * V0 - 4 * p * c;
        E = 2 * c * V0 - 4 * p * s;
        F = V0 * V0 - 4 * p * U0;
        isValidConic = true;
    }

    if (!isValidConic) {
        st[GeoMeaningful] = 0.0;
        return true;
    }

    // 17247-17260: polar line / Joachimsthal determinant. The adjugate index
    // signs are the page's own (S12/S23 negated, S13 not) - do not "fix".
    const double m11 = A, m12 = C / 2, m13 = D / 2;
    const double m21 = C / 2, m22 = B, m23 = E / 2;
    const double m31 = D / 2, m32 = E / 2, m33 = F;
    const double S11 = m22 * m33 - m23 * m32;
    const double S22 = m11 * m33 - m13 * m31;
    const double S33 = m11 * m22 - m12 * m21;
    const double S12 = -(m21 * m33 - m23 * m31);
    const double S13 = m21 * m32 - m22 * m31;
    const double S23 = -(m11 * m32 - m12 * m31);
    const double aq = S11 + S33 * x0 * x0 - 2 * S13 * x0;
    const double bq = -2 * S12 + 2 * S13 * y0 + 2 * S23 * x0 - 2 * S33 * x0 * y0;
    const double cq = S22 + S33 * y0 * y0 - 2 * S23 * y0;

    const double epsilon = 1e-9;
    struct Sol {
        bool isVertical;
        double k;
    };
    std::vector<Sol> solutions;

    if (std::fabs(aq) < epsilon) {
        // 17266-17274: near-vertical slope; disc_vert gates the vertical
        // solution, bq gates the finite-slope one (both may be pushed).
        const double cxE = C * x0 + E;   // (C*x0+E) ** 2
        const double disc_vert = cxE * cxE - 4 * B * (A * x0 * x0 + D * x0 + F);
        if (std::fabs(disc_vert) < 1e-7) {
            solutions.push_back({ true, 0.0 });
        }
        if (std::fabs(bq) > epsilon) {
            solutions.push_back({ false, -cq / bq });
        }
    } else {
        const double delta = bq * bq - 4 * aq * cq;
        if (delta >= -epsilon) {
            const double sqrtDelta = std::sqrt(JsMath::max(0.0, delta));
            const double k1 = (-bq + sqrtDelta) / (2 * aq);
            solutions.push_back({ false, k1 });
            if (delta > epsilon) {
                const double k2 = (-bq - sqrtDelta) / (2 * aq);
                solutions.push_back({ false, k2 });
            }
        }
    }

    if (solutions.empty()) {
        newMeaningful = false;
    } else {
        Sol selected;
        if (solutions.size() == 1) {
            selected = solutions[0];
        } else {
            selected = (entry.sign == 1.0) ? solutions[0] : solutions[1];
        }

        if (conicType == GeoType::CircularArc) {
            // 17300-17329: touch point + arc range gate.
            double touchX, touchY;
            double cx, cy;
            circleCenter(state, conicIdx, cx, cy);
            if (selected.isVertical) {
                touchX = x0;
                touchY = cy;
            } else {
                const double k_sol = selected.k;
                const double m = k_sol;
                const double b_line = y0 - m * x0;
                touchX = (cx + m * (cy - b_line)) / (1 + m * m);
                touchY = m * touchX + b_line;
            }
            const double angle = std::atan2(touchY - cy, touchX - cx);
            const double sA = cr[GeoStartAngle];
            double eA = cr[GeoEndAngle];
            if (eA < sA) eA += 2.0 * kPI;
            double checkAngle = angle;
            while (checkAngle < sA - 1e-9) checkAngle += 2.0 * kPI;
            while (checkAngle > sA + 2.0 * kPI - 1e-9) checkAngle -= 2.0 * kPI;
            if (!(checkAngle <= eA + 1e-9)) {
                newMeaningful = false;
                st[GeoErrCode] = 2.0;   // "切点不在圆弧范围内"
            }
        }

        if (newMeaningful) {
            if (selected.isVertical) {
                // 17332-17336
                st[GeoP1X] = x0;
                st[GeoP1Y] = y0;
                st[GeoP2X] = x0;
                st[GeoP2Y] = y0 + 1;
                st[GeoDirX] = 0;
                st[GeoDirY] = 1;
                // GeoTermA stays NaN (detailsString vertical branch reads GeoP1X).
            } else {
                // 17337-17344; GeoTermA carries k for the adapter's detailsString.
                const double k_val = selected.k;
                st[GeoP1X] = x0;
                st[GeoP1Y] = y0;
                st[GeoP2X] = x0 + 1;
                st[GeoP2Y] = y0 + k_val;
                const double len = std::sqrt(1 + k_val * k_val);
                st[GeoDirX] = 1 / len;
                st[GeoDirY] = k_val / len;
                st[GeoTermA] = k_val;
            }
        }
    }

    st[GeoMeaningful] = newMeaningful ? 1.0 : 0.0;
    return true;
}

} // namespace

bool geoEvalIntersect(GeoState& state, GeoEntry& entry, double* st) {
    switch (entry.type) {
        case GeoType::Intersect:
            return evalIntersect(state, entry, st);
        case GeoType::Tangent:
            return evalTangent(state, entry, st);
        default:
            return false;   // not this group -> driver aborts -> JS fallback
    }
}

} // namespace Core
} // namespace ArchMaths
