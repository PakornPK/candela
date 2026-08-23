cmake_minimum_required(VERSION 3.20)
project(libraw_wrapper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(wrapper_core STATIC wrapper_core.cpp)
target_include_directories(wrapper_core PUBLIC .)

if(EMSCRIPTEN)
  # LibRaw ships no CMake support of its own (dropped in 2014, per
  # third_party/libraw/README.cmake) -- it's built separately via its native
  # autotools workflow (emconfigure/emmake) in build.sh, which must run
  # before this configure step. We link the resulting static lib as a plain
  # file path rather than a CMake target.
  set(LIBRAW_STATIC_LIB ${CMAKE_CURRENT_SOURCE_DIR}/third_party/libraw/lib/.libs/libraw_r.a)
  if(NOT EXISTS ${LIBRAW_STATIC_LIB})
    message(FATAL_ERROR "LibRaw static lib not found at ${LIBRAW_STATIC_LIB} -- run build.sh, which builds it via emconfigure/emmake before this CMake configure step.")
  endif()

  add_executable(libraw wrapper.cpp)
  target_include_directories(libraw PRIVATE third_party/libraw)
  target_link_libraries(libraw PRIVATE wrapper_core ${LIBRAW_STATIC_LIB})
  # NOTE: build.sh passes additional required flags (-fexceptions,
  # -sSTACK_SIZE) via CMake cache variables -- see build.sh for why.
  target_link_options(libraw PRIVATE
    "-sMODULARIZE=1"
    # EXPORT_ES6: without this, Emscripten emits a UMD-style module whose
    # CJS/AMD export branches never execute in the browser (native ES
    # `import` sees no exports at all -- "does not provide an export named
    # 'default'"). This project's package.json has "type": "module", so the
    # browser and Vite both load this file as a real ES module; EXPORT_ES6
    # makes Emscripten emit a genuine `export default` to match.
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createLibRawModule"
    # HEAPU8/HEAPU16: decode.ts (Task 5) writes the input file's bytes
    # directly into wasm linear memory via a malloc'd pointer and reads the
    # decoded Bayer buffer back out the same way -- both require direct
    # access to the memory-view typed arrays. ccall/cwrap alone only cover
    # calling exported functions, not touching memory, so both views must be
    # requested explicitly here (Emscripten does not attach them to the
    # Module object by default).
    "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\",\"HEAPU8\",\"HEAPU16\"]"
    "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\"]"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sENVIRONMENT=web,node"
  )
  set_target_properties(libraw PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_SOURCE_DIR}/../../src/wasm
  )
else()
  enable_testing()
  add_executable(wrapper_core_test test/wrapper_core_test.cpp)
  target_link_libraries(wrapper_core_test PRIVATE wrapper_core)
  add_test(NAME wrapper_core_test COMMAND wrapper_core_test)
endif()
