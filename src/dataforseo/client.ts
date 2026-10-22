/**
 * Thin DataForSEO v3 client. One POST, no retries (a retry can cost money twice),
 * hard timeout, and structured errors that never contain credentials.
 */

export const DFS_BASE_URL = {
  live: "https://api.dataforseo.com",
  sandbox: "https://sandbox.dataforseo.com",
} as const;

export type DfsMode = keyof typeof DFS_BASE_URL;

export interface DfsTask {
  id: string;
  status_code: number;
  status_message: string;
  cost: number;
  result_count: number;
  path: string[];
  data: Record<string, unknown>;
  result: unknown[] | null;
}

export interface DfsResponse {
  version: string;
  status_code: number;
  status_message: string;
  time: string;
  cost: number;
  tasks_count: number;
  tasks_error: number;
  tasks: DfsTask[];
}

export class DataForSeoError extends Error {
  constructor(
    message: string,
    /** DataForSEO status_code (e.g. 40501) or a local code: "timeout", "network", "http_<n>", "bad_response". */
    readonly code: number | string,
    /** What DataForSEO reported as charged, 0 if unknown. */
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = "DataForSeoError";
  }
}

export interface DfsCallResult {
  task: DfsTask;
  costUsd: number;
}

export interface DataForSeoClient {
  readonly mode: DfsMode;
  post(endpoint: string, body: unknown[]): Promise<DfsCallResult>;
}

export function createDataForSeoClient(opts: {
  mode: DfsMode;
  login: string;
  password: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): DataForSeoClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = "Basic " + Buffer.from(`${opts.login}:${opts.password}`).toString("base64");
  const base = DFS_BASE_URL[opts.mode];

  return {
    mode: opts.mode,
    async post(endpoint, body) {
      // Endpoints come from our own static config, never from user input (no SSRF surface),
      // but assert the shape anyway so a config typo cannot turn into an arbitrary URL.
      if (!/^\/v3\/[a-z0-9_/]+$/.test(endpoint)) throw new DataForSeoError("invalid endpoint", "bad_endpoint");
      if (!opts.login || !opts.password) throw new DataForSeoError("DataForSEO credentials are not configured", "no_credentials");

      let res: Response;
      try {
        res = await fetchImpl(base + endpoint, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs),
          redirect: "error",
        });
      } catch (err) {
        const name = (err as Error).name;
        throw new DataForSeoError(
          name === "TimeoutError" || name === "AbortError" ? "DataForSEO timed out" : "DataForSEO unreachable",
          name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
        );
      }

      let json: DfsResponse;
      try {
        json = (await res.json()) as DfsResponse;
      } catch {
        throw new DataForSeoError(`DataForSEO returned non-JSON (HTTP ${res.status})`, `http_${res.status}`);
      }

      const cost = typeof json.cost === "number" ? json.cost : 0;
      if (json.status_code !== 20000) {
        throw new DataForSeoError(json.status_message ?? "DataForSEO error", json.status_code ?? `http_${res.status}`, cost);
      }
      const task = json.tasks?.[0];
      if (!task) throw new DataForSeoError("DataForSEO response has no task", "bad_response", cost);
      if (task.status_code !== 20000) {
        throw new DataForSeoError(task.status_message ?? "DataForSEO task error", task.status_code, cost);
      }
      return { task, costUsd: cost };
    },
  };
}
