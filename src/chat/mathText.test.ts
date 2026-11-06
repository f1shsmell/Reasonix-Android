import { describe, expect, it } from "vitest";
import { normalizeMath } from "./mathText";

describe("normalizeMath", () => {
  it("turns LaTeX's own delimiters into the ones remark-math reads", () => {
    expect(normalizeMath("行内：\\(E = mc^2\\)")).toBe("行内：$E = mc^2$");
    expect(normalizeMath("块级：\n\\[\\sum_{i=1}^{n} i\\]")).toBe("块级：\n\n$$\n\\sum_{i=1}^{n} i\n$$\n");
  });

  it("leaves code and dollar math alone", () => {
    expect(normalizeMath("`\\(x\\)`")).toBe("`\\(x\\)`");
    expect(normalizeMath("```\n\\(x\\)\n```")).toBe("```\n\\(x\\)\n```");
    expect(normalizeMath("已渲染 $x$ 和 $$y$$")).toBe("已渲染 $x$ 和 $$y$$");
  });
});
