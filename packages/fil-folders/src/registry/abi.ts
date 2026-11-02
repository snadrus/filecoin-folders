/** ABI of `contracts/src/FolderRegistry.sol`. The anvil test checks it against forge's artifact. */
const committedEvent = {
  type: "event",
  name: "Committed",
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "ns", type: "bytes32", indexed: true },
    { name: "key", type: "bytes32", indexed: true },
    { name: "pieceCid", type: "bytes", indexed: false },
    { name: "prevPieceCid", type: "bytes", indexed: false },
    { name: "version", type: "uint64", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

export const folderRegistryAbi = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "initialOwner", type: "address" },
      { name: "initialSessionKeyRegistry", type: "address" },
    ],
  },
  {
    type: "function",
    name: "MAX_PIECE_CID_BYTES",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "PERMISSION_COMMIT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "sessionKeyRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setOwner",
    stateMutability: "nonpayable",
    inputs: [{ name: "nextOwner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setSessionKeyRegistry",
    stateMutability: "nonpayable",
    inputs: [{ name: "nextRegistry", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ns", type: "bytes32" },
      { name: "key", type: "bytes32" },
      { name: "pieceCid", type: "bytes" },
      { name: "prevPieceCid", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "volumeOwner", type: "address" },
      { name: "ns", type: "bytes32" },
      { name: "key", type: "bytes32" },
      { name: "pieceCid", type: "bytes" },
      { name: "prevPieceCid", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setWriter",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ns", type: "bytes32" },
      { name: "writer", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "head",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "ns", type: "bytes32" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [
      { name: "pieceCid", type: "bytes" },
      { name: "version", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "isWriter",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "ns", type: "bytes32" },
      { name: "writer", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  committedEvent,
  {
    type: "event",
    name: "WriterSet",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "ns", type: "bytes32", indexed: true },
      { name: "writer", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false },
    ],
  },
  {
    type: "error",
    name: "CasConflict",
    inputs: [
      { name: "currentPieceCid", type: "bytes" },
      { name: "currentVersion", type: "uint64" },
    ],
  },
  {
    type: "error",
    name: "NotAuthorized",
    inputs: [
      { name: "caller", type: "address" },
      { name: "owner", type: "address" },
      { name: "ns", type: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
  {
    type: "error",
    name: "PieceCidTooLarge",
    inputs: [{ name: "length", type: "uint256" }],
  },
  {
    type: "error",
    name: "VersionOverflow",
    inputs: [],
  },
  {
    type: "error",
    name: "NotContractOwner",
    inputs: [],
  },
  {
    type: "event",
    name: "OwnerUpdated",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "nextOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "SessionKeyRegistryUpdated",
    inputs: [
      { name: "previousRegistry", type: "address", indexed: true },
      { name: "nextRegistry", type: "address", indexed: true },
    ],
  },
] as const;

export { committedEvent };
