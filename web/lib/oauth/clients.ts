import { logger } from '@/lib/logger';
import { createServiceClient } from '@/lib/supabase-utils';
import { CimdError, fetchClientMetadataDocument, isCimdClientId } from './cimd';

// Resolve a client_id to the metadata needed to authorize it.
//
// Two kinds of client_id reach this module:
//   - an opaque `wqn_client_*` id issued by /api/oauth/register
//   - an HTTPS URL, resolved by fetching its Client ID Metadata Document
//
// Stored rows win over the live document, which is the opposite of what you
// would want if every host were reachable. It is deliberate: this deployment
// cannot reach every client metadata host (a blocked egress firewall looks
// identical to a dead server), and without a way to pin a known client the
// only remedy would be to turn CIMD off entirely. Pinning is an explicit
// operator decision recorded in the database, and unknown clients still go
// through CIMD.
//
// CIMD documents are deliberately NOT cached. The document is fetched once
// per authorization and once per token exchange, which is a low request rate,
// and refetching means a client that rotates its redirect_uris takes effect
// immediately instead of leaving a stale (and possibly widened) copy behind.

export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  source: 'database' | 'cimd';
}

async function findStoredClient(
  clientId: string
): Promise<ResolvedClient | null> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error) {
    logger.error('OAuth client lookup failed', error, {
      component: 'OAuthClients',
      action: 'resolveDatabase',
    });
    return null;
  }
  if (!data) return null;

  return {
    clientId: data.client_id,
    clientName: data.client_name,
    redirectUris: data.redirect_uris,
    source: 'database',
  };
}

export async function resolveClient(
  clientId: string
): Promise<ResolvedClient | null> {
  const stored = await findStoredClient(clientId);
  if (stored) return stored;

  if (!isCimdClientId(clientId)) return null;

  try {
    const document = await fetchClientMetadataDocument(clientId);
    return { ...document, source: 'cimd' };
  } catch (error) {
    const reason = error instanceof CimdError ? error.reason : 'unknown';
    const message =
      error instanceof CimdError ? error.message : 'Unexpected CIMD failure';
    logger.warn('Client ID metadata document rejected', {
      component: 'OAuthClients',
      action: 'resolveCimd',
      clientId,
      reason,
      message,
    });
    return null;
  }
}

/**
 * Byte-exact redirect URI match against the registered list.
 *
 * No wildcards, no normalization: a prefix or substring match here is how
 * open-redirect and code-interception bugs get in.
 */
export function clientAllowsRedirectUri(
  client: ResolvedClient,
  redirectUri: string
): boolean {
  return client.redirectUris.includes(redirectUri);
}
