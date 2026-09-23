import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function finalizeStatus(path, tempRoot) {
  try {
    if (!path || !tempRoot) return 2;
    const root = await realpath(tempRoot), actual = await realpath(path), rel = relative(root, actual), info = await lstat(path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || info.isSymbolicLink() || !info.isFile() || info.size > 1024) return 2;
    const status = JSON.parse(await readFile(actual, 'utf8'));
    return Object.keys(status).length === 1 && [0, 1, 2, 3].includes(status.exitCode) ? status.exitCode : 2;
  } catch { return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await finalizeStatus(process.env.JEVFUZZ_STATUS_PATH, process.env.RUNNER_TEMP);
