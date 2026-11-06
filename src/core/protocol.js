'use strict';
// Constants from the LocalSend protocol specification (https://github.com/localsend/protocol).
const VERSION = '2.2';
const API = '/api/localsend/v2';
const DEFAULT_PORT = 53317;
const DEFAULT_MULTICAST = '224.0.0.167';
const DEVICE_TYPES = ['mobile', 'desktop', 'web', 'headless', 'server'];
const TEXT_PREVIEW_LIMIT = 64 * 1024; // longer text is sent as a .txt file instead of an inline message

// Unknown or missing device types fall back to "desktop", like the reference implementation.
function normalizeDeviceType(t) {
  return DEVICE_TYPES.includes(t) ? t : 'desktop';
}

// Receivers may only trust a hex digest; anything else is treated as "no checksum supplied".
function normalizeSha256(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null;
}

// Parses an ISO-8601 timestamp from file metadata, rejecting nonsense values.
function parseMetaDate(v) {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) && t > Date.UTC(1980, 0, 1) && t < Date.now() + 24 * 3600e3 ? d : null;
}

module.exports = { VERSION, API, DEFAULT_PORT, DEFAULT_MULTICAST, DEVICE_TYPES, TEXT_PREVIEW_LIMIT, normalizeDeviceType, normalizeSha256, parseMetaDate };
