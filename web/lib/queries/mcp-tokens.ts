import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiDelete, apiGet, apiPost } from '@/lib/api-client';

export type McpToken = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

export type McpTokensSnapshot = {
  tokens: McpToken[];
  /** Server-enforced cap on concurrently active (non-revoked) tokens. */
  maxActiveTokens: number;
};

export type CreatedMcpToken = {
  token: McpToken;
  /** Shown once at creation; never persisted server-side. */
  plaintext: string;
};

const mcpTokensKey = ['mcp-tokens'] as const;

export function useMcpTokens() {
  return useQuery({
    queryKey: mcpTokensKey,
    queryFn: () => apiGet<McpTokensSnapshot>('/api/mcp-tokens'),
  });
}

export function useCreateMcpToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiPost<CreatedMcpToken>('/api/mcp-tokens', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpTokensKey }),
  });
}

export function useRevokeMcpToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ revoked: true }>(`/api/mcp-tokens/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpTokensKey }),
  });
}
