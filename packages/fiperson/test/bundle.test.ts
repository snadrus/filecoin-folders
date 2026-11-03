import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("bundle split", () => {
  it("fiperson/view pulls in no edit code and no dependencies", async () => {
    const out = await build({ entryPoints: ["src/view/index.ts"], bundle: true, write: false, format: "esm", metafile: true, minify: true, platform: "browser" });
    const inputs = Object.keys(out.metafile.inputs);
    expect(inputs.every((f) => f.startsWith("src/view/"))).toBe(true);
    const code = out.outputFiles[0]!.text;
    for (const marker of ["Store identity piece", "Link identity to wallet", "padEnd(", "IdentityBlocked"]) expect(code).not.toContain(marker);
    expect(code.length).toBeLessThan(20_000) // 16 kB until notify contacts + person card (#46);
  });
});
