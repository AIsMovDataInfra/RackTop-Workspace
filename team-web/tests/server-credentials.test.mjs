import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServerCredentialCipher, parseServerCredentialKey } from '../server/server-credentials.mjs';
import { readConfig } from '../server/server.mjs';

test('credential configuration requires a canonical independent 256-bit key and permits metadata-only initialization', () => {
  assert.equal(createServerCredentialCipher(undefined), null);
  assert.equal(parseServerCredentialKey(''), null);
  const key = randomBytes(32).toString('base64');
  assert.equal(readConfig({ TEAM_SERVER_CREDENTIAL_KEY: key }).serverCredentialKey, key);
  assert.equal(parseServerCredentialKey(key).length, 32);
  for (const invalid of ['not-a-key', `${key}\n`, randomBytes(31).toString('base64'), randomBytes(33).toString('base64'), key.replace(/=$/, ''), {}, 32]) {
    assert.throws(() => createServerCredentialCipher(invalid), /TEAM_SERVER_CREDENTIAL_KEY/);
  }
});

test('AES-GCM secrets use random nonces, authenticated bindings, exact 16-byte tags and fail closed for tampering or wrong keys', () => {
  const cipher = createServerCredentialCipher(randomBytes(32).toString('base64'));
  const binding = { serverId: 'synthetic-server', company: 'A公司', slot: 'target', identityHash: 'synthetic-connection-hash' };
  const password = '  合成 SSH 密码 !"$\\ spaces  ';
  const first = cipher.encrypt(password, binding), second = cipher.encrypt(password, binding);
  assert.equal(first.nonce.length, 12); assert.equal(first.auth_tag.length, 16);
  assert.notDeepEqual(first.nonce, second.nonce); assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes(Buffer.from(password)), false);
  assert.equal(cipher.decrypt(first, binding), password);
  for (const field of ['serverId', 'company', 'slot', 'identityHash']) {
    assert.throws(() => cipher.decrypt(first, { ...binding, [field]: 'different' }), { status: 503, code: 'CREDENTIALS_UNAVAILABLE' });
  }
  for (const field of ['nonce', 'ciphertext', 'auth_tag']) {
    const changed = Buffer.from(first[field]); changed[0] ^= 1;
    assert.throws(() => cipher.decrypt({ ...first, [field]: changed }, binding), { code: 'CREDENTIALS_UNAVAILABLE' });
  }
  for (const auth_tag of [first.auth_tag.subarray(0, 12), Buffer.alloc(17), 'not-bytes']) {
    assert.throws(() => cipher.decrypt({ ...first, auth_tag }, binding), { code: 'CREDENTIALS_UNAVAILABLE' });
  }
  for (const changed of [{ format_version: 2 }, { key_id: 'another-key' }, { identity_hash: 'another-identity' }, { nonce: Buffer.alloc(11) }]) {
    assert.throws(() => cipher.decrypt({ ...first, ...changed }, binding), { code: 'CREDENTIALS_UNAVAILABLE' });
  }
  const wrong = createServerCredentialCipher(randomBytes(32).toString('base64'));
  assert.throws(() => wrong.decrypt(first, binding), { code: 'CREDENTIALS_UNAVAILABLE' });
});
