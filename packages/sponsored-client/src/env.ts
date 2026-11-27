/** Read a Vite or Node env var. Tests use `vi.stubEnv`. */
export function readEnv(name: string): string {
  const meta = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.[name];
  if (meta != null && meta !== "") return String(meta);
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc?.env?.[name]) return String(proc.env[name]);
  return "";
}
