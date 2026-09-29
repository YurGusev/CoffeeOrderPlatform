export type CommandKind =
  | "create-customer"
  | "create-quote"
  | "create-draft"
  | "put-item"
  | "delete-item"
  | "confirm-order"
  | "request-reconciliation";

export type PendingIntent = Readonly<{
  actorRef: string;
  createdAt: string;
  fingerprint: string;
  key: string;
  kind: CommandKind;
  method: "POST" | "PUT" | "DELETE";
  path: string;
  state: "pending" | "ambiguous";
  version: 1;
}>;

export type BegunIntent = Readonly<{
  created: boolean;
  intent: PendingIntent;
}>;

const PREFIX = "coffee-platform:intent:v1:";
const RECOVERY_DISCARDED_WARNING = "coffee-platform:recovery-discarded:v1";
export const PENDING_INTENTS_CHANGED = "coffee-platform:pending-intents-changed";
const utcFormatter = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  year: "numeric",
});
const allowedKinds = new Set<CommandKind>([
  "create-customer",
  "create-quote",
  "create-draft",
  "put-item",
  "delete-item",
  "confirm-order",
  "request-reconciliation",
]);
const allowedPath = /^\/api\/client-v1\/(?:customers|pricing\/quotes|orders\/drafts|orders\/ord_[0-9A-HJKMNP-TV-Z]{26}(?:\/items\/itm_[0-9A-HJKMNP-TV-Z]{26}|\/commands\/(?:confirm|request-aroma-reconciliation))?)$/u;
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
const orderCommandPath = /^\/api\/client-v1\/orders\/(ord_[0-9A-HJKMNP-TV-Z]{26})(?:\/items\/itm_[0-9A-HJKMNP-TV-Z]{26}|\/commands\/(?:confirm|request-aroma-reconciliation))$/u;

function matchesCommand(kind: CommandKind, method: PendingIntent["method"], path: string): boolean {
  if (kind === "create-customer") return method === "POST" && path === "/api/client-v1/customers";
  if (kind === "create-quote") return method === "POST" && path === "/api/client-v1/pricing/quotes";
  if (kind === "create-draft") return method === "POST" && path === "/api/client-v1/orders/drafts";
  if (kind === "put-item") return method === "PUT" && /\/items\/itm_[0-9A-HJKMNP-TV-Z]{26}$/u.test(path);
  if (kind === "delete-item") return method === "DELETE" && /\/items\/itm_[0-9A-HJKMNP-TV-Z]{26}$/u.test(path);
  if (kind === "confirm-order") return method === "POST" && path.endsWith("/commands/confirm");
  return method === "POST" && path.endsWith("/commands/request-aroma-reconciliation");
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function isIntent(value: unknown): value is PendingIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item["version"] === 1
    && typeof item["actorRef"] === "string"
    && item["actorRef"].length > 0
    && typeof item["createdAt"] === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(item["createdAt"])
    && typeof item["fingerprint"] === "string"
    && /^[a-f0-9]{64}$/u.test(item["fingerprint"])
    && typeof item["key"] === "string"
    && uuidPattern.test(item["key"])
    && allowedKinds.has(item["kind"] as CommandKind)
    && ["POST", "PUT", "DELETE"].includes(String(item["method"]))
    && typeof item["path"] === "string"
    && allowedPath.test(item["path"])
    && matchesCommand(item["kind"] as CommandKind, item["method"] as PendingIntent["method"], item["path"])
    && ["pending", "ambiguous"].includes(String(item["state"]));
}

function intentScope(kind: CommandKind, path: string): string {
  if (["put-item", "delete-item", "confirm-order", "request-reconciliation"].includes(kind)) {
    const match = orderCommandPath.exec(path);
    if (match?.[1]) return `/api/client-v1/orders/${match[1]}`;
  }
  return path;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function browserFingerprint(body: unknown): Promise<string> {
  return sha256(JSON.stringify(canonicalValue(body ?? null)));
}

export function readPendingIntents(): Readonly<{ corrupt: boolean; items: PendingIntent[] }> {
  const target = storage();
  if (!target) return { corrupt: false, items: [] };
  const items: PendingIntent[] = [];
  let corrupt = false;
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(target.getItem(key) ?? "null");
      if (!isIntent(parsed) || key !== `${PREFIX}${parsed.key}`) {
        corrupt = true;
        continue;
      }
      items.push(parsed);
    } catch {
      corrupt = true;
    }
  }
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { corrupt, items };
}

export async function beginIntent(input: Readonly<{
  actorRef: string;
  body: unknown;
  kind: CommandKind;
  method: PendingIntent["method"];
  path: string;
}>): Promise<BegunIntent> {
  const target = storage();
  if (!target) throw new Error("Хранилище восстановления этой вкладки недоступно");
  if (!allowedKinds.has(input.kind) || !allowedPath.test(input.path) || !matchesCommand(input.kind, input.method, input.path)) {
    throw new Error("Команда не входит в allowlist восстановления");
  }
  const snapshot = readPendingIntents();
  if (snapshot.corrupt) throw new Error("Повреждённые данные восстановления требуют новой защищённой сессии");
  const fingerprint = await browserFingerprint(input.body);
  const existing = snapshot.items.find((item) => item.actorRef === input.actorRef
    && intentScope(item.kind, item.path) === intentScope(input.kind, input.path));
  if (existing) return { created: false, intent: existing };
  const intent: PendingIntent = {
    actorRef: input.actorRef,
    createdAt: `${utcFormatter.format().replace(" ", "T")}Z`,
    fingerprint,
    key: crypto.randomUUID(),
    kind: input.kind,
    method: input.method,
    path: input.path,
    state: "pending",
    version: 1,
  };
  target.setItem(`${PREFIX}${intent.key}`, JSON.stringify(intent));
  window.dispatchEvent(new Event(PENDING_INTENTS_CHANGED));
  return { created: true, intent };
}

export function markIntentAmbiguous(intent: PendingIntent): void {
  const target = storage();
  const key = `${PREFIX}${intent.key}`;
  const current = target?.getItem(key);
  if (!target || !current) return;
  try {
    const parsed: unknown = JSON.parse(current);
    if (!isIntent(parsed) || parsed.key !== intent.key || parsed.actorRef !== intent.actorRef) return;
  } catch {
    return;
  }
  target.setItem(key, JSON.stringify({ ...intent, state: "ambiguous" }));
  window.dispatchEvent(new Event(PENDING_INTENTS_CHANGED));
}

export function completeIntent(key: string): void {
  storage()?.removeItem(`${PREFIX}${key}`);
  window.dispatchEvent(new Event(PENDING_INTENTS_CHANGED));
}

export function clearPendingIntents(): void {
  const target = storage();
  if (!target) return;
  const keys: string[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const key of keys) target.removeItem(key);
  window.dispatchEvent(new Event(PENDING_INTENTS_CHANGED));
}

export function markRecoveryDiscarded(): void {
  storage()?.setItem(RECOVERY_DISCARDED_WARNING, "true");
}

export function hasRecoveryDiscardedWarning(): boolean {
  return storage()?.getItem(RECOVERY_DISCARDED_WARNING) === "true";
}

export function dismissRecoveryDiscardedWarning(): void {
  storage()?.removeItem(RECOVERY_DISCARDED_WARNING);
}
