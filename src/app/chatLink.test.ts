import { describe, expect, it } from "vitest";
import { parseChatLink } from "./chatLink";

describe("parseChatLink", () => {
  it("reads the runtime and the context a notification carries", () => {
    expect(
      parseChatLink(
        "reasonix://chat?runtime=r1&root=C%3A%5CDev%5CReasonix&title=%E8%BF%9E%E6%8E%A5",
      ),
    ).toEqual({ runtimeId: "r1", root: "C:\\Dev\\Reasonix", title: "连接" });
  });

  it("carries the peer a notification came from", () => {
    expect(
      parseChatLink(
        "reasonix://chat?runtime=r1&peer=http%3A%2F%2F192.168.7.7%3A56789&peerName=studio",
      ),
    ).toEqual({
      runtimeId: "r1",
      peer: "http://192.168.7.7:56789",
      peerName: "studio",
    });
  });

  it("accepts a link that only names the runtime", () => {
    expect(parseChatLink("reasonix://chat?runtime=r1")).toEqual({ runtimeId: "r1" });
  });

  it("refuses a link with no runtime", () => {
    expect(parseChatLink("reasonix://chat?root=x")).toBeNull();
    expect(parseChatLink("reasonix://chat")).toBeNull();
  });

  it("refuses another reasonix host or scheme", () => {
    expect(parseChatLink("reasonix://connect?runtime=r1")).toBeNull();
    expect(parseChatLink("https://example.com/chat?runtime=r1")).toBeNull();
    expect(parseChatLink("not a url")).toBeNull();
  });
});
