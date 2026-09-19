import { open } from 'fs/promises';

/**
 * Minimal ISO-BMFF (MP4) box reader answering two questions without spawning ffmpeg:
 *
 *  1. Is the file fragmented? A top-level `moof` means yes.
 *  2. Where does each fragment live on disk, and when does it start on the media timeline?
 *
 * The V2 player appends fragments to a SourceBuffer, so it needs byte ranges. Timing
 * travels inside each fragment (`traf/tfdt`); we read it out here only to build seek and
 * prefetch maps without parsing again later.
 */

const HEADER_SIZE = 8;
const MAX_BOXES = 100_000; // guard against corrupt files looping forever

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

/** Parse a box header at `offset`; returns null at EOF or on garbage. */
function parseHeader(raw, offset, limit) {
  if (!raw || raw.length < HEADER_SIZE) return null;

  let size = raw.readUInt32BE(0);
  const type = raw.toString('latin1', 4, 8);
  let headerSize = HEADER_SIZE;

  if (size === 1) {
    if (raw.length < 16) return null;
    const big = raw.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset; // runs to end of file
  }

  if (!/^[a-z0-9]{4}$/.test(type)) return null;
  if (size < headerSize || offset + size > limit) return null;

  return { type, offset, size, payloadOffset: offset + headerSize, end: offset + size };
}

/** Walk top-level boxes, invoking `onBox` for each. Stops on the first unparseable box. */
async function walk(handle, fileSize, onBox) {
  let offset = 0;
  let count = 0;

  while (offset + HEADER_SIZE <= fileSize && count < MAX_BOXES) {
    const raw = await readAt(handle, offset, Math.min(16, fileSize - offset));
    const box = parseHeader(raw, offset, fileSize);
    if (!box) return false;
    await onBox(box);
    count += 1;
    offset = box.end;
  }

  return true;
}

function payloadOf(handle, box) {
  return readAt(handle, box.payloadOffset, box.size - (box.payloadOffset - box.offset));
}

/** Enumerate child boxes inside a container payload. */
function children(payload, start = 0, end = payload.length) {
  const list = [];
  let offset = start;

  while (offset + HEADER_SIZE <= end) {
    const size = payload.readUInt32BE(offset);
    const type = payload.toString('latin1', offset + 4, offset + 8);
    if (!/^[a-z0-9]{4}$/.test(type)) break;
    if (size < HEADER_SIZE || offset + size > end) break;
    list.push({ type, offset, size, payloadOffset: offset + HEADER_SIZE });
    offset += size;
  }

  return list;
}

/** mvhd gives timescale and duration; version 1 uses 64-bit fields. */
function parseMvhd(payload) {
  return payload[0] === 1
    ? { timescale: payload.readUInt32BE(20), duration: Number(payload.readBigUInt64BE(24)) }
    : { timescale: payload.readUInt32BE(12), duration: payload.readUInt32BE(16) };
}

/**
 * mdhd carries the *media* timescale, which is what tfdt values are expressed in. The
 * movie-level mvhd timescale is unrelated (ffmpeg uses e.g. 5000 there), so mixing them up
 * silently scales every fragment start time.
 */
function parseMdhd(payload) {
  return payload[0] === 1
    ? { timescale: payload.readUInt32BE(20), duration: Number(payload.readBigUInt64BE(24)) }
    : { timescale: payload.readUInt32BE(12), duration: payload.readUInt32BE(16) };
}

/** hdlr handler_type at offset 8: 'soun' for the audio track we care about. */
function parseHandler(payload) {
  return payload.length >= 12 ? payload.toString('latin1', 8, 12) : null;
}

/** tfdt is the fragment's absolute decode time — what keeps seeks and appends aligned. */
function parseTfdt(payload) {
  return payload[0] === 1 ? Number(payload.readBigUInt64BE(4)) : payload.readUInt32BE(4);
}

export async function listTopBoxes(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const boxes = [];
    await walk(handle, size, (box) => boxes.push(box));
    return { boxes, fileSize: size };
  } finally {
    await handle.close();
  }
}

/**
 * @returns {{ fragmented: boolean, initEnd: number|null, fileSize: number,
 *             timescale: number|null, durationSec: number|null,
 *             fragments: Array<{ index, offset, size, start, end }> }}
 */
export async function scanMp4(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();

    let movieTimescale = null;
    let movieDurationSec = null;
    let timescale = null; // media (audio) timescale — the unit tfdt uses
    let durationSec = null;
    const moofs = [];

    await walk(handle, size, async (box) => {
      if (box.type === 'moov') {
        const payload = await payloadOf(handle, box);

        const mvhd = children(payload).find((child) => child.type === 'mvhd');
        if (mvhd) {
          const parsed = parseMvhd(payload.subarray(mvhd.payloadOffset));
          movieTimescale = parsed.timescale || null;
          movieDurationSec = parsed.duration && parsed.timescale ? parsed.duration / parsed.timescale : null;
        }

        for (const trak of children(payload).filter((child) => child.type === 'trak')) {
          const mdia = children(payload, trak.payloadOffset, trak.offset + trak.size)
            .find((child) => child.type === 'mdia');
          if (!mdia) continue;

          const members = children(payload, mdia.payloadOffset, mdia.offset + mdia.size);
          const mdhd = members.find((child) => child.type === 'mdhd');
          const hdlr = members.find((child) => child.type === 'hdlr');
          if (!mdhd) continue;

          const parsed = parseMdhd(payload.subarray(mdhd.payloadOffset));
          const handler = hdlr ? parseHandler(payload.subarray(hdlr.payloadOffset)) : null;

          if (handler === 'soun' || !timescale) {
            timescale = parsed.timescale || timescale;
            durationSec = parsed.duration && parsed.timescale ? parsed.duration / parsed.timescale : null;
          }
          if (handler === 'soun') break; // prefer the audio track over embedded artwork
        }

        if (!timescale) {
          timescale = movieTimescale;
          durationSec = movieDurationSec;
        }
      } else if (box.type === 'moof') {
        moofs.push(box);
      }
    });

    // Media start time of each fragment, read from its own tfdt box.
    const starts = [];
    for (const moof of moofs) {
      let startSec = null;
      if (timescale) {
        const payload = await payloadOf(handle, moof);
        for (const traf of children(payload).filter((child) => child.type === 'traf')) {
          const tfdt = children(payload, traf.payloadOffset, traf.offset + traf.size)
            .find((child) => child.type === 'tfdt');
          if (!tfdt) continue;
          startSec = parseTfdt(payload.subarray(tfdt.payloadOffset)) / timescale;
          break;
        }
      }
      starts.push(startSec);
    }

    // A fragment spans from its moof to the next moof (or EOF), which naturally includes
    // the mdat that follows it and any styp ahead of the next fragment.
    const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(3)) : null);

    const fragments = moofs.map((moof, i) => ({
      index: i,
      offset: moof.offset,
      size: (i + 1 < moofs.length ? moofs[i + 1].offset : size) - moof.offset,
      start: round(starts[i] ?? 0),
      end: i + 1 < moofs.length ? round(starts[i + 1]) : round(durationSec),
    }));

    return {
      fragmented: moofs.length > 0,
      // bytes [0, initEnd) are ftyp+moov — exactly the init segment a SourceBuffer needs.
      initEnd: moofs.length ? moofs[0].offset : null,
      fileSize: size,
      timescale,
      durationSec,
      movieDurationSec,
      fragments,
    };
  } finally {
    await handle.close();
  }
}

export default { scanMp4, listTopBoxes };
