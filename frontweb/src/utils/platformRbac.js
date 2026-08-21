export const ACCOUNT_PERMISSIONS = Object.freeze({
  READ: 'platform.users.read',
  ROLE: 'platform.users.role',
  STATUS: 'platform.users.status',
  FORCE_LOGOUT: 'platform.users.force_logout',
})

export const BILLING_PERMISSIONS = Object.freeze({
  MANAGE: 'platform.billing.manage',
  REDEEM_CODES_MANAGE: 'platform.redeem_codes.manage',
})

const ROLE_PERMISSIONS = Object.freeze({
  admin: [...Object.values(ACCOUNT_PERMISSIONS), ...Object.values(BILLING_PERMISSIONS)],
  ops: [
    ACCOUNT_PERMISSIONS.READ,
    ACCOUNT_PERMISSIONS.STATUS,
    ACCOUNT_PERMISSIONS.FORCE_LOGOUT,
  ],
  support: [ACCOUNT_PERMISSIONS.READ, ACCOUNT_PERMISSIONS.FORCE_LOGOUT],
  read_only: [ACCOUNT_PERMISSIONS.READ],
  redeem_admin: [BILLING_PERMISSIONS.REDEEM_CODES_MANAGE],
  user: [],
})

export function canPlatformAccount(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission)
}
