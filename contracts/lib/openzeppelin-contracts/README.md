Vendored subset of OpenZeppelin Contracts v5.1.0 (MIT): P256 (+Math, SafeCast, Errors, Panic) and Base64,
for passkey (WebAuthn P-256) owners in LockedSignerAccount. Filecoin has no RIP-7212 precompile at 0x100,
so P256.verify uses its Solidity fallback.
