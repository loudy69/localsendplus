'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Self-signed certificate persisted on disk. Like LocalSend, the device
// fingerprint is the SHA-256 of the certificate so it stays stable across runs.
function loadIdentity(dir, key = '') {
  const suffix = String(key || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 40);
  const file = path.join(dir, suffix ? `identity-${suffix}.json` : 'identity.json');
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (id.cert && id.key) return withFingerprint(id);
  } catch {
    /* generate below */
  }
  const selfsigned = require('selfsigned');
  const kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pems = selfsigned.generate([{ name: 'commonName', value: 'LocalSendPlus' }], {
    days: 3650,
    algorithm: 'sha256',
    keyPair: { publicKey: kp.publicKey, privateKey: kp.privateKey },
  });
  const id = { cert: pems.cert, key: kp.privateKey };
  fs.writeFileSync(file, JSON.stringify(id));
  return withFingerprint(id);
}

function withFingerprint(id) {
  const x509 = new crypto.X509Certificate(id.cert);
  return { ...id, fingerprint: x509.fingerprint256.replace(/:/g, '').toLowerCase() };
}

module.exports = { loadIdentity };
