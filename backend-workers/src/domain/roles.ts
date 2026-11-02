/** The four system roles (PDF §2), exactly the codes in the `roles` table. Mirrors Ims.Domain.Roles.UserRole. */
export const USER_ROLES = ['Admin', 'HR', 'Trainee', 'Employee'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** The roles a staff member can hold (PDF §8: Employee / HR / Admin). */
export const STAFF_ROLES: readonly UserRole[] = ['Employee', 'HR', 'Admin'];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}
