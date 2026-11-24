import type { PortCandidate, TunnelStatus } from '@everport/core';
import { describe, expect, it } from 'vitest';
import { pickerEntries, pickerPlaceholder, sharedNames, sharedPorts, suggestedLabel } from './port-items.js';

const cand = (over: Partial<PortCandidate>): PortCandidate => ({
  port: 3000,
  address: '0.0.0.0',
  pid: 1,
  group: 'workspace',
  label: 'node · fe',
  detail: '',
  http: 200,
  shared: false,
  ...over,
});

const tunnel = (label: string, target = 'http://127.0.0.1:9999') => ({ label, target }) as TunnelStatus;

const list = [
  cand({ port: 3301, project: 'api', label: 'node · api' }),
  cand({ port: 8787, group: 'docker', project: 'proxy-1', label: 'proxy-1 (proxy)' }),
  cand({ port: 3000, group: 'dev', project: 'fe', http: 0, shared: true }),
  cand({ port: 5432, group: 'other', label: 'postgres.exe', http: 0 }),
  cand({ port: 135, group: 'hidden', label: 'svchost.exe' }),
];

const shape = (e: ReturnType<typeof pickerEntries>) =>
  e.map((x) => (x.kind === 'candidate' ? x.candidate.port : x.kind === 'separator' ? `-${x.label}` : x.kind));

describe('pickerEntries', () => {
  it('shows only the manual entry while scanning', () => {
    expect(shape(pickerEntries({ candidates: null, showAll: false, typed: '' }))).toEqual(['-', 'manual']);
  });

  it('groups candidates, hides Other behind "show all" and never shows hidden ports', () => {
    expect(shape(pickerEntries({ candidates: list, showAll: false, typed: '' }))).toEqual([
      '-This workspace',
      3301,
      '-Docker',
      8787,
      '-Other dev servers',
      3000,
      '-',
      'showAll',
      '-',
      'manual',
    ]);
    expect(shape(pickerEntries({ candidates: list, showAll: true, typed: '' }))).toEqual([
      '-This workspace',
      3301,
      '-Docker',
      8787,
      '-Other dev servers',
      3000,
      '-Other listening ports',
      5432,
      '-',
      'manual',
    ]);
  });

  it('notes shared ports and ports without HTTP, with what choosing them means', () => {
    const e = pickerEntries({ candidates: list, showAll: false, typed: '' });
    const fe = e.find((x) => x.kind === 'candidate' && x.candidate.port === 3000);
    expect(fe).toMatchObject({
      detail:
        "Already shared by a tunnel · adding it again gives it a second URL · Doesn't answer HTTP · a web URL won't work for it",
      description: 'node · fe',
    });
    const named = pickerEntries({ candidates: list, showAll: false, typed: '', sharedNames: new Map([[3000, 'web']]) });
    const fe2 = named.find((x) => x.kind === 'candidate' && x.candidate.port === 3000);
    expect(fe2 && 'detail' in fe2 ? fe2.detail : '').toContain('Already shared as "web"');
    const api = e.find((x) => x.kind === 'candidate' && x.candidate.port === 3301);
    expect(api && 'detail' in api ? api.detail : undefined).toBeUndefined();
  });

  it('offers what the user typed unless it is a listed port or invalid', () => {
    const typed = (t: string) => pickerEntries({ candidates: list, showAll: false, typed: t })[0];
    expect(typed('localhost:4000')).toMatchObject({ kind: 'typed', target: 'http://localhost:4000' });
    expect(typed('9000')).toMatchObject({ kind: 'typed', target: 'http://127.0.0.1:9000' });
    expect(typed('3301')!.kind).toBe('separator');
    expect(typed('ftp://x')!.kind).toBe('separator');
  });
});

describe('pickerPlaceholder', () => {
  it('says when nothing useful was found', () => {
    expect(pickerPlaceholder(null)).toContain('Looking');
    expect(pickerPlaceholder(list)).toContain('Pick a running service');
    expect(pickerPlaceholder([list[3]!, list[4]!])).toContain('No running dev servers');
  });
});

describe('suggestedLabel', () => {
  it('uses the project, then project-port, then the port', () => {
    const api = list[0]!;
    expect(suggestedLabel(api, [])).toBe('api');
    expect(suggestedLabel(api, [tunnel('API')])).toBe('api-3301');
    expect(suggestedLabel(api, [tunnel('api'), tunnel('api-3301')])).toBe('3301');
    expect(suggestedLabel(list[3]!, [])).toBe('5432');
  });
});

describe('sharedPorts', () => {
  it('lists local tunnel ports only', () => {
    expect(
      sharedPorts([
        tunnel('a', 'http://127.0.0.1:3000'),
        tunnel('b', 'http://localhost:5173/api'),
        tunnel('c', 'http://[::1]:4000'),
        tunnel('d', 'http://192.168.1.9:8080'),
      ]),
    ).toEqual([3000, 5173, 4000]);
  });
});

describe('sharedNames', () => {
  it('names the first tunnel on each local port', () => {
    const names = sharedNames([tunnel('a', 'http://127.0.0.1:3000'), tunnel('b', 'http://localhost:3000/x')]);
    expect([...names]).toEqual([[3000, 'a']]);
  });
});
