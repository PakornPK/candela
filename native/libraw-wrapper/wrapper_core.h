#pragma once
#include <cstdint>

namespace candela {

struct DimensionLimits {
    static constexpr uint32_t kMaxWidth = 20000;
    static constexpr uint32_t kMaxHeight = 20000;
    static constexpr uint64_t kMaxPixels = 200'000'000; // 200MP ceiling
};

// True if width/height are plausible for a camera raw file. Used to reject
// corrupt files before we allocate a buffer sized from their claimed dimensions.
bool validate_dimensions(uint32_t width, uint32_t height);

} // namespace candela
