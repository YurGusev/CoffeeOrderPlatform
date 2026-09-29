import { QueryClient } from "@tanstack/react-query";
import { isRetryableQueryError } from "../api/client.js";

export function safeQueryRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && isRetryableQueryError(error);
}

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { networkMode: "always", retry: false },
    queries: {
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      retry: safeQueryRetry,
      retryDelay: 500,
      staleTime: 0,
    },
  },
});
