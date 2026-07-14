import { z } from "zod";

export const LocalUserRoleSchema = z.enum([
  "developer",
  "admin",
  "operator",
  "viewer",
]);
export type LocalUserRole = z.infer<typeof LocalUserRoleSchema>;

export const AppPermissionSchema = z.enum([
  "system:control",
  "users:manage",
  "accounts:manage",
  "rules:manage",
  "automation:execute",
  "ads:operate",
  "launch:manage",
]);
export type AppPermission = z.infer<typeof AppPermissionSchema>;

const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{2,31}$/, "用户名需以字母开头，只能包含字母、数字、下划线和短横线。");

export const StrongPasswordSchema = z
  .string()
  .min(12, "密码至少需要 12 位。")
  .max(128)
  .refine(
    (value) =>
      /[a-z]/.test(value) &&
      /[A-Z]/.test(value) &&
      /\d/.test(value) &&
      /[^A-Za-z0-9]/.test(value),
    "密码必须同时包含大写字母、小写字母、数字和符号。",
  );

export const LoginInputSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const InitialDeveloperInputSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().trim().min(1).max(80),
  password: StrongPasswordSchema,
});
export type InitialDeveloperInput = z.infer<
  typeof InitialDeveloperInputSchema
>;

export const LocalUserCreateInputSchema = InitialDeveloperInputSchema.extend({
  role: LocalUserRoleSchema,
});
export type LocalUserCreateInput = z.infer<typeof LocalUserCreateInputSchema>;

export const LocalUserUpdateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  role: LocalUserRoleSchema,
  enabled: z.boolean(),
});
export type LocalUserUpdateInput = z.infer<typeof LocalUserUpdateInputSchema>;

export const PasswordChangeInputSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: StrongPasswordSchema,
});
export type PasswordChangeInput = z.infer<typeof PasswordChangeInputSchema>;

export const LocalUserRecordSchema = z.object({
  id: z.string().min(1),
  username: UsernameSchema,
  displayName: z.string().min(1),
  role: LocalUserRoleSchema,
  enabled: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LocalUserRecord = z.infer<typeof LocalUserRecordSchema>;

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
  user: LocalUserRecord | null;
  permissions: AppPermission[];
  csrfToken: string | null;
}

const permissionMap: Record<LocalUserRole, AppPermission[]> = {
  developer: AppPermissionSchema.options,
  admin: [
    "system:control",
    "users:manage",
    "accounts:manage",
    "rules:manage",
    "automation:execute",
    "ads:operate",
    "launch:manage",
  ],
  operator: [
    "accounts:manage",
    "automation:execute",
    "ads:operate",
    "launch:manage",
  ],
  viewer: [],
};

export function permissionsForRole(role: LocalUserRole): AppPermission[] {
  return [...permissionMap[role]];
}

