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
    "-sEXPORT_NAME=createLibRawModule"
    "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\"]"
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
