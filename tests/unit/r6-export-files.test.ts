/**
 * The file writers behind Export's formats: Ogg pages (CRC, lacing,
 * granule positions, stream flags), the Opus headers, and the parts .zip
 * (which parts get a file, each one soloed, names, one file per part).
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { createClip, createProject } from '../../src/project/factory';
import type { Project } from '../../src/project/types';
import { exportNotes, playedNotes } from '../../src/render/midi';
import { OGG_BOS, OGG_EOS, oggCrc, oggOpus, oggPage, opusHead, opusTags, parseOggPages, preSkipOf } from '../../src/render/ogg';
import { soloPart, stemFileNames, stemParts, zipFiles } from '../../src/render/stems';

describe('Ogg pages', () => {
  it('the CRC is the Ogg one (polynomial 0x04c11db7, no reflection, start 0)', () => {
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
    expect(oggCrc(new Uint8Array(0))).toBe(0);
  });

  it('a page: capture pattern, flags, granule, serial, sequence, lacing and a CRC over the page with its CRC field zeroed', () => {
    const a = new Uint8Array(300).fill(7);
    const b = new Uint8Array(255).fill(9);
    const page = oggPage({ packets: [a, b], granule: 2 ** 33 + 5, serial: 0x01020304, sequence: 3, flags: OGG_EOS });
    expect([...page.subarray(0, 4)]).toEqual([0x4f, 0x67, 0x67, 0x53]);
    expect(page[5]).toBe(OGG_EOS);
    // 300 = 255 + 45; 255 = 255 + 0 (a packet of exactly 255 bytes ends with a 0 lacing value).
    expect(page[26]).toBe(4);
    expect([...page.subarray(27, 31)]).toEqual([255, 45, 255, 0]);
    expect(page.length).toBe(27 + 4 + 555);
    const [parsed] = parseOggPages(page);
    expect(parsed.crcOk).toBe(true);
    expect(parsed.granule).toBe(2 ** 33 + 5);
    expect(parsed.serial).toBe(0x01020304);
    expect(parsed.sequence).toBe(3);
    expect(parsed.packets.map((p) => p.length)).toEqual([300, 255]);
    // One changed byte breaks the CRC.
    const bad = page.slice();
    bad[40] ^= 1;
    expect(parseOggPages(bad)[0].crcOk).toBe(false);
  });

  it('Opus headers: OpusHead (version 1, channels, pre-skip, rate) and OpusTags (vendor, comments)', () => {
    const head = opusHead(2, 312, 48000);
    expect(head.length).toBe(19);
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect([head[8], head[9]]).toEqual([1, 2]);
    expect(preSkipOf(head)).toBe(312);
    expect(new DataView(head.buffer).getUint32(12, true)).toBe(48000);
    expect(preSkipOf(new Uint8Array(19))).toBeNull();
    const tags = opusTags('Omni Song', ['TITLE=Ünïcode']);
    const v = new DataView(tags.buffer);
    expect(new TextDecoder().decode(tags.subarray(0, 8))).toBe('OpusTags');
    expect(v.getUint32(8, true)).toBe(9);
    expect(v.getUint32(21, true)).toBe(1);
    expect(new TextDecoder().decode(tags.subarray(29))).toBe('TITLE=Ünïcode');
  });

  it('a stream: head page (BOS), tags page, audio pages of about a second, the last one EOS with granule = pre-skip + length', () => {
    const packets = Array.from({ length: 130 }, (_, i) => ({ data: new Uint8Array(300 + (i % 7)).fill(i), samples: 960 }));
    const frames = 130 * 960 - 500;
    const bytes = oggOpus({ channels: 2, preSkip: 312, inputSampleRate: 48000, frames, packets, vendor: 'Omni Song' });
    const pages = parseOggPages(bytes);
    expect(pages.every((p) => p.crcOk && !p.open && p.serial === pages[0].serial)).toBe(true);
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));
    expect(pages[0].flags).toBe(OGG_BOS);
    expect(pages[0].granule).toBe(0);
    expect(pages[1].granule).toBe(0);
    const audio = pages.slice(2);
    expect(audio.flatMap((p) => p.packets).length).toBe(130);
    // 50 packets of 20 ms = 1 s per page; granules count samples up to each page's last packet.
    expect(audio.map((p) => p.packets.length)).toEqual([50, 50, 30]);
    expect(audio[0].granule).toBe(312 + 50 * 960);
    expect(audio[1].granule).toBe(312 + 100 * 960);
    expect(audio[2].granule).toBe(312 + frames);
    expect(audio.map((p) => p.flags)).toEqual([0, 0, OGG_EOS]);
  });

  it('a page never holds more than 255 lacing values', () => {
    const packets = Array.from({ length: 40 }, () => ({ data: new Uint8Array(2000), samples: 960 }));
    const pages = parseOggPages(oggOpus({ channels: 2, preSkip: 0, inputSampleRate: 48000, frames: 40 * 960, packets, vendor: 'x' }));
    for (const p of pages.slice(2)) expect(p.packets.length * 8).toBeLessThanOrEqual(255);
    expect(pages.slice(2).flatMap((p) => p.packets).length).toBe(40);
  });
});

function project(): Project {
  const p = createProject({ bpm: 120, now: 0 });
  for (const t of p.tracks) t.clips = t.clips.map(() => null);
  const clip = (i: number, notes: number) => {
    const t = p.tracks[i];
    t.clips[0] = createClip(
      t.name,
      1,
      // Drum parts play pads 0..15 (a higher note would be silent, and get no file).
      Array.from({ length: notes }, (_, k) => ({ tick: k * 96, pitch: t.instrument.kind === 'drums' ? 0 : 40, velocity: 1, duration: 48 })),
    );
    p.arrangement.regions.push({ id: `r${i}`, trackId: t.id, clipId: t.clips[0]!.id, start: 0, bars: 2, offset: 0 });
  };
  clip(0, 4);
  clip(2, 2);
  clip(4, 1);
  clip(5, 0);
  return p;
}

describe('Parts as separate files', () => {
  it('one file per heard part that plays notes, in part order; muted parts are left out', () => {
    const p = project();
    expect(stemParts(p, { kind: 'song' }).map((x) => x.trackId)).toEqual([p.tracks[0].id, p.tracks[2].id, p.tracks[4].id]);
    p.tracks[2].mute = true;
    expect(stemParts(p, { kind: 'song' }).map((x) => x.trackId)).toEqual([p.tracks[0].id, p.tracks[4].id]);
  });

  it('each part is rendered soloed: it alone is heard, the project is not changed', () => {
    const p = project();
    p.tracks[4].solo = true;
    const solo = soloPart(p, p.tracks[0].id);
    expect(solo.tracks.filter((t) => t.solo).map((t) => t.id)).toEqual([p.tracks[0].id]);
    expect(exportNotes(solo, { kind: 'song' }).map((x) => x.trackId)).toEqual([p.tracks[0].id]);
    expect(p.tracks[4].solo).toBe(true);
    expect(p.tracks[0].solo).toBe(false);
  });

  it('file names keep part order and never repeat or hold characters file systems refuse', () => {
    expect(
      stemFileNames(
        [
          { name: 'Drums', index: 0 },
          { name: 'Lead/Hook?', index: 4 },
          { name: 'lead hook', index: 5 },
          { name: 'Lead Hook', index: 6 },
        ],
        'wav',
      ),
    ).toEqual(['01 Drums.wav', '05 Lead Hook.wav', '06 lead hook.wav', '07 Lead Hook.wav']);
    expect(
      stemFileNames(
        [
          { name: 'Bass', index: 2 },
          { name: 'Bass', index: 2 },
        ],
        'wav',
      ),
    ).toEqual(['03 Bass.wav', '03 Bass (2).wav']);
  });

  it('the .zip holds exactly the files, byte for byte', () => {
    const files = [
      { name: '01 Drums.wav', data: Uint8Array.from([1, 2, 3]) },
      { name: '03 Bass.wav', data: new Uint8Array(1000).fill(5) },
    ];
    const out = unzipSync(zipFiles(files));
    expect(Object.keys(out).sort()).toEqual(['01 Drums.wav', '03 Bass.wav']);
    expect([...out['01 Drums.wav']]).toEqual([1, 2, 3]);
    expect(out['03 Bass.wav'].length).toBe(1000);
  });
});

describe('notes as the sequencer plays them', () => {
  it('a note ends where its clip starts over; a bass plays the lowest of notes starting together, until the next one', () => {
    const clip = {
      bars: 1 as const,
      notes: [
        { id: 'a', tick: 0, pitch: 48, velocity: 1, duration: 200 },
        { id: 'b', tick: 0, pitch: 43, velocity: 1, duration: 200 },
        { id: 'c', tick: 96, pitch: 45, velocity: 1, duration: 1000 },
      ],
    };
    expect(playedNotes(clip, false).map((n) => [n.tick, n.pitch, n.duration])).toEqual([
      [0, 43, 200],
      [0, 48, 200],
      [96, 45, 288],
    ]);
    expect(playedNotes(clip, true).map((n) => [n.tick, n.pitch, n.duration])).toEqual([
      [0, 43, 96],
      [96, 45, 288],
    ]);
  });
});
