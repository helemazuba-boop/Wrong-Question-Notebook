import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { requestMetadataSchema } from '@/lib/device-control-v3';
import {
  problemManifestRequestSchema,
  problemObservationRequestSchema,
} from '@/lib/problem-study-v1';

type Definition = 'requestMetadata' | 'manifestRequest' | 'observationRequest';
type RequestCase = {
  name: string;
  definition: Definition;
  fixture: string;
  expected: boolean;
  set?: Record<string, unknown>;
  remove?: string[];
  replace?: null;
};

const root = resolve(process.cwd(), 'contracts/problem-study-v1');
const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const schema = readJson('problem-study-v1.schema.json');
const cases = readJson('fixtures/request-validation-cases.json')
  .cases as RequestCase[];
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);
const rootValidator = ajv.getSchema(schema.$id)!;
const runtime = {
  requestMetadata: requestMetadataSchema,
  manifestRequest: problemManifestRequestSchema,
  observationRequest: problemObservationRequestSchema,
};

describe('Problem request JSON Schema and runtime validation', () => {
  it.each(cases)('$name', testCase => {
    const payload = readJson(`fixtures/valid/${testCase.fixture}`);
    for (const key of testCase.remove ?? []) delete payload[key];
    Object.assign(payload, testCase.set);
    const input = 'replace' in testCase ? testCase.replace : payload;
    const validate = ajv.getSchema(
      `${schema.$id}#/$defs/${testCase.definition}`
    )!;
    expect(validate(input), JSON.stringify(validate.errors)).toBe(
      testCase.expected
    );
    expect(runtime[testCase.definition].safeParse(input).success).toBe(
      testCase.expected
    );
    // Standalone metadata intentionally rejects business fields that belong
    // to a full request. It is not itself a member of the root wire union.
    if (testCase.definition !== 'requestMetadata') {
      expect(rootValidator(input), JSON.stringify(rootValidator.errors)).toBe(
        testCase.expected
      );
    }
  });
});
