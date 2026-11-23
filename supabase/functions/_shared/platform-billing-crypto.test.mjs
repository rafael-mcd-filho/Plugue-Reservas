// Offline compatibility coverage for the shared reservation/billing AES-GCM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OLD_CIPHERTEXT = 'v1:AQIDBAUGBwgJCgsM:aY89tI/t3ekqxA8ufnbHSTEigI26GT+uxDGcm231v2+48SfolCvmXv3W';

function cryptoApi(key = KEY) {
  const exported = {};
  const source = ts.transpileModule(readFileSync(new URL('./platform-billing.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(exports, require, Deno) { ${source}\n})`, {
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, atob, btoa, URL, console,
  })(exported, (name) => {
    assert.equal(name, './platform-billing-base-url.ts');
    return {};
  }, { env: { get: (name) => name === 'PLATFORM_BILLING_TOKEN_ENCRYPTION_KEY' ? key : undefined } });
  return exported;
}

test('shared crypto still decrypts a ciphertext generated before the BufferSource type change', async () => {
  assert.equal(await cryptoApi().decryptPlatformAsaasToken(OLD_CIPHERTEXT), 'legacy-offline-asaas-token');
});

test('AES-GCM round trip preserves a token and encrypts with a fresh random IV each time', async () => {
  const api = cryptoApi();
  const token = '$aact_offline-token_ç-unicode';
  const first = await api.encryptPlatformAsaasToken(token);
  const second = await api.encryptPlatformAsaasToken(token);
  assert.notEqual(first, second);
  assert.equal(await api.decryptPlatformAsaasToken(first), token);
  assert.equal(await api.decryptPlatformAsaasToken(second), token);
  assert.ok(!first.includes(token));
});

test('AES-GCM rejects tampered ciphertext and wrong keys', async () => {
  const api = cryptoApi();
  const cipher = await api.encryptPlatformAsaasToken('offline-token');
  const fields = cipher.split(':');
  const bytes = Buffer.from(fields[2], 'base64');
  bytes[0] ^= 1;
  await assert.rejects(api.decryptPlatformAsaasToken(`${fields[0]}:${fields[1]}:${bytes.toString('base64')}`));
  await assert.rejects(cryptoApi('another-offline-encryption-key').decryptPlatformAsaasToken(cipher));
  await assert.rejects(api.decryptPlatformAsaasToken('plaintext-token'), /não está criptografado/);
});
