import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedIdentity, guestName, type IdentityV1 } from "fiperson/edit";
import { IdentityBlocked, type IdentityIO } from "../src/identity/io.js";
import { IdentityPage, safeReturn } from "../src/identity/page.js";

const A = "0x1111111111111111111111111111111111111111";
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeIO(over: Partial<IdentityIO> = {}): IdentityIO & { saved: IdentityV1[] } {
  const saved: IdentityV1[] = [];
  return {
    saved,
    peek: async () => A,
    connect: async () => A,
    load: async (address) => ({ address: address as never, displayName: guestName(address), source: "guest", identity: null }),
    save: async (_a, doc) => (saved.push(doc), { pieceCid: "bafkzcibx", version: "1" }),
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("identity page", () => {
  it("prefills the old FiFolders display name, saves, caches, and returns", async () => {
    localStorage.setItem("fifolders:display-name", "Old Name");
    const root = document.createElement("main");
    document.body.appendChild(root);
    const io = fakeIO();
    const navigate = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    const page = new IdentityPage(root, io, "?return=" + encodeURIComponent(location.origin + "/fipen/?doc=1"), navigate);
    await page.start();
    const name = root.querySelector<HTMLInputElement>("[data-testid=identity-name]")!;
    expect(name.value).toBe("Old Name");
    name.value = "Andy";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await page.save();
    expect(io.saved[0]).toMatchObject({ v: 1, displayName: "Andy", address: A });
    expect(cachedIdentity(A).displayName).toBe("Andy");
    expect(root.querySelector("[data-testid=identity-saved]")).toBeTruthy();
    vi.advanceTimersByTime(2000);
    expect(navigate).toHaveBeenCalledWith(location.origin + "/fipen/?doc=1");
    vi.useRealTimers();
  });

  it("requires a display name", async () => {
    const root = document.createElement("main");
    const page = new IdentityPage(root, fakeIO());
    await page.start();
    page.state.draft.displayName = "  ";
    await page.save();
    expect(root.querySelector("[data-testid=identity-error]")!.textContent).toMatch(/required/);
  });

  it("shows a blocked message when storage payments are not set up", async () => {
    const root = document.createElement("main");
    const page = new IdentityPage(root, fakeIO({ save: async () => { throw new IdentityBlocked("Storage payments are not set up"); } }));
    await page.start();
    await page.save();
    await tick();
    expect(root.querySelector("[data-testid=identity-blocked]")!.textContent).toMatch(/payments/);
  });

  it("only returns to same-origin pages", () => {
    expect(safeReturn("https://evil.example/x")).toBeNull();
    expect(safeReturn("/fipen/")).toBe(location.origin + "/fipen/");
  });
});
