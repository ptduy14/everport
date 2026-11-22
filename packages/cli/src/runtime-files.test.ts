import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeFiles } from './runtime-files.js';

const dir = join(process.cwd(), 'somewhere', 'dist');
const moduleUrl = pathToFileURL(join(dir, 'everport.js')).href;

describe('resolveRuntimeFiles', () => {
  it('finds the agent and the Worker beside the CLI file', () => {
    expect(resolveRuntimeFiles(moduleUrl, () => true)).toEqual({
      agentEntry: join(dir, 'agent.js'),
      workerFile: join(dir, 'worker.js'),
    });
  });

  it.each(['agent.js', 'worker.js'])('names %s when it is missing and says to reinstall', (missing) => {
    const exists = (path: string) => !path.endsWith(missing);
    expect(() => resolveRuntimeFiles(moduleUrl, exists)).toThrowError(
      expect.objectContaining({
        code: 'INTERNAL',
        message: expect.stringContaining(missing),
        hint: 'Reinstall everport.',
      }),
    );
  });
});
