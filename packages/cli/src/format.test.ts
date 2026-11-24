import type { TunnelStatus } from '@everport/core';
import { describe, expect, it } from 'vitest';
import { doctorLines, renderTable, subdomainNotice, tunnelTable, tunnelWarnings } from './format.js';

const status = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  id: 'b3f1c2',
  label: 'fe',
  name: 'fe',
  url: 'https://fe-everport.example.workers.dev',
  target: 'http://127.0.0.1:3000',
  enabled: true,
  state: 'active',
  ...over,
});

describe('renderTable', () => {
  it('pads each column to its widest cell and trims the end of every line', () => {
    expect(renderTable(['A', 'BB'], [['long cell', 'x']])).toBe(
      ['A          BB', '---------  --', 'long cell  x'].join('\n'),
    );
  });
});

describe('tunnelTable', () => {
  it('shows the columns and a readable state for every state', () => {
    const states: [TunnelStatus['state'], string][] = [
      ['active', 'online'],
      ['stopped', 'stopped'],
      ['down', 'offline'],
      ['missing', 'missing'],
      ['failed', 'error'],
    ];
    for (const [state, text] of states) expect(tunnelTable([status({ state })])).toContain(text);
    expect(tunnelTable([status()]).split('\n')[0]).toMatch(/^ID\s+LABEL\s+URL\s+TARGET\s+STATE$/);
  });

  it('adds a HEALTH column only when some tunnel has health', () => {
    expect(tunnelTable([status()])).not.toContain('HEALTH');
    expect(tunnelTable([status({ health: 'ok' })])).toContain('HEALTH');
  });

  it('shows a plain local target short, like the VS Code view', () => {
    expect(tunnelTable([status()])).toContain('localhost:3000');
    expect(tunnelTable([status()])).not.toContain('http://127.0.0.1:3000');
  });

  it('colours only the state, after padding, so columns stay aligned', () => {
    const red = (text: string) => `<${text}>`;
    const lines = tunnelTable([status(), status({ id: 'x', label: 'be', state: 'failed' })], red).split('\n');
    expect(lines[2]).toContain('<online');
    expect(lines[3]).toContain('<error ');
    expect(tunnelTable([status()])).not.toContain('<');
  });

  it('points at "everport add" when there is nothing', () => {
    expect(tunnelTable([])).toContain('everport add');
  });
});

describe('tunnelWarnings', () => {
  it('says nothing for a healthy tunnel', () => {
    expect(tunnelWarnings([status({ health: 'ok', outdated: false })])).toEqual([]);
  });

  it('explains a failed tunnel with its message and fix', () => {
    const warnings = tunnelWarnings([
      status({ state: 'failed', error: { code: 'X', message: 'broke', hint: 'fix it' } }),
    ]);
    expect(warnings).toEqual(['! fe: broke', '  Fix: fix it']);
  });

  it('does not repeat itself for a failed tunnel whose health also looks bad', () => {
    const warnings = tunnelWarnings([
      status({ state: 'failed', health: 'mismatch', error: { code: 'X', message: 'broke', hint: '' } }),
    ]);
    expect(warnings).toEqual(['! fe: broke']);
  });

  it('says a preview is gone and what to run', () => {
    const warnings = tunnelWarnings([status({ state: 'missing', health: 'not-found' })]);
    expect(warnings.join(' ')).toContain('gone from Cloudflare');
    expect(warnings.join(' ')).toContain('everport up');
  });

  it('says an address cannot be reached, and notes old relay code as information', () => {
    expect(tunnelWarnings([status({ health: 'unreachable' })])[0]).toContain('cannot reach');
    const old = tunnelWarnings([status({ health: 'ok', outdated: true })]);
    expect(old).toHaveLength(1);
    expect(old[0]!.startsWith('i ')).toBe(true);
  });
});

describe('doctorLines', () => {
  it('marks each check OK or FAIL and puts the hint under a failure only', () => {
    expect(
      doctorLines([
        { name: 'a', ok: true, detail: 'fine', hint: 'ignored' },
        { name: 'b', ok: false, detail: 'broken', hint: 'do this' },
      ]),
    ).toEqual(['OK    a: fine', 'FAIL  b: broken', '      Fix: do this']);
  });
});

describe('subdomainNotice', () => {
  it('names the subdomain taken from the address and says it is public', () => {
    const text = subdomainNotice('https://fe-everport.example.workers.dev');
    expect(text).toContain('"example"');
    expect(text).toContain('public');
    expect(text).toContain('email');
  });
});
