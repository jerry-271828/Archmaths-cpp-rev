#pragma once

// Shared plumbing for the wasm core's C ABI: program handles and scratch
// buffers that the algorithm kernels (implicit contours, meshes, samplers)
// build on.

#include "ExprProgram.h"

#include <cstdint>
#include <vector>

#define ARCHCORE_EXPORT(name) extern "C" __attribute__((export_name(#name), used))

namespace ArchMaths {
namespace Core {

// Returns nullptr for unknown/released handles.
Program* programFromHandle(int handle);

// Growable output buffer whose storage JS reads through a pointer/length pair
// exported by the kernel that filled it.
template <class T>
struct OutBuffer {
    std::vector<T> data;
    void clear() { data.clear(); }
    T* ptr() { return data.empty() ? nullptr : data.data(); }
    int size() const { return static_cast<int>(data.size()); }
};

} // namespace Core
} // namespace ArchMaths
