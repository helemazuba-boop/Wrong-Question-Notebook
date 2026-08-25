import { readFileSync } from 'fs';
import { resolve } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

type JsonSchema = {
  $id: string;
  $defs: Record<string, unknown>;
};

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function contractValidator(contract: 'word-study-v1' | 'note-study-v1') {
  const root = resolve(process.cwd(), `contracts/${contract}`);
  const schema = loadJson(
    resolve(root, `${contract}.schema.json`)
  ) as JsonSchema;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  return {
    root,
    schema,
    validate(definition: string, fixtureName: string) {
      const validator = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
      expect(validator, `missing $defs/${definition}`).toBeDefined();
      const fixture = loadJson(resolve(root, 'fixtures/valid', fixtureName));
      const valid = validator!(fixture);
      expect(validator!.errors).toEqual(null);
      expect(valid).toBe(true);
    },
  };
}

describe('study JSON Schema contracts', () => {
  it('accepts the minimal word skip request and shared response envelope', () => {
    const contract = contractValidator('word-study-v1');
    contract.validate('skipObservationRequest', 'skip-request.json');
    contract.validate('skipObservationResponse', 'skip-response.json');
    contract.validate('observationResponse', 'observation-response.json');

    // The root is a union of wire shapes. A response shared by submit and
    // skip must appear only once in that union or `oneOf` becomes ambiguous.
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const rootValidator = ajv.compile(contract.schema);
    const response = loadJson(
      resolve(contract.root, 'fixtures/valid/skip-response.json')
    );
    expect(rootValidator(response)).toBe(true);
    expect(rootValidator.errors).toEqual(null);
  });

  it('accepts the minimal note skip request', () => {
    contractValidator('note-study-v1').validate(
      'skipObservationRequest',
      'skip-request.json'
    );
  });
});
