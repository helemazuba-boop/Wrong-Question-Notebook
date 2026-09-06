import { beforeEach, describe, expect, it } from 'vitest';
import { createApiTokenUnauthorizedResponse, createApiTokenInsufficientScopeResponse } from '@/lib/api-token-auth';
import { GET as protectedResource } from '@/app/.well-known/oauth-protected-resource/route';
import { GET as authorizationServer } from '@/app/.well-known/oauth-authorization-server/route';

const ORIGIN = 'https://wqn.example.test';

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
});

describe('MCP unauthorized challenge (RFC 9728)', () => {
  it('points at the protected resource metadata document', async () => {
    const res = await createApiTokenUnauthorizedResponse();

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
    );
  });

  it('advertises the scope the MCP spec asks servers to declare', async () => {
    const res = await createApiTokenUnauthorizedResponse();

    expect(res.headers.get('www-authenticate')).toContain('scope="mcp:all"');
  });

  it('returns 403 with insufficient_scope for an under-scoped credential', async () => {
    const res = await createApiTokenInsufficientScopeResponse();

    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:all"');
  });

  it('keeps the JSON-RPC error envelope clients already parse', async () => {
    const res = await createApiTokenUnauthorizedResponse('nope');

    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'nope' },
    });
  });
});

describe('protected resource metadata', () => {
  it('advertises the MCP endpoint the client actually called', async () => {
    const body = await (await protectedResource()).json();

    expect(body.resource).toBe(`${ORIGIN}/api/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.scopes_supported).toContain('mcp:all');
  });
});

describe('authorization server metadata (RFC 8414)', () => {
  it('has an issuer with no path, query or fragment', async () => {
    const body = await (await authorizationServer()).json();

    expect(body.issuer).toBe(ORIGIN);
  });

  it('advertises absolute endpoints under the issuer', async () => {
    const body = await (await authorizationServer()).json();

    for (const key of [
      'authorization_endpoint',
      'token_endpoint',
      'registration_endpoint',
      'revocation_endpoint',
    ] as const) {
      expect(body[key], key).toMatch(new RegExp(`^${ORIGIN}/`));
    }
  });

  it('offers only PKCE public-client code flow', async () => {
    const body = await (await authorizationServer()).json();

    expect(body.response_types_supported).toEqual(['code']);
    expect(body.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('advertises CIMD, resource indicators and the iss parameter', async () => {
    const body = await (await authorizationServer()).json();

    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.resource_indicators_supported).toBe(true);
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });
});
