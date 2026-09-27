// Test fixture for geometry-intersect-check.mjs.
//
// The geometry driver (geometry.cpp) dispatches every entry to one of the four
// group functions, and a group "decline" (the unported stub) aborts the whole
// run. To exercise geoEvalIntersect in isolation, this fixture provides no-op
// implementations of the OTHER three groups: they accept every entry and write
// nothing, so pre-uploaded state rows (values + GeoMeaningful) persist through
// the fixed-point loop exactly like a converged JS state. Only used by the
// private test build documented in geometry-intersect-check.mjs; never part of
// the official wasm build (build.sh only compiles wasm/core/kernels/*.cpp).
#include "geometry_common.h"

namespace ArchMaths {
namespace Core {

bool geoEvalPoints(GeoState&, GeoEntry&, double*) { return true; }
bool geoEvalConstructs(GeoState&, GeoEntry&, double*) { return true; }
bool geoEvalMeasure(GeoState&, GeoEntry&, double*) { return true; }

} // namespace Core
} // namespace ArchMaths
