import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replaceAll('=', '').replaceAll(/\s+/g, '');
  let bits = '';
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error('TOTP secret is not valid base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8)
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

function generateTotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const byte = (index: number): number => {
    const result = digest.at(index);
    if (result === undefined) throw new Error('TOTP digest byte is missing');
    return result;
  };
  const offset = byte(digest.length - 1) & 0x0f;
  const value =
    (((byte(offset) & 0x7f) << 24) |
      ((byte(offset + 1) & 0xff) << 16) |
      ((byte(offset + 2) & 0xff) << 8) |
      (byte(offset + 3) & 0xff)) %
    1_000_000;
  return value.toString().padStart(6, '0');
}

export function verifyTotp(
  code: string,
  base32Secret: string,
  now = new Date(),
  allowedWindow = 1,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let secret: Buffer;
  try {
    secret = decodeBase32(base32Secret);
  } catch {
    return false;
  }
  if (secret.length < 10) return false;
  const supplied = Buffer.from(code, 'ascii');
  const counter = Math.floor(now.getTime() / 30_000);
  for (let drift = -allowedWindow; drift <= allowedWindow; drift += 1) {
    const candidate = Buffer.from(generateTotp(secret, counter + drift), 'ascii');
    if (candidate.length === supplied.length && timingSafeEqual(candidate, supplied)) return true;
  }
  return false;
}
