import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubClient } from '../github/client.ts';

const execFileP = promisify(execFile);

/** Read-only view of a repository's files, independent of where they live. */
export interface RepoSource {
  kind: 'github' | 'local';
  /** All file paths (POSIX separators, relative to the repo root). */
  files: string[];
  /** True when the listing was capped and some files are missing. */
  truncated: boolean;
  /** Bytes per extension, used for language detection on local repos. */
  sizes: Map<string, number>;
  read(file: string): Promise<string | null>;
  /** Files whose full content was scanned for secrets. */
  scannedForSecrets: Set<string>;
}

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor', '.venv', 'venv',
  '__pycache__', 'target', '.terraform', '.cache', 'bower_components', '.gradle', '.idea', '.vscode', 'release',
]);

const MAX_LOCAL_FILES = 20_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;

export async function localSource(root: string): Promise<RepoSource> {
  const abs = path.resolve(root);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${abs}`);
  const files: string[] = [];
  const sizes = new Map<string, number>();
  let truncated = false;
  const walk = (dir: string) => {
    if (files.length >= MAX_LOCAL_FILES) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow links out of the authorised tree
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_LOCAL_FILES) {
          truncated = true;
          return;
        }
        const rel = path.relative(abs, full).split(path.sep).join('/');
        files.push(rel);
        try {
          const ext = path.extname(e.name).toLowerCase() || e.name;
          sizes.set(ext, (sizes.get(ext) ?? 0) + fs.statSync(full).size);
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(abs);
  return {
    kind: 'local',
    files,
    truncated,
    sizes,
    scannedForSecrets: new Set(),
    async read(file) {
      const full = path.resolve(abs, file);
      if (!full.startsWith(abs + path.sep)) return null; // path traversal guard
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
        return fs.readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

export async function localGitInfo(root: string): Promise<{ sha: string; message: string; author: string; date: string; branch: string } | null> {
  try {
    const opts = { cwd: root, timeout: 5000, windowsHide: true };
    const { stdout } = await execFileP('git', ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%cI'], opts);
    const [sha, message, author, date] = stdout.trim().split('\x1f') as [string, string, string, string];
    const branch = (await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts)).stdout.trim();
    return { sha, message, author, date, branch };
  } catch {
    return null;
  }
}

interface TreeResponse {
  truncated: boolean;
  tree: { path: string; type: string; size?: number }[];
}

export async function githubSource(gh: GitHubClient, owner: string, repo: string, ref: string): Promise<RepoSource> {
  const tree = await gh.json<TreeResponse>(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const files: string[] = [];
  const sizes = new Map<string, number>();
  const fileSizes = new Map<string, number>();
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (entry.path.split('/').some((seg) => IGNORED_DIRS.has(seg))) continue;
    files.push(entry.path);
    fileSizes.set(entry.path, entry.size ?? 0);
    const ext = path.posix.extname(entry.path).toLowerCase() || path.posix.basename(entry.path);
    sizes.set(ext, (sizes.get(ext) ?? 0) + (entry.size ?? 0));
  }
  const cache = new Map<string, Promise<string | null>>();
  return {
    kind: 'github',
    files,
    truncated: tree.truncated,
    sizes,
    scannedForSecrets: new Set(),
    read(file) {
      if ((fileSizes.get(file) ?? 0) > MAX_READ_BYTES) return Promise.resolve(null);
      let p = cache.get(file);
      if (!p) {
        const encoded = file.split('/').map(encodeURIComponent).join('/');
        p = gh.text(`/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, MAX_READ_BYTES).catch(() => null);
        cache.set(file, p);
      }
      return p;
    },
  };
}
