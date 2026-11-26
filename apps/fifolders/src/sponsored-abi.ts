import { parseAbi } from "viem";
/** LockedSignerAccount (contracts/src/LockedSignerAccount.sol): shared by the browser and the sponsor backend. */

export const lockedAccountAbi = parseAbi([
  "function owner() view returns (address)",
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
  "error BadSigner(address recovered)",
  "error BadNonce(uint256 expected, uint256 got)",
  "error Expired(uint256 deadline)",
  "error CallFailed(bytes returndata)",
  "error NotAdmin()",
  "error ProviderNotApproved(uint256 providerId)",
]);

export const lockedFactoryAbi = parseAbi([
  "function predict(address owner, uint256 salt, uint256 sessionExpiry) view returns (address)",
  "function create(address owner, uint256 salt, uint256 sessionExpiry) returns (address)",
  "function admin() view returns (address)",
  "function appAllowed(address target, bytes4 selector) view returns (bool)",
  "function setAppAllowed(address target, bytes4 selector, bool allowed)",
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
