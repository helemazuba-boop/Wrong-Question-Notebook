import { NextResponse } from 'next/server';
import { getAppOrigin } from '@/lib/app-origin';
import {
  MCP_RESOURCE_URL,
  OAUTH_SCOPES_SUPPORTED,
} from '@/lib/oauth/constants';

// RFC 9728 protected resource metadata for the public MCP endpoint.
//
// /api/mcp answers an unauthenticated request with
//   WWW-Authenticate: Bearer resource_metadata="<this URL>"
// and the client fetches this document to learn where to authenticate. The
// `resource` value must match the URL the client called byte for byte --
// otherwise the client is expected to reject the token audience.

export const runtime = 'nodejs';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    resource: `${getAppOrigin()}${MCP_RESOURCE_URL}`,
    authorization_servers: [getAppOrigin()],
    scopes_supported: OAUTH_SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
  });
}
