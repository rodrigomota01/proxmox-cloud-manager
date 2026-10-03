/**
 * Typed API client generated from docs/api/openapi.json (`npm run gen:api`).
 * Adds the bearer token and the active tenant, refreshes once on 401 and retries.
 */
import createClient from "openapi-fetch";

import { getAccessToken, refresh } from "@/lib/auth/session";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

let tenantId: string | null = null;
export function setActiveTenant(id: string | null) {
  tenantId = id;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

async function authFetch(input: Request): Promise<Response> {
  const send = (token: string | null) => {
    const req = input.clone();
    if (token) req.headers.set("Authorization", `Bearer ${token}`);
    if (tenantId && !req.headers.has("X-Tenant-Id")) req.headers.set("X-Tenant-Id", tenantId);
    return fetch(req);
  };
  let res = await send(getAccessToken() ?? (await refresh()));
  if (res.status === 401) {
    const token = await refresh();
    if (token) res = await send(token);
  }
  return res;
}

export const api = createClient<paths>({ fetch: authFetch });

type Problem = {
  status?: number;
  code?: string;
  title?: string;
  detail?: string;
  errors?: { field: string; message: string }[];
};

/** Unwraps an openapi-fetch result, throwing ApiError for problem+json responses. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const p = (result.error ?? {}) as Problem;
    throw new ApiError(
      result.response.status,
      p.code ?? "HTTP_ERROR",
      p.detail ?? p.title ?? `HTTP ${result.response.status}`,
      p.errors ?? [],
    );
  }
  return result.data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fieldErrors.length) {
      return err.fieldErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
    }
    const byStatus: Record<number, string> = {
      403: "Você não tem permissão para esta ação.",
      404: "Recurso não encontrado.",
      409: err.message,
      503: "Serviço indisponível no momento.",
    };
    return byStatus[err.status] ?? err.message;
  }
  return "Erro inesperado.";
}
