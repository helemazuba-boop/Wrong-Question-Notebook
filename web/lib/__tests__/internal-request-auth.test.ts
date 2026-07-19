import {
  signInternalRequest,
  verifyInternalRequest,
} from '../internal-request-auth';

describe('internal realtime request authentication', () => {
  const secret = 'a'.repeat(64);
  const timestamp = '1784390400000';
  const body = '{"device_id":"device","user_id":"user"}';

  it('accepts an intact, timely request', () => {
    expect(
      verifyInternalRequest({
        secret,
        timestamp,
        signature: signInternalRequest(secret, timestamp, body),
        body,
        nowMs: Number(timestamp),
      })
    ).toBe(true);
  });

  it('rejects body tampering and expired requests', () => {
    const signature = signInternalRequest(secret, timestamp, body);
    expect(
      verifyInternalRequest({
        secret,
        timestamp,
        signature,
        body: `${body} `,
        nowMs: Number(timestamp),
      })
    ).toBe(false);
    expect(
      verifyInternalRequest({
        secret,
        timestamp,
        signature,
        body,
        nowMs: Number(timestamp) + 30_001,
      })
    ).toBe(false);
  });
});
