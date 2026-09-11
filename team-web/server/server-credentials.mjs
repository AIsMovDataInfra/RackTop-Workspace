import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ApiError } from './store.mjs';

export function credentialsUnavailable() {
  return new ApiError(503, 'CREDENTIALS_UNAVAILABLE', '共享密码暂不可用，请联系管理员检查服务配置');
}

export function parseServerCredentialKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('TEAM_SERVER_CREDENTIAL_KEY 必须是 32 字节随机密钥的标准 base64 编码');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('TEAM_SERVER_CREDENTIAL_KEY 格式无效');
  return key;
}

// The key lives outside releases and SQLite. Every encrypted slot is bound to
// its server, organization and connection identity; copying a row cannot rebind it.
export function createServerCredentialCipher(value) {
  const key = parseServerCredentialKey(value);
  if (!key) return null;
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const aad = ({ serverId, company, slot, identityHash }) => Buffer.from(JSON.stringify([
    'racktop-server-password', 1, serverId, company, slot, identityHash,
  ]));
  return {
    keyId,
    encrypt(password, binding) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(binding));
      const plaintext = Buffer.from(password, 'utf8');
      try {
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { format_version: 1, key_id: keyId, identity_hash: binding.identityHash,
          nonce, ciphertext, auth_tag: cipher.getAuthTag() };
      } finally { plaintext.fill(0); }
    },
    decrypt(row, binding) {
      let plaintext;
      try {
        if (row.format_version !== 1 || row.key_id !== keyId || row.identity_hash !== binding.identityHash
          || !(row.nonce instanceof Uint8Array) || row.nonce.length !== 12
          || !(row.auth_tag instanceof Uint8Array) || row.auth_tag.length !== 16
          || !(row.ciphertext instanceof Uint8Array) || row.ciphertext.length < 1 || row.ciphertext.length > 4096) throw credentialsUnavailable();
        const cipher = createDecipheriv('aes-256-gcm', key, row.nonce, { authTagLength: 16 });
        cipher.setAAD(aad(binding)); cipher.setAuthTag(row.auth_tag);
        plaintext = Buffer.concat([cipher.update(row.ciphertext), cipher.final()]);
        return plaintext.toString('utf8');
      } catch { throw credentialsUnavailable(); }
      finally { plaintext?.fill(0); }
    },
  };
}
