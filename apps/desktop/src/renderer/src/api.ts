import type { AirDeskBridge, CommandName } from '@airdesk/contracts';

declare global {
  interface Window {
    airdesk: AirDeskBridge;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Listener = (code: string) => void;
const sessionListeners = new Set<Listener>();
/** App shell subscribes to be told when the backend ended the session. */
export function onSessionLost(fn: Listener): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export async function call<T>(command: CommandName, payload: unknown = {}): Promise<T> {
  const res = await window.airdesk.invoke<T>(command, payload);
  if (res.ok) return res.data;
  if (res.error.code === 'UNAUTHENTICATED' || res.error.code === 'SESSION_EXPIRED') {
    for (const l of sessionListeners) l(res.error.code);
  }
  throw new ApiError(res.error.code, res.error.message, res.error.details);
}
