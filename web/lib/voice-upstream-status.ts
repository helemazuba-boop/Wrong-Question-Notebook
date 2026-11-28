/** Provider credentials are server configuration, never device admission. */
export function voiceUpstreamErrorStatus(status: number): number {
  return status === 401 || status === 403 || status >= 500 ? 502 : status;
}
