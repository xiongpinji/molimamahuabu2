export function authRedirect(publicMode, to, session) {
  if (to.name === 'login' || to.meta?.public) return null
  // 本地单用户模式后端不鉴权；前端也不再因 requiresAuth 把人拦到无法登录的页面
  if (!publicMode) return null
  if (!session?.token) {
    return { name: 'login', query: { redirect: to.fullPath || to.path || '/' } }
  }
  if (Array.isArray(to.meta?.roles) && !to.meta.roles.includes(session.user?.role)) {
    return { name: 'list' }
  }
  return null
}
