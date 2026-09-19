import { describe, it, expect } from 'vitest';
import { canonicalFormat, getMimeType, SUPPORTED_FORMATS } from '../src/utils/audioFormat.js';

describe('canonicalFormat', () => {
  it('resolves real ffprobe container strings', () => {
    const cases = [
      ['M4A/isom/iso2', 'm4a'],
      ['Mp42/mp42/isom', 'm4a'],
      ['ipod/mp42/iso2', 'm4a'],
      ['MP3', 'mp3'],
      // ffprobe is unhelpful for mp3, so the extension has to decide
      [{ format: 'MP2/3 (MPEG audio layer 3)', filepath: 'x.mp3' }, 'mp3'],
      ['FLAC', 'flac'],
      ['Ogg', 'ogg'],
      ['Matroska/WebM', null], // webm is not in the supported list; extension decides
      ['WAV / WAVE (Waveform Audio)', 'wav'],
      [{ format: 'Matroska/WebM', filepath: 'y.webm' }, null],
    ];

    for (const [source, expected] of cases) {
      const label = typeof source === 'string' ? source : `${source.format} + ${source.filepath}`;
      expect(canonicalFormat(source), `container "${label}"`).toBe(expected);
    }
  });

  it('falls back to the file extension when the container string is useless', () => {
    expect(canonicalFormat({ format: 'Matroska/WebM', filepath: 'a/b/song.opus' })).toBe('opus');
    expect(canonicalFormat({ format: '', filepath: 'song.MP3' })).toBe('mp3');
    expect(canonicalFormat({ format: null, filepath: '/x/y/z.m4a' })).toBe('m4a');
  });

  it('accepts a bare string as well as a track object', () => {
    expect(canonicalFormat('.FLAC')).toBe('flac');
    expect(canonicalFormat('aac')).toBe('aac');
    expect(canonicalFormat(undefined)).toBe(null);
  });

  it('returns null for genuinely unknown formats', () => {
    expect(canonicalFormat({ format: 'somethingelse', filepath: 'x.unknown' })).toBe(null);
  });
});

describe('getMimeType', () => {
  it('labels m4a as audio/mp4 (regression: was served as audio/mpeg)', () => {
    // This is the exact value stored in tracks.format for every yt-dlp download.
    expect(getMimeType({ format: 'M4A/isom/iso2', filepath: 'yt-abc.m4a' })).toBe('audio/mp4');
  });

  it('covers every supported format', () => {
    const expected = {
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      opus: 'audio/opus',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      wav: 'audio/wav',
    };

    for (const format of SUPPORTED_FORMATS) {
      expect(getMimeType({ format, filepath: `t.${format}` })).toBe(expected[format]);
    }
  });

  it('keeps the historical audio/mpeg default for unknown containers', () => {
    expect(getMimeType({ format: 'mystery', filepath: 'track.mystery' })).toBe('audio/mpeg');
  });
});
