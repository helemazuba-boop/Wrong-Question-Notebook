import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KnowledgeRegistryLockSchema,
  parseKnowledgeRegistryArtifactText,
  verifyKnowledgeRegistryArtifact,
} from '@/lib/problem-marks/registry-artifact';

const SOURCE_SHA = 'a'.repeat(40);

function artifactText() {
  return `${JSON.stringify(
    {
      schema_version: 1,
      subjects: [
        {
          stable_key: 'math',
          name: 'Mathematics',
          aliases: ['Math'],
          status: 'active',
        },
      ],
      marks: [
        {
          stable_key: 'math.skill.parameter_separation',
          name: 'Parameter separation',
          kind: 'skill',
          subject: 'math',
          aliases: [],
          description: 'Separate the parameter from the variable.',
          include: [],
          exclude: [],
          status: 'active',
        },
      ],
    },
    null,
    2
  )}\n`;
}

function skillRetrievalLock(sourceSha = SOURCE_SHA) {
  return {
    profile_id: 'skill-rag-qwen37-v1',
    profile_fingerprint: `sha256:${'1'.repeat(64)}`,
    provider_protocol: 'dashscope-qwen37-native-v1',
    representation_revision: `sha256:${'2'.repeat(64)}`,
    artifact_url: `https://raw.githubusercontent.com/example/registry/${sourceSha}/dist/skill-retrieval/skill-rag-qwen37-v1.json`,
    artifact_sha256: '3'.repeat(64),
    manifest_url: `https://raw.githubusercontent.com/example/registry/${sourceSha}/dist/skill-retrieval/skill-rag-qwen37-v1.manifest.json`,
    manifest_sha256: '4'.repeat(64),
  };
}

function lock(text = artifactText()) {
  return KnowledgeRegistryLockSchema.parse({
    repository: 'https://github.com/example/registry',
    source_sha: SOURCE_SHA,
    schema_version: 1,
    artifact_url: `https://raw.githubusercontent.com/example/registry/${SOURCE_SHA}/dist/registry.json`,
    content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    skill_retrieval: skillRetrievalLock(),
  });
}

describe('Knowledge Registry artifact consumer', () => {
  it('parses and verifies the exact locked bytes', () => {
    const text = artifactText();
    expect(
      parseKnowledgeRegistryArtifactText(text).artifact.marks
    ).toHaveLength(1);
    expect(
      verifyKnowledgeRegistryArtifact(lock(text), text).subjects[0].stable_key
    ).toBe('math');
  });

  it('rejects tampered bytes and URLs that do not pin the source SHA', () => {
    const text = artifactText();
    expect(() =>
      verifyKnowledgeRegistryArtifact(lock(text), `${text} `)
    ).toThrow('content hash');
    expect(() =>
      KnowledgeRegistryLockSchema.parse({
        ...lock(text),
        skill_retrieval: {
          ...skillRetrievalLock(),
          artifact_url:
            'https://raw.githubusercontent.com/example/registry/main/dist/skill-retrieval/skill-rag-qwen37-v1.json',
        },
      })
    ).toThrow('locked source SHA');
  });

  it('rejects duplicate and internally inconsistent stable identities', () => {
    const value = JSON.parse(artifactText());
    value.subjects.push(value.subjects[0]);
    value.marks[0].kind = 'knowledge';
    expect(() =>
      parseKnowledgeRegistryArtifactText(`${JSON.stringify(value)}\n`)
    ).toThrow();
  });
});
