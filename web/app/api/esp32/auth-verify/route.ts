import { NextResponse } from 'next/server';
import { authenticateEsp32Device } from '@/lib/esp32-device-auth';

export const runtime = 'nodejs';

// Thin auth verification endpoint for nginx `auth_request` subrequests.
//
// Purpose: front the WSS Flash proxy (nginx → StepFun Realtime) with the same
// device-token check the rest of `/api/esp32/*` uses, so the upstream proxy
// can short-circuit unauthenticated connections at the handshake. Without
// this, nginx unconditionally injects the StepFun key and we end up paying
// for any anonymous traffic that reaches the public hostname.
//
// nginx invokes this as a GET subrequest (Authorization header forwarded by
// the proxy_set_header directive in the auth_request block). The subrequest
// never reads the response body, so we return 204 with no payload for the
// happy path — the cheapest possible "allow". On failure we let
// `authenticateEsp32Device` return its standard 401 JSON, which nginx will
// surface as 401 to the original WebSocket handshake.
//
// `updateLastSeen` is intentionally kept on (the default): Flash session
// handshakes are real device activity and should refresh the device row's
// timestamp so the web UI reflects liveness without waiting for the next
// HTTP sync.
//
// Not wrapped in `withSecurity`: this location is `internal` in nginx (never
// reachable from the public internet), and rate-limiting auth itself would
// fight the legitimate retry pattern of Realtime reconnects. Rate-limiting
// the public `/v1/realtime` endpoint is handled at the nginx layer via
// `limit_req` on the device token.
export async function GET(req: Request) {
  // TEMP DIAGNOSTIC (remove once Flash WSS auth is confirmed working):
  // Logs the *prefix* of the Authorization header nginx forwarded for the
  // subrequest. Lets us distinguish three failure modes from docker logs:
  //   • auth="MISSING..."        → device didn't send Authorization at all,
  //                                 OR nginx didn't forward $http_authorization
  //   • auth="Bearer abc12..."   → device + nginx OK; token mismatch path
  //   • ua="ESP32 Websocket..."  → confirms the request came from the device
  //                                 fleet (not a manual curl)
  // Only the first 20 chars are logged, never the full token.
  const authHeader = req.headers.get('Authorization');
  const ua = req.headers.get('User-Agent');
  const xf = req.headers.get('X-Original-URI');
  const authPrefix = authHeader ? `${authHeader.slice(0, 20)}...` : 'MISSING';

  const auth = await authenticateEsp32Device(req);
  const resultCode = auth instanceof NextResponse ? 401 : 204;
  console.log(
    `[auth-verify] auth="${authPrefix}" ua="${ua ?? 'none'}" orig="${xf ?? 'none'}" result=${resultCode}`
  );
  if (auth instanceof NextResponse) {
    // Already a 401/500 JSON response from the auth helper. Block caching so
    // nginx never serves a stale 401 to a freshly-paired device.
    auth.headers.set('Cache-Control', 'no-store');
    return auth;
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
