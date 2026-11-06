package com.reasonix.mobile;

import org.json.JSONObject;

/**
 * A Java string as a JavaScript string literal.
 *
 * `JSONObject.quote` escapes quotes, backslashes and control characters, but
 * not U+2028/U+2029; older WebViews treat those as line terminators inside a
 * literal, which kills the whole `evaluateJavascript` call.
 */
final class JsString {
    private JsString() {}

    static String quote(String value) {
        return JSONObject.quote(value)
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029");
    }
}
