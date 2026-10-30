import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkDeviceTrust,
  deviceFingerprint,
  forgetDevice,
  pinDevice,
  trustedDevice,
  trustedDevices,
} from "./deviceTrust";

const PIN_STORE = "reasonix.devices.v1";
/** Thirty-two `0x01` bytes, the key the fixed digest below belongs to. */
const KEY_A = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const FULL_A = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Distinct 32-byte keys without depending on any particular one's digest. */
function key(seed: number): string {
  return base64Url(Uint8Array.from({ length: 32 }, (_, index) => (seed * 37 + index * 11) & 0xff));
}

async function fullOf(publicKey: string): Promise<string> {
  const result = await deviceFingerprint(publicKey);
  if (result === null) throw new Error("test key did not decode");
  return result.full;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("deviceFingerprint", () => {
  it("digests the decoded key and shows the first eight groups", async () => {
    const result = await deviceFingerprint(KEY_A);

    expect(result?.full).toBe(FULL_A);
    expect(result?.display).toBe("72cd 6e84 22c4 07fb 6d09 8690 f113 0b7d");
  });

  it("reads the standard and URL-safe spellings of one key the same", async () => {
    const publicKey = key(2);
    const standard = publicKey.replaceAll("-", "+").replaceAll("_", "/");
    expect(await deviceFingerprint(standard)).toEqual(await deviceFingerprint(publicKey));
  });

  it("refuses a value that is not a key", async () => {
    expect(await deviceFingerprint("")).toBeNull();
    expect(await deviceFingerprint("%%%not-base64%%%")).toBeNull();
  });
});

describe("checkDeviceTrust", () => {
  it("asks before the first trust and stores the pin once accepted", async () => {
    const publicKey = key(3);
    const confirm = vi.fn(async () => true);

    const first = await checkDeviceTrust({ id: "dev1", publicKey }, confirm);
    expect(first).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledWith({ id: "dev1", fingerprint: expect.any(String) });
    expect(trustedDevice("dev1")).toMatchObject({
      id: "dev1",
      publicKey,
      fingerprint: await fullOf(publicKey),
    });

    // Afterwards the same key needs nobody: recovery verifies without asking.
    const again = await checkDeviceTrust({ id: "dev1", publicKey });
    expect(again).toEqual({ ok: true });
  });

  it("remembers nothing when the person declines", async () => {
    const publicKey = key(4);
    const result = await checkDeviceTrust({ id: "dev1", publicKey }, async () => false);

    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(trustedDevice("dev1")).toBeNull();
  });

  it("requires a decision when nobody can be asked", async () => {
    const publicKey = key(5);
    const result = await checkDeviceTrust({ id: "dev1", publicKey });

    expect(result).toMatchObject({ ok: false, code: "required" });
    expect(typeof (result as { fingerprint?: string }).fingerprint).toBe("string");
  });

  it("refuses a changed key without offering to approve it", async () => {
    const first = key(6);
    const second = key(7);
    expect(pinDevice({ id: "dev1", publicKey: first, fingerprint: await fullOf(first) })).toBe(true);
    const confirm = vi.fn(async () => true);

    const result = await checkDeviceTrust({ id: "dev1", publicKey: second }, confirm);

    expect(result).toMatchObject({ ok: false, code: "changed" });
    expect(confirm).not.toHaveBeenCalled();
    expect(trustedDevice("dev1")?.fingerprint).toBe(await fullOf(first));
  });

  it("refuses a key it cannot read", async () => {
    const result = await checkDeviceTrust({ id: "dev1", publicKey: "%%%" }, async () => true);
    expect(result).toMatchObject({ ok: false, code: "unreadable" });
  });

  it("treats a storage that cannot write as no trust at all", async () => {
    const publicKey = key(8);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const result = await checkDeviceTrust({ id: "dev1", publicKey }, async () => true);

    expect(result).toMatchObject({ ok: false, code: "required" });
  });

  it("forgets a device when asked, so a reinstall can be approved", async () => {
    const first = key(9);
    const second = key(10);
    pinDevice({ id: "dev1", publicKey: first, fingerprint: await fullOf(first) });
    forgetDevice("dev1");

    expect(trustedDevice("dev1")).toBeNull();
    expect(await checkDeviceTrust({ id: "dev1", publicKey: second }, async () => true)).toEqual({
      ok: true,
    });
  });
});

describe("the pin store", () => {
  it("keeps the newest pin first and drops one pin per device", async () => {
    const one = key(11);
    const two = key(12);
    pinDevice({ id: "dev1", publicKey: one, fingerprint: await fullOf(one) });
    pinDevice({ id: "dev2", publicKey: one, fingerprint: await fullOf(one) });
    pinDevice({ id: "dev1", publicKey: two, fingerprint: await fullOf(two) });

    const rows = trustedDevices();
    expect(rows.map((row) => row.id)).toEqual(["dev1", "dev2"]);
    expect(rows[0]?.fingerprint).toBe(await fullOf(two));
    expect(JSON.parse(localStorage.getItem(PIN_STORE) ?? "[]")).toHaveLength(2);
  });

  it("ignores a store that was hand-edited into nonsense", () => {
    localStorage.setItem(PIN_STORE, JSON.stringify([{ id: 3 }, null, "dev1"]));
    expect(trustedDevices()).toEqual([]);
  });
});
