package com.reasonix.mobile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Reads the wire fixtures shared with `src/wire/contract.test.ts`. */
final class Fixtures {
    private Fixtures() {}

    static String read(String name) throws IOException {
        try (InputStream in = Fixtures.class.getResourceAsStream("/wire/" + name)) {
            if (in == null) throw new IOException("missing fixture: " + name);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
