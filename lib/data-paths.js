// Local state files (rules, move manifest, digest, session log).
// Defaults to the home directory so nothing is written inside the repo.
// Override with ICLOUD_MCP_DATA_DIR for tests or a dedicated data folder.
import { homedir } from 'os';
import { join } from 'path';

export function dataDir() {
  return process.env.ICLOUD_MCP_DATA_DIR || homedir();
}

export function dataFile(filename) {
  return join(dataDir(), filename);
}
