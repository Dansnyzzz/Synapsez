/**
 * Who may do what in Settings → Administration (owner, 2026-11-04).
 *
 * The deployment has one **owner**: the first administrator. Only the owner makes
 * and unmakes other administrators and decides what each may do. Every other
 * administrator holds the permissions the owner gave them, and nothing else.
 *
 * Three things are the owner's alone, and are not permissions to hand out:
 *
 *   - making, changing and removing administrators;
 *   - acting on another administrator: suspending, limiting or deleting one;
 *   - the machine under the server: the local tools and any MCP server that runs
 *     on it (`usesInProcessTools`, routes/mcp.js). On a server somebody runs on
 *     their own computer, "administrator" used to mean a shell on that computer
 *     with everyone's stored keys in reach. A person made an administrator to read
 *     feedback was not being given that.
 *
 * An administrator made before this existed has no list (`admin_permissions` is
 * NULL), and keeps the powers they already had in the page: all of those below. So
 * does one made with `scripts/make-admin.js`, by somebody at the database already.
 * Anyone made here has a list, and a list, once written, is the whole of it.
 */

/** Everything an administrator can be given, in the order Settings lists them. */
export const ADMIN_PERMISSIONS = Object.freeze(['users', 'delete_users', 'models', 'feedback', 'activity', 'free_tier']);

const known = new Set(ADMIN_PERMISSIONS);

export const isOwner = (user) => user?.role === 'admin' && user?.is_owner === true;

/** A stored list as a list: some drivers hand JSONB back as text. */
function storedList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return [];
  }
}

/** What this account may do. Nothing for anyone who is not an administrator. */
export function permissionsOf(user) {
  if (user?.role !== 'admin') return [];
  if (isOwner(user)) return [...ADMIN_PERMISSIONS];
  const list = storedList(user.admin_permissions);
  return list ? ADMIN_PERMISSIONS.filter((p) => list.includes(p)) : [...ADMIN_PERMISSIONS];
}

export const can = (user, permission) => permissionsOf(user).includes(permission);

/** Only the known names, once each: what a request sent is not what gets stored. */
export const cleanPermissions = (list) => (Array.isArray(list) ? ADMIN_PERMISSIONS.filter((p) => list.includes(p)) : []);

/** Whether this administrator may act on that account at all. The owner, on anyone else; others, on non-administrators. */
export function mayActOn(actor, target) {
  if (!target || target.id === actor?.id) return false;
  if (isOwner(target)) return false;
  return target.role !== 'admin' || isOwner(actor);
}

/** Guards for a route: any one of the permissions named. */
export const requirePermission = (...permissions) => (req, res, next) => {
  if (permissions.some((p) => known.has(p) && can(req.user, p))) return next();
  res.status(403).json({ error: 'You do not have permission for that.' });
};

export const requireOwner = (req, res, next) => {
  if (isOwner(req.user)) return next();
  res.status(403).json({ error: 'Only the owner of this deployment can do that.' });
};
