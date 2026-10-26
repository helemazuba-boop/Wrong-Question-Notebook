import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const root = resolve('contracts/ai-interaction-v1');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
describe('STD interaction contract', () => {
  it('pins the schema, manifest and firmware copy to the same bytes', () => {
    const schema = read('ai-interaction-v1.schema.json');
    const digest = createHash('sha256').update(schema).digest('hex');
    expect(JSON.parse(read('manifest.json')).schema_sha256).toBe(digest);
    const firmware = resolve('../../firmware/firmware/wqn-zectrix-note4');
    if (existsSync(firmware)) {
      expect(
        readFileSync(
          resolve(
            firmware,
            'contracts/ai-interaction-v1/ai-interaction-v1.schema.json'
          ),
          'utf8'
        )
      ).toBe(schema);
      expect(
        readFileSync(resolve(firmware, 'main/ai_interaction.h'), 'utf8')
      ).toContain(digest);
    }
  });
  for (const kind of ['valid', 'invalid'])
    for (const file of readdirSync(resolve(root, 'fixtures', kind)))
      it(`${kind}/${file}`, () => {
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        addFormats(ajv);
        const validate = ajv.compile(
          JSON.parse(read('ai-interaction-v1.schema.json'))
        );
        expect(
          validate(JSON.parse(read(`fixtures/${kind}/${file}`))),
          JSON.stringify(validate.errors)
        ).toBe(kind === 'valid');
      });
});
