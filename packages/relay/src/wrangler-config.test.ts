import { describe, expect, it } from 'vitest';
import { renderWranglerConfig } from './wrangler-config.js';

describe('renderWranglerConfig', () => {
  const config = renderWranglerConfig({ workerName: 'everport' });

  it('names the Worker and its bundled file, with the date the PoC was measured on', () => {
    expect(config).toContain('name = "everport"');
    expect(config).toContain('main = "worker.js"');
    expect(config).toContain('compatibility_date = "2025-01-01"');
  });

  it('takes a different file name and date when asked', () => {
    const custom = renderWranglerConfig({ workerName: 'x', main: 'relay.js', compatibilityDate: '2026-01-01' });
    expect(custom).toContain('main = "relay.js"');
    expect(custom).toContain('compatibility_date = "2026-01-01"');
  });

  it('binds the Durable Object twice: for production and, separately, for previews', () => {
    const binding = '{ name = "RELAY", class_name = "Relay" }';
    expect(config.split(binding)).toHaveLength(3);
    expect(config).toMatch(/\[durable_objects\]\nbindings = \[/);
    expect(config).toMatch(/\[previews\.durable_objects\]\nbindings = \[/);
  });

  it('declares the SQLite migration the free plan requires', () => {
    expect(config).toContain('new_sqlite_classes = ["Relay"]');
  });
});
