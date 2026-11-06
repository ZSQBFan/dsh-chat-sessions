/**
 * dsh-chat-sessions — empty-session reclamation (S7).
 *
 * The host ships no session-delete API (`sessionPersistence` only offers
 * `create/open/stat/list/flush`), and the closest reference plugin in this ecosystem
 * (`@aeroscis/dsh-temptask`) answers the same question with archive-only cleanup:
 *
 *   DeleteSessionPolicy = 'archive' | 'keep'   // default 'archive'
 *   archiveSessionQuietly() → ctx.workspaceRegistry.archiveSession(sessionId)
 *
 * The automatic maintenance sweep only reclaims empty cwds of sessions already
 * archived through the native UI. It never infers abandonment from message counts
 * or log timestamps: an unsent browser draft has neither a durable message nor a
 * fresh log timestamp. This also applies when the plugin is activated again.
 *
 * `IDLE_MS`, `decide` and `idleSince` remain exported for compatibility with the
 * public ./gc module, but the host no longer uses them to change archive flags.
 * Directory reclamation accepts only `session-<uuid>` cwds and uses non-recursive
 * `rmdir` after checking for files (Finder droppings are tolerated).
 *
 * Filesystem-only, node builtins only, so check.mjs can drive it against a throwaway dir.
 */
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** A session that never saw a user message is only reclaimed once it looks abandoned. */
export const IDLE_MS = 90_000;
/** The real leaf directory name; the title never lives here (cwd has no public setter). */
const SESSION_DIR = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Legacy threshold policy retained for the public ./gc export; not used by automatic maintenance.
 *
 * "Empty" means the log holds no user or assistant messages, which does not establish
 * whether a browser has an active composer or saved draft. Callers must not use this
 * policy alone to automatically archive sessions. Running or archived sessions and
 * conversations with messages are kept.
 * @param state `{ userMessages, assistantMessages, running, archived, idleMs }` for one session.
 * @returns 'archive' | 'keep'.
 */
export function decide({ userMessages, assistantMessages, running, archived, idleMs, thresholdMs = IDLE_MS }) {
  const spoke = userMessages > 0 || assistantMessages > 0;
  if (running === true) return 'keep';
  // `archived` wins: the flag is the user's (the sidebar's archive menu writes it), so the sweep
  // must never pull a session back out — doing that made a manually archived row reappear.
  if (archived === true) return 'keep';
  if (spoke) return 'keep';
  return idleMs >= thresholdMs ? 'archive' : 'keep';
}

/** How long the session has been silent, in milliseconds. */
export function idleSince(lastTime, now = Date.now()) {
  if (typeof lastTime !== 'number' || lastTime <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - lastTime);
}

/** True when the basename still follows the `session-<uuid>` contract the GC relies on. */
export function isSessionDirName(name) {
  return SESSION_DIR.test(name);
}

/**
 * A directory may be reclaimed when it holds nothing but macOS Finder droppings.
 * @returns the entries found (empty array = reclaimable).
 */
export async function reclaimableEntries(path) {
  try {
    const entries = await readdir(path);
    return entries.filter((name) => name !== '.DS_Store');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Remove one empty session cwd.
 *
 * `rmdir` is the second guard after `reclaimableEntries`: it refuses a non-empty directory
 * (ENOTEMPTY) instead of taking files with it, and it can never recurse.
 * @returns true when the directory is gone afterwards.
 */
export async function reclaimEmptyDir(path) {
  if ((await reclaimableEntries(path)).length > 0) return false;
  try {
    // `rmdir` refuses even a lone `.DS_Store`, so clear the Finder dropping first (PRD A6).
    await unlink(join(path, '.DS_Store')).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await rmdir(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
}

/** The cwd a standalone session would own under `<root>/.sessions`. */
export function sessionDirPath(sessionsRoot, sessionId) {
  return join(sessionsRoot, sessionId);
}
