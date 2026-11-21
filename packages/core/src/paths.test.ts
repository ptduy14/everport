import { describe, expect, it } from 'vitest';
import { createLayout, joinPath, resolveDataDir } from './paths.js';

describe('resolveDataDir', () => {
  it('uses LOCALAPPDATA on Windows', () => {
    expect(
      resolveDataDir({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
        home: 'C:\\Users\\a',
      }),
    ).toBe('C:\\Users\\a\\AppData\\Local\\everport');
  });

  it('falls back to home/AppData/Local on Windows without LOCALAPPDATA', () => {
    expect(resolveDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\a' })).toBe(
      'C:\\Users\\a\\AppData\\Local\\everport',
    );
  });

  it('uses Application Support on macOS', () => {
    expect(resolveDataDir({ platform: 'darwin', env: {}, home: '/Users/a' })).toBe(
      '/Users/a/Library/Application Support/everport',
    );
  });

  it('honours XDG_DATA_HOME on Linux, else ~/.local/share', () => {
    expect(resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/x/data' }, home: '/home/a' })).toBe(
      '/x/data/everport',
    );
    expect(resolveDataDir({ platform: 'linux', env: {}, home: '/home/a' })).toBe('/home/a/.local/share/everport');
  });

  it('EVERPORT_DATA_DIR overrides everything', () => {
    expect(resolveDataDir({ platform: 'linux', env: { EVERPORT_DATA_DIR: '/custom' }, home: '/home/a' })).toBe(
      '/custom',
    );
  });
});

describe('createLayout', () => {
  it('derives all paths from the data dir', () => {
    const l = createLayout({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\Users\\a' });
    expect(l.configFile).toBe('C:\\L\\everport\\tunnels.json');
    expect(l.lockFile).toBe('C:\\L\\everport\\everport.lock');
    expect(l.logFile).toBe('C:\\L\\everport\\logs\\everport.log');
    expect(l.agentLogFile).toBe('C:\\L\\everport\\logs\\agent.log');
    expect(l.agentOutFile).toBe('C:\\L\\everport\\logs\\agent.out.log');
    expect(l.relaySecretFile).toBe('C:\\L\\everport\\relay-secret');
    expect(l.agentStateFile).toBe('C:\\L\\everport\\agent.json');
  });

  it('accepts an explicit data dir', () => {
    const l = createLayout({ platform: 'linux', env: {}, home: '/h' }, '/data');
    expect(l.dataDir).toBe('/data');
    expect(l.configFile).toBe('/data/tunnels.json');
  });
});

describe('joinPath', () => {
  it('does not double separators', () => {
    expect(joinPath('linux', '/a/', '/b/', 'c')).toBe('/a/b/c');
  });
});
