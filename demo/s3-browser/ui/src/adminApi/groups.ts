// === IAM Group Management ===
import { throwApiError } from '../errorHandling';
import { adminFetch, safeJson } from './core';
import type { IamPermission } from './users';

export interface IamGroup {
  id: number;
  name: string;
  description: string;
  permissions: IamPermission[];
  member_ids: number[];
  created_at: string;
}

interface CreateGroupRequest {
  name: string;
  description?: string;
  permissions: IamPermission[];
}

interface UpdateGroupRequest {
  name?: string;
  description?: string;
  permissions?: IamPermission[];
}

export async function getGroups(): Promise<IamGroup[]> {
  const res = await adminFetch('/api/admin/groups');
  return safeJson(res);
}

export async function createGroup(req: CreateGroupRequest): Promise<IamGroup> {
  const res = await adminFetch('/api/admin/groups', 'POST', req);
  return safeJson(res);
}

export async function cloneGroup(
  id: number,
  req: { name?: string; copy_members?: boolean } = {},
): Promise<IamGroup> {
  const res = await adminFetch(`/api/admin/groups/${id}/clone`, 'POST', req);
  return safeJson(res);
}

export async function updateGroup(id: number, req: UpdateGroupRequest): Promise<IamGroup> {
  const res = await adminFetch(`/api/admin/groups/${id}`, 'PUT', req);
  return safeJson(res);
}

export async function deleteGroup(id: number): Promise<void> {
  const res = await adminFetch(`/api/admin/groups/${id}`, 'DELETE');
  if (!res.ok) await throwApiError(res, `Delete group ${id}`);
}

export async function addGroupMember(groupId: number, userId: number): Promise<void> {
  const res = await adminFetch(`/api/admin/groups/${groupId}/members`, 'POST', { user_id: userId });
  if (!res.ok) await throwApiError(res, `Add member ${userId} to group ${groupId}`);
}

export async function removeGroupMember(groupId: number, userId: number): Promise<void> {
  const res = await adminFetch(`/api/admin/groups/${groupId}/members/${userId}`, 'DELETE');
  if (!res.ok) await throwApiError(res, `Remove member ${userId} from group ${groupId}`);
}
