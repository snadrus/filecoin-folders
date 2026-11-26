import { parseAbi } from "viem";
/** LockedSignerAccount (contracts/src/LockedSignerAccount.sol): shared by the browser and the sponsor backend. */

export const lockedAccountAbi = parseAbi([
  "function owner() view returns (address)",
  "function passkeyX() view returns (bytes32)",
  "function passkeyY() view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function sessionExpiry() view returns (uint256)",
  "function sessionSigners(address) view returns (uint256)",
  "function isAllowed(address target, bytes4 selector) view returns (bool)",
  "function execute(address target, uint256 value, bytes data, uint256 nonce, uint256 deadline, bytes signature) returns (bytes)",
  "function addSessionKey(address key, uint256 expiry)",
  "function removeSessionKey(address key)",
  "function allowDataSet(uint256 providerId, uint256 clientDataSetId, string[] keys, string[] values) returns (address)",
  "function sweep(uint256 amount)",
  "error CallNotAllowed(address target, bytes4 selector)",
  "error BadPasskeySignature()",
  "error BadSigner(address recovered)",
  "error BadNonce(uint256 expected, uint256 got)",
  "error Expired(uint256 deadline)",
  "error CallFailed(bytes returndata)",
  "error NotAdmin()",
  "error ProviderNotApproved(uint256 providerId)",
]);

export const lockedFactoryAbi = parseAbi([
  "function predict(address owner, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) view returns (address)",
  "function create(address owner, bytes32 qx, bytes32 qy, uint256 salt, uint256 sessionExpiry) returns (address)",
  "function isAccount(address account) view returns (bool)",
  "function admin() view returns (address)",
  "function REGISTRY() view returns (address)",
]);

/** EIP-712 `Execute` the account verifies (domain: name "LockedSignerAccount", version "1", verifyingContract = account). */
export const EXECUTE_TYPES = {
  Execute: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function executeDomain(chainId: number, account: `0x${string}`) {
  return { name: "LockedSignerAccount", version: "1", chainId, verifyingContract: account } as const;
}

/** EIP-712 request the sponsor backend authenticates (owner wallet, account session key, or passkey). */
export const SPONSOR_REQUEST_TYPES = {
  SponsorRequest: [
    { name: "action", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
} as const;

export function sponsorDomain(chainId: number) {
  return { name: "FiFolders Sponsor", version: "1", chainId } as const;
}

/** Stable JSON (sorted keys) so client and server hash the same body. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value === "bigint" ? value.toString() : value);
}

export type SponsorOwner = { kind: "eoa"; address: `0x${string}` } | { kind: "passkey"; x: `0x${string}`; y: `0x${string}` };

export type SponsorAuth = { issuedAt: string } & (
  | { kind: "eoa"; address: `0x${string}`; signature: `0x${string}` }
  | { kind: "session"; account: `0x${string}`; key: `0x${string}`; signature: `0x${string}` }
  | { kind: "passkey"; x: `0x${string}`; y: `0x${string}`; authenticatorData: `0x${string}`; clientDataJSON: string; signature: `0x${string}` }
);
