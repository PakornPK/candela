#include "wrapper_core.h"

namespace candela {

bool validate_dimensions(uint32_t width, uint32_t height) {
    if (width == 0 || height == 0) return false;
    if (width > DimensionLimits::kMaxWidth || height > DimensionLimits::kMaxHeight) return false;
    uint64_t pixels = static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
    return pixels <= DimensionLimits::kMaxPixels;
}

} // namespace candela
