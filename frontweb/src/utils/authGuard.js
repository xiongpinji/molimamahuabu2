export function authRedirect(publicMode, to, session) {
  if (!publicMode || to.name === 'login' || session?.token) return null
  return { name: 'login', query: { redirect: to.fullPath || to.path || '/' } }
}
