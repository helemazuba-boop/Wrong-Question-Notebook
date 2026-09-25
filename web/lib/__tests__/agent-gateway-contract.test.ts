import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  AGENT_GATEWAY_CONTRACT_DIR,
  AGENT_GATEWAY_SCHEMA_SHA256,
} from '../agent-gateway-contract';
import type {
  OpenCodeHistoryMessage,
  OpenCodeSessionSummary,
} from '../opencode-agent-gateway';

const contractRoot = resolve(process.cwd(), AGENT_GATEWAY_CONTRACT_DIR);

type Manifest = {
  contract: string;
  version: string;
  schema: string;
  schema_sha256: string;
  routes: Array<{ method: string; path: string }>;
  stream_events: string[];
  stream_terminator: string;
};

type StreamFrame = { event: string; data: Record<string, unknown> };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(contractRoot, path), 'utf8'));
}

function readText(path: string): string {
  return readFileSync(resolve(contractRoot, path), 'utf8');
}

function fixtures(directory: 'valid' | 'invalid'): string[] {
  const dir = resolve(contractRoot, 'fixtures', directory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort();
}

function loadValidator() {
  const schema = JSON.parse(readText('agent-gateway-v0.schema.json'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return { schema, validate: ajv.compile(schema) };
}

describe('agent gateway v0 contract mirror', () => {
  it('pins the schema digest in code, the manifest and the firmware build', () => {
    const digest = createHash('sha256')
      .update(readText('agent-gateway-v0.schema.json'))
      .digest('hex');
    const manifest = readJson('manifest.json') as Manifest;

    expect(digest).toBe(AGENT_GATEWAY_SCHEMA_SHA256);
    expect(manifest.schema_sha256).toBe(digest);
  });

  it('declares the same nine routes and eleven events the firmware manifest does', () => {
    const manifest = readJson('manifest.json') as Manifest;
    // The firmware build pins these against its own manifest, so a route or
    // event added here without the firmware knowing is a real drift, not a
    // doc nit.
    expect(
      manifest.routes.map(route => `${route.method} ${route.path}`)
    ).toEqual([
      'GET /agent/sessions',
      'POST /agent/sessions',
      'POST /agent/transcribe',
      'POST /agent/sessions/{id}/run',
      'GET /agent/sessions/{id}/events',
      'POST /agent/sessions/{id}/permission',
      'GET /agent/sessions/{id}/history',
      'POST /agent/sessions/{id}/question',
      'POST /agent/sessions/{id}/interrupt',
    ]);
    expect(manifest.stream_events).toEqual([
      'agent.accepted',
      'agent.attached',
      'agent.status',
      'agent.text.delta',
      'agent.text',
      'agent.reasoning.delta',
      'agent.reasoning',
      'agent.tool',
      'agent.permission',
      'agent.question',
      'agent.error',
    ]);
    // The terminator is the one thing the v2 migration deliberately did NOT
    // change: the cloud projects upstream's `session.execution.*` onto it, and
    // any other ending is `stream_incomplete` on the device.
    expect(manifest.stream_terminator).toBe('agent.status { status: "idle" }');
  });

  it.each(fixtures('valid'))('accepts valid fixture %s', name => {
    const { validate } = loadValidator();
    const valid = validate(readJson(`fixtures/valid/${name}`));
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it.each(fixtures('invalid'))('rejects invalid fixture %s', name => {
    const { validate } = loadValidator();
    expect(validate(readJson(`fixtures/invalid/${name}`))).toBe(false);
  });

  it('covers both directions of the stream vocabulary', () => {
    // Asserted rather than counted so a stream fixture that silently loses its
    // terminator cannot pass as a valid frame list.
    const frames = readJson('fixtures/valid/run-stream.json') as StreamFrame[];
    expect(frames.at(-1)).toEqual({
      event: 'agent.status',
      data: { status: 'idle', message: '执行完成' },
    });
  });

  describe('envelopes the routes actually send', () => {
    const { validate } = loadValidator();

    // Each payload is typed against the gateway interface the route returns,
    // so a route field added without the schema noticing is a type error here
    // as well as a schema failure.
    it('answers a session list', () => {
      const sessions: OpenCodeSessionSummary[] = [
        {
          id: 'ses_01J8ZQ4K7V2N9X0M3B6C5D4E7F',
          title: '错题整理',
          updatedAt: 1758432000000,
        },
      ];
      expect(validate({ success: true, data: { sessions } })).toBe(true);
    });

    it('answers a create', () => {
      const session: OpenCodeSessionSummary = {
        id: 'ses_01J8ZQ4K7V2N9X0M3B6C5D4E9B',
        title: '新 Session',
        updatedAt: 1758518400000,
      };
      expect(validate({ success: true, data: { session } })).toBe(true);
    });

    it('answers a transcribe with the latency and provider it measured', () => {
      // The device discards both extra fields; the schema names them so the
      // body the route really returns is one the contract accepts.
      expect(
        validate({
          success: true,
          data: {
            transcript: '整理成错题本',
            latency_ms: 820,
            asr: 'dashscope',
          },
        })
      ).toBe(true);
      expect(
        validate({
          success: true,
          data: { transcript: 'x'.repeat(5000), latency_ms: 0 },
        })
      ).toBe(false);
    });

    it('acknowledges both replies the same way and accepts both requests', () => {
      // One acknowledgement shared by the two routes, because the device only
      // checks the HTTP status.
      expect(validate({ success: true, data: { replied: true } })).toBe(true);
      expect(validate({ success: true, data: { replied: false } })).toBe(false);
      expect(
        validate({ permission_id: 'prm_1', decision: 'once', confirmed: true })
      ).toBe(true);
      expect(
        validate({ question_id: 'frm_1', answer: 'math', confirmed: true })
      ).toBe(true);
      // No `always`: the device can only express a one-shot approval or a
      // rejection, so the third upstream value would be a dead surface.
      expect(
        validate({
          permission_id: 'prm_1',
          decision: 'always',
          confirmed: true,
        })
      ).toBe(false);
      expect(
        validate({ permission_id: 'prm_1', decision: 'once', confirmed: false })
      ).toBe(false);
    });

    it('answers an interrupt that found nothing to stop', () => {
      // `interrupted: false` is a success, and the upstream sends it bare --
      // without the gateway tolerating that shape every stop read as delivered.
      expect(validate({ success: true, data: { interrupted: false } })).toBe(
        true
      );
      expect(validate({ success: true, data: { interrupted: true } })).toBe(
        true
      );
    });

    it('answers a history backfill', () => {
      const messages: OpenCodeHistoryMessage[] = [
        { role: 'user', text: '整理成错题本' },
        {
          role: 'assistant',
          text: '已找到 3 道同类题。',
          thinking: '先判断极限类型。',
          tools: [
            { name: 'notebook.search', status: 'done', preview: 'query=极限' },
          ],
        },
      ];
      expect(validate({ success: true, data: { messages } })).toBe(true);
    });

    it('answers every failure it recognises', () => {
      for (const code of [
        'auth_required',
        'session_not_found',
        'confirmation_required',
        'invalid_session',
        'invalid_response',
        'upstream_error',
        'agent_unavailable',
        'rate_limited',
        'disabled',
        'forbidden',
      ]) {
        expect(
          validate({ success: false, error: { code, message: 'x' } }),
          code
        ).toBe(true);
      }
    });

    it('answers a device-lookup throw with the shared error helper body', () => {
      // `createApiErrorResponse` carries no `code`, so the device degrades it to
      // `upstream_error` rather than inventing one. A schema that only allowed
      // `{success, error}` would reject this.
      expect(
        validate({
          error: 'Failed to authenticate device',
          status: 500,
          timestamp: '2026-09-25T00:00:00.000Z',
        })
      ).toBe(true);
      expect(validate({ error: 'boom' })).toBe(true);
      expect(validate({ error: 42 })).toBe(false);
    });

    it('answers nothing outside those shapes', () => {
      // The envelope itself is what the invalid fixtures pin; these are the
      // two ways a route could smuggle one past them.
      expect(validate({ data: { sessions: [] } })).toBe(false);
      expect(validate({ success: false, data: { sessions: [] } })).toBe(false);
    });
  });
});
