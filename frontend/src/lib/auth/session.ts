/**
 * Access token lives only in memory (docs/architecture/06-autenticacao.md). The refresh
 * token is an HttpOnly cookie scoped to /api/v1/auth that JS never sees.
 *
 * Refresh tokens rotate and a reused one revokes the whole session. Two tabs refreshing
 * at once would look exactly like that, so refreshes are serialized across tabs with the
 * Web Locks API: the second tab waits, then refreshes with the cookie the first one
 * already rotated. Within a tab, concurrent callers share one in-flight refresh.
 */

const AUTH = "/api/v1/auth";
const LOCK = "cm-auth-refresh";
const CSRF = { "X-Requested-With": "cloud-manager" };

type Listener = (token: string | null) => void;

let accessToken: string | null = null;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<Listener>();

export function getAccessToken(): string | null {
  return accessToken;
}

function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((fn) => fn(token));
}

export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function doRefresh(): Promise<string | null> {
  const res = await fetch(`${AUTH}/refresh`, {
    method: "POST",
    headers: CSRF,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

/** Returns a fresh access token, or null when the session is gone. */
export function refresh(): Promise<string | null> {
  if (!inflight) {
    const run = () => doRefresh().catch(() => null);
    inflight = navigatorLock(run).then((token) => {
      setAccessToken(token);
      return token;
    }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; status: number; message: string; retryAfter?: number };

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${AUTH}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "same-origin",
  });
  if (res.ok) {
    const body = (await res.json()) as { access_token: string };
    setAccessToken(body.access_token);
    return { ok: true };
  }
  const retryAfter = Number(res.headers.get("retry-after")) || undefined;
  const message =
    res.status === 429
      ? `Muitas tentativas. Tente novamente em ${retryAfter ?? 60}s.`
      : res.status === 401
        ? "E-mail ou senha inválidos."
        : "Não foi possível entrar. Tente novamente.";
  return { ok: false, status: res.status, message, retryAfter };
}

export async function logout(): Promise<void> {
  await navigatorLock(() =>
    fetch(`${AUTH}/logout`, { method: "POST", headers: CSRF, credentials: "same-origin" }),
  ).catch(() => undefined);
  setAccessToken(null);
}

/** Runs fn holding the cross-tab refresh lock (plain call where Web Locks is missing). */
function navigatorLock<T>(fn: () => Promise<T>): Promise<T> {
  // request() resolves with the callback's resolved value; its typing nests the promise
  return typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks.request(LOCK, fn) as unknown as Promise<T>)
    : fn();
}
