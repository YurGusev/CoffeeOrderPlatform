import type {HttpClient} from "@coffee-platform/platform-http";

/** Probe the already configured scoped mTLS client under the runtime readiness deadline. */
export async function checkInternalApiReady(client: Pick<HttpClient, "fetch"> | undefined, signal: AbortSignal): Promise<boolean> {
  if (client === undefined || signal.aborted) return false;
  const response = await client.fetch("/health/ready", {method: "GET", signal, redirect: "error"});
  void response.body?.cancel().catch(() => undefined);
  return response.status === 200;
}
