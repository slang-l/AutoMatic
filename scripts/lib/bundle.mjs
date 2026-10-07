import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMIT_PATTERN, RELEASE_ID_PATTERN } from './github.mjs';

export function verifiedBundle(directory, { release, commit } = {}) {
  if (!RELEASE_ID_PATTERN.test(release ?? '') || !COMMIT_PATTERN.test(commit ?? ''))
    throw new Error('Invalid expected release identity');
  const files = ['tar.gz', 'sha256', 'json'].map((extension) =>
    resolve(directory, `${release}.${extension}`),
  );
  for (const file of files)
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error('Bundle files must be regular files');
  const checksum = readFileSync(files[1], 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid artifact checksum');
  if (createHash('sha256').update(readFileSync(files[0])).digest('hex') !== checksum)
    throw new Error('Artifact checksum mismatch');
  const metadata = JSON.parse(readFileSync(files[2], 'utf8'));
  if (
    metadata.schema !== 1 ||
    metadata.release !== release ||
    metadata.commit !== commit ||
    metadata.source !== 'git' ||
    metadata.nodeMajor !== 22 ||
    metadata.platform !== 'linux' ||
    metadata.arch !== 'x64'
  )
    throw new Error('Artifact manifest does not match verified source');
  return { files, metadata, checksum };
}
