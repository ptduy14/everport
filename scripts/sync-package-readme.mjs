// Writes packages/cli/README.md (what npm shows) from the root README: relative links become absolute, and the
// Install section describes installing from npm. Run by the package's prepublishOnly, and by hand after editing the
// root README:   node scripts/sync-package-readme.mjs
/* global console */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'https://github.com/ptduy14/everport';
let text = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

const raw = 'https://raw.githubusercontent.com/ptduy14/everport/main';
// Images need the raw address to render on npm; other relative links point at the file on GitHub.
text = text.replace(/!\[([^\]]*)\]\((docs\/[^)]+)\)/g, (_m, alt, path) => `![${alt}](${raw}/${path})`);
text = text.replace(
  /\]\((docs\/[^)]+|SECURITY\.md|CONTRIBUTING\.md|LICENSE)\)/g,
  (_m, path) => `](${repo}/blob/main/${path})`,
);

const install = `## Install

\`\`\`powershell
npm install -g everport
\`\`\`

Needs Node.js 22.12 or newer. The package has no runtime dependencies: it holds the CLI (\`everport\`, alias \`ep\`), the background agent and the relay Worker. A VS Code extension with the same actions is published separately as "Everport" (publisher \`everport-dev\`).

`;
const start = text.indexOf('## Install');
const end = text.indexOf('## Use');
if (start === -1 || end === -1 || end < start) throw new Error('README sections "Install" and "Use" not found');
text = text.slice(0, start) + install + text.slice(end);

writeFileSync(join(root, 'packages', 'cli', 'README.md'), text);
copyFileSync(join(root, 'LICENSE'), join(root, 'packages', 'cli', 'LICENSE'));
console.log('packages/cli/README.md and LICENSE written');
