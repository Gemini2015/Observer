import { createHash, randomBytes } from 'node:crypto';

/** 生成 URL 安全的随机 token（默认 32 字节）。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 计算 SHA-256 十六进制摘要，用于 token 落库。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
