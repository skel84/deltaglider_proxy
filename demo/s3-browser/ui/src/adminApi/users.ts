// === IAM User Management ===
import { throwApiError } from '../errorHandling';
import { adminFetch, safeJson } from './core';

export interface IamPermission {
  id: number;
  effect?: string; // "Allow" or "Deny", defaults to "Allow"
  actions: string[];
  resources: string[];
  conditions?: Record<string, Record<string, string | string[]>>;
}

export interface IamUser {
  id: number;
  name: string;
  access_key_id: string;
  secret_access_key?: string;
  enabled: boolean;
  created_at: string;
  permissions: IamPermission[];
  /** Group IDs this user belongs to. Populated by the server on every
   *  `/users` fetch. Used by the list panel to distinguish a user with
   *  no direct policies but inherited permissions from a truly-no-access
   *  user (UX-5). */
  group_ids?: number[];
  auth_source?: string; // "local" or "external"
}

export interface CreateUserRequest {
  name: string;
  access_key_id?: string;
  secret_access_key?: string;
  enabled?: boolean;
  permissions: IamPermission[];
}

export interface UpdateUserRequest {
  name?: string;
  enabled?: boolean;
  permissions?: IamPermission[];
}

export async function getUsers(): Promise<IamUser[]> {
  const res = await adminFetch('/api/admin/users');
  return safeJson(res);
}

export async function createUser(req: CreateUserRequest): Promise<IamUser> {
  const res = await adminFetch('/api/admin/users', 'POST', req);
  return safeJson(res);
}

export async function cloneUser(
  id: number,
  req: { name?: string; copy_group_memberships?: boolean } = {},
): Promise<IamUser> {
  const res = await adminFetch(`/api/admin/users/${id}/clone`, 'POST', req);
  return safeJson(res);
}

export async function updateUser(id: number, req: UpdateUserRequest): Promise<IamUser> {
  const res = await adminFetch(`/api/admin/users/${id}`, 'PUT', req);
  return safeJson(res);
}

export async function deleteUser(id: number): Promise<void> {
  const res = await adminFetch(`/api/admin/users/${id}`, 'DELETE');
  if (!res.ok) await throwApiError(res, `Delete user ${id}`);
}

export async function rotateUserKeys(
  id: number,
  accessKeyId?: string,
  secretAccessKey?: string,
): Promise<IamUser> {
  const body: Record<string, string> = {};
  if (accessKeyId) body.access_key_id = accessKeyId;
  if (secretAccessKey) body.secret_access_key = secretAccessKey;
  const res = await adminFetch(
    `/api/admin/users/${id}/rotate-keys`,
    'POST',
    Object.keys(body).length > 0 ? body : undefined,
  );
  return safeJson(res);
}
