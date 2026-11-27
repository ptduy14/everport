export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** Minimal join that follows the target platform, so paths can be computed (and tested) for any OS. */
export function joinPath(platform: NodeJS.Platform, ...parts: string[]): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts
    .map((p, i) => {
      const trimmed = p.replace(/[\\/]+$/, '');
      return i === 0 ? trimmed : trimmed.replace(/^[\\/]+/, '');
    })
    .filter((p, i) => i === 0 || p !== '')
    .join(sep);
}

export function resolveDataDir({ platform, env, home }: PathEnv): string {
  const override = env['EVERPORT_DATA_DIR'];
  if (override) return override;
  if (platform === 'win32') {
    return joinPath(platform, env['LOCALAPPDATA'] || joinPath(platform, home, 'AppData', 'Local'), 'everport');
  }
  if (platform === 'darwin') {
    return joinPath(platform, home, 'Library', 'Application Support', 'everport');
  }
  return joinPath(platform, env['XDG_DATA_HOME'] || joinPath(platform, home, '.local', 'share'), 'everport');
}

export interface Layout {
  platform: NodeJS.Platform;
  dataDir: string;
  logsDir: string;
  logFile: string;
  /** What the agent's own logger writes. */
  agentLogFile: string;
  /** stdout and stderr of the detached agent process (crashes, uncaught errors). A separate file: two writers on one file lose lines on Windows. */
  agentOutFile: string;
  configFile: string;
  lockFile: string;
  /** The relay secret: its own file, never inside tunnels.json. */
  relaySecretFile: string;
  /** pid and control port of the running agent. */
  agentStateFile: string;
  /** Where npx installed the pinned wrangler, so later runs start it without npx. */
  wranglerStateFile: string;
}

export function createLayout(p: PathEnv, dataDirOverride?: string): Layout {
  const { platform } = p;
  const dataDir = dataDirOverride ?? resolveDataDir(p);
  const logsDir = joinPath(platform, dataDir, 'logs');
  return {
    platform,
    dataDir,
    logsDir,
    logFile: joinPath(platform, logsDir, 'everport.log'),
    agentLogFile: joinPath(platform, logsDir, 'agent.log'),
    agentOutFile: joinPath(platform, logsDir, 'agent.out.log'),
    configFile: joinPath(platform, dataDir, 'tunnels.json'),
    lockFile: joinPath(platform, dataDir, 'everport.lock'),
    relaySecretFile: joinPath(platform, dataDir, 'relay-secret'),
    agentStateFile: joinPath(platform, dataDir, 'agent.json'),
    // Not "wrangler.json": wrangler reads that name as its own config in any parent folder of its working directory
    wranglerStateFile: joinPath(platform, dataDir, 'wrangler-install.json'),
  };
}
