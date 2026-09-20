import Ajv2020 from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';

const problemDetails = JSON.parse(readFileSync(new URL('../contracts/schemas/common/problem-details.v1.schema.json', import.meta.url), 'utf8'));
const uriReferencePattern = new RegExp(problemDetails.$defs.ProblemDetails.properties.instance.pattern, 'u');

export function contractAjv(options = {}) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, ...options });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) => {
      try { Temporal.Instant.from(value); return true; }
      catch { return false; }
    },
  });
  ajv.addFormat('email', { type: 'string', validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) });
  ajv.addFormat('uri', { type: 'string', validate: (value) => URL.canParse(value) });
  ajv.addFormat('uri-reference', { type: 'string', validate: (value) => uriReferencePattern.test(value) });
  ajv.addFormat('binary', true);
  return ajv;
}
