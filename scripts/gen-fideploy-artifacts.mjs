// Embed forge output for /fideploy/ (run after `forge build --root contracts`). Deterministic: solc 0.8.28, optimizer 200, shanghai, ipfs metadata.
import { readFileSync, writeFileSync } from "node:fs";
const pick = (name) => {
  const j = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { name, abi: j.abi.filter((x) => x.type === "constructor"), bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object, compiler: j.metadata?.compiler?.version ?? "0.8.28" };
};
const out = { FolderRegistryV2: pick("FolderRegistryV2"), FiClub: pick("FiClub") };
writeFileSync("apps/fifolders/src/fideploy/artifacts.json", JSON.stringify(out) + "\n");
console.log("wrote", Object.keys(out).join(", "));
