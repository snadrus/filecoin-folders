// Playwright webServer: start anvil on :8546, deploy FiClub with anvil's well-known local test key
// (local chain only; no real funds), then serve /ficlub/ pointed at it.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bin = (n) => (fs.existsSync(path.join(os.homedir(), ".foundry/bin", n)) ? path.join(os.homedir(), ".foundry/bin", n) : n);
const RPC = "http://127.0.0.1:8546";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil account #0

const anvil = spawn(bin("anvil"), ["--port", "8546", "--silent"], { stdio: "ignore" });
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    if (r.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
const root = path.resolve(import.meta.dirname, "../../../contracts");
const out = execFileSync(bin("forge"), ["create", "src/FiClub.sol:FiClub", "--rpc-url", RPC, "--private-key", KEY, "--broadcast", "--json"], { cwd: root }).toString();
const addr = JSON.parse(out.slice(out.indexOf("{"))).deployedTo;
const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", "4175", "--strictPort"], {
  stdio: "inherit",
  env: { ...process.env, VITE_FICLUB_ADDRESS_LOCAL: addr, VITE_FICLUB_RPC: RPC, VITE_FICLUB_CHAIN_ID: "31337" },
});
const stop = () => (anvil.kill(), vite.kill(), process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
