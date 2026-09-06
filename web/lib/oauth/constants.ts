// Values shared between discovery (/.well-known/*), the MCP endpoint's
// WWW-Authenticate challenge and the token store. Kept in one place because
// RFC 9728 requires the advertised `resource` to match the URL the client
// called, and RFC 8414 requires the metadata to match the issuer.

/** Path of the MCP endpoint that the OAuth flow protects. */
export const MCP_RESOURCE_URL = '/api/mcp';

/** RFC 9728 / RFC 8414 discovery document for the resource above. */
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource';

/**
 * The only scope this server issues. MCP tools are not separated: a token
 * grants the same access the user already has through the web UI, so the
 * consent screen states that plainly rather than itemising tools.
 */
export const OAUTH_SCOPES_SUPPORTED = ['mcp:all'];
