import axios from 'axios'
import { ElMessage } from 'element-plus'
import {
  applyAdminHeader,
  applyAuthHeader,
  applyTenantHeader,
  clearSessionOnUnauthorized,
} from './authSession'
import { apiErrorMessage, userHttpErrorMessage } from './httpError'

const request = axios.create({
  baseURL: '/api/v1',
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' }
})

request.interceptors.request.use((config) => applyAdminHeader(applyTenantHeader(applyAuthHeader(config))))

request.interceptors.response.use(
  (response) => {
    // blob 类型直接返回原始数据，不做 JSON 解包
    if (response.config?.responseType === 'blob') {
      return response.data
    }
    const res = response.data
    if (res.success !== false) {
      return res.data !== undefined ? res.data : res
    }
    return Promise.reject(new Error(apiErrorMessage(res, '请求失败')))
  },
  (error) => {
    const unauthorized = Number(error.response?.status) === 401
    const authorization = error.config?.headers?.get?.('Authorization')
      || error.config?.headers?.Authorization
      || error.config?.headers?.authorization
      || ''
    const requestToken = /^Bearer\s+(.+)$/i.exec(String(authorization))?.[1] || ''
    const errorCode = error.response?.data?.error?.code
    if (clearSessionOnUnauthorized(error.response?.status, true, undefined, requestToken, errorCode)
      && typeof window !== 'undefined'
      && window.location.pathname !== '/'
      && window.location.pathname !== '/login') {
      const redirect = `${window.location.pathname}${window.location.search}`
      window.location.assign(`/login?redirect=${encodeURIComponent(redirect)}`)
    }
    // 提取后端实际错误信息（优先 API 返回的 message，而非 axios 通用 "status code 500"）
    const backendMsg = apiErrorMessage(error.response?.data)
    const msg = userHttpErrorMessage(error)
    if (!unauthorized && !error.config?.silentError) ElMessage.error(msg)
    // 将真实错误信息写回 message，使组件 catch 块可直接用 e.message 获取可读内容
    if (backendMsg || msg !== error.message) error.message = msg
    return Promise.reject(error)
  }
)

export default request
