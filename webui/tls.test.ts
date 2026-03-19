import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { loadOrGenerateTls } from './tls.js';

let tmpDir: string;
let tlsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-tls-test-'));
  tlsDir = path.join(tmpDir, 'data', 'tls');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadOrGenerateTls', () => {
  it('generates CA, server cert, and default client cert on first run', () => {
    const result = loadOrGenerateTls(tlsDir);

    expect(result.ca).toBeInstanceOf(Buffer);
    expect(result.cert).toBeInstanceOf(Buffer);
    expect(result.key).toBeInstanceOf(Buffer);

    // All files created
    expect(fs.existsSync(path.join(tlsDir, 'ca-cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(tlsDir, 'ca-key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(tlsDir, 'server-cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(tlsDir, 'server-key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(tlsDir, 'clients', 'default.p12'))).toBe(true);
  });

  it('reuses existing CA on second run', () => {
    const first = loadOrGenerateTls(tlsDir);
    const caBefore = fs.readFileSync(path.join(tlsDir, 'ca-cert.pem'), 'utf-8');

    const second = loadOrGenerateTls(tlsDir);
    const caAfter = fs.readFileSync(path.join(tlsDir, 'ca-cert.pem'), 'utf-8');

    // CA should be the same
    expect(caAfter).toBe(caBefore);
    // Both return valid buffers
    expect(first.ca.toString()).toBe(second.ca.toString());
  });

  it('sets private key permissions to 0600', () => {
    loadOrGenerateTls(tlsDir);

    const caKeyStat = fs.statSync(path.join(tlsDir, 'ca-key.pem'));
    const serverKeyStat = fs.statSync(path.join(tlsDir, 'server-key.pem'));

    expect(caKeyStat.mode & 0o777).toBe(0o600);
    expect(serverKeyStat.mode & 0o777).toBe(0o600);
  });

  it('generates valid X.509 certificates', () => {
    loadOrGenerateTls(tlsDir);

    const caPem = fs.readFileSync(path.join(tlsDir, 'ca-cert.pem'), 'utf-8');
    const serverPem = fs.readFileSync(path.join(tlsDir, 'server-cert.pem'), 'utf-8');

    const ca = new crypto.X509Certificate(caPem);
    const server = new crypto.X509Certificate(serverPem);

    expect(ca.subject).toContain('CN=nanoclaw-ca');
    expect(server.subject).toContain('CN=nanoclaw-webui');

    // Server cert should be signed by CA
    expect(server.checkIssued(ca)).toBe(true);
  });

  it('server cert SAN includes localhost and 127.0.0.1', () => {
    loadOrGenerateTls(tlsDir);

    const serverPem = fs.readFileSync(path.join(tlsDir, 'server-cert.pem'), 'utf-8');
    const server = new crypto.X509Certificate(serverPem);
    const san = server.subjectAltName ?? '';

    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP Address:127.0.0.1');
  });

  it('regenerates expired server cert', () => {
    // Generate everything first
    loadOrGenerateTls(tlsDir);
    const originalServerPem = fs.readFileSync(path.join(tlsDir, 'server-cert.pem'), 'utf-8');

    // Overwrite server cert with an already-expired one (generate with -days 0)
    const { execSync } = require('node:child_process');
    const serverKey = path.join(tlsDir, 'server-key.pem');
    const caCert = path.join(tlsDir, 'ca-cert.pem');
    const caKey = path.join(tlsDir, 'ca-key.pem');
    const csrPath = path.join(tlsDir, 'test.csr');

    execSync(`openssl req -new -key ${serverKey} -subj "/CN=expired" -out ${csrPath}`, { stdio: 'pipe' });
    execSync(
      `openssl x509 -req -in ${csrPath} -CA ${caCert} -CAkey ${caKey} -CAcreateserial ` +
        `-days 0 -sha256 -out ${path.join(tlsDir, 'server-cert.pem')}`,
      { stdio: 'pipe' },
    );
    fs.unlinkSync(csrPath);

    // Reload — should regenerate server cert
    const result = loadOrGenerateTls(tlsDir);
    const newServerPem = fs.readFileSync(path.join(tlsDir, 'server-cert.pem'), 'utf-8');

    expect(newServerPem).not.toBe(originalServerPem);
    expect(result.cert).toBeInstanceOf(Buffer);
  });
});

describe('custom certificates', () => {
  it('loads custom certs when all three paths provided', () => {
    // Generate a set of certs first as "custom"
    loadOrGenerateTls(tlsDir);

    const customCa = path.join(tlsDir, 'ca-cert.pem');
    const customCert = path.join(tlsDir, 'server-cert.pem');
    const customKey = path.join(tlsDir, 'server-key.pem');

    // Create a new tlsDir for the custom load
    const tlsDir2 = path.join(tmpDir, 'data', 'tls2');
    const result = loadOrGenerateTls(tlsDir2, customCa, customCert, customKey);

    expect(result.ca).toBeInstanceOf(Buffer);
    expect(result.cert).toBeInstanceOf(Buffer);
    expect(result.key).toBeInstanceOf(Buffer);
  });

  it('throws when only some custom paths provided', () => {
    expect(() =>
      loadOrGenerateTls(tlsDir, '/some/ca.pem', undefined, undefined),
    ).toThrow(/must all be set together/);
  });
});
