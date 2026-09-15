/**
 * tracks.format stores whatever ffprobe reported as the *container* string, e.g.
 * "M4A/isom/iso2", "Mp42/mp42/isom" or "Matroska/WebM" — not a bare extension. Any lookup
 * keyed on that value silently misses, which is how m4a files ended up served as
 * audio/mpeg. Resolve to one canonical format token instead.
 */

const FORMAT_BY_TOKEN = {
  m4a: 'm4a',
  aac: 'aac',
  mp3: 'mp3',
  flac: 'flac',
  ogg: 'ogg',
  opus: 'opus',
  wav: 'wav',
  // ISO-BMFF containers carry AAC audio; the browser-facing name is m4a.
  mp4: 'm4a',
  mp42: 'm4a',
  ipod: 'm4a',
  isom: 'm4a',
  m4v: 'm4a',
};

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
};

export function formatCandidates(source) {
  const track = typeof source === 'string' || !source ? { format: source } : source;
  const candidates = String(track.format || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (track.filepath) {
    const ext = track.filepath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (ext) candidates.push(ext);
  }
  return candidates;
}

/** @returns canonical format token ('m4a', 'mp3', ...) or null when unrecognised */
export function canonicalFormat(source) {
  for (const candidate of formatCandidates(source)) {
    const format = FORMAT_BY_TOKEN[candidate];
    if (format) return format;
  }
  return null;
}

/** Content type for the audio element / SourceBuffer consumer. */
export function getMimeType(source) {
  // Unknown containers keep the historical audio/mpeg default so behaviour only changes
  // where it was demonstrably wrong.
  return MIME_BY_FORMAT[canonicalFormat(source)] || 'audio/mpeg';
}

export const SUPPORTED_FORMATS = Object.keys(MIME_BY_FORMAT);

export default { canonicalFormat, getMimeType, formatCandidates, SUPPORTED_FORMATS };
