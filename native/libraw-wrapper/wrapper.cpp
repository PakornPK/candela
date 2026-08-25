#include <emscripten.h>
#include <libraw/libraw.h>
#include <cstdint>
#include <cstdio>
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
    // Full 6x6 CFA, 36 bytes, one byte per position in row-major order,
    // values 0=R 1=G 2=B (LibRaw's COLOR() output). Computed via COLOR(r,c)
    // unconditionally -- for Bayer cameras that yields their 2x2 tiled 3x3,
    // so demosaic.wgsl can always use a 6x6 lookup regardless of sensor type
    // (X-Trans files would otherwise report an all-G 2x2 and render with
    // wrong colors, since their CFA is 6x6, not 2x2).
    uint8_t* cfa6 = nullptr;
    uint16_t* bayer_data = nullptr;
    // LibRaw's error_count() (libraw_internal_data.unpacker_data.data_error)
    // at the moment decode() returned -- the number of short reads / corrupt
    // samples the unpacker hit while decoding. 0 for clean decodes.
    uint32_t data_error = 0;
    // Camera color matrix: the row-normalized camera-RGB -> linear-sRGB 3x3
    // folded from imgdata.color.rgb_cam[3][4]. Row-major, one row per output
    // channel: [Rr Rg Rb, Gr Gg Gb, Br Bg Bb]. All zeros when the camera has
    // no usable matrix (see has_color_matrix).
    float color_matrix[9] = {};
    // 1 when the camera has a usable color matrix (imgdata.color.cam_xyz
    // populated by adobe_coeff during open_buffer), 0 when JS must fall back
    // to the identity matrix.
    int has_color_matrix = 0;
    // Shooting metadata, packed [iso_speed, shutter, aperture, focal_len]
    // from imgdata.other -- 0 when the file doesn't report a value (not every
    // camera fills all four). shutter is exposure time in seconds (1/140s ->
    // ~0.00714); JS formats it as a fraction. Same array-of-floats pattern as
    // color_matrix so JS can DataView-read without a HEAPF32 heap view.
    float camera_meta[4] = {};
    // As-shot white-balance scale factors (imgdata.color.cam_mul), one per CFA
    // channel [R, G1, B, G2]. NOT normalized: LibRaw stores them in the
    // camera's natural scale, so JS normalizes by the green reference before
    // use. G2 (cam_mul[3]) can be 0 -- cameras that report a 3-value WB
    // (Fuji: [G, R, B]) leave the second green unfilled -- so JS averages
    // G1+G2 only when both are nonzero (a naive average would halve green
    // and double the R/B gains, a 2x warm cast). has_cam_mul is 0 when the
    // camera reports no usable values (all-zero cam_mul -- rare).
    float cam_mul[4] = {};
    int has_cam_mul = 0;
    // 0 = success, LibRaw error codes otherwise (all LibRaw codes are <= 0),
    // -1000 = implausible dimensions or missing raw_image (wrapper-detected,
    // not from LibRaw -- kept clear of LibRaw's own range, which includes
    // -1 as LIBRAW_UNSPECIFIED_ERROR), -1001 = allocation/exception raised by
    // the wrapper's own code (new/make_unique) rather than by LibRaw,
    // -1004 = unpack() "succeeded" but error_count() exceeds ~1% of the frame
    // (garbage decode; wrapper-detected, not a LibRaw code).
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

        // Garbage-decode detection. Some cameras -- Nikon "High Efficiency*"
        // (HE*) compression being the one that surfaced this, see the HE*
        // diagnosis -- unpack() with LIBRAW_SUCCESS but produce unusable
        // data: the unpacker hits short reads for a large fraction of the
        // frame, incrementing error_count() on each one. The embedded-JPEG
        // fallback depends on distinguishing "clean decode" from "garbage
        // that happens to return success", so surface a large error count as
        // a failure instead of handing ~24M corrupted samples up to the GPU.
        // Threshold: >1% of the frame corrupted. Clean files (verified
        // fixtures: D800 NEF all variants, Fuji RAF) report 0; the Z f HE*
        // files report ~54%. Checked here, BEFORE the bayer copy, so an
        // unsupported file never wastes the 48MB+ WASM-heap copy below.
        result->data_error = static_cast<uint32_t>(processor.error_count());
        result->width = width; // set even on the garbage path so diagnostics carry dims
        result->height = height;
        size_t pixel_count = static_cast<size_t>(width) * height;
        if (result->data_error > pixel_count / 100) {
            result->error_code = -1004;
            return result;
        }
        auto bayer_owned = std::make_unique<uint16_t[]>(pixel_count);

        // Copy row-by-row using raw_pitch (LibRaw's actual bytes-per-row) so
        // cameras whose raw buffer carries row padding don't misalign every
        // row after the first. The flat memcpy this replaced assumed
        // raw_pitch == width*2, which holds for the fixtures on hand (the
        // Fuji RAF reports raw_pitch == width*2 exactly) but is not
        // guaranteed for all cameras. The output buffer is always tight
        // (width samples per row), so JS-side layout stays pitch-free.
        uint32_t pitch_samples = processor.imgdata.sizes.raw_pitch / sizeof(uint16_t);
        if (pitch_samples >= width) {
            for (uint32_t y = 0; y < height; ++y) {
                std::memcpy(bayer_owned.get() + static_cast<size_t>(y) * width,
                            raw.raw_image + static_cast<size_t>(y) * pitch_samples,
                            width * sizeof(uint16_t));
            }
        } else {
            // Defensive fallback for a corrupt/misreported pitch: a flat copy
            // is at least what the old code did, and this case has never been
            // observed with a real file.
            std::memcpy(bayer_owned.get(), raw.raw_image, pixel_count * sizeof(uint16_t));
        }

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

        auto cfa6_owned = std::make_unique<uint8_t[]>(36);
        for (int row = 0; row < 6; ++row) {
            for (int col = 0; col < 6; ++col) {
                cfa6_owned[row * 6 + col] = static_cast<uint8_t>(processor.COLOR(row, col));
            }
        }
        result->cfa6 = cfa6_owned.release(); // ownership crosses to JS; freed via free_decoded()

        // Camera color matrix from imgdata.color.rgb_cam -- computed by LibRaw
        // inside open_buffer (adobe_coeff() -> cam_xyz_coeff()), so this just
        // reads the result. Channel order 0=R, 1=G1, 2=B, 3=G2. The two green
        // CFA positions share one color filter and the demosaic averages the
        // green spatial samples into a single G channel, so the folded green
        // column is rgb_cam[i][1] + rgb_cam[i][3] -- a SUM, not an average.
        // (Adobe's 3x3 tables leave the G2 row of cam_xyz zero, so
        // rgb_cam[*][3] is also zero and the sum equals rgb_cam[i][1] for
        // standard Bayer files; averaging would halve green and cast the image
        // magenta.) White balance is deliberately separate: cam_mul is exposed
        // below (as-shot WB) so the app can open files at the camera's own
        // white point, applied by the whiteBalance op BEFORE this matrix --
        // LrC's order -- instead of being folded into a matrix-neutral
        // daylight look.
        {
            const float* rgb_cam = &processor.imgdata.color.rgb_cam[0][0]; // [3][4], row-major
            for (int i = 0; i < 3; ++i) {
                result->color_matrix[i * 3 + 0] = rgb_cam[i * 4 + 0];
                result->color_matrix[i * 3 + 1] = rgb_cam[i * 4 + 1] + rgb_cam[i * 4 + 3];
                result->color_matrix[i * 3 + 2] = rgb_cam[i * 4 + 2];
            }
            // LibRaw's own "no usable camera matrix" test (identify.cpp):
            // cam_xyz absent means the matrix is all-zero and must not apply.
            result->has_color_matrix = processor.imgdata.color.cam_xyz[0][0] >= 0.01f ? 1 : 0;
        }

        // As-shot white balance. Exposed so the app can open files at the
        // camera's own WB (Lightroom's "As Shot") instead of a matrix-neutral
        // daylight white point; the whiteBalance op consumes these as raw
        // gains and keeps them exact until the user drags the WB sliders
        // (kelvin+tint cannot represent an arbitrary cam_mul).
        {
            const float* cam_mul = processor.imgdata.color.cam_mul;
            result->cam_mul[0] = cam_mul[0];
            result->cam_mul[1] = cam_mul[1];
            result->cam_mul[2] = cam_mul[2];
            result->cam_mul[3] = cam_mul[3];
            result->has_cam_mul = (cam_mul[0] > 0.0f && cam_mul[1] > 0.0f && cam_mul[2] > 0.0f) ? 1 : 0;
        }

        // Shooting metadata. These sit in imgdata.other; they're filled by
        // LibRaw's EXIF parsing (inside open_buffer/identify), and 0.0 is the
        // library's "not reported" sentinel for each. We're past unpack() at
        // this point, so any decoder-side metadata is also settled.
        result->camera_meta[0] = processor.imgdata.other.iso_speed;
        result->camera_meta[1] = processor.imgdata.other.shutter;
        result->camera_meta[2] = processor.imgdata.other.aperture;
        result->camera_meta[3] = processor.imgdata.other.focal_len;
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
uint8_t* decode_result_cfa6(DecodeResult* r) { return r->cfa6; }

EMSCRIPTEN_KEEPALIVE
int decode_result_error_code(DecodeResult* r) { return r->error_code; }

EMSCRIPTEN_KEEPALIVE
uint32_t decode_result_data_error(DecodeResult* r) { return r->data_error; }

EMSCRIPTEN_KEEPALIVE
float* decode_result_color_matrix(DecodeResult* r) { return r->color_matrix; }

EMSCRIPTEN_KEEPALIVE
int decode_result_has_color_matrix(DecodeResult* r) { return r->has_color_matrix; }

EMSCRIPTEN_KEEPALIVE
float* decode_result_camera_meta(DecodeResult* r) { return r->camera_meta; }

EMSCRIPTEN_KEEPALIVE
float* decode_result_cam_mul(DecodeResult* r) { return r->cam_mul; }

EMSCRIPTEN_KEEPALIVE
int decode_result_has_cam_mul(DecodeResult* r) { return r->has_cam_mul; }

EMSCRIPTEN_KEEPALIVE
void free_decoded(DecodeResult* r) {
    if (!r) return;
    delete[] r->cfa6;
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
    // failures), -1000 = embedded thumbnail is missing, empty, or not JPEG
    // format (LIBRAW_THUMBNAIL_JPEG required -- wrapper-detected, not a
    // LibRaw code, kept clear of LibRaw's own range same as DecodeResult's
    // -1000), -1001 = allocation/exception raised by the wrapper's own code.
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
