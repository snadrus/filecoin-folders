import "../stale-chunks.js";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "../treclub/treclub.css";
import "./tredeploy.css";
import { DeployPage } from "./page.js";
import { walletConnectConfig } from "../wallets.js";

const root = document.querySelector<HTMLElement>("#tredeploy-app");
if (!root) throw new Error("missing #tredeploy-app");
const walletConnect = async () => {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const p = await EthereumProvider.init({ ...walletConnectConfig(location.origin, "calibration"), optionalChains: [314, 314159] } as never);
  await p.connect();
  return p as never;
};
void new DeployPage(root, { walletConnect }).start().catch((e) => {
  console.error("tredeploy", e);
  root.textContent = "TreDeploy could not start. Reload to try again.";
});
