import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { git, gitCommonDir, gitRoot } from './git-process.js';
import { listWorkspaceGitWorktrees, type WorkspaceGitWorktreeList } from './worktrees.js';

export type WorktreeRemovalReason =
  | 'main_worktree'
  | 'active_worktree'
  | 'not_found'
  | 'locked_worktree'
  | 'dirty_worktree'
  | 'unknown';

export interface WorktreeRemovalResult {
  status: number;
  body: { success: boolean; reason?: WorktreeRemovalReason; error?: string };
}

export interface WorktreeRemovalItem {
  workspace: string;
  worktreeDir: string;
}

export interface WorktreeBatchRemovalResult {
  success: boolean;
  removedPaths: string[];
  failedItems: Array<{
    worktreeDir: string;
    reason: WorktreeRemovalReason;
    error?: string;
  }>;
}

export interface ManagedWorktreeRuntimeSafety {
  listRunningWorktreeDirs(): Promise<string[]>;
}

export interface ManagedWorktreeServicePort {
  list(workspace: string): Promise<WorkspaceGitWorktreeList>;
  remove(
    workspace: string,
    worktreeDir: string,
    activeWorktreeDir?: string,
  ): Promise<WorktreeRemovalResult>;
  removeBatch(
    items: WorktreeRemovalItem[],
    activeWorktreeDir?: string,
  ): Promise<WorktreeBatchRemovalResult>;
}

export class ManagedWorktreeService implements ManagedWorktreeServicePort {
  constructor(private readonly runtimeSafety: ManagedWorktreeRuntimeSafety) {}

  list(workspace: string): Promise<WorkspaceGitWorktreeList> {
    return listWorkspaceGitWorktrees(workspace, { usePrimaryWorktree: true });
  }

  async remove(
    workspace: string,
    worktreeDir: string,
    activeWorktreeDir?: string,
  ): Promise<WorktreeRemovalResult> {
    return removeManagedWorktree(
      workspace,
      worktreeDir,
      activeWorktreeDir,
      await this.runtimeSafety.listRunningWorktreeDirs(),
    );
  }

  async removeBatch(
    items: WorktreeRemovalItem[],
    activeWorktreeDir?: string,
  ): Promise<WorktreeBatchRemovalResult> {
    return removeManagedWorktreesBatch(
      items,
      activeWorktreeDir,
      await this.runtimeSafety.listRunningWorktreeDirs(),
    );
  }
}

interface ManagedWorktreeSnapshot {
  mainRoot: string;
  entries: Array<{
    canonicalPath: string;
    isLocked: boolean;
    isMain: boolean;
  }>;
}

interface PreparedManagedWorktreeRemoval {
  mainRoot: string;
  requestedPath: string;
}

type ManagedWorktreeRemovalPreparation =
  | { kind: 'ready'; removal: PreparedManagedWorktreeRemoval }
  | { kind: 'refused'; result: WorktreeRemovalResult };

interface BatchWorktreeRemovalItemResult {
  item: WorktreeRemovalItem;
  result: WorktreeRemovalResult;
}

async function resolveProtectedWorktreePaths(paths: readonly string[]): Promise<Set<string>> {
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
  const canonicalPaths = await Promise.all(
    uniquePaths.map((path) => realpath(path).catch(() => resolve(path))),
  );
  return new Set(canonicalPaths);
}

function pathBelongsToWorktree(worktreePath: string, candidatePath: string): boolean {
  const rel = relative(worktreePath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A user-facing worktree removal is deliberately narrower than raw
 * `git worktree remove`: it may only reclaim clean, unlocked linked worktrees
 * belonging to the current repository. This keeps the main checkout, all
 * active session worktrees, and uncommitted work intact while allowing users to
 * reclaim worktrees created by Shards Code, Codex, or Git directly.
 */
export async function removeManagedWorktree(
  workspace: string,
  worktreeDir: string,
  activeWorktreeDir?: string,
  runningWorktreeDirs: readonly string[] = [],
): Promise<WorktreeRemovalResult> {
  const snapshot = await inspectManagedWorktrees(workspace);
  if ('result' in snapshot) return snapshot.result;
  const protectedWorktreePaths = await resolveProtectedWorktreePaths([
    activeWorktreeDir ?? workspace,
    ...runningWorktreeDirs,
  ]);
  const preparation = await prepareManagedWorktreeRemoval(
    snapshot.snapshot,
    worktreeDir,
    protectedWorktreePaths,
  );
  if (preparation.kind === 'refused') return preparation.result;
  return executeManagedWorktreeRemoval(preparation.removal);
}

/**
 * The list endpoint additionally reads modification times for Settings. Removal
 * only needs ownership and safety metadata, so keep this snapshot deliberately
 * lightweight and reuse it for every requested worktree in the same repository.
 */
async function inspectManagedWorktrees(
  workspace: string,
): Promise<{ snapshot: ManagedWorktreeSnapshot } | { result: WorktreeRemovalResult }> {
  const root = await gitRoot(workspace);
  if (!root) {
    return {
      result: {
        status: 400,
        body: { success: false, reason: 'not_found', error: 'Not a git repository' },
      },
    };
  }
  const listed = await git(['worktree', 'list', '--porcelain'], root);
  if (listed.code !== 0) {
    return {
      result: {
        status: 500,
        body: {
          success: false,
          reason: 'unknown',
          error: listed.stderr || listed.stdout || 'Failed to inspect git worktrees',
        },
      },
    };
  }
  const rawEntries = listed.stdout
    .split(/\n\n+/)
    .map((block) =>
      Object.fromEntries(
        block
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [key, ...rest] = line.split(' ');
            return [key, rest.join(' ')];
          }),
      ),
    )
    .filter((item) => typeof item.worktree === 'string');
  const mainRoot = typeof rawEntries[0]?.worktree === 'string' ? rawEntries[0].worktree : root;
  const entries = await Promise.all(
    rawEntries.map(async (entry) => ({
      canonicalPath: await realpath(String(entry.worktree)).catch(() =>
        resolve(String(entry.worktree)),
      ),
      isLocked: 'locked' in entry,
      isMain: resolve(String(entry.worktree)) === resolve(mainRoot),
    })),
  );
  return { snapshot: { mainRoot, entries } };
}

async function prepareManagedWorktreeRemoval(
  snapshot: ManagedWorktreeSnapshot,
  worktreeDir: string,
  protectedWorktreePaths: ReadonlySet<string>,
): Promise<ManagedWorktreeRemovalPreparation> {
  const requestedPath = await realpath(worktreeDir).catch(() => resolve(worktreeDir));
  const entry = snapshot.entries.find((candidate) => candidate.canonicalPath === requestedPath);
  if (!entry) {
    return {
      kind: 'refused',
      result: {
        status: 404,
        body: { success: false, reason: 'not_found', error: 'Worktree was not found' },
      },
    };
  }
  if (entry.isMain) {
    return {
      kind: 'refused',
      result: {
        status: 400,
        body: {
          success: false,
          reason: 'main_worktree',
          error: 'The main worktree cannot be removed',
        },
      },
    };
  }
  if (
    [...protectedWorktreePaths].some((protectedPath) =>
      pathBelongsToWorktree(requestedPath, protectedPath),
    )
  ) {
    return {
      kind: 'refused',
      result: {
        status: 409,
        body: {
          success: false,
          reason: 'active_worktree',
          error: 'The worktree used by an active session cannot be removed',
        },
      },
    };
  }
  if (entry.isLocked) {
    return {
      kind: 'refused',
      result: {
        status: 409,
        body: { success: false, reason: 'locked_worktree', error: 'This worktree is locked' },
      },
    };
  }
  const unavailable = await inspectWorktreeDirectory(requestedPath);
  if (unavailable) return { kind: 'refused', result: unavailable };
  const changes = await git(['status', '--porcelain'], requestedPath);
  if (changes.code !== 0) {
    return {
      kind: 'refused',
      result: (await inspectWorktreeDirectory(requestedPath)) ?? {
        status: 500,
        body: {
          success: false,
          reason: 'unknown',
          error: 'Unable to verify that the worktree is clean',
        },
      },
    };
  }
  if (changes.stdout.trim()) {
    return {
      kind: 'refused',
      result: {
        status: 409,
        body: {
          success: false,
          reason: 'dirty_worktree',
          error: 'Commit, stash, or discard its changes before removing this worktree',
        },
      },
    };
  }

  return { kind: 'ready', removal: { mainRoot: snapshot.mainRoot, requestedPath } };
}

async function inspectWorktreeDirectory(
  worktreePath: string,
): Promise<WorktreeRemovalResult | undefined> {
  try {
    if ((await stat(worktreePath)).isDirectory()) return undefined;
    return {
      status: 500,
      body: { success: false, reason: 'unknown', error: 'Worktree path is not a directory' },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    return {
      status: missing ? 404 : 500,
      body: {
        success: false,
        reason: missing ? 'not_found' : 'unknown',
        error: missing ? 'Worktree directory no longer exists' : 'Unable to inspect worktree directory',
      },
    };
  }
}

async function executeManagedWorktreeRemoval(
  removal: PreparedManagedWorktreeRemoval,
): Promise<WorktreeRemovalResult> {
  const result = await git(['worktree', 'remove', '--', removal.requestedPath], removal.mainRoot);
  return result.code === 0
    ? { status: 200, body: { success: true } }
    : {
        status: 500,
        body: {
          success: false,
          reason: 'unknown',
          error: result.stderr || result.stdout || 'Failed to remove worktree',
        },
      };
}

export async function removeManagedWorktreesBatch(
  items: WorktreeRemovalItem[],
  activeWorktreeDir?: string,
  runningWorktreeDirs: readonly string[] = [],
): Promise<WorktreeBatchRemovalResult> {
  const groups = await groupWorktreeRemovalItems(items);
  const groupedItems = [...groups.values()];
  const settledGroups = await Promise.allSettled(
    groupedItems.map((group) =>
      removeManagedWorktreeGroup(group, activeWorktreeDir, runningWorktreeDirs),
    ),
  );
  const removedPaths: string[] = [];
  const failedItems: WorktreeBatchRemovalResult['failedItems'] = [];

  for (const [index, settled] of settledGroups.entries()) {
    const group = groupedItems[index] ?? [];
    const results =
      settled.status === 'fulfilled'
        ? settled.value
        : group.map((item) => ({
            item,
            result: {
              status: 500,
              body: {
                success: false,
                reason: 'unknown' as const,
                error:
                  settled.reason instanceof Error
                    ? settled.reason.message
                    : 'Failed to remove worktree',
              },
            },
          }));
    for (const { item, result } of results) {
      if (result.body.success) {
        removedPaths.push(item.worktreeDir);
      } else {
        failedItems.push({
          worktreeDir: item.worktreeDir,
          reason: result.body.reason ?? 'unknown',
          error: result.body.error,
        });
      }
    }
  }

  return { success: true, removedPaths, failedItems };
}

async function groupWorktreeRemovalItems(
  items: WorktreeRemovalItem[],
): Promise<Map<string, WorktreeRemovalItem[]>> {
  const byWorkspace = new Map<string, WorktreeRemovalItem[]>();
  for (const item of items) {
    const workspaceItems = byWorkspace.get(item.workspace) ?? [];
    workspaceItems.push(item);
    byWorkspace.set(item.workspace, workspaceItems);
  }
  const workspaceGroups = await Promise.all(
    [...byWorkspace.entries()].map(async ([workspace, workspaceItems]) => ({
      key: (await gitCommonDir(workspace)) ?? `workspace:${workspace}`,
      items: workspaceItems,
    })),
  );
  const grouped = new Map<string, WorktreeRemovalItem[]>();
  for (const group of workspaceGroups) {
    const existing = grouped.get(group.key) ?? [];
    existing.push(...group.items);
    grouped.set(group.key, existing);
  }
  return grouped;
}

async function removeManagedWorktreeGroup(
  items: WorktreeRemovalItem[],
  activeWorktreeDir?: string,
  runningWorktreeDirs: readonly string[] = [],
): Promise<BatchWorktreeRemovalItemResult[]> {
  const snapshot = await inspectManagedWorktrees(items[0]?.workspace ?? '');
  if ('result' in snapshot) return items.map((item) => ({ item, result: snapshot.result }));
  const protectedWorktreePaths = await resolveProtectedWorktreePaths([
    activeWorktreeDir ?? items[0]?.workspace ?? snapshot.snapshot.mainRoot,
    ...runningWorktreeDirs,
  ]);

  // The repository snapshot and status checks are shared by this group. Once
  // they pass, removals can run concurrently; Git-level conflicts are isolated
  // to their worktree and reported as individual failures below.
  const prepared = await Promise.all(
    items.map(async (item) => ({
      item,
      preparation: await prepareManagedWorktreeRemoval(
        snapshot.snapshot,
        item.worktreeDir,
        protectedWorktreePaths,
      ),
    })),
  );
  const settledRemovals = await Promise.allSettled(
    prepared.map(async ({ item, preparation }) => ({
      item,
      result:
        preparation.kind === 'ready'
          ? await executeManagedWorktreeRemoval(preparation.removal)
          : preparation.result,
    })),
  );
  return settledRemovals.map((settled, index) => {
    if (settled.status === 'fulfilled') return settled.value;
    const item = prepared[index]?.item;
    return {
      item: item ?? { workspace: '', worktreeDir: '' },
      result: {
        status: 500,
        body: {
          success: false,
          reason: 'unknown',
          error:
            settled.reason instanceof Error ? settled.reason.message : 'Failed to remove worktree',
        },
      },
    };
  });
}
