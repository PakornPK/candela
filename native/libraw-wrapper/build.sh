#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

LIBRAW_DIR="third_party/libraw"
LIBRAW_LIB="$LIBRAW_DIR/lib/.libs/libraw_r.a"

# Re-apply the read_utils.cpp fread fix if a `git submodule update` reset it.
# Upstream checks `fread() < count` BEFORE libraw_swab(); on a short read it
# throws (derror) before the byte swap runs, which leaves half-swapped
# predictor bytes for big-endian NEFs. The patched order swabs first, then
# checks. Must match LIBRAW_OWN_SWAB above (the swab it runs first is
# LibRaw's own loop). Idempotent: `git apply` on an already-patched file
# fails, which set -e turns into a loud build abort rather than a silent
# wasm built from an unpatched tree.
PATCH_FILE="$(pwd)/patches/read_utils-fread.patch"
if ! grep -q 'size_t rn = (unsigned)fread(pixel, 2, count, ifp);' "$LIBRAW_DIR/src/utils/read_utils.cpp"; then
  echo "Applying read_utils.cpp fread fix..."
  (cd "$LIBRAW_DIR" && git apply "$PATCH_FILE")
fi

if [ ! -f "$LIBRAW_DIR/configure" ]; then
  echo "Generating LibRaw's configure script..."
  (cd "$LIBRAW_DIR" && autoreconf --install)
fi

if [ ! -f "$LIBRAW_LIB" ]; then
  echo "Building LibRaw for WASM via emconfigure/emmake..."
  # CXXFLAGS/CFLAGS=-fexceptions: LibRaw's public API (open_buffer/unpack in
  # src/utils/open.cpp) converts internal throws into int error codes via its
  # own try/catch blocks. Emscripten disables C++ exception unwinding by
  # default; without -fexceptions here (and again below, for the wrapper
  # build), those catches are dead code and a throw traps the whole module
  # instead of returning cleanly. Confirmed empirically: decode() on
  # unrecognized/garbage input crashed with "memory access out of bounds"
  # until both LibRaw and the wrapper were rebuilt with -fexceptions.
  #
  # -DLIBRAW_OWN_SWAB: required. Emscripten's libc swab() is broken -- it
  # zeroes the output buffer instead of swapping adjacent bytes. LibRaw's
  # byte-swap path (libraw_swab, src/utils/utils_libraw.cpp) falls back to
  # libc swab() when this macro is undefined, which corrupts read_shorts()
  # for big-endian raw files (Nikon NEF: order=0x4D4D) and produces garbage
  # predictor state in nikon_load_raw. LIBRAW_OWN_SWAB makes libraw_swab use
  # its own byte-swap loop, which is correct in both native and WASM.
  # Verified: all NEF variants decode with data_error=0 and bayer means
  # exactly matching a native LibRaw build; Fuji RAF (little-endian, never
  # hits swab) is unchanged.
  (cd "$LIBRAW_DIR" && CXXFLAGS="-fexceptions -DLIBRAW_OWN_SWAB" CFLAGS="-fexceptions -DLIBRAW_OWN_SWAB" emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-examples --disable-openmp)
  (cd "$LIBRAW_DIR" && emmake make lib/libraw_r.la)
fi

# -fexceptions: see the comment above the LibRaw configure step -- must match
# on both sides of the static-lib link for exception unwinding to work at all.
#
# -sSTACK_SIZE: wrapper.cpp stack-allocates `LibRaw processor;` in decode().
# sizeof(LibRaw) is ~740KB (its embedded imgdata struct is large), which blows
# Emscripten's default 64KB wasm stack before a single byte of input is even
# read. 8MB leaves headroom for LibRaw's own (sometimes recursive) decoders.
emcmake cmake -B build-wasm -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-fexceptions" \
  -DCMAKE_EXE_LINKER_FLAGS="-fexceptions -sSTACK_SIZE=8388608"
cmake --build build-wasm
