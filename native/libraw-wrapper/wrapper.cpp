#include <emscripten.h>
#include <libraw/libraw.h>
#include <cstdint>
#include <cstring>
#include <memory>
#include "wrapper_core.h"

extern "C" {

// Ownership crosses the JS/WASM boundary as a raw pointer by necessity —
// Emscripten's ccall interface has no concept of RAII on the JS side. JS
// must call free_decoded() exactly once per successful decode() call.
struct DecodeResult {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t black_level = 0;
    uint32_t white_level = 0;
    uint32_t cfa_pattern = 0; // 4 packed bytes, one per 2x2 position: 0=R,1=G,2=B
    uint16_t* bayer_data = nullptr;
    int error_code = 0; // 0 = success, LibRaw error codes otherwise, -1 = implausible dimensions
};

EMSCRIPTEN_KEEPALIVE
DecodeResult* decode(const uint8_t* file_bytes, uint32_t length) {
    auto* result = new DecodeResult{};
    LibRaw processor;

    int ret = processor.open_buffer(const_cast<uint8_t*>(file_bytes), length);
    if (ret != LIBRAW_SUCCESS) {
        result->error_code = ret;
        return result;
    }

    ret = processor.unpack();
    if (ret != LIBRAW_SUCCESS) {
        result->error_code = ret;
        return result;
    }

    const auto& raw = processor.imgdata.rawdata;
    uint32_t width = processor.imgdata.sizes.raw_width;
    uint32_t height = processor.imgdata.sizes.raw_height;

    if (!candela::validate_dimensions(width, height) || raw.raw_image == nullptr) {
        result->error_code = -1;
        return result;
    }

    size_t pixel_count = static_cast<size_t>(width) * height;
    auto bayer_owned = std::make_unique<uint16_t[]>(pixel_count);
    std::memcpy(bayer_owned.get(), raw.raw_image, pixel_count * sizeof(uint16_t));

    result->width = width;
    result->height = height;
    result->black_level = processor.imgdata.color.black;
    result->white_level = processor.imgdata.color.maximum;
    result->bayer_data = bayer_owned.release(); // ownership crosses to JS; freed via free_decoded()
    result->error_code = 0;

    uint32_t packed = 0;
    for (int row = 0; row < 2; ++row) {
        for (int col = 0; col < 2; ++col) {
            packed = (packed << 8) | static_cast<uint8_t>(processor.COLOR(row, col));
        }
    }
    result->cfa_pattern = packed;

    return result;
}

EMSCRIPTEN_KEEPALIVE
uint16_t* decode_result_bayer_ptr(DecodeResult* r) { return r->bayer_data; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_width(DecodeResult* r) { return r->width; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_height(DecodeResult* r) { return r->height; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_black_level(DecodeResult* r) { return r->black_level; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_white_level(DecodeResult* r) { return r->white_level; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_cfa_pattern(DecodeResult* r) { return r->cfa_pattern; }

EMSCRIPTEN_KEEPALIVE
int decode_result_error_code(DecodeResult* r) { return r->error_code; }

EMSCRIPTEN_KEEPALIVE
void free_decoded(DecodeResult* r) {
    if (!r) return;
    delete[] r->bayer_data;
    delete r;
}

} // extern "C"
