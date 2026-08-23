#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

LIBRAW_DIR="third_party/libraw"
LIBRAW_LIB="$LIBRAW_DIR/lib/.libs/libraw_r.a"

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
  (cd "$LIBRAW_DIR" && CXXFLAGS="-fexceptions" CFLAGS="-fexceptions" emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-examples --disable-openmp)
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
