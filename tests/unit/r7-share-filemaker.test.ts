/**
 * Share's file choices, pure: the extension and type each kind of file is saved with, which Sound
 * the song has now, and the copy a music file is rendered from (the project itself never changes).
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/factory';
import { MASTERING_PARAMS, neutralMasteringParams, readParam } from '../../src/project/params';
import { AS_IT_IS, FILE_EXT, FILE_MIME, currentSound, safeName, shareProject, withDrive } from '../../src/app/views/share/fileMaker';
import { presetSettings } from '../../src/state/commands';

const drive = (p: { mastering: { params: Record<string, number> } }) => readParam(MASTERING_PARAMS, p.mastering.params, 'loudness');

describe('kinds of file', () => {
  it('the smaller file is Opus in Ogg, saved as .ogg (audio/ogg); the others keep their usual extensions', () => {
    expect(FILE_EXT).toEqual({ wav: 'wav', opus: 'ogg', stems: 'zip', midi: 'mid' });
    expect(FILE_MIME.opus).toBe('audio/ogg');
    expect(FILE_MIME.wav).toBe('audio/wav');
    expect(safeName('My: beat / test?')).toBe('My beat test');
  });
});

describe('the Sound a file is made with', () => {
  it('a new project sounds Clean; mastering off sounds Clean too; settings of its own are “as you hear it”', () => {
    const p = createProject({ now: 0 });
    expect(currentSound(p)).toBe('clean');
    expect(currentSound({ mastering: { ...p.mastering, enabled: false } })).toBe('clean');
    expect(currentSound({ mastering: { enabled: true, params: presetSettings('warm')!, presetId: 'warm' } })).toBe('warm');
    expect(currentSound({ mastering: { enabled: true, params: { ...presetSettings('warm')!, glue: 0.9 }, presetId: 'warm' } })).toBe(AS_IT_IS);
  });

  it('a preset or loudness renders a copy: the project and its mastering stay exactly as they were', () => {
    const p = createProject({ now: 0 });
    const frozen = JSON.stringify(p);
    // The Sound it has now, not loud: the project itself.
    expect(shareProject(p, 'clean', false)).toBe(p);
    const warm = shareProject(p, 'warm', true);
    expect(warm).not.toBe(p);
    expect(warm.mastering.presetId).toBe('warm');
    expect(warm.mastering.enabled).toBe(true);
    expect(warm.mastering.params).toEqual(presetSettings('warm'));
    const louder = withDrive(warm, 9);
    expect(drive(louder)).toBe(9);
    expect(drive(warm)).toBe(presetSettings('warm')!.loudness);
    // Mastering off and loud: a copy with neutral mastering on (sounds like no mastering), so Loudness drive can move.
    const off = { ...p, mastering: { ...p.mastering, enabled: false, params: { ...neutralMasteringParams(), glue: 0.7 } } };
    const offFrozen = JSON.stringify(off);
    const loudOff = shareProject(off, 'clean', true);
    expect(loudOff.mastering.enabled).toBe(true);
    expect(loudOff.mastering.params).toEqual(neutralMasteringParams());
    expect(shareProject(off, 'clean', false)).toBe(off);
    expect(JSON.stringify(p)).toBe(frozen);
    expect(JSON.stringify(off)).toBe(offFrozen);
  });
});
