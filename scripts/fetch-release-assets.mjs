import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHubClient, positiveId, RELEASE_ID_PATTERN } from './lib/github.mjs';

export async function fetchReleaseAssets(
  client,
  { directory, release, archiveId, checksumId, manifestId },
) {
  if (!RELEASE_ID_PATTERN.test(release)) throw new Error('Invalid release ID');
  mkdirSync(directory, { recursive: true });
  for (const [assetId, extension] of [
    [archiveId, 'tar.gz'],
    [checksumId, 'sha256'],
    [manifestId, 'json'],
  ]) {
    const bytes = await client.request(`/releases/assets/${positiveId(assetId, 'asset ID')}`, {
      raw: true,
      accept: 'application/octet-stream',
    });
    if (bytes.length > 1024 ** 3) throw new Error('Release asset is too large');
    writeFileSync(resolve(directory, `${release}.${extension}`), bytes);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  fetchReleaseAssets(createGitHubClient(), {
    directory: 'artifact',
    release: process.env.RELEASE_ID,
    archiveId: process.env.ARCHIVE_ID,
    checksumId: process.env.CHECKSUM_ID,
    manifestId: process.env.MANIFEST_ID,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
