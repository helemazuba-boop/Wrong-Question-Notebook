'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

// Study data changes on the server (device sync, review scheduling, other
// sessions), so default to slightly stale data with a background refetch
// instead of treating every mount as fresh. Window refocus refetching is
// off: a focused study session should never trigger surprise rewrites of
// the visible list.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === 'undefined') {
    // Server render: a fresh client per request avoids sharing cache
    // between users during SSR.
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}

const QueryDevtools = dynamicDevtools();

/**
 * Dev-only React Query Devtools, lazily loaded so the production bundle
 * never downloads it.
 */
function dynamicDevtools() {
  if (process.env.NODE_ENV === 'production') {
    return () => null;
  }
  return React.lazy(async () => {
    const m = await import('@tanstack/react-query-devtools');
    return { default: m.ReactQueryDevtools };
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(getQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <React.Suspense fallback={null}>
        <QueryDevtools initialIsOpen={false} />
      </React.Suspense>
    </QueryClientProvider>
  );
}
