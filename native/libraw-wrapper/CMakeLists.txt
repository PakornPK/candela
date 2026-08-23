cmake_minimum_required(VERSION 3.20)
project(libraw_wrapper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(wrapper_core STATIC wrapper_core.cpp)
target_include_directories(wrapper_core PUBLIC .)

if(EMSCRIPTEN)
  add_subdirectory(third_party/libraw)
  add_executable(libraw wrapper.cpp)
  target_link_libraries(libraw PRIVATE wrapper_core raw_r)
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
