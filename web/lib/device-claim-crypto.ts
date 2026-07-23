import { createHash, randomBytes, webcrypto } from 'crypto';
import type { SealedCredential } from './device-control-v3';

const CLAIM_INFO_PREFIX = 'wqn-device-claim-v3:';

function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, 'base64url');
  return new Uint8Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer
  );
}

export function hashClaimDisplayCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function isValidP256PublicKey(value: string): boolean {
  try {
    const raw = fromBase64Url(value);
    return raw.byteLength === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

export async function sealDeviceCredential(input: {
  claimId: string;
  devicePublicKey: string;
  deviceId: string;
  accessToken: string;
}): Promise<SealedCredential> {
  const subtle = webcrypto.subtle;
  const rawDevicePublicKey = fromBase64Url(input.devicePublicKey);
  if (rawDevicePublicKey.byteLength !== 65 || rawDevicePublicKey[0] !== 0x04) {
    throw new TypeError('INVALID_DEVICE_PUBLIC_KEY');
  }

  const devicePublicKey = await subtle.importKey(
    'raw',
    rawDevicePublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const serverKeyPair = (await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;
  const sharedSecret = await subtle.deriveBits(
    { name: 'ECDH', public: devicePublicKey },
    serverKeyPair.privateKey,
    256
  );
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  const salt = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(12));
  const info = new TextEncoder().encode(`${CLAIM_INFO_PREFIX}${input.claimId}`);
  const aesKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      protocol: 3,
      device_id: input.deviceId,
      access_token: input.accessToken,
    })
  );
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    plaintext
  );
  const serverPublicKey = await subtle.exportKey(
    'raw',
    serverKeyPair.publicKey
  );

  return {
    server_public_key: toBase64Url(serverPublicKey),
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

export async function decryptDeviceCredentialForTest(input: {
  claimId: string;
  devicePrivateKey: CryptoKey;
  sealed: SealedCredential;
}): Promise<unknown> {
  const subtle = webcrypto.subtle;
  const serverPublicKey = await subtle.importKey(
    'raw',
    fromBase64Url(input.sealed.server_public_key),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = await subtle.deriveBits(
    { name: 'ECDH', public: serverPublicKey },
    input.devicePrivateKey,
    256
  );
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: fromBase64Url(input.sealed.salt),
      info: new TextEncoder().encode(`${CLAIM_INFO_PREFIX}${input.claimId}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(input.sealed.iv) },
    aesKey,
    fromBase64Url(input.sealed.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function generateP256DeviceKeyForTest(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
}> {
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;
  const rawPublicKey = await webcrypto.subtle.exportKey(
    'raw',
    keyPair.publicKey
  );
  return {
    publicKey: toBase64Url(rawPublicKey),
    privateKey: keyPair.privateKey,
  };
}
