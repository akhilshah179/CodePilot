import type { Db } from '../db.ts';
import { AppError } from '../errors.ts';

export type PlatformRole = 'admin' | 'user';
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export type Permission =
  | 'project:view'
  | 'project:delete'
  | 'code:view'
  | 'code:search'
  | 'analysis:view'
  | 'analysis:trigger'
  | 'flows:edit'
  | 'share:create'
  | 'share:revoke'
  | 'consent:manage'
  | 'member:manage'
  | 'member:view';

/**
 * Role-Permission Matrix:
 * - Owner: full control over workspace/project, members, flows, shares, deletion, and consent.
 * - Admin: can analyze, edit flows, manage shares, invite members, view all. Cannot delete project or alter owner.
 * - Member: can analyze, view code, search, view architecture and flows.
 * - Viewer: strictly read-only access to existing project results and code.
 */
const ROLE_PERMISSIONS: Record<WorkspaceRole, Set<Permission>> = {
  owner: new Set([
    'project:view',
    'project:delete',
    'code:view',
    'code:search',
    'analysis:view',
    'analysis:trigger',
    'flows:edit',
    'share:create',
    'share:revoke',
    'consent:manage',
    'member:manage',
    'member:view',
  ]),
  admin: new Set([
    'project:view',
    'code:view',
    'code:search',
    'analysis:view',
    'analysis:trigger',
    'flows:edit',
    'share:create',
    'share:revoke',
    'member:manage',
    'member:view',
  ]),
  member: new Set([
    'project:view',
    'code:view',
    'code:search',
    'analysis:view',
    'analysis:trigger',
    'member:view',
  ]),
  viewer: new Set([
    'project:view',
    'code:view',
    'code:search',
    'analysis:view',
    'member:view',
  ]),
};

export function hasPermission(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface MemberDetail {
  userId: string;
  role: WorkspaceRole;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export class RbacService {
  constructor(private readonly db: Db) {}

  /**
   * Retrieves the user's role on the given project.
   * If the user is the primary owner or in project_members, returns the role.
   */
  getRole(projectId: string, userId: string): WorkspaceRole | null {
    const mem = this.db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId) as { role: WorkspaceRole } | undefined;
    if (mem) return mem.role;

    const proj = this.db
      .prepare('SELECT user_id FROM projects WHERE id = ?')
      .get(projectId) as { user_id: string | null } | undefined;
    if (proj && proj.user_id === userId) return 'owner';
    return null;
  }

  /**
   * Enforces a specific permission for a user on a project.
   * If the user has no role on the project, returns 404 (prevent IDOR information leakage).
   * If the user has a role but lacks the permission, returns 403 Forbidden.
   */
  requirePermission(projectId: string, userId: string | null | undefined, permission: Permission): WorkspaceRole {
    if (!userId) {
      throw new AppError('not_found', 'Project not found.', 404);
    }
    const role = this.getRole(projectId, userId);
    if (!role) {
      // Indistinguishable from non-existent project to prevent enumeration
      throw new AppError('not_found', 'Project not found.', 404);
    }
    if (!hasPermission(role, permission)) {
      throw new AppError('forbidden', `You do not have permission to perform this action (${permission}).`, 403);
    }
    return role;
  }

  /** List all members of a project. */
  listMembers(projectId: string): MemberDetail[] {
    const rows = this.db
      .prepare(
        `SELECT m.user_id, m.role, m.created_at, u.name, u.email, u.avatar_url
         FROM project_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'member' THEN 3 ELSE 4 END, m.created_at ASC`,
      )
      .all(projectId) as { user_id: string; role: WorkspaceRole; created_at: string; name: string | null; email: string | null; avatar_url: string | null }[];

    return rows.map((r) => ({
      userId: r.user_id,
      role: r.role,
      name: r.name,
      email: r.email,
      avatarUrl: r.avatar_url,
      createdAt: r.created_at,
    }));
  }

  /** Add or update a member on a project. */
  setMember(projectId: string, targetUserId: string, role: 'admin' | 'member' | 'viewer', callerRole: WorkspaceRole, nowStr: string) {
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      throw new AppError('forbidden', 'Only project owners and admins can manage members.', 403);
    }
    const targetUser = this.db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser) throw new AppError('not_found', 'User not found.', 404);

    const existingRole = this.getRole(projectId, targetUserId);
    if (existingRole === 'owner') {
      throw new AppError('forbidden', 'Cannot change the role of the project owner.', 403);
    }
    if (callerRole === 'admin' && existingRole === 'admin') {
      throw new AppError('forbidden', 'Admins cannot modify other admins.', 403);
    }

    this.db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(projectId, targetUserId, role, nowStr);
  }

  /** Remove a member from a project. */
  removeMember(projectId: string, targetUserId: string, callerRole: WorkspaceRole) {
    if (callerRole !== 'owner' && callerRole !== 'admin') {
      throw new AppError('forbidden', 'Only project owners and admins can manage members.', 403);
    }
    const existingRole = this.getRole(projectId, targetUserId);
    if (existingRole === 'owner') {
      throw new AppError('forbidden', 'Cannot remove the project owner.', 403);
    }
    if (callerRole === 'admin' && existingRole === 'admin') {
      throw new AppError('forbidden', 'Admins cannot remove other admins.', 403);
    }
    const res = this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, targetUserId);
    if (!res.changes) throw new AppError('not_found', 'Member not found on this project.', 404);
  }
}
