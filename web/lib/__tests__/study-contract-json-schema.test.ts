import { readFileSync } from 'fs';
import { resolve } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { wordManifestSuccessSchema } from '@/lib/word-study-v1';

type JsonSchema = {
  $id: string;
  $defs: Record<string, unknown>;
};

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function contractValidator(
  contract: 'word-study-v1' | 'note-study-v1' | 'problem-study-v1'
) {
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
  it.each([
    ['localSessionRequest', 'local-session-shuffle-request.json'],
    ['eligibilityRequest', 'eligibility-request.json'],
    ['eligibilityResponse', 'eligibility-response.json'],
  ])(
    'accepts strict Word eligibility/shuffle contract %s',
    (definition, fixture) => {
      contractValidator('word-study-v1').validate(definition, fixture);
    }
  );

  it.each(['missing-revision', 'include-mastered', 'legacy-revision'])(
    'rejects invalid local shuffle semantics: %s',
    scenario => {
      const contract = contractValidator('word-study-v1');
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv);
      ajv.addSchema(contract.schema);
      const validate = ajv.getSchema(
        `${contract.schema.$id}#/$defs/localSessionRequest`
      )!;
      const payload = loadJson(
        resolve(
          contract.root,
          'fixtures/valid/local-session-shuffle-request.json'
        )
      ) as Record<string, unknown>;
      if (scenario === 'missing-revision') delete payload.progress_revision;
      if (scenario === 'include-mastered') {
        (payload.scope as Record<string, unknown>).include_mastered = true;
      }
      if (scenario === 'legacy-revision') {
        delete payload.mode;
        (payload.scope as Record<string, unknown>).include_mastered = true;
      }
      expect(validate(payload)).toBe(false);
    }
  );

  it.each([
    'candidate-page-request.json',
    'manifest-request.json',
    'observation-request.json',
    'skip-request.json',
  ])('accepts the Word wire-union request shape: %s', name => {
    const contract = contractValidator('word-study-v1');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateRoot = ajv.compile(contract.schema);
    const payload = loadJson(resolve(contract.root, 'fixtures/valid', name));
    expect(validateRoot(payload), JSON.stringify(validateRoot.errors)).toBe(
      true
    );
  });

  it('accepts the current Word manifest fixture with zlib transport coding', () => {
    contractValidator('word-study-v1').validate(
      'manifestResponse',
      'manifest-response.json'
    );
  });

  it.each(['none', 'gzip', 'deflate', null])(
    'rejects an unsupported Word manifest transport coding: %s',
    compression => {
      const contract = contractValidator('word-study-v1');
      const payload = loadJson(
        resolve(contract.root, 'fixtures/valid/manifest-response.json')
      ) as { data: { decks: Array<{ pack: { compression: unknown } }> } };
      payload.data.decks[0].pack.compression = compression;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      addFormats(ajv);
      const validateRoot = ajv.compile(contract.schema);
      expect(validateRoot(payload)).toBe(false);
      expect(wordManifestSuccessSchema.safeParse(payload).success).toBe(false);
    }
  );

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

  it('accepts long-sequence local session and observation batch wire shapes', () => {
    const contract = contractValidator('word-study-v1');
    contract.validate('localSessionRequest', 'local-session-request.json');
    contract.validate('localSessionResponse', 'local-session-response.json');
    contract.validate(
      'observationBatchRequest',
      'observation-batch-request.json'
    );
    contract.validate(
      'observationBatchResponse',
      'observation-batch-response.json'
    );
    contract.validate(
      'observationBatchResponse',
      'observation-batch-partial-response.json'
    );

    // The firmware-origin request anyOf grouping must keep the root oneOf
    // unambiguous for both new request fixtures.
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const rootValidator = ajv.compile(contract.schema);
    for (const name of [
      'local-session-request.json',
      'observation-batch-request.json',
    ]) {
      const request = loadJson(resolve(contract.root, 'fixtures/valid', name));
      expect(rootValidator(request)).toBe(true);
      expect(rootValidator.errors).toEqual(null);
    }
  });

  it('accepts the minimal note skip request', () => {
    contractValidator('note-study-v1').validate(
      'skipObservationRequest',
      'skip-request.json'
    );
  });

  it('accepts the problem pack row and meta fixtures', () => {
    const contract = contractValidator('problem-study-v1');
    contract.validate('packRow', 'pack-row.json');
    contract.validate('packMeta', 'pack-meta.json');
  });
});
