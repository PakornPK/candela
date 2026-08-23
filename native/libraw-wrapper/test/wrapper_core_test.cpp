#include <cassert>
#include "../wrapper_core.h"

int main() {
    using namespace candela;

    assert(validate_dimensions(6000, 4000) == true);    // typical 24MP
    assert(validate_dimensions(9504, 6336) == true);    // ~60MP
    assert(validate_dimensions(0, 100) == false);        // zero width
    assert(validate_dimensions(100, 0) == false);        // zero height
    assert(validate_dimensions(50000, 50000) == false);  // absurd dims from a corrupt file

    return 0;
}
