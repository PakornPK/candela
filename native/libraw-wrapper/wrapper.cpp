#include <emscripten.h>
#include <libraw/libraw.h>
#include <cstdint>
#include <cstring>
#include <exception>
#include <memory>
#include "wrapper_core.h"

extern "C" {

// Ownership crosses the JS/WASM boundary as a raw pointer by necessity —
// Emscripten's ccall interface has no concept of RAII on the JS side. decode()
// heap-allocates and returns a DecodeResult* on EVERY call, including its
// error early-returns (open_buffer failure, unpack() failure, dimension
// validation failure, and the allocation-failure catch below) -- not just on
// success. bayer_data is safely nullptr on those error paths (delete[] on
// nullptr is a no-op), but the DecodeResult struct itself is still
// heap-allocated and must still be freed. JS must call free_decoded() exactly
// once per decode() call, success or failure.
struct DecodeResult {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t black_level = 0;
    uint32_t white_level = 0;
    // CFA pattern packed into 4 bytes of one uint32_t, most-significant byte
    // first: bits [31:24]=color at (row=0,col=0), [23:16]=(0,1), [15:8]=(1,0),
    // [7:0]=(1,1). One byte per position, values 0=R,1=G,2=B (matches
    // LibRaw's COLOR() return value). To unpack in JS: for i in 0..3,
    // byte i (MSB-first) is (packed >> ((3-i)*8)) & 0xFF.
    // NOTE: this is a different representation from uniforms.ts's
    // packCfaPattern(), which builds a 4-element Uint32Array (one full u32
    // per position, not one byte) from an "RGGB"-style string for a
    // vec4<u32> — decode_result_cfa_pattern()'s output must be unpacked
    // into that shape by whatever TS code bridges them (Task 5), not fed
    // to packCfaPattern() directly.
    uint32_t cfa_pattern = 0;
    uint16_t* bayer_data = nullptr;
    // 0 = success, LibRaw error codes otherwise (all LibRaw codes are <= 0),
    // -1000 = implausible dimensions or missing raw_image (wrapper-detected,
    // not from LibRaw -- kept clear of LibRaw's own range, which includes
    // -1 as LIBRAW_UNSPECIFIED_ERROR), -1001 = allocation/exception raised by
    // the wrapper's own code (new/make_unique) rather than by LibRaw.
    int error_code = 0;
};

EMSCRIPTEN_KEEPALIVE
DecodeResult* decode(const uint8_t* file_bytes, uint32_t length) {
    auto* result = new DecodeResult{};

    try {
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
            result->error_code = -1000;
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
    } catch (const std::exception&) {
        // Allocation failure (new/make_unique) or any other exception raised
        // by the wrapper's own code, as opposed to a LibRaw-internal error
        // (which open_buffer/unpack already convert to a return code -- see
        // build.sh's -fexceptions comment). result is a valid, already
        // heap-allocated DecodeResult*; only mark it as failed and hand it
        // back so the caller's free_decoded() contract stays uniform.
        result->error_code = -1001;
    }

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
