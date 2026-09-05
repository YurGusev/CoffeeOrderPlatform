import { createHash } from 'node:crypto';
export type * from '@coffee-platform/generated-client-v1';

const ref = '[0-9A-HJKMNP-TV-Z]{26}';
const commands = [
  ['POST', /^\/api\/client-v1\/customers$/, true, false],
  ['POST', /^\/api\/client-v1\/pricing\/quotes$/, true, false],
  ['POST', /^\/api\/client-v1\/orders\/drafts$/, true, false],
  ['PUT', new RegExp(`^/api/client-v1/orders/ord_${ref}/items/itm_${ref}$`), true, false],
  ['DELETE', new RegExp(`^/api/client-v1/orders/ord_${ref}/items/itm_${ref}$`), false, true],
  ['POST', new RegExp(`^/api/client-v1/orders/ord_${ref}/commands/confirm$`), true, false],
  ['POST', new RegExp(`^/api/client-v1/orders/ord_${ref}/commands/request-aroma-reconciliation$`), true, false],
] as const;

export type ClientCommandRequestShape = Readonly<{
  method: string;
  path: string;
  replayOnly?: boolean;
  hasBody: boolean;
  ifMatchVersion?: string;
}>;

export function validateClientCommandRequest(input: ClientCommandRequestShape): 'command' | 'replay' {
  const command = commands.find(([method, path]) => method === input.method && path.test(input.path));
  if (!command) throw new Error('VALIDATION_FAILED: unsupported command method/path');
  const [, , bodyRequired, versionHeaderRequired] = command;
  if (input.replayOnly !== undefined) {
    if (input.replayOnly !== true || input.hasBody || input.ifMatchVersion !== undefined) {
      throw new Error('VALIDATION_FAILED: replay-only requires exactly true and no body/version');
    }
    return 'replay';
  }
  if (input.hasBody !== bodyRequired || (versionHeaderRequired && !/^(0|[1-9][0-9]*)$/.test(input.ifMatchVersion ?? ''))) {
    throw new Error('VALIDATION_FAILED: normal command body/version mismatch');
  }
  return 'command';
}

export function clientCommandScope(method: string, canonicalPath: string): string {
  if (!commands.some(([allowedMethod, path]) => allowedMethod === method && path.test(canonicalPath))) {
    throw new Error('VALIDATION_FAILED: non-canonical command scope');
  }
  return createHash('sha256').update(`${method}\n${canonicalPath}`, 'utf8').digest('hex');
}
