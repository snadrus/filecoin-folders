import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALIBRATION_RPC,
  DEFAULT_VOLUME,
  isSponsored,
  MAINNET_RPC,
  registryConfig,
  sponsorUrl,
} from "../src/config.js";
import { CALIBRATION_REGISTRY_V1, MAINNET_REGISTRY_V2, MAINNET_REGISTRY_V2_FROM_BLOCK } from "fil-folders";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sponsor config", () => {
  it("is off without VITE_SPONSOR_URL", () => {
    vi.stubEnv("VITE_SPONSOR_URL", "");
    expect(isSponsored("calibration")).toBe(false);
    vi.stubEnv("VITE_SPONSOR_URL", "http://sponsor/");
    expect(isSponsored("calibration")).toBe(true);
    expect(sponsorUrl("calibration")).toBe("http://sponsor");
    expect(sponsorUrl("mainnet")).toBe("");
  });

  it("serves mainnet under /mainnet when enabled", () => {
    vi.stubEnv("VITE_SPONSOR_URL", "https://fast.example");
    vi.stubEnv("VITE_SPONSOR_NETWORKS", "calibration,mainnet");
    expect(sponsorUrl("calibration")).toBe("https://fast.example");
    expect(sponsorUrl("mainnet")).toBe("https://fast.example/mainnet");
  });
});

describe("registryConfig", () => {
  it("defaults Calibration to v1 (migrates to v2) and mainnet to the published v2 registry", () => {
    vi.stubEnv("VITE_FOLDER_REGISTRY", "");
    vi.stubEnv("VITE_FOLDER_REGISTRY_MAINNET", "");
    expect(registryConfig("calibration").address.toLowerCase()).toBe(CALIBRATION_REGISTRY_V1.toLowerCase());
    expect(registryConfig("mainnet")).toEqual({ address: MAINNET_REGISTRY_V2, fromBlock: MAINNET_REGISTRY_V2_FROM_BLOCK });
  });

  it("uses the same default volume as the drive", () => {
    expect(DEFAULT_VOLUME).toBe("My Drive");
  });

  it("uses the public Filecoin RPCs", () => {
    expect(CALIBRATION_RPC).toContain("calibration");
    expect(MAINNET_RPC).toContain("api.node.glif.io");
  });
});
