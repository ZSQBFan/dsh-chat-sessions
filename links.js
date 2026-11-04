/**
 * dsh-chat-sessions — title symlink layer (S6).
 *
 * The real leaf is always `session-<uuid>`: the cwd is written into the session header and has
 * no public setter (`ApiSessionCwdConflict`), so a title can never rename the directory itself.
 * Every user-visible name therefore lives one level up, as a RELATIVE symlink
 * `<root>/<slug>` → `.sessions/session-<uuid>`, which keeps the link valid when `<root>` is
 * moved or synced (an absolute link would break).
 *
 * Two sessions can share one directory: pressing 新会话 inside a standalone chat makes the host
 * inherit the previous cwd (README section 18). `readlink` cannot tell such siblings apart — both
 * names resolve to the same target — so identity is settled at the level of the ROOM:
 *
 *   one directory ⇒ at most one name in `<root>` and at most one name in `<root>/.archive`.
 *
 * `<root>/.links.json` records `{ rooms: { "<target>": "<name>" } }`. The symlinks stay the source
 * of truth for *existence*; the record only settles *which name the room currently answers to*.
 * The room is OWNED by the session whose id equals the directory name (the session that created
 * it); only that owner may rename the room when its title changes. A sibling that inherited the
 * cwd adopts whatever name the room already has and never mints a second one.
 *
 * This module is filesystem-only and deliberately keeps `node:fs/promises` as its only
 * dependency so `check.mjs` can drive it against a throwaway directory.
 */
import { lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Longest accepted slug, in Unicode code points (PRD slug rules). */
const MAX_NAME_CODE_POINTS = 60;
/** Longest accepted slug, in UTF-8 bytes; most filesystems cap a single name at 255. */
const MAX_NAME_BYTES = 200;
/** How many `-2`, `-3`, … variants to try before giving up on a duplicate title. */
const MAX_DUPLICATES = 50;
/** Characters a title may not carry into a filename. */
const ILLEGAL = /[:*?"<>|/\\]/gu;
/** Control characters are dropped, not replaced, so they never become dashes. */
const CONTROL = /[\u0000-\u001f\u007f]/gu;
/** Dot-directory that holds the links of archived sessions (PRD A7); hidden like `.sessions`. */
export const ARCHIVE_DIRECTORY = '.archive';
/** Dot-file that records the name each room currently answers to (hidden, one object of JSON). */
export const LINKS_FILE = '.links.json';

/** Byte length of a string, without pulling in a Buffer for one call. */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * Turn a session title into a filesystem-safe slug.
 * @param title the raw title (may be empty or undefined).
 * @returns the slug, or an empty string when nothing usable is left.
 */
export function slugify(title) {
  const collapsed = String(title ?? '')
    .replace(CONTROL, '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  let slug = '';
  for (const character of collapsed) {
    const next = slug + character;
    if ([...next].length > MAX_NAME_CODE_POINTS || byteLength(next) > MAX_NAME_BYTES) break;
    slug = next;
  }
  return slug.replace(/-+$/gu, '');
}

/**
 * The link target of one session directory, always relative to `<root>`.
 * @param directory the directory name under `.sessions` (not necessarily the session id).
 * @returns `.sessions/<directory>`.
 */
export function linkTarget(directory) {
  return `.sessions/${directory}`;
}

/** Describe whatever currently occupies a link path. */
async function inspect(path) {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) return { kind: 'file' };
    return { kind: 'link', target: await readlink(path) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'free' };
    throw error;
  }
}

/**
 * Read `<root>/.links.json` as a room → name map.
 *
 * A missing or damaged file simply means "no room has a recorded name yet" — the links on disk
 * still describe reality and get adopted on the next sweep. Files written by earlier builds
 * (`{ version: 1, claims: { <sessionId>: <name> } }`) carried per-SESSION claims; that model let
 * two siblings of one room fight over the name, so it is ignored and rebuilt from disk.
 */
async function readRooms(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, LINKS_FILE), 'utf8'));
    const rooms = parsed?.rooms;
    if (typeof rooms !== 'object' || rooms === null) return {};
    const kept = Object.entries(rooms)
      .filter(([target, name]) => typeof target === 'string' && typeof name === 'string' && name !== '');
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

/**
 * Read the v1 per-session claims, if the file still has them.
 *
 * Identity is a room-level question now, so these records are never trusted to *decide* a name —
 * but they are a good hint for `tidyLinks`, which has to pick one survivor among legacy duplicates:
 * the claim of the session that owns the directory (its id is the directory name) is the room's
 * own name, e.g. `创建AI自我介绍文件` rather than `Test`.
 */
async function readLegacyClaims(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, LINKS_FILE), 'utf8'));
    const claims = parsed?.claims;
    return typeof claims === 'object' && claims !== null ? { ...claims } : {};
  } catch {
    return {};
  }
}

/** Persist the room → name map; failures are never fatal (the links themselves still work). */
async function writeRooms(root, rooms) {
  const payload = `${JSON.stringify({ version: 2, rooms }, null, 2)}\n`;
  await writeFile(join(root, LINKS_FILE), payload);
}

/** All symlink names directly inside `directory` whose target is `target`. */
async function namesFor(directory, target) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const names = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isSymbolicLink()) continue;
    try {
      if (await readlink(join(directory, entry.name)) === target) names.push(entry.name);
    } catch {
      // A link that vanished between readdir and readlink is simply not ours.
    }
  }
  return names.sort();
}

/**
 * The name `directory` already uses for this room, taken from disk.
 *
 * Disk wins over the record: a name someone deleted by hand must not be reported as the room's.
 */
async function adoptName(directory, target) {
  const names = await namesFor(directory, target);
  return names.length === 0 ? null : names[0];
}

/** The recorded name for this room, but only while it still exists in `directory`. */
async function roomName(directory, target, rooms) {
  const name = rooms[target.startsWith('../') ? target.slice(3) : target];
  if (typeof name !== 'string' || name === '') return null;
  const occupant = await inspect(join(directory, name));
  return occupant.kind === 'link' && occupant.target === target ? name : null;
}

/**
 * Resolve the single name a room answers to inside one directory (`<root>` or `.archive`).
 * @returns the name, or null when this room has no link there.
 */
async function resolveRoomName(directory, target, rooms) {
  return (await roomName(directory, target, rooms)) ?? (await adoptName(directory, target));
}

/**
 * Pick the first usable name for a room inside one directory.
 *
 * A name is reusable when it is either free or already points at THIS room (the room may legitimately
 * keep its own name); a name pointing at another room, or a plain file, pushes to `-2`, `-3`, …
 */
async function pickName(directory, slug, target) {
  let name = slug;
  for (let index = 2; index <= MAX_DUPLICATES; index += 1) {
    const occupant = await inspect(join(directory, name));
    if (occupant.kind === 'free') return name;
    if (occupant.kind === 'link' && occupant.target === target) return name;
    name = `${slug}-${index}`;
  }
  throw new Error(`too many links already named "${slug}" under ${directory}`);
}

/** Absolute paths of the two directories that can hold a room's link. */
function directories(root) {
  return { top: root, archive: join(root, ARCHIVE_DIRECTORY) };
}

/**
 * The name a room answers to inside `<root>`, or null while it has none.
 * @param root the chats root.
 * @param target `.sessions/<directory>` of the room.
 */
export async function findRoomLink(root, target) {
  return resolveRoomName(root, target, await readRooms(root));
}

/**
 * The name a room answers to inside `<root>/.archive/`, or null.
 * @param root the chats root.
 * @param target `.sessions/<directory>` of the room.
 */
export async function findArchivedRoomLink(root, target) {
  const { archive } = directories(root);
  const rooms = await readRooms(root);
  return (await resolveRoomName(archive, `../${target}`, rooms))
    ?? (await resolveRoomName(archive, target, rooms));
}

async function repairArchivedTarget(root, target) {
  const { archive } = directories(root);
  for (const name of await namesFor(archive, target)) {
    // Earlier builds moved .sessions/... verbatim one directory deeper.
    await unlink(join(archive, name));
    await symlink(`../${target}`, join(archive, name));
  }
}

/**
 * Give one room its title link, renaming it when the room's own title changed.
 *
 * Only `owner` (the session whose id is the directory name) may rename the room; a sibling that
 * inherited the cwd reports `unchanged` and adopts whatever name the room already has. A room with
 * no link yet is named by whichever sweep reaches it first, and that choice is recorded, so the
 * room stops moving from then on.
 * @param input `{ root, target, slug, owner }`.
 * @returns `{ status, name }` — `created`, `renamed`, `unchanged`, `adopted`, or `skipped`.
 */
export async function ensureRoomLink(input) {
  const { root, target, owner = false } = input ?? {};
  const slug = slugify(input?.slug ?? input?.title ?? '');
  const rooms = await readRooms(root);
  const current = await resolveRoomName(root, target, rooms);

  if (current !== null) {
    if (!owner || slug === '' || slug === current) {
      rooms[target] = current;
      await writeRooms(root, rooms);
      return { status: 'unchanged', name: current };
    }
    const name = await pickName(root, slug, target);
    if (name !== current) {
      await unlink(join(root, current));
      await symlink(target, join(root, name));
    }
    rooms[target] = name;
    await writeRooms(root, rooms);
    return { status: 'renamed', name, from: current };
  }

  if (slug === '') return { status: 'skipped', reason: 'no-title', name: null };
  const name = await pickName(root, slug, target);
  await symlink(target, join(root, name));
  rooms[target] = name;
  await writeRooms(root, rooms);
  return { status: 'created', name };
}

/**
 * Move one room's link into `<root>/.archive/` (PRD A7).
 *
 * Only the link moves: the real directory, the log, and the session record are untouched, so a
 * failure here can cost a name but never data. The name travels with the room, so a room archived
 * as `周报-2` comes back as `周报-2`. A room that never had a link (never titled) gets one created
 * directly in the archive, so the archive stays the single place where "this session still exists
 * on disk" is visible (PRD R-5).
 * @param input `{ root, target, slug }`.
 * @returns `{ status, from, to }` — `archived`, `unchanged`, or `skipped`.
 */
export async function archiveRoomLink(input) {
  const { root, target } = input ?? {};
  const slug = slugify(input?.slug ?? input?.title ?? '');
  const { top, archive } = directories(root);
  const rooms = await readRooms(root);

  await repairArchivedTarget(root, target);
  const archivedTarget = `../${target}`;
  const already = await resolveRoomName(archive, archivedTarget, rooms);
  if (already !== null) {
    rooms[target] = already;
    await writeRooms(root, rooms);
    return { status: 'unchanged', from: null, to: already };
  }

  await mkdir(archive, { recursive: true });
  const current = await resolveRoomName(top, target, rooms);
  if (current !== null) {
    const name = await pickName(archive, current, archivedTarget);
    await symlink(archivedTarget, join(archive, name));
    await unlink(join(top, current));
    rooms[target] = name;
    await writeRooms(root, rooms);
    return { status: 'archived', from: current, to: name };
  }

  if (slug === '') return { status: 'skipped', reason: 'no-title', from: null, to: null };
  const name = await pickName(archive, slug, archivedTarget);
  await symlink(archivedTarget, join(archive, name));
  rooms[target] = name;
  await writeRooms(root, rooms);
  return { status: 'archived', from: null, to: name };
}

/**
 * Move one room's link back out of `<root>/.archive/` (PRD A7 unarchive).
 * @param input `{ root, target }`.
 * @returns `{ status, from, to }` — `restored`, `unchanged`, or `skipped`.
 */
export async function restoreRoomLink(input) {
  const { root, target } = input ?? {};
  const { top, archive } = directories(root);
  const rooms = await readRooms(root);

  await repairArchivedTarget(root, target);
  const archived = await resolveRoomName(archive, `../${target}`, rooms);
  if (archived === null) {
    const remembered = rooms[target];
    const current = await resolveRoomName(top, target, rooms);
    if (current === null && typeof remembered === 'string' && remembered !== '') {
      const name = await pickName(top, remembered, target);
      await symlink(target, join(top, name));
      rooms[target] = name;
      await writeRooms(root, rooms);
      return { status: 'restored', from: null, to: name };
    }
    return { status: 'skipped', reason: 'not-archived', from: null, to: null };
  }

  const current = await resolveRoomName(top, target, rooms);
  if (current !== null) {
    await unlink(join(archive, archived));
    rooms[target] = current;
    await writeRooms(root, rooms);
    return { status: 'unchanged', from: archived, to: current };
  }

  const name = await pickName(top, archived, target);
  await symlink(target, join(top, name));
  await unlink(join(archive, archived));
  rooms[target] = name;
  await writeRooms(root, rooms);
  return { status: 'restored', from: archived, to: name };
}

/**
 * Forget one room entirely (its directory is being reclaimed).
 * @param input `{ root, target }`.
 * @returns the removed name, or null when the room had none.
 */
export async function dropRoomLink(input) {
  const { root, target, keepName = false } = input ?? {};
  const { top, archive } = directories(root);
  const rooms = await readRooms(root);
  let removed = null;
  for (const [directory, targets] of [[top, [target]], [archive, [target, `../${target}`]]]) {
    for (const spelling of targets) {
      for (const name of await namesFor(directory, spelling)) {
        const occupant = await inspect(join(directory, name));
        if (occupant.kind !== 'link' || occupant.target !== spelling) continue;
        await unlink(join(directory, name));
        removed ??= name;
      }
    }
  }
  if (keepName && removed !== null) rooms[target] = removed;
  else if (!keepName) delete rooms[target];
  await writeRooms(root, rooms);
  return removed;
}

/**
 * Redundant names: two or more links inside one directory pointing at the SAME room.
 *
 * Keys the old per-session model minted one name per session, so a room shared by several sessions
 * accumulated `Test` + `创建AI自我介绍文件` in `<root>`, or `周报-4/-6/-7` in `.archive/`. The room
 * model cannot produce those any more; this pass cleans up what earlier builds left behind and
 * records the surviving name so later sweeps keep it. Dry run by default.
 * @param first `root` or `{ root, apply }`.
 * @returns `{ scanned, groups, removed, roomsRecorded, applied }`.
 */
export async function tidyLinks(first, apply) {
  const config = typeof first === 'string' ? { root: first, apply } : (first ?? {});
  const root = config.root;
  const run = config.apply === true;
  const rooms = await readRooms(root);
  const legacyClaims = await readLegacyClaims(root);
  const report = { scanned: 0, groups: [], removed: [], roomsRecorded: 0, applied: run };

  for (const directory of ['', ARCHIVE_DIRECTORY]) {
    const base = directory === '' ? root : join(root, directory);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const byTarget = new Map();
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isSymbolicLink()) continue;
      report.scanned += 1;
      let target;
      try {
        target = await readlink(join(base, entry.name));
      } catch {
        continue;
      }
      const bucket = byTarget.get(target) ?? [];
      bucket.push(entry.name);
      byTarget.set(target, bucket);
    }
    for (const [target, names] of byTarget) {
      if (names.length < 2) continue;
      const sorted = [...names].sort();
      // Prefer the name the room already answers to; otherwise prefer a hand-made name over a
      // `-2`-style duplicate, then the shortest, then alphabetical — deterministic every run.
      const roomKey = directory === ARCHIVE_DIRECTORY && target.startsWith('../') ? target.slice(3) : target;
      const recorded = rooms[roomKey];
      const ownerHint = legacyClaims[target.split('/').pop() ?? ''];
      const keep = sorted.includes(recorded)
        ? recorded
        : sorted.includes(ownerHint)
          ? ownerHint
          : sorted.sort((a, b) => Number(/-\d+$/u.test(a)) - Number(/-\d+$/u.test(b))
            || a.length - b.length
            || a.localeCompare(b))[0];
      const drop = sorted.filter((name) => name !== keep);
      report.groups.push({ directory: directory === '' ? '.' : directory, target, keep, drop });
      if (!run) continue;
      for (const name of drop) {
        try {
          await unlink(join(base, name));
          report.removed.push({ directory: directory === '' ? '.' : directory, name, target });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (rooms[roomKey] !== keep) {
        rooms[roomKey] = keep;
        report.roomsRecorded += 1;
      }
    }
  }

  if (run) await writeRooms(root, rooms);
  return report;
}

/**
 * Read everything the host can tell from a persisted session's event log.
 *
 * One pass yields both layers' inputs: the latest `session/title` (link name) and whether a
 * user ever spoke in this session (garbage-collection predicate — `blank` is unusable here
 * because the first seeded turn flips it, see README section 11).
 * @param persistence the sessionPersistence service.
 * @param sessionId the session to read.
 * @returns `{ title, userMessages, assistantMessages, lastTime }`; `title` is null without one.
 */
export async function readSessionLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read');
  try {
    const { events } = await handle.read();
    let title = null;
    let userMessages = 0;
    let assistantMessages = 0;
    let lastTime = 0;
    for (const event of events) {
      if (typeof event?.time === 'number' && event.time > lastTime) lastTime = event.time;
      if (event?.type === 'session/title') {
        const value = event.data?.title;
        if (typeof value === 'string' && value.trim() !== '') title = value;
        continue;
      }
      if (event?.type === 'user/message') userMessages += 1;
      else if (event?.type === 'assistant/message') assistantMessages += 1;
    }
    return { title, userMessages, assistantMessages, lastTime };
  } finally {
    await handle.close();
  }
}

/**
 * Read the latest title a persisted session logged (`session/title` is last-wins).
 * @param persistence the sessionPersistence service.
 * @param sessionId the session to read.
 * @returns the latest non-empty title, or null while the session still has none.
 */
export async function readSessionTitle(persistence, sessionId) {
  return (await readSessionLog(persistence, sessionId)).title;
}
