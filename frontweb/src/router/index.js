import { createRouter, createWebHistory } from 'vue-router'
import { readSession } from '@/utils/authSession'
import { authRedirect } from '@/utils/authGuard'

const publicPlatformMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { title: '登录' }
    },
    {
      path: '/',
      name: 'list',
      component: () => import('@/views/FilmList.vue'),
      meta: { title: '项目列表' }
    },
    {
      path: '/drama/:id',
      name: 'drama-detail',
      component: () => import('@/views/DramaDetail.vue'),
      meta: { title: '剧集管理' }
    },
    {
      path: '/film/:id',
      name: 'film',
      component: () => import('@/views/FilmCreate.vue'),
      meta: { title: 'AI 视频生成' }
    },
    {
      path: '/film/:id/canvas',
      name: 'film-canvas',
      component: () => import('@/views/DramaCanvas.vue'),
      meta: { title: '画布模式' }
    },
    {
      path: '/canvas',
      name: 'home-canvas',
      component: () => import('@/views/HomeCanvas.vue'),
      meta: { title: '首页自由画布' }
    },
    {
      path: '/ai-config',
      name: 'ai-config',
      component: () => import('@/views/AiConfig.vue'),
      meta: { title: 'AI 配置' }
    },
    {
      path: '/billing-admin',
      name: 'billing-admin',
      component: () => import('@/views/BillingAdmin.vue'),
      meta: { title: '平台管理后台', roles: ['admin'] }
    },
    {
      path: '/account-admin',
      name: 'account-admin',
      component: () => import('@/views/AccountAdmin.vue'),
      meta: {
        title: '账号与权限',
        roles: ['admin', 'ops', 'support', 'read_only']
      }
    },
    {
      path: '/tenant-console',
      name: 'tenant-console',
      component: () => import('@/views/TenantConsole.vue'),
      meta: { title: '工作区与积分' }
    },
    {
      path: '/free-create',
      name: 'free-create',
      component: () => import('@/views/FreeCreate.vue'),
      meta: { title: '自由创作' }
    },
    {
      path: '/media-library',
      name: 'media-library',
      component: () => import('@/views/MediaLibrary.vue'),
      meta: { title: '媒体素材库' }
    }
  ]
})

router.beforeEach((to) => {
  if (to.meta.title) {
    document.title = `${to.meta.title} - 茉莉妈妈短剧制作平台`
  }
  return authRedirect(publicPlatformMode, to, readSession()) || true
})

export default router
