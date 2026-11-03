import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedIdentity, guestName, type IdentityV1 } from "fiperson/edit";
import { IdentityBlocked, type IdentityIO } from "../src/identity/io.js";
import { IdentityPage, safeReturn } from "../src/identity/page.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeIO(over: Partial<IdentityIO> = {}): IdentityIO & { saved: IdentityV1[] } {
  const saved: IdentityV1[] = [];
  return {
    saved,
    peek: async () => A,
    connect: async () => A,
    load: async (address) => ({ address: address as never, displayName: guestName(address), source: "guest", identity: null }),
    save: async (_a, doc) => (saved.push(doc), { pieceCid: "bafkzcibx", version: "1" }),
    findClubs: async (address) => ({ address: address as never, clubs: [{ id: "1", name: "Acme", members: [address as never, B], admins: [address as never], role: "admin" }], coworkers: [B], checkedAt: 1 }),
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

describe("notifications + clubs", () => {
  it("saves a Slack contact into the identity, rejects half-filled IDs, and finds clubs", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const io = fakeIO();
    const page = new IdentityPage(root, io, "");
    await page.start();
    await tick();
    const set = (id: string, v: string) => {
      const el = root.querySelector<HTMLInputElement>(`[data-testid=${id}]`)!;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("identity-slack-team", "T0ACME");
    await page.save();
    expect(root.querySelector("[data-testid=identity-error]")?.textContent).toContain("member ID");
    set("identity-slack-user", "u0bea");
    set("identity-slack-domain", "acme");
    await page.save();
    expect(io.saved.at(-1)?.notify).toEqual({ preferred: "slack", contacts: [{ channel: "slack", team: "T0ACME", user: "U0BEA", domain: "acme" }] });
    root.querySelector<HTMLButtonElement>("[data-testid=identity-find-clubs]")!.click();
    await tick();
    await tick();
    expect(root.querySelector("[data-testid=identity-clubs-list]")?.textContent).toContain("Acme");
    expect(root.querySelector("[data-testid=identity-coworkers]")?.textContent).toContain("1 club-mate");
  });
});
