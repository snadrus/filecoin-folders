# Upgrading the v2 account beacon

The Calibration (and, after mainnet deploy, mainnet) UpgradeableBeacon is owned by Andy's Ledger Ethereum address:

`0xD62bD538bcEaB1284950E513f6Da796dD790642a`

That address is an EOA (empty code, not an `0xff` f1 masked-ID). There is no timelock: `upgradeTo` takes effect on inclusion. After the Calibration handover, the sponsor-key workflow `upgrade-v2-beacon-calibration` will refuse to send, because the sponsor is no longer the owner.

Do not transfer beacon ownership to the f1 recovery masked-ID; it cannot sign EVM transactions.

## Calibration addresses

| | |
|---|---|
| Chain ID | `314159` |
| RPC | `https://api.calibration.node.glif.io/rpc/v1` |
| Factory | `0x228867301f1f0EaF75b5d7af62F3c44e1796A56D` |
| Beacon | `0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA` |

Confirm the live implementation before upgrading:

```sh
cast call 0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA "implementation()(address)" \
  --rpc-url https://api.calibration.node.glif.io/rpc/v1
cast call 0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA "owner()(address)" \
  --rpc-url https://api.calibration.node.glif.io/rpc/v1
```

The Ledger needs a little Calibration FIL for gas (`eth_getBalance` was 0 at handover).

## 1. Deploy a new implementation

`LockedSignerAccountV2`'s constructor takes the factory address. Anyone can deploy a new implementation; accounts do not change until the beacon points at it.

```sh
forge create contracts/src/LockedSignerAccountV2.sol:LockedSignerAccountV2 \
  --rpc-url https://api.calibration.node.glif.io/rpc/v1 \
  --constructor-args 0x228867301f1f0EaF75b5d7af62F3c44e1796A56D
```

Record the deployed address (`NEW_IMPL`). It must have contract code (`cast code $NEW_IMPL` is not `0x`).

## 2. Call `upgradeTo` from the Ledger

On Calibration, as `0xD62bD538bcEaB1284950E513f6Da796dD790642a`, call the beacon:

- To: `0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA`
- Function: `upgradeTo(address newImplementation)` (selector `0x3659cfe6`)
- Argument: `NEW_IMPL`

With Foundry and a Ledger (use the Ethereum derivation path that yields `0xD62b…642a`):

```sh
cast send 0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA \
  "upgradeTo(address)" "$NEW_IMPL" \
  --rpc-url https://api.calibration.node.glif.io/rpc/v1 \
  --chain 314159 \
  --ledger \
  --from 0xD62bD538bcEaB1284950E513f6Da796dD790642a
```

Alternatively, connect the Ledger through MetaMask, Rabby, or Remix to Calibration (chain ID 314159) and send the same `upgradeTo(NEW_IMPL)` call.

## 3. Verify

```sh
cast call 0xbF8D1Ff1c632E953c52Cc4a7CdFD81E17374D9fA "implementation()(address)" \
  --rpc-url https://api.calibration.node.glif.io/rpc/v1
```

The result must equal `NEW_IMPL`. Filecoin RPCs can lag one head after inclusion; poll if it still shows the previous implementation.

## Mainnet

`deployments/beacon-owner.json` records this Ledger as `intendedBeaconOwner`. `deploy-v2.ts` transfers UpgradeableBeacon ownership to it immediately after a mainnet v2 factory deploy. Use the mainnet factory and beacon addresses from `deployments/mainnet-factory-v2.json` once that file exists; the `upgradeTo` call is the same, on chain ID `314`.
