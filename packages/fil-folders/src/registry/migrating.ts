import type { Address, Hex } from "viem";
import { bytesEqual } from "../bytes.js";
import { RegistryCasConflict } from "../errors.js";
import type { CommittedRecord, Registry, RegistryCommit } from "./types.js";

export interface MigratingRegistryOptions {
  /** FolderRegistry v2 (or any successor). Reads and writes go here first. */
  current: Registry;
  /** FolderRegistry v1. Read-only fallback while a head has not moved yet. */
  legacy: Registry;
  /**
   * Wraps the one-time commit that moves a head from `legacy` to `current`
   * (e.g. a labeled wallet prompt "Move drive pointer to new registry").
   */
  wrapMigration?: <T>(info: { owner: Address; ns: Hex; key: Hex }, fn: () => Promise<T>) => Promise<T>;
}

export interface MigratingRegistry extends Registry {
  readonly migrating: true;
  /** True while `(owner, ns, key)` has a legacy head and no successor head. */
  needsMigration(owner: Address, ns: Hex, key: Hex): Promise<boolean>;
}

/**
 * Reads the successor head first and falls back to the legacy head. The first commit for a key whose
 * head is still only on `legacy` is a migration: it CAS-checks against the legacy head and writes the
 * successor at version 0. Manifests carry `prev`, so history stays linked across the move.
 */
export function createMigratingRegistry(options: MigratingRegistryOptions): MigratingRegistry {
  const { current, legacy } = options;
  const wrap = options.wrapMigration ?? ((_info, fn) => fn());
  return {
    migrating: true,
    async head(owner, ns, key) {
      const head = await current.head(owner, ns, key);
      if (head.version > 0n) return head;
      return legacy.head(owner, ns, key).catch(() => head);
    },
    async needsMigration(owner, ns, key) {
      const head = await current.head(owner, ns, key);
      if (head.version > 0n) return false;
      const old = await legacy.head(owner, ns, key).catch(() => null);
      return !!old && old.version > 0n && old.pieceCid.byteLength > 0;
    },
    async commit(input: RegistryCommit): Promise<CommittedRecord> {
      const head = await current.head(input.owner, input.ns, input.key);
      if (head.version > 0n || input.prevPieceCid.byteLength === 0) {
        if (head.version === 0n && input.prevPieceCid.byteLength === 0) {
          // Brand-new on v2; still refuse if a legacy head exists the caller did not see.
          const old = await legacy.head(input.owner, input.ns, input.key).catch(() => null);
          if (old && old.pieceCid.byteLength > 0) throw new RegistryCasConflict(old.pieceCid, old.version);
        }
        return current.commit(input);
      }
      const old = await legacy.head(input.owner, input.ns, input.key);
      if (!bytesEqual(old.pieceCid, input.prevPieceCid)) throw new RegistryCasConflict(old.pieceCid, old.version);
      return wrap({ owner: input.owner, ns: input.ns, key: input.key }, () => current.commit({ ...input, prevPieceCid: new Uint8Array() }));
    },
    setWriter: (ns, writer, allowed) => current.setWriter(ns, writer, allowed),
    async isWriter(owner, ns, writer) {
      return current.isWriter(owner, ns, writer);
    },
    async committed(query) {
      const [old, now] = await Promise.all([legacy.committed(query).catch(() => [] as CommittedRecord[]), current.committed(query)]);
      return [...old, ...now];
    },
  };
}
