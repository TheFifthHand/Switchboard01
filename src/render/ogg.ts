/**
 * Ogg Opus files (RFC 3533 pages, RFC 7845 Opus mapping), pure: no DOM, no
 * audio. The encoder (opus.ts) hands over Opus packets; this module wraps
 * them in an Ogg stream:
 *
 *   page 0  OpusHead (beginning of stream), granule 0
 *   page 1  OpusTags, granule 0
 *   page 2… audio packets, about one second per page; each page's granule
 *           position is the 48 kHz sample count (pre-skip included) at the
 *           end of its last packet; the last page is marked end of stream and
 *           its granule trims the encoder's padding, so a player plays
 *           exactly the rendered length.
 *
 * Packets are never split across pages (an Opus packet is far shorter than
 * a page can hold). Each page carries its CRC-32 (polynomial 0x04c11db7,
 * no reflection, initial value 0, computed with the CRC field zeroed).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** The Ogg page checksum of `bytes`. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

export const OGG_CONTINUED = 0x01;
export const OGG_BOS = 0x02;
export const OGG_EOS = 0x04;

/** One Ogg page holding whole packets. */
export function oggPage(opts: { packets: readonly Uint8Array[]; granule: number; serial: number; sequence: number; flags: number }): Uint8Array {
  const lacing: number[] = [];
  for (const p of opts.packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    // A packet ends with a lacing value under 255 (0 when its length is a multiple of 255).
    lacing.push(n);
  }
  if (lacing.length > 255) throw new RangeError('Too many packets for one Ogg page');
  const body = opts.packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // version
  page[5] = opts.flags;
  // Granule position: 64-bit little-endian (sample counts stay far below 2^53).
  const g = Math.max(0, Math.floor(opts.granule));
  view.setUint32(6, g % 0x100000000, true);
  view.setUint32(10, Math.floor(g / 0x100000000), true);
  view.setUint32(14, opts.serial >>> 0, true);
  view.setUint32(18, opts.sequence >>> 0, true);
  view.setUint32(22, 0, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of opts.packets) {
    page.set(p, at);
    at += p.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** The Opus identification header (RFC 7845 §5.1), channel mapping family 0 (mono or stereo). */
export function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusHead'), 0);
  b[8] = 1;
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputSampleRate, true);
  v.setInt16(16, 0, true); // output gain
  b[18] = 0; // mapping family
  return b;
}

/** The Opus comment header (RFC 7845 §5.2): vendor and "KEY=value" comments. */
export function opusTags(vendor: string, comments: readonly string[]): Uint8Array {
  const enc = new TextEncoder();
  const v = enc.encode(vendor);
  const cs = comments.map((c) => enc.encode(c));
  const b = new Uint8Array(8 + 4 + v.length + 4 + cs.reduce((s, c) => s + 4 + c.length, 0));
  const view = new DataView(b.buffer);
  b.set(enc.encode('OpusTags'), 0);
  let at = 8;
  view.setUint32(at, v.length, true);
  b.set(v, at + 4);
  at += 4 + v.length;
  view.setUint32(at, cs.length, true);
  at += 4;
  for (const c of cs) {
    view.setUint32(at, c.length, true);
    b.set(c, at + 4);
    at += 4 + c.length;
  }
  return b;
}

/** Read the pre-skip from an OpusHead (an encoder's codec description), or null when it is not one. */
export function preSkipOf(head: Uint8Array | null | undefined): number | null {
  if (!head || head.length < 19) return null;
  if (new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') return null;
  return head[10] | (head[11] << 8);
}

export interface OpusPacket {
  data: Uint8Array;
  /** Samples at 48 kHz this packet decodes to. */
  samples: number;
}

/** Serial number of the one logical stream (any fixed value: the same audio gives the same bytes). */
export const OGG_SERIAL = 0x0b5e5501;
/** Audio pages close after about this many 48 kHz samples. */
const PAGE_SAMPLES = 48000;

/**
 * An Ogg Opus file from encoded packets. `frames` is the length of the
 * source audio in 48 kHz samples: the last page's granule (pre-skip +
 * frames) tells players where the music ends inside the last packet.
 */
export function oggOpus(opts: {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  frames: number;
  packets: readonly OpusPacket[];
  vendor: string;
  comments?: readonly string[];
}): Uint8Array {
  const pages: Uint8Array[] = [];
  let seq = 0;
  const serial = OGG_SERIAL;
  pages.push(oggPage({ packets: [opusHead(opts.channels, opts.preSkip, opts.inputSampleRate)], granule: 0, serial, sequence: seq++, flags: OGG_BOS }));
  pages.push(oggPage({ packets: [opusTags(opts.vendor, opts.comments ?? [])], granule: 0, serial, sequence: seq++, flags: 0 }));
  const end = opts.preSkip + Math.max(0, Math.round(opts.frames));
  let granule = opts.preSkip;
  let batch: Uint8Array[] = [];
  let segments = 0;
  let batchSamples = 0;
  const flush = (last: boolean) => {
    pages.push(oggPage({ packets: batch, granule: last ? Math.min(granule, end) : granule, serial, sequence: seq++, flags: last ? OGG_EOS : 0 }));
    batch = [];
    segments = 0;
    batchSamples = 0;
  };
  const packets = opts.packets;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const segs = Math.floor(p.data.length / 255) + 1;
    if (batch.length && segments + segs > 255) flush(false);
    batch.push(p.data);
    segments += segs;
    granule += p.samples;
    batchSamples += p.samples;
    if (i === packets.length - 1) flush(true);
    else if (batchSamples >= PAGE_SAMPLES) flush(false);
  }
  // No audio at all: an empty last page still ends the stream.
  if (!packets.length) flush(true);
  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ParsedOggPage {
  flags: number;
  granule: number;
  serial: number;
  sequence: number;
  crc: number;
  /** The CRC matches the page. */
  crcOk: boolean;
  packets: Uint8Array[];
  /** Bytes of the last packet when it continues on the next page. */
  open: boolean;
}

/** The pages of an Ogg stream (for checks: whole pages only). */
export function parseOggPages(bytes: Uint8Array): ParsedOggPage[] {
  const out: ParsedOggPage[] = [];
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 27 <= bytes.length) {
    if (bytes[at] !== 0x4f || bytes[at + 1] !== 0x67 || bytes[at + 2] !== 0x67 || bytes[at + 3] !== 0x53) throw new Error(`No Ogg page at byte ${at}`);
    const n = bytes[at + 26];
    const lacing = bytes.subarray(at + 27, at + 27 + n);
    const size = 27 + n + lacing.reduce((s, v) => s + v, 0);
    const page = bytes.slice(at, at + size);
    const crc = view.getUint32(at + 22, true);
    page.fill(0, 22, 26);
    const packets: Uint8Array[] = [];
    let p = at + 27 + n;
    let len = 0;
    let start = p;
    for (const v of lacing) {
      len += v;
      if (v < 255) {
        packets.push(bytes.slice(start, start + len));
        start += len;
        len = 0;
      }
    }
    p = start + len;
    out.push({
      flags: bytes[at + 5],
      granule: view.getUint32(at + 6, true) + view.getUint32(at + 10, true) * 0x100000000,
      serial: view.getUint32(at + 14, true),
      sequence: view.getUint32(at + 18, true),
      crc,
      crcOk: oggCrc(page) === crc,
      packets,
      open: len > 0,
    });
    at += size;
  }
  return out;
}
