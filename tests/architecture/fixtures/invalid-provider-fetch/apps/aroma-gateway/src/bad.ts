export async function readThroughProvider(url: string): Promise<Response> {
  return globalThis.fetch(url);
}
