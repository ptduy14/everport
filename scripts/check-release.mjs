// Decides whether main carries a version to release, for .github/workflows/release.yml.
// A release needs the CLI and the extension on the same version, a "## <version>" section in the extension's
// CHANGELOG, and no tag v<version> yet. Writes `version` and `release` to $GITHUB_OUTPUT and the section's text to
// the file named by $RELEASE_NOTES. By hand:   node scripts/check-release.mjs
/* global console, process */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The text under "## <version>" in a changelog, without the heading; undefined when there is no such section. */
export function releaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** Throws when the two packages disagree or the changelog lacks the version; otherwise says whether to release. */
export function checkRelease({ cliVersion, extensionVersion, changelog, tagExists }) {
  if (cliVersion !== extensionVersion) {
    throw new Error(
      `The CLI is at ${cliVersion} but the extension at ${extensionVersion}: give both packages the same version`,
    );
  }
  const version = cliVersion;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Version ${version} is not major.minor.patch, which the VS Code Marketplace requires`);
  }
  const notes = releaseNotes(changelog, version);
  if (!notes) throw new Error(`packages/vscode/CHANGELOG.md has no "## ${version}" section with text under it`);
  return { version, release: !tagExists(`v${version}`), notes };
}

const remoteTagExists = (tag) =>
  execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' }).trim() !== '';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const result = checkRelease({
    cliVersion: JSON.parse(read('packages/cli/package.json')).version,
    extensionVersion: JSON.parse(read('packages/vscode/package.json')).version,
    changelog: read('packages/vscode/CHANGELOG.md'),
    tagExists: remoteTagExists,
  });
  console.log(
    result.release
      ? `Version ${result.version} has no tag yet: it will be released.`
      : `Tag v${result.version} exists: nothing to release.`,
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nrelease=${result.release}\n`);
  }
  if (process.env.RELEASE_NOTES) writeFileSync(process.env.RELEASE_NOTES, `${result.notes}\n`);
}
