import { invoke as tauriInvoke, addPluginListener as tauriAddPluginListener } from "@tauri-apps/api/core";

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}
export const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

export async function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(command, args);
  const response = await fetch(`/__api/command/${encodeURIComponent(command)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function addPluginListener(
  plugin: string,
  event: string,
  handler: (payload: unknown) => void,
): Promise<{ unregister: () => Promise<void> }> {
  if (isTauri) return tauriAddPluginListener(plugin, event, handler);
  void plugin; void event; void handler;
  return { unregister: async () => {} };
}
