/**
 * The Synapse SDK calls `Array.fromAsync` and `Promise.withResolvers`.
 * Both ship in Node.js 22 and in current evergreen browsers.
 */
export function assertSupportedRuntime(): void {
  const arrayCtor = Array as unknown as { fromAsync?: unknown };
  const promiseCtor = Promise as unknown as { withResolvers?: unknown };
  const missing: string[] = [];
  if (typeof arrayCtor.fromAsync !== "function") missing.push("Array.fromAsync");
  if (typeof promiseCtor.withResolvers !== "function") missing.push("Promise.withResolvers");
  if (missing.length > 0) {
    throw new Error(
      `fil-folders requires ${missing.join(" and ")} (Node.js 22+ or a current browser). The Synapse SDK uses both.`,
    );
  }
}
