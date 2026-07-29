export function authRedirect(publicMode, to, session) {
  if (to.name === 'login' || to.meta?.public) return null
  if (!publicMode && !to.meta?.requiresAuth) return null
  if (!session?.token) {
    return { name: 'login', query: { redirect: to.fullPath || to.path || '/' } }
  }
  if (Array.isArray(to.meta?.roles) && !to.meta.roles.includes(session.user?.role)) {
    return { name: 'list' }
  }
  return null
}
