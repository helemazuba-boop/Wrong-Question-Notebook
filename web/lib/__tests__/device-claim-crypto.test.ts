import {
  decryptDeviceCredentialForTest,
  generateP256DeviceKeyForTest,
  isValidP256PublicKey,
  sealDeviceCredential,
} from '../device-claim-crypto';

describe('device claim credential sealing', () => {
  it('round-trips a token with P-256 ECDH, HKDF and AES-GCM', async () => {
    const device = await generateP256DeviceKeyForTest();
    const claimId = '11111111-1111-4111-8111-111111111111';
    const sealed = await sealDeviceCredential({
      claimId,
      devicePublicKey: device.publicKey,
      deviceId: '22222222-2222-4222-8222-222222222222',
      accessToken:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });

    expect(isValidP256PublicKey(device.publicKey)).toBe(true);
    expect(
      await decryptDeviceCredentialForTest({
        claimId,
        devicePrivateKey: device.privateKey,
        sealed,
      })
    ).toEqual({
      protocol: 3,
      device_id: '22222222-2222-4222-8222-222222222222',
      access_token:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
  });

  it('rejects a non-SEC1 key', () => {
    expect(isValidP256PublicKey('A'.repeat(87))).toBe(false);
  });
});
