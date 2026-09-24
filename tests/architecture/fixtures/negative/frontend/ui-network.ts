export async function loadRemote(): Promise<unknown> {
  return fetch("/remote");
}
