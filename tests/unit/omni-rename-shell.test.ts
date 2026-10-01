// The rename to Omni Song changes what people see and keeps what their data
// and installs depend on: the page and the installable app say Omni Song; the
// manifest keeps its install identity (start_url and scope, no explicit id)
// and file names, so an app installed as SWITCHBOARD / 01 updates in place;
// browser storage keys and the project format id stay as they were.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_NAME } from '../../src/persistence/db';
import { PROJECT_SCHEMA } from '../../src/project/types';
import { UI_STORAGE_KEY } from '../../src/state/uiStore';
import { MIX_PREFS_KEY } from '../../src/app/views/mix/mixPrefs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('Omni Song: the name people see', () => {
  it('the page is titled Omni Song, with a matching description and no-script text', () => {
    const html = read('index.html');
    expect(html).toContain('<title>Omni Song</title>');
    expect(html).toMatch(/<meta name="description" content="Omni Song — [^"]+" \/>/);
    expect(html).toContain('<meta name="application-name" content="Omni Song" />');
    expect(html).toContain('<noscript>Omni Song needs JavaScript to make sound.</noscript>');
    expect(html).not.toMatch(/switchboard/i);
  });

  it('the installable app is called Omni Song and keeps its identity, so earlier installs update in place', () => {
    const cfg = read('vite.config.ts');
    const manifest = cfg.slice(cfg.indexOf('manifest: {'), cfg.indexOf('workbox: {'));
    expect(manifest).toContain("name: 'Omni Song',");
    expect(manifest).toContain("short_name: 'Omni Song',");
    // Same identity and scope as 1.0: no explicit id (Chrome then uses start_url), same start_url and scope.
    expect(manifest).not.toMatch(/\bid:/);
    expect(manifest).toContain("start_url: './',");
    expect(manifest).toContain("scope: './',");
    // Same service worker and manifest file names (the defaults), and the same update flow (the user presses Update).
    expect(cfg).not.toMatch(/\bfilename:|manifestFilename:|strategies:/);
    expect(cfg).toContain("registerType: 'prompt'");
    expect(cfg).not.toMatch(/SWITCHBOARD|Switchboard/);
  });

  it('the package is omni-song 2.0.0', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('omni-song');
    expect(pkg.version).toBe('2.0.0');
    expect(pkg.description).toMatch(/^Omni Song/);
  });

  it('the release zip name is allowed into the repository, next to the 1.0 one', () => {
    const ignore = read('.gitignore').split(/\r?\n/);
    expect(ignore).toContain('release/*.zip');
    expect(ignore).toContain('!release/omni-song-*.zip');
    expect(ignore).toContain('!release/switchboard01-*.zip');
  });

  it('keeps the identifiers existing users’ data depends on', () => {
    expect(DB_NAME).toBe('switchboard01');
    expect(UI_STORAGE_KEY).toBe('switchboard01.ui');
    expect(MIX_PREFS_KEY).toBe('switchboard01.mix');
    expect(PROJECT_SCHEMA).toBe('switchboard01.project');
  });

  it('START HERE explains the new launcher name and that old projects and files carry over', () => {
    const text = read('launcher/START-HERE.txt');
    expect(text).toMatch(/^OMNI SONG - START HERE/);
    expect(text).toContain('"Start Omni Song.bat"');
    expect(text).toContain('COMING FROM SWITCHBOARD / 01');
    expect(text).toContain('"Start SWITCHBOARD.bat" is now called "Start Omni Song.bat"');
    expect(text).toContain('.omnisong.zip');
    expect(text).toContain('.sb01.zip');
    // Windows line endings, plain ASCII: it opens cleanly in Notepad.
    expect(text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('the Windows launcher is "Start Omni Song.bat" and its window says Omni Song', () => {
    const bat = read('launcher/Start Omni Song.bat');
    expect(bat).toContain('title Omni Song');
    expect(bat).toContain('launcher\\serve.ps1');
    expect(bat).not.toMatch(/switchboard/i);
    expect(bat.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
    const ps1 = read('launcher/serve.ps1');
    expect(ps1).toContain("Write-Host '  Omni Song' -ForegroundColor Yellow");
    // It still recognises a running copy of the older version (same address, same projects).
    expect(ps1).toContain("'<title>Omni Song</title>'");
    expect(ps1).toContain("'<title>SWITCHBOARD / 01</title>'");
  });
});
