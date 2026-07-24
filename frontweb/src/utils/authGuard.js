export function authRedirect(publicMode, to, session) {
  if (!publicMode || to.name === 'login') return null
  if (!session?.token) {
    return { name: 'login', query: { redirect: to.fullPath || to.path || '/' } }
  }
  if (Array.isArray(to.meta?.roles) && !to.meta.roles.includes(session.user?.role)) {
    return { name: 'list' }
  }
  return null
}
