<template>
  <main class="login-page">
    <section class="login-card">
      <img class="brand-image" src="/moli-mama-logo.png" alt="茉莉妈妈" />
      <div class="brand-copy">
        <h1>茉莉妈妈</h1>
        <p>短剧制作平台</p>
      </div>

      <div class="auth-tabs" role="tablist" aria-label="账号操作">
        <button
          v-for="item in modes"
          :key="item.value"
          type="button"
          role="tab"
          :aria-selected="mode === item.value"
          :class="{ active: mode === item.value }"
          @click="switchMode(item.value)"
        >
          {{ item.label }}
        </button>
      </div>

      <el-form class="login-form" label-position="top" @submit.prevent="submit">
        <el-form-item label="邮箱">
          <el-input v-model.trim="email" type="email" autocomplete="username" placeholder="请输入邮箱" />
        </el-form-item>

        <el-form-item v-if="mode !== 'login'" label="邮箱验证码">
          <div class="code-row">
            <el-input
              v-model.trim="verificationCode"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="6 位验证码"
            />
            <el-button :disabled="countdown > 0" :loading="codeLoading" @click="sendCode">
              {{ countdown > 0 ? `${countdown} 秒` : '获取验证码' }}
            </el-button>
          </div>
        </el-form-item>

        <el-form-item :label="mode === 'login' ? '密码' : '新密码'">
          <el-input
            v-model="password"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            show-password
            placeholder="至少 12 个字符"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-form-item v-if="mode !== 'login'" label="确认新密码">
          <el-input
            v-model="passwordConfirm"
            type="password"
            autocomplete="new-password"
            show-password
            placeholder="再次输入新密码"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-button class="login-button" type="primary" :loading="loading" @click="submit">
          {{ submitLabel }}
        </el-button>
      </el-form>
      <p class="safe-tip">
        {{ mode === 'login'
          ? '公开平台必须登录后才能生成内容。'
          : '验证码 10 分钟内有效，平台不会在邮件中索要密码。' }}
      </p>
    </section>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  login,
  register,
  requestPasswordResetCode,
  requestRegistrationCode,
  resetPassword,
} from '@/api/auth'
import { saveSession } from '@/utils/authSession'

const route = useRoute()
const router = useRouter()
const modes = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
  { value: 'reset', label: '找回密码' },
]
const mode = ref('login')
const email = ref('')
const password = ref('')
const passwordConfirm = ref('')
const verificationCode = ref('')
const loading = ref(false)
const codeLoading = ref(false)
const countdown = ref(0)
let countdownTimer

const submitLabel = computed(() => ({
  login: '登录平台',
  register: '注册并登录',
  reset: '重置密码',
}[mode.value]))

function switchMode(value) {
  mode.value = value
  password.value = ''
  passwordConfirm.value = ''
  verificationCode.value = ''
}

function startCountdown() {
  clearInterval(countdownTimer)
  countdown.value = 60
  countdownTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) clearInterval(countdownTimer)
  }, 1000)
}

async function sendCode() {
  if (!email.value) return ElMessage.warning('请先输入邮箱')
  codeLoading.value = true
  try {
    if (mode.value === 'register') {
      await requestRegistrationCode({ email: email.value })
    } else {
      await requestPasswordResetCode({ email: email.value })
    }
    startCountdown()
    ElMessage.success('验证码已发送，请检查邮箱')
  } finally {
    codeLoading.value = false
  }
}

function validateNewPassword() {
  if (!verificationCode.value) {
    ElMessage.warning('请输入邮箱验证码')
    return false
  }
  if (password.value.length < 12) {
    ElMessage.warning('密码至少需要 12 个字符')
    return false
  }
  if (password.value !== passwordConfirm.value) {
    ElMessage.warning('两次输入的密码不一致')
    return false
  }
  return true
}

async function submit() {
  if (!email.value || !password.value) return ElMessage.warning('请输入邮箱和密码')
  if (mode.value !== 'login' && !validateNewPassword()) return
  loading.value = true
  try {
    if (mode.value === 'reset') {
      await resetPassword({
        email: email.value,
        verification_code: verificationCode.value,
        new_password: password.value,
      })
      switchMode('login')
      ElMessage.success('密码已重置，请使用新密码登录')
      return
    }
    const session = mode.value === 'register'
      ? await register({
        email: email.value,
        password: password.value,
        verification_code: verificationCode.value,
      })
      : await login({ email: email.value, password: password.value })
    saveSession(session)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/'
    await router.replace(redirect)
    ElMessage.success(mode.value === 'register' ? '注册成功' : '登录成功')
  } finally {
    loading.value = false
  }
}

onBeforeUnmount(() => clearInterval(countdownTimer))
</script>

<style scoped>
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #fff2f5, #f7f8fb 55%); }
.login-card { width: min(440px, 100%); padding: 32px; border: 1px solid rgba(225, 120, 145, .18); border-radius: 24px; background: rgba(255, 255, 255, .94); box-shadow: 0 24px 70px rgba(81, 45, 54, .12); }
.brand-image { display: block; width: 92px; height: 92px; margin: 0 auto 12px; border-radius: 24px; object-fit: cover; }
.brand-copy { margin-bottom: 22px; text-align: center; }
.brand-copy h1 { margin: 0; color: #31262a; font-size: 30px; letter-spacing: 3px; }
.brand-copy p { margin: 7px 0 0; color: #8d727a; font-size: 14px; letter-spacing: 5px; }
.auth-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 22px; padding: 5px; border-radius: 13px; background: #f6eef1; }
.auth-tabs button { padding: 9px 6px; border: 0; border-radius: 9px; color: #8d727a; background: transparent; cursor: pointer; }
.auth-tabs button.active { color: #9b3f5d; background: #fff; box-shadow: 0 4px 16px rgba(93, 52, 66, .1); font-weight: 700; }
.login-form { margin-top: 4px; }
.code-row { display: grid; grid-template-columns: minmax(0, 1fr) 118px; gap: 10px; width: 100%; }
.login-button { width: 100%; height: 44px; margin-top: 6px; border: 0; background: linear-gradient(135deg, #ef8ca4, #dd6d8d); }
.safe-tip { margin: 18px 0 0; color: #a08c92; font-size: 12px; line-height: 1.7; text-align: center; }
</style>
