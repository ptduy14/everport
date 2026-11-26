import { describe, expect, it } from 'vitest';
import { windowsAgentCommandLine } from './node-process-table.js';

const BS = String.fromCharCode(92);
const bs = (s: string) => s.replaceAll('|', BS);

describe('windowsAgentCommandLine', () => {
  it('runs the command through cmd.exe with output appended to the log', () => {
    const line = windowsAgentCommandLine(bs('C:|node|node.exe'), ['agent.js', 'run'], bs('C:|logs|agent.log'));
    expect(line).toBe(bs('/c ""C:|node|node.exe" agent.js run >> "C:|logs|agent.log" 2>&1"'));
  });

  it('quotes paths and arguments with spaces', () => {
    const line = windowsAgentCommandLine(
      bs('C:|My Tools|node.exe'),
      ['my agent.js', 'run'],
      bs('C:|My Logs|agent.log'),
    );
    expect(line).toContain(bs('"C:|My Tools|node.exe" "my agent.js" run'));
    expect(line).toContain(bs('>> "C:|My Logs|agent.log"'));
  });

  it('quotes arguments with characters cmd treats specially', () => {
    const line = windowsAgentCommandLine('node.exe', [bs('C:|Users|Tom&Jo|agent.js'), '--data-dir', 'a(1)'], 'log');
    expect(line).toContain(bs('"C:|Users|Tom&Jo|agent.js" --data-dir "a(1)"'));
  });
});
