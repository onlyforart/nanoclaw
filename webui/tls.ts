import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export interface TlsConfig {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function setKeyPerms(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows doesn't support chmod
  }
}

function checkKeyPerms(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      logger.warn(
        { file: filePath, mode: '0' + mode.toString(8) },
        'Private key has overly permissive permissions (expected 0600)',
      );
    }
  } catch {
    // File doesn't exist yet
  }
}

function getCertExpiry(certPath: string): Date | null {
  try {
    const pem = fs.readFileSync(certPath, 'utf-8');
    const cert = new crypto.X509Certificate(pem);
    return new Date(cert.validTo);
  } catch {
    return null;
  }
}

function isCertExpired(certPath: string): boolean {
  const expiry = getCertExpiry(certPath);
  if (!expiry) return true;
  return expiry.getTime() < Date.now();
}

function isCertExpiringSoon(certPath: string, daysThreshold: number = 30): boolean {
  const expiry = getCertExpiry(certPath);
  if (!expiry) return true;
  const threshold = Date.now() + daysThreshold * 24 * 60 * 60 * 1000;
  return expiry.getTime() < threshold;
}

function generateCA(tlsDir: string): void {
  const caKey = path.join(tlsDir, 'ca-key.pem');
  const caCert = path.join(tlsDir, 'ca-cert.pem');

  logger.info('Generating private CA...');
  execSync(`openssl genrsa -out "${caKey}" 2048`, { stdio: 'pipe' });
  setKeyPerms(caKey);

  execSync(
    `openssl req -x509 -new -nodes -key "${caKey}" -sha256 -days 3650 -out "${caCert}" -subj "/CN=nanoclaw-ca"`,
    { stdio: 'pipe' },
  );
  logger.info('Private CA generated (10 year lifetime)');
}

function generateServerCert(tlsDir: string): void {
  const caKey = path.join(tlsDir, 'ca-key.pem');
  const caCert = path.join(tlsDir, 'ca-cert.pem');
  const serverKey = path.join(tlsDir, 'server-key.pem');
  const serverCert = path.join(tlsDir, 'server-cert.pem');
  const csrPath = path.join(tlsDir, 'server.csr');

  const hostname = os.hostname();

  // Collect all non-loopback IPv4 addresses for SAN
  const lanIps: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        lanIps.push(`IP:${addr.address}`);
      }
    }
  }

  const san = ['DNS:localhost', 'IP:127.0.0.1', `DNS:${hostname}`, ...lanIps].join(',');

  logger.info('Generating server certificate...');
  execSync(`openssl genrsa -out "${serverKey}" 2048`, { stdio: 'pipe' });
  setKeyPerms(serverKey);

  execSync(
    `openssl req -new -key "${serverKey}" -subj "/CN=nanoclaw-webui" ` +
      `-addext "subjectAltName=${san}" ` +
      `-out "${csrPath}"`,
    { stdio: 'pipe' },
  );

  execSync(
    `openssl x509 -req -in "${csrPath}" -CA "${caCert}" -CAkey "${caKey}" -CAcreateserial ` +
      `-days 365 -sha256 -copy_extensions copyall -out "${serverCert}"`,
    { stdio: 'pipe' },
  );

  try {
    fs.unlinkSync(csrPath);
  } catch {
    // ignore
  }
  logger.info({ hostname }, 'Server certificate generated (1 year)');
}

function generateDefaultClient(tlsDir: string): void {
  const caKey = path.join(tlsDir, 'ca-key.pem');
  const caCert = path.join(tlsDir, 'ca-cert.pem');
  const clientsDir = path.join(tlsDir, 'clients');
  const clientKey = path.join(clientsDir, 'default-key.pem');
  const clientCert = path.join(clientsDir, 'default-cert.pem');
  const clientP12 = path.join(clientsDir, 'default.p12');
  const csrPath = path.join(clientsDir, 'default.csr');

  ensureDir(clientsDir);

  logger.info('Generating default client certificate...');
  execSync(`openssl genrsa -out "${clientKey}" 2048`, { stdio: 'pipe' });
  setKeyPerms(clientKey);

  execSync(
    `openssl req -new -key "${clientKey}" -subj "/CN=default" -out "${csrPath}"`,
    { stdio: 'pipe' },
  );

  execSync(
    `openssl x509 -req -in "${csrPath}" -CA "${caCert}" -CAkey "${caKey}" -CAcreateserial ` +
      `-days 365 -sha256 -out "${clientCert}"`,
    { stdio: 'pipe' },
  );

  // Standard .p12 with password (for Linux/Firefox)
  // Try with -legacy first (OpenSSL 3.x), fall back without
  try {
    execSync(
      `openssl pkcs12 -export -legacy -out "${clientP12}" ` +
        `-inkey "${clientKey}" -in "${clientCert}" ` +
        `-certfile "${caCert}" -passout pass:nanoclaw`,
      { stdio: 'pipe' },
    );
  } catch {
    execSync(
      `openssl pkcs12 -export -out "${clientP12}" ` +
        `-inkey "${clientKey}" -in "${clientCert}" ` +
        `-certfile "${caCert}" -passout pass:nanoclaw`,
      { stdio: 'pipe' },
    );
  }

  // Passwordless .p12 for macOS (avoids repeated Keychain prompts)
  const clientP12NoPass = clientP12.replace('.p12', '-nopass.p12');
  try {
    execSync(
      `openssl pkcs12 -export -legacy -out "${clientP12NoPass}" ` +
        `-inkey "${clientKey}" -in "${clientCert}" ` +
        `-certfile "${caCert}" -passout pass:`,
      { stdio: 'pipe' },
    );
  } catch {
    execSync(
      `openssl pkcs12 -export -out "${clientP12NoPass}" ` +
        `-inkey "${clientKey}" -in "${clientCert}" ` +
        `-certfile "${caCert}" -passout pass:`,
      { stdio: 'pipe' },
    );
  }

  try {
    fs.unlinkSync(csrPath);
  } catch {
    // ignore
  }
  logger.info('Default client certificate generated (1 year)');
}

export function loadOrGenerateTls(
  tlsDir: string,
  customCa?: string,
  customCert?: string,
  customKey?: string,
): TlsConfig {
  // Custom certificates
  const customCount = [customCa, customCert, customKey].filter(Boolean).length;
  if (customCount > 0 && customCount < 3) {
    throw new Error('WEBUI_TLS_CA, WEBUI_TLS_CERT, and WEBUI_TLS_KEY must all be set together');
  }

  if (customCa && customCert && customKey) {
    logger.info('Using custom TLS certificates');

    if (isCertExpired(customCert)) {
      throw new Error('Custom server certificate has expired. Replace it and restart.');
    }
    if (isCertExpired(customCa)) {
      throw new Error('Custom CA certificate has expired. Replace it and restart.');
    }
    if (isCertExpiringSoon(customCert)) {
      logger.warn('Custom server certificate expires within 30 days');
    }

    return {
      ca: fs.readFileSync(customCa),
      cert: fs.readFileSync(customCert),
      key: fs.readFileSync(customKey),
    };
  }

  // Auto-generated certificates
  const caCert = path.join(tlsDir, 'ca-cert.pem');
  const caKey = path.join(tlsDir, 'ca-key.pem');
  const serverCert = path.join(tlsDir, 'server-cert.pem');
  const serverKey = path.join(tlsDir, 'server-key.pem');
  const clientP12 = path.join(tlsDir, 'clients', 'default.p12');

  ensureDir(tlsDir);

  let firstRun = false;

  // Step 1: CA
  if (!fs.existsSync(caCert) || !fs.existsSync(caKey)) {
    generateCA(tlsDir);
    firstRun = true;
  } else {
    checkKeyPerms(caKey);
    if (isCertExpired(caCert)) {
      throw new Error(
        'Auto-generated CA certificate has expired (10 year lifetime). Delete data/tls/ and restart to regenerate all certificates.',
      );
    }
  }

  // Step 2: Server cert
  if (!fs.existsSync(serverCert) || !fs.existsSync(serverKey) || isCertExpired(serverCert)) {
    if (fs.existsSync(serverCert) && isCertExpired(serverCert)) {
      logger.info('Server certificate expired, regenerating...');
    }
    generateServerCert(tlsDir);
  } else {
    checkKeyPerms(serverKey);
    if (isCertExpiringSoon(serverCert)) {
      const expiry = getCertExpiry(serverCert);
      logger.warn({ expires: expiry?.toISOString() }, 'Server certificate expires within 30 days');
    }
  }

  // Step 3: Default client cert
  if (!fs.existsSync(clientP12)) {
    generateDefaultClient(tlsDir);
    firstRun = true;
  } else {
    checkKeyPerms(path.join(tlsDir, 'clients', 'default-key.pem'));
  }

  if (firstRun) {
    const clientP12NoPass = clientP12.replace('.p12', '-nopass.p12');
    // Also generate DER format CA cert for macOS
    const caCer = caCert.replace('.pem', '.cer');
    try {
      execSync(`openssl x509 -in "${caCert}" -outform der -out "${caCer}"`, { stdio: 'pipe' });
    } catch {
      // ignore — PEM still works on Linux
    }

    logger.info('=== First-run certificate setup complete ===');
    logger.info('');
    logger.info('Browser setup (macOS):');
    logger.info(`  1. Import CA cert into login keychain: ${caCer}`);
    logger.info('     Then set to "Always Trust" in Keychain Access > Get Info > Trust');
    logger.info(`  2. Import client cert into LOGIN keychain (not System): ${clientP12NoPass}`);
    logger.info('     Leave password blank. Then set to "Always Trust".');
    logger.info('');
    logger.info('Browser setup (Linux/Firefox):');
    logger.info(`  1. Import CA cert as trusted authority: ${caCert}`);
    logger.info(`  2. Import client cert: ${clientP12} (password: nanoclaw)`);
  }

  return {
    ca: fs.readFileSync(caCert),
    cert: fs.readFileSync(serverCert),
    key: fs.readFileSync(serverKey),
  };
}
