#include <emscripten.h>
#include <libraw/libraw.h>
#include <cstdint>
#include <cstring>
#include <exception>
#include <memory>
#include "wrapper_core.h"

// LibRaw::adjust_bl() is protected -- it's the method that consolidates a
// per-tile black-level map (used by some cameras, Fuji RAF among them, see
// its own "Fuji RAF dng" comment) into imgdata.color.cblack[0..3]. We need
// it before reading black level, but calling processor.subtract_black()
// (the public method that also calls adjust_bl()) is not an option: it
// requires raw2image() to have already run, which builds a full
// interpolated-position 4-channel CPU image -- exactly the CPU-side
// demosaic work this project's GPU-first architecture exists to avoid
// (CLAUDE.md: "No readback to the WASM heap except on export"). This
// derived class does nothing but republish the one protected method we
// need, without touching LibRaw's own vendored source.
class LibRawWithPublicAdjustBl : public LibRaw {
public:
    using LibRaw::adjust_bl;
};

extern "C" {

// Ownership crosses the JS/WASM boundary as a raw pointer by necessity —
// Emscripten's ccall interface has no concept of RAII on the JS side. decode()
// heap-allocates and returns a DecodeResult* on EVERY call, including its
// error early-returns (open_buffer failure, unpack() failure, dimension
// validation failure, and the allocation-failure catch below) -- not just on
// success. bayer_data is safely nullptr on those error paths (delete[] on
// nullptr is a no-op), but the DecodeResult struct itself is still
// heap-allocated and must still be freed. JS must call free_decoded() exactly
// once per decode() call, success or failure -- EXCEPT for the one case where
// decode() itself returns nullptr (the DecodeResult allocation failed): there
// is nothing to free in that case. free_decoded() null-checks defensively, so
// calling it on a null return is harmless, just unnecessary.
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
    DecodeResult* result = nullptr;

    try {
        result = new DecodeResult{};

        LibRawWithPublicAdjustBl processor;

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

        // Some cameras (Fuji RAF among them, per LibRaw's own adjust_bl()
        // comment "Fuji RAF dng") store black level as a per-tile map in
        // cblack[6+] rather than directly in cblack[0..3] until adjust_bl()
        // consolidates it. adjust_bl() only touches color-metadata fields,
        // not the raw pixel buffer already copied above, so it's safe to
        // call here regardless of camera type.
        processor.adjust_bl();

        // imgdata.color.black alone is 0 on many cameras (this Fuji X100V
        // fixture included) -- the real per-pixel black offset lives in
        // imgdata.color.cblack[0..3] (one value per Bayer/X-Trans channel
        // slot). adjust_bl() above already folds color.black into every
        // cblack[c] (see its final loop: "for c in 0..3: cblack[c] +=
        // black"), so cblack[c] alone is the complete black level --
        // adding color.black again would double-count it. This matches
        // LibRaw's own subtract_black_internal(), which subtracts cblack[c]
        // alone, never color.black + cblack[c]. We use max(cblack[0..3])
        // rather than per-channel values since this wrapper reports a
        // single scalar (matching unpack.wgsl's Levels struct, which
        // normalizes uniformly) -- max errs toward slightly lifting blacks
        // on some channels rather than crushing any channel, which is the
        // safer failure mode per CLAUDE.md's warning that under-subtracting
        // crushes/clips the image.
        uint16_t max_cblack = 0;
        for (int c = 0; c < 4; ++c) {
            if (processor.imgdata.color.cblack[c] > max_cblack) {
                max_cblack = static_cast<uint16_t>(processor.imgdata.color.cblack[c]);
            }
        }

        result->width = width;
        result->height = height;
        result->black_level = max_cblack;
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
        // build.sh's -fexceptions comment).
        if (result == nullptr) {
            // The DecodeResult allocation itself is what threw -- there is no
            // heap-allocated struct left to report the error through, and
            // nothing for the caller to free. Return nullptr; JS must
            // null-check decode()'s return value before touching it.
            return nullptr;
        }
        // result is a valid, already heap-allocated DecodeResult*; only mark
        // it as failed and hand it back so the caller's free_decoded()
        // contract stays uniform.
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

// Ownership/lifecycle mirrors DecodeResult/decode() above -- see that
// struct's comment for the full contract. JS must call free_thumbnail()
// exactly once per extract_thumbnail() call, except when
// extract_thumbnail() itself returns nullptr (nothing to free).
struct ThumbnailResult {
    uint8_t* data = nullptr;
    uint32_t length = 0;
    // 0 = success, LibRaw error codes otherwise (open_buffer/unpack_thumb
    // failures), -1000 = embedded thumbnail exists but isn't JPEG format
    // (LIBRAW_THUMBNAIL_JPEG required -- wrapper-detected, not a LibRaw
    // code, kept clear of LibRaw's own range same as DecodeResult's -1000),
    // -1001 = allocation/exception raised by the wrapper's own code.
    int error_code = 0;
};

EMSCRIPTEN_KEEPALIVE
ThumbnailResult* extract_thumbnail(const uint8_t* file_bytes, uint32_t length) {
    ThumbnailResult* result = nullptr;

    try {
        result = new ThumbnailResult{};

        LibRaw processor;

        int ret = processor.open_buffer(const_cast<uint8_t*>(file_bytes), length);
        if (ret != LIBRAW_SUCCESS) {
            result->error_code = ret;
            return result;
        }

        ret = processor.unpack_thumb();
        if (ret != LIBRAW_SUCCESS) {
            result->error_code = ret;
            return result;
        }

        const auto& thumb = processor.imgdata.thumbnail;
        if (thumb.tformat != LIBRAW_THUMBNAIL_JPEG || thumb.thumb == nullptr || thumb.tlength == 0) {
            result->error_code = -1000;
            return result;
        }

        auto data_owned = std::make_unique<uint8_t[]>(thumb.tlength);
        std::memcpy(data_owned.get(), thumb.thumb, thumb.tlength);

        result->data = data_owned.release(); // ownership crosses to JS; freed via free_thumbnail()
        result->length = static_cast<uint32_t>(thumb.tlength);
        result->error_code = 0;
    } catch (const std::exception&) {
        if (result == nullptr) {
            return nullptr;
        }
        result->error_code = -1001;
    }

    return result;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* thumbnail_result_data_ptr(ThumbnailResult* r) { return r->data; }

EMSCRIPTEN_KEEPALIVE
uint32_t thumbnail_result_length(ThumbnailResult* r) { return r->length; }

EMSCRIPTEN_KEEPALIVE
int thumbnail_result_error_code(ThumbnailResult* r) { return r->error_code; }

EMSCRIPTEN_KEEPALIVE
void free_thumbnail(ThumbnailResult* r) {
    if (!r) return;
    delete[] r->data;
    delete r;
}

} // extern "C"
