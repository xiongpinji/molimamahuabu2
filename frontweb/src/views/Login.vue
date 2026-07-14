<template>
  <main class="login-page">
    <section class="login-card">
      <img class="brand-image" src="/moli-mama-logo.png" alt="茉莉妈妈" />
      <div class="brand-copy">
        <h1>茉莉妈妈</h1>
        <p>短剧制作平台</p>
      </div>

      <el-form class="login-form" label-position="top" @submit.prevent="submit">
        <el-form-item label="邮箱">
          <el-input v-model.trim="email" type="email" autocomplete="username" placeholder="请输入登录邮箱" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" autocomplete="current-password" show-password placeholder="请输入密码" @keyup.enter="submit" />
        </el-form-item>
        <el-button class="login-button" type="primary" :loading="loading" @click="submit">登录平台</el-button>
      </el-form>
      <p class="safe-tip">为保护模型额度，公开平台必须登录后才能生成内容。</p>
    </section>
  </main>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { login } from '@/api/auth'
import { saveSession } from '@/utils/authSession'

const route = useRoute()
const router = useRouter()
const email = ref('')
const password = ref('')
const loading = ref(false)

async function submit() {
  if (!email.value || !password.value) return ElMessage.warning('请输入邮箱和密码')
  loading.value = true
  try {
    const session = await login({ email: email.value, password: password.value })
    saveSession(session)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/'
    await router.replace(redirect)
    ElMessage.success('登录成功')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #fff2f5, #f7f8fb 55%); }
.login-card { width: min(420px, 100%); padding: 32px; border: 1px solid rgba(225, 120, 145, .18); border-radius: 24px; background: rgba(255, 255, 255, .94); box-shadow: 0 24px 70px rgba(81, 45, 54, .12); }
.brand-image { display: block; width: 92px; height: 92px; margin: 0 auto 12px; border-radius: 24px; object-fit: cover; }
.brand-copy { text-align: center; margin-bottom: 28px; }
.brand-copy h1 { margin: 0; color: #31262a; font-size: 30px; letter-spacing: 3px; }
.brand-copy p { margin: 7px 0 0; color: #8d727a; font-size: 14px; letter-spacing: 5px; }
.login-form { margin-top: 4px; }
.login-button { width: 100%; height: 44px; margin-top: 6px; border: 0; background: linear-gradient(135deg, #ef8ca4, #dd6d8d); }
.safe-tip { margin: 18px 0 0; color: #a08c92; font-size: 12px; line-height: 1.7; text-align: center; }
</style>
