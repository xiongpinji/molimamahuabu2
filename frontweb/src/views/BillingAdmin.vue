<template>
  <AdminWorkspaceShell
    title="运营与计费"
    header-title="平台管理后台"
    eyebrow="平台运营控制台"
    :description="isSuperAdmin
      ? '统一管理充值套餐、兑换码、积分流水、成本利润、对账和每个模型的独立计费规则。'
      : '生成、查询和停用平台兑换码。'"
  >
    <section v-if="requiresAdminToken && !unlocked" class="unlock-panel" aria-labelledby="unlock-title">
      <div>
        <p class="panel-kicker">敏感操作保护</p>
        <h2 id="unlock-title">验证管理员身份</h2>
        <p>令牌仅保存在当前浏览器会话，用于调用现有平台管理接口。</p>
      </div>
      <div class="admin-auth">
        <el-input
          v-model="adminToken"
          type="password"
          show-password
          autocomplete="off"
          placeholder="输入平台管理员令牌"
        />
        <el-button type="primary" :loading="loading" @click="unlock">验证并读取</el-button>
      </div>
      <el-alert
        title="管理员令牌只保存在当前浏览器会话，不会写入长期存储。"
        type="info"
        :closable="false"
      />
    </section>

    <template v-else>
      <section v-if="isSuperAdmin" class="billing-summary" aria-label="运营概览">
        <article>
          <span>计费模型</span>
          <strong>{{ prices.length }}</strong>
        </article>
        <article>
          <span>平台账号</span>
          <strong>{{ users.length }}</strong>
        </article>
        <article>
          <span>工作区</span>
          <strong>{{ tenants.length }}</strong>
        </article>
        <article>
          <span>积分流水</span>
          <strong>{{ transactions.length }}</strong>
        </article>
      </section>

      <el-tabs v-model="activeTab" class="admin-tabs">
        <el-tab-pane v-if="isSuperAdmin" label="充值套餐" name="recharge">
          <section class="panel">
            <RechargePackageAdminPanel />
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="模型计费" name="models">
          <section class="panel">
            <div class="panel-heading model-heading">
              <div>
                <h2>模型计费</h2>
                <p>自动汇总 AI 配置中的实际模型；连接验证并启用计费后自动进入画布，无需修改前端代码。</p>
              </div>
              <el-button type="primary" :loading="syncingProviderPricing" @click="syncProviderPricingNow">
                同步中转站成本
              </el-button>
            </div>
            <div class="model-pricing-summary" aria-label="模型计费状态">
              <el-tag type="success">已定价 {{ configuredModelCount }}</el-tag>
              <el-tag type="warning">未定价 {{ unconfiguredModelCount }}</el-tag>
              <el-tag type="info">已停用 {{ disabledModelCount }}</el-tag>
            </div>
            <el-alert
              v-if="providerConfigId"
              title="当前仅显示所选中转站配置下的模型"
              type="info"
              :closable="false"
              show-icon
            />
            <div class="model-filters">
              <el-input
                v-model.trim="modelSearch"
                clearable
                placeholder="搜索模型名称、ID 或公开备注"
              />
              <el-select v-model="modelCategory" aria-label="模型类型筛选">
                <el-option label="全部类型" value="all" />
                <el-option label="文本" value="text" />
                <el-option label="图片" value="image" />
                <el-option label="视频" value="video" />
                <el-option label="音频" value="audio" />
                <el-option label="其他" value="other" />
              </el-select>
              <el-select v-model="modelPricingState" aria-label="计费状态筛选">
                <el-option label="全部状态" value="all" />
                <el-option label="已定价" value="configured" />
                <el-option label="未定价" value="unconfigured" />
                <el-option label="已停用" value="disabled" />
              </el-select>
            </div>
            <div class="model-list">
              <template v-for="group in filteredPriceGroups" :key="group.key">
                <div class="model-provider-group">
                  <div class="model-provider-group-heading">
                    <div>
                      <strong>{{ group.label }}</strong>
                      <small>{{ group.baseUrl || '未配置中转站地址' }}</small>
                    </div>
                    <el-tag type="info" size="small">{{ group.items.length }} 个模型</el-tag>
                  </div>
                </div>
                <div v-for="item in group.items" :key="`${group.key}:${item.model}`" class="model-row">
                <label class="model-field"><span>前端显示名称</span><el-input v-model="item.display_name" maxlength="120" show-word-limit placeholder="画布下拉中展示的名称" /></label>
                <label class="model-field">
                  <span>模型类型</span>
                  <el-select v-model="item.category">
                    <el-option label="文本" value="text" />
                    <el-option label="图片" value="image" />
                    <el-option label="视频" value="video" />
                    <el-option label="音频" value="audio" />
                    <el-option label="其他" value="other" />
                  </el-select>
                </label>
                <label v-if="!usesVideoResolutionPricing(item) && !usesImageResolutionPricing(item)" class="model-field">
                  <span>用户收费（积分）</span>
                  <el-input-number v-model="item.credits" :min="1" :step="1" step-strictly />
                </label>
                <div v-if="usesImageResolutionPricing(item)" class="resolution-pricing-editor">
                  <template v-for="resolution in resolutionKeys(item)" :key="resolution">
                    <label class="model-field">
                      <span>{{ imageResolutionLabels[resolution].credits }}</span>
                      <el-input-number v-model="item.resolution_prices[resolution].credits" :min="1" :step="1" step-strictly />
                    </label>
                    <label class="model-field">
                      <span>{{ imageResolutionLabels[resolution].cost }}</span>
                      <el-input-number v-model="item.resolution_prices[resolution].cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" />
                    </label>
                  </template>
                </div>
                <div v-else-if="usesVideoResolutionPricing(item)" class="resolution-pricing-editor">
                  <label class="model-field">
                    <span>用户计费模式</span>
                    <el-select v-model="item.billing_unit">
                      <el-option label="按次计费" value="request" />
                      <el-option label="按秒计费" value="second" />
                    </el-select>
                  </label>
                  <template v-for="resolution in resolutionKeys(item)" :key="resolution">
                    <label class="model-field">
                      <span v-if="item.billing_unit === 'request'">{{ videoResolutionLabels[resolution] }} 用户收费（积分/次）</span>
                      <span v-else>{{ videoResolutionLabels[resolution] }} 用户收费（积分/秒）</span>
                      <el-input-number v-model="item.resolution_prices[resolution].credits" :min="1" :step="1" step-strictly />
                    </label>
                    <label class="model-field"><span>{{ videoResolutionLabels[resolution] }} API 成本（元/秒）</span><el-input-number v-model="item.resolution_prices[resolution].cost_yuan_per_second" :min="0" :precision="6" :step="0.01" /></label>
                  </template>
                </div>
                <label class="model-field">
                  <span>计费状态</span>
                  <el-select v-model="item.status">
                    <el-option label="启用" value="enabled" />
                    <el-option label="停用" value="disabled" />
                  </el-select>
                </label>
                <el-button :loading="savingModel === item.model" @click="saveModel(item)">保存</el-button>
                <label class="model-field model-public-note">
                  <span>用户公开备注（可选）</span>
                  <el-input
                    v-model="item.public_note"
                    type="textarea"
                    :rows="2"
                    maxlength="500"
                    show-word-limit
                    placeholder="展示给用户的模型说明"
                  />
                </label>
                <small>
                  {{ item.model }} · {{ formatModelPrice(item) }}
                  <el-tag v-if="!item.configured" type="warning" size="small">未定价</el-tag>
                </small>
                <small class="model-provider" :title="providerBaseUrl(item)">
                  中转站：{{ providerLabel(item) }}
                </small>
                <small class="model-provider-cost">
                  <template v-if="item.provider_costs?.length">
                    中转站成本：{{ formatProviderCosts(item) }}
                  </template>
                  <template v-else>中转站成本：未同步</template>
                </small>
                <div v-if="!usesVideoResolutionPricing(item) && !usesImageResolutionPricing(item)" class="cost-editor">
                  <span>API 成本</span>
                  <el-select v-if="!usesFixedRequestVideoPricing(item)" v-model="item.cost_unit">
                    <el-option label="按次" value="request" />
                    <el-option label="按张" value="image" />
                    <el-option label="按秒" value="second" />
                    <el-option label="按 Token" value="token" />
                  </el-select>
                  <span v-else>按次</span>
                  <template v-if="item.cost_unit === 'token'">
                    <el-input-number v-model="item.input_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" />
                    <span>元 / 千输入 Token</span>
                    <el-input-number v-model="item.output_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" />
                    <span>元 / 千输出 Token</span>
                  </template>
                  <template v-else>
                    <el-input-number v-model="item.cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" />
                    <span>元 / {{ costUnitLabel(item.cost_unit) }}</span>
                  </template>
                </div>
                </div>
              </template>
              <el-empty v-if="filteredPriceGroups.length === 0" description="没有匹配的模型" />
            </div>
            <div class="new-model">
              <label class="model-field"><span>模型 ID</span><el-input v-model.trim="newModel.model" /></label>
              <label class="model-field"><span>前端显示名称</span><el-input v-model.trim="newModel.display_name" maxlength="120" show-word-limit placeholder="画布下拉中展示的名称" /></label>
              <label class="model-field">
                <span>模型类型</span>
                <el-select v-model="newModel.category">
                  <el-option label="文本" value="text" />
                  <el-option label="图片" value="image" />
                  <el-option label="视频" value="video" />
                  <el-option label="音频" value="audio" />
                  <el-option label="其他" value="other" />
                </el-select>
              </label>
              <label v-if="!usesVideoResolutionPricing(newModel) && !usesImageResolutionPricing(newModel)" class="model-field"><span>用户收费（积分）</span><el-input-number v-model="newModel.credits" :min="1" :step="1" step-strictly /></label>
              <div v-if="usesImageResolutionPricing(newModel)" class="resolution-pricing-editor">
                <template v-for="resolution in resolutionKeys(newModel)" :key="resolution">
                  <label class="model-field">
                    <span>{{ imageResolutionLabels[resolution].credits }}</span>
                    <el-input-number v-model="newModel.resolution_prices[resolution].credits" :min="1" :step="1" step-strictly />
                  </label>
                  <label class="model-field">
                    <span>{{ imageResolutionLabels[resolution].cost }}</span>
                    <el-input-number v-model="newModel.resolution_prices[resolution].cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" />
                  </label>
                </template>
              </div>
              <div v-else-if="usesVideoResolutionPricing(newModel)" class="resolution-pricing-editor">
                <label class="model-field">
                  <span>用户计费模式</span>
                  <el-select v-model="newModel.billing_unit">
                    <el-option label="按次计费" value="request" />
                    <el-option label="按秒计费" value="second" />
                  </el-select>
                </label>
                <template v-for="resolution in resolutionKeys(newModel)" :key="resolution">
                  <label class="model-field">
                    <span v-if="newModel.billing_unit === 'request'">{{ videoResolutionLabels[resolution] }} 用户收费（积分/次）</span>
                    <span v-else>{{ videoResolutionLabels[resolution] }} 用户收费（积分/秒）</span>
                    <el-input-number v-model="newModel.resolution_prices[resolution].credits" :min="1" :step="1" step-strictly />
                  </label>
                  <label class="model-field"><span>{{ videoResolutionLabels[resolution] }} API 成本（元/秒）</span><el-input-number v-model="newModel.resolution_prices[resolution].cost_yuan_per_second" :min="0" :precision="6" :step="0.01" /></label>
                </template>
              </div>
              <label v-if="!usesFixedRequestVideoPricing(newModel) && !usesVideoResolutionPricing(newModel) && !usesImageResolutionPricing(newModel)" class="model-field">
                <span>平台成本单位</span>
                <el-select v-model="newModel.cost_unit">
                  <el-option label="按次成本" value="request" />
                  <el-option label="按张成本" value="image" />
                  <el-option label="按秒成本" value="second" />
                  <el-option label="按 Token 成本" value="token" />
                </el-select>
              </label>
              <template v-if="!usesFixedRequestVideoPricing(newModel) && !usesVideoResolutionPricing(newModel) && !usesImageResolutionPricing(newModel) && newModel.cost_unit === 'token'">
                <label class="model-field"><span>千输入 Token 成本（元）</span><el-input-number v-model="newModel.input_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" /></label>
                <label class="model-field"><span>千输出 Token 成本（元）</span><el-input-number v-model="newModel.output_cost_yuan_per_1k" :min="0" :precision="6" :step="0.001" /></label>
              </template>
              <label v-else-if="!usesVideoResolutionPricing(newModel) && !usesImageResolutionPricing(newModel)" class="model-field"><span>单位成本（元）</span><el-input-number v-model="newModel.cost_yuan_per_unit" :min="0" :precision="6" :step="0.01" /></label>
              <label class="model-field model-public-note">
                <span>用户公开备注（可选）</span>
                <el-input
                  v-model.trim="newModel.public_note"
                  type="textarea"
                  :rows="2"
                  maxlength="500"
                  show-word-limit
                  placeholder="展示给用户的模型说明"
                />
              </label>
              <el-button type="primary" :loading="savingModel === newModel.model" @click="addModel">
                新增模型
              </el-button>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="经营台账" name="ledger">
          <section class="panel">
            <div class="panel-heading ledger-heading">
              <div>
                <h2>经营台账</h2>
                <p>按模型核算积分消耗、API 成本与预计利润；文本及推理模型按输入、输出 Token 统计。</p>
              </div>
              <div class="ledger-controls">
                <el-select v-model="ledgerPeriod" @change="loadLedgerReport">
                  <el-option label="日报" value="day" />
                  <el-option label="月报" value="month" />
                  <el-option label="年报" value="year" />
                </el-select>
                <el-input-number
                  v-model="creditValueYuan"
                  :min="0"
                  :precision="6"
                  :step="0.01"
                  aria-label="每积分估值"
                />
                <span>元 / 积分</span>
                <el-input-number
                  v-model="usdCnyRate"
                  :min="0.000001"
                  :precision="6"
                  :step="0.01"
                  aria-label="美元兑人民币汇率"
                />
                <span>元 / 美元</span>
                <el-button :loading="savingLedgerSettings" @click="saveLedgerSettings">保存估值</el-button>
              </div>
            </div>
            <el-alert
              title="收入与利润为估算值：预计收入 = 消耗积分 × 每积分估值；推理 Token 已包含在输出 Token 中，不重复计费。"
              type="info"
              :closable="false"
            />
            <div class="ledger-summary">
              <article><span>调用量</span><strong>{{ ledgerReport.summary.usage_count }}</strong></article>
              <article><span>消耗积分</span><strong>{{ ledgerReport.summary.credits_consumed }}</strong></article>
              <article><span>API 成本</span><strong>{{ formatMoney(ledgerReport.summary.cost_micros) }}</strong></article>
              <article><span>预计利润</span><strong>{{ formatMoney(ledgerReport.summary.estimated_profit_micros) }}</strong></article>
            </div>
            <el-table :data="ledgerReport.rows" empty-text="暂无已完成的生成记录">
              <el-table-column prop="period" label="周期" width="110" />
              <el-table-column prop="model" label="模型" min-width="180" />
              <el-table-column prop="resource_type" label="类型" width="100" />
              <el-table-column prop="resolution" label="分辨率" width="90" />
              <el-table-column prop="usage_count" label="调用量" width="90" />
              <el-table-column prop="credits_consumed" label="消耗积分" width="100" />
              <el-table-column prop="input_tokens" label="输入 Token" width="120" />
              <el-table-column prop="output_tokens" label="输出 Token" width="120" />
              <el-table-column prop="reasoning_tokens" label="推理 Token" width="120" />
              <el-table-column label="API 成本" width="120">
                <template #default="{ row }">{{ formatMoney(row.cost_micros) }}</template>
              </el-table-column>
              <el-table-column label="预计收入" width="120">
                <template #default="{ row }">{{ formatMoney(row.estimated_revenue_micros) }}</template>
              </el-table-column>
              <el-table-column label="预计利润" width="120">
                <template #default="{ row }">{{ formatMoney(row.estimated_profit_micros) }}</template>
              </el-table-column>
              <el-table-column prop="uncosted_usage_count" label="未取得用量" width="110" />
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane label="兑换码" name="codes">
          <RedeemOperationsPanel :users="users" :tenants="tenants" />
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="账号管理" name="accounts">
          <section class="panel">
            <el-table :data="users" empty-text="暂无账号">
              <el-table-column prop="email" label="邮箱" min-width="230" />
              <el-table-column label="平台角色" width="150">
                <template #default="{ row }">
                  <el-select v-model="row.role">
                    <el-option label="用户" value="user" />
                    <el-option label="总管理员" value="admin" />
                    <el-option label="兑换码管理员" value="redeem_admin" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="150">
                <template #default="{ row }">
                  <el-select v-model="row.status">
                    <el-option label="启用" value="active" />
                    <el-option label="停用" value="disabled" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column prop="tenant_count" label="工作区" width="90" />
              <el-table-column label="操作" width="100" align="right">
                <template #default="{ row }">
                  <el-button :loading="savingUser === row.id" @click="saveUser(row)">保存</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="积分流水" name="credits">
          <section class="panel">
            <div class="credit-form">
              <el-select v-model="creditForm.tenant_id" filterable placeholder="选择工作区">
                <el-option
                  v-for="tenant in tenants"
                  :key="tenant.id"
                  :label="`${tenant.name}（余额 ${tenant.available}）`"
                  :value="tenant.id"
                />
              </el-select>
              <el-input-number v-model="creditForm.amount" :step="100" step-strictly />
              <el-input v-model.trim="creditForm.reason" placeholder="调账原因" />
              <el-button type="primary" :loading="adjustingCredits" @click="submitAdjustment">确认调账</el-button>
            </div>
            <p class="field-hint">正数增加积分，负数扣回积分；扣回后余额不能小于零。</p>
            <el-table :data="transactions" empty-text="暂无积分流水">
              <el-table-column prop="tenant_name" label="工作区" min-width="160" />
              <el-table-column prop="amount" label="变动" width="100" />
              <el-table-column prop="reason" label="原因" min-width="200" />
              <el-table-column prop="event_type" label="类型" width="120" />
              <el-table-column label="时间" min-width="180">
                <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
              </el-table-column>
            </el-table>
          </section>
        </el-tab-pane>

        <el-tab-pane v-if="isSuperAdmin" label="积分对账" name="reconciliation">
          <BillingReconciliationPanel />
        </el-tab-pane>
      </el-tabs>
    </template>
  </AdminWorkspaceShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import AdminWorkspaceShell from '@/components/AdminWorkspaceShell.vue'
import RedeemOperationsPanel from '@/components/RedeemOperationsPanel.vue'
import BillingReconciliationPanel from '@/components/BillingReconciliationPanel.vue'
import RechargePackageAdminPanel from '@/components/RechargePackageAdminPanel.vue'
import {
  adjustTenantCredits,
  getLedgerReport,
  getLedgerSettings,
  listAdminCreditTransactions,
  listAdminTenants,
  listModelPrices,
  listPlatformUsers,
  syncProviderPricing,
  updateModelPrice,
  updateLedgerSettings,
  updatePlatformUser,
} from '@/api/billing'
import { readSession, saveAdminToken } from '@/utils/authSession'
import { formatModelPrice } from '@/utils/billingDisplay'
import {
  filterModelPricesByProviderConfig,
  groupModelPricesByProvider,
} from '@/utils/billingModelGroups'

const publicMode = /^(1|true|yes)$/i.test(String(import.meta.env.VITE_PUBLIC_PLATFORM_MODE || ''))
const route = useRoute()
const sessionRole = readSession()?.user?.role
const isSuperAdmin = sessionRole ? sessionRole === 'admin' : !publicMode
const requiresAdminToken = isSuperAdmin && publicMode && !sessionRole
const adminToken = ref('')
const loading = ref(false)
const unlocked = ref(!requiresAdminToken)
const requestedTab = String(route.query.tab || '')
const requestedModel = String(route.query.model || '').trim()
const requestedConfigId = Number(route.query.config_id)
const providerConfigId = Number.isSafeInteger(requestedConfigId) && requestedConfigId > 0
  ? requestedConfigId
  : null
const activeTab = ref(isSuperAdmin && ['recharge', 'models', 'ledger', 'codes', 'users', 'transactions', 'reconciliation'].includes(requestedTab)
  ? requestedTab
  : (isSuperAdmin ? 'models' : 'codes'))
const prices = ref([])
const users = ref([])
const tenants = ref([])
const transactions = ref([])
const savingModel = ref('')
const savingUser = ref('')
const adjustingCredits = ref(false)
const modelSearch = ref(requestedModel)
const modelCategory = ref('all')
const modelPricingState = ref('all')
const ledgerPeriod = ref('day')
const creditValueYuan = ref(0)
const usdCnyRate = ref(7.2)
const savingLedgerSettings = ref(false)
const syncingProviderPricing = ref(false)
const emptyLedgerReport = () => ({
  summary: {
    usage_count: 0,
    credits_consumed: 0,
    cost_micros: 0,
    estimated_revenue_micros: 0,
    estimated_profit_micros: 0,
    uncosted_usage_count: 0,
  },
  rows: [],
})
const ledgerReport = ref(emptyLedgerReport())
const GPT_IMAGE_MODEL_ID = 'gpt-image-2-2-4k'
const USMERCARI_IMAGE_MODELS = new Set([GPT_IMAGE_MODEL_ID, 'nano-banana-2'])
const FIXED_REQUEST_VIDEO_MODELS = new Set([
  'minimax h3',
  'xuan-video-v1-6e7b4763634e6206',
])
const USMERCARI_IMAGE_TIER_DEFAULTS = {
  '1k': { credits: 70, cost_yuan_per_unit: 0.08 },
  '2k': { credits: 87, cost_yuan_per_unit: 0.10 },
  '4k': { credits: 105, cost_yuan_per_unit: 0.12 },
}
const imageResolutionLabels = {
  '1k': { credits: '1K 用户收费（积分/张）', cost: '1K API 成本（人民币元/张）' },
  '2k': { credits: '2K 用户收费（积分/张）', cost: '2K API 成本（人民币元/张）' },
  '4k': { credits: '4K 用户收费（积分/张）', cost: '4K API 成本（人民币元/张）' },
}
const videoResolutionLabels = {
  '480p': '480P',
  '720p': '720P',
  '1080p': '1080P',
}
const newModel = reactive({
  model: '',
  display_name: '',
  public_note: '',
  category: 'video',
  billing_unit: 'second',
  credits: 1,
  cost_unit: 'request',
  cost_yuan_per_unit: 0,
  input_cost_yuan_per_1k: 0,
  output_cost_yuan_per_1k: 0,
  resolution_prices: emptyResolutionPrices(),
})
const creditForm = reactive({
  tenant_id: '',
  amount: 100,
  reason: '',
})

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '永久'
}

function microsToYuan(value) {
  return Number(value || 0) / 1_000_000
}

function yuanToMicros(value) {
  return Math.round(Number(value || 0) * 1_000_000)
}

function formatMoney(value) {
  return `¥${microsToYuan(value).toFixed(4)}`
}

function costUnitLabel(value) {
  return { request: '次', image: '张', second: '秒', token: '千 Token' }[value] || '次'
}

function billingUnitLabel(value) {
  return value === 'request' ? '次' : '秒'
}

function providerEntries(item) {
  if (Array.isArray(item?.providers) && item.providers.length) return item.providers
  if (item?.provider || item?.provider_name || item?.provider_base_url) {
    return [{
      provider: item.provider,
      provider_name: item.provider_name,
      provider_base_url: item.provider_base_url,
    }]
  }
  return []
}

function providerLabel(item) {
  const labels = providerEntries(item).map((entry) => (
    [entry.provider_name || entry.provider, entry.provider && entry.provider_name !== entry.provider ? entry.provider : '']
      .filter(Boolean)
      .join(' · ')
  )).filter(Boolean)
  return labels.length ? [...new Set(labels)].join(' / ') : '未关联中转站'
}

function providerBaseUrl(item) {
  return providerEntries(item).map((entry) => entry.provider_base_url).filter(Boolean).join(' / ')
}

function formatProviderCosts(item) {
  return (item.provider_costs || []).map((cost) => {
    const provider = cost.provider_name || cost.provider || `配置 ${cost.config_id}`
    const amount = microsToYuan(cost.micros_per_unit).toFixed(6)
    const source = cost.cost_source === 'relay_auto' ? '自动同步' : '手工'
    const fetched = cost.source_fetched_at ? `，${formatDate(cost.source_fetched_at)}` : ''
    return `${provider} ¥${amount}/${costUnitLabel(cost.cost_unit)}（${source}${fetched}）`
  }).join('；')
}

function usesImageResolutionPricing(item) {
  return item?.category === 'image'
    && USMERCARI_IMAGE_MODELS.has(String(item?.model || '').toLowerCase())
}

function usesFixedRequestVideoPricing(item) {
  return item?.category === 'video'
    && FIXED_REQUEST_VIDEO_MODELS.has(String(item?.model || '').toLowerCase())
}

function isWan3VideoPricing(item) {
  return String(item?.model || '').trim().toLowerCase() === 'wan3.0-video'
    || String(item?.api_protocol || item?.protocol || '').trim().toLowerCase() === 'toapis_wan3_video'
}

function providerVideoResolutionKeys(item) {
  const providerResolutions = new Set((item?.provider_costs || []).flatMap((cost) => (
    Object.keys(cost?.resolution_prices || {}).map((resolution) => resolution.toLowerCase())
  )))
  const supported = Object.keys(videoResolutionLabels).filter((resolution) => providerResolutions.has(resolution))
  if (supported.length) return supported
  return isWan3VideoPricing(item) ? ['480p', '720p', '1080p'] : ['480p', '720p']
}

function usesVideoResolutionPricing(item) {
  return item?.category === 'video' && !usesFixedRequestVideoPricing(item)
}

function resolutionKeys(itemOrCategory) {
  const category = typeof itemOrCategory === 'string' ? itemOrCategory : itemOrCategory?.category
  if (category === 'video') return usesVideoResolutionPricing(itemOrCategory) ? providerVideoResolutionKeys(itemOrCategory) : []
  if (!usesImageResolutionPricing(itemOrCategory)) return []
  const model = String(itemOrCategory?.model || '').toLowerCase()
  return model === GPT_IMAGE_MODEL_ID ? ['1k', '2k'] : ['1k', '2k', '4k']
}

function videoResolutionWarning(item) {
  const labels = resolutionKeys(item).map((resolution) => videoResolutionLabels[resolution] || resolution.toUpperCase())
  return `请填写 ${labels.join(' 和 ')} 的正整数积分`
}

function normalizePrice(item) {
  const resolutionPrices = item.resolution_prices || {}
  const fallbackCredits = Number.isSafeInteger(Number(item.credits)) && Number(item.credits) > 0
    ? Number(item.credits)
    : 1
  const fallbackCost = Number(item.cost_micros_per_unit) || 0
  const emptyPrices = emptyResolutionPrices(item.model)
  const useUsmercariDefaults = USMERCARI_IMAGE_MODELS.has(String(item.model).toLowerCase())
    && Object.keys(resolutionPrices).length === 0
    && item.credits == null
  return {
    ...item,
    display_name: String(item.display_name ?? item.model ?? ''),
    public_note: String(item.public_note ?? ''),
    configured: item.credits != null && item.status !== 'unconfigured',
    status: item.status === 'unconfigured' ? 'enabled' : item.status,
    billing_unit: item.category === 'video'
      ? (usesFixedRequestVideoPricing(item) || item.billing_unit === 'request' ? 'request' : 'second')
      : 'request',
    cost_unit: usesFixedRequestVideoPricing(item) ? 'request' : item.cost_unit,
    cost_yuan_per_unit: microsToYuan(item.cost_micros_per_unit),
    input_cost_yuan_per_1k: microsToYuan(item.input_cost_micros_per_1k),
    output_cost_yuan_per_1k: microsToYuan(item.output_cost_micros_per_1k),
    resolution_prices: Object.fromEntries(Object.keys(emptyPrices).map((resolution) => {
      const tier = resolutionPrices[resolution]
      if (resolution.endsWith('p')) {
        return [resolution, {
          credits: Number(tier?.credits) || fallbackCredits,
          cost_yuan_per_second: microsToYuan(tier?.cost_micros_per_second ?? fallbackCost),
        }]
      }
      return [resolution, {
        credits: Number(tier?.credits) || (useUsmercariDefaults ? emptyPrices[resolution].credits : fallbackCredits),
        cost_yuan_per_unit: tier
          ? microsToYuan(tier.cost_micros_per_unit)
          : useUsmercariDefaults
            ? emptyPrices[resolution].cost_yuan_per_unit
            : microsToYuan(fallbackCost),
      }]
    })),
  }
}

function emptyResolutionPrices(model = '') {
  const imageDefaults = USMERCARI_IMAGE_MODELS.has(String(model).toLowerCase())
    ? USMERCARI_IMAGE_TIER_DEFAULTS
    : {
        '1k': { credits: 1, cost_yuan_per_unit: 0 },
        '2k': { credits: 1, cost_yuan_per_unit: 0 },
        '4k': { credits: 1, cost_yuan_per_unit: 0 },
      }
  const videoDefaults = isWan3VideoPricing({ model })
    ? {
        '480p': { credits: 1, cost_yuan_per_second: 0 },
        '720p': { credits: 1, cost_yuan_per_second: 0 },
        '1080p': { credits: 1, cost_yuan_per_second: 0 },
      }
    : {
        '480p': { credits: 1, cost_yuan_per_second: 0 },
        '720p': { credits: 1, cost_yuan_per_second: 0 },
      }
  return {
    ...Object.fromEntries(Object.entries(imageDefaults).map(([resolution, tier]) => [resolution, { ...tier }])),
    ...videoDefaults,
  }
}

function resolutionPricePayload(item) {
  return Object.fromEntries(resolutionKeys(item).map((resolution) => {
    const tier = item.resolution_prices[resolution]
    return item.category === 'image'
      ? [resolution, {
          credits: Number(tier.credits),
          cost_micros_per_unit: yuanToMicros(tier.cost_yuan_per_unit),
        }]
      : [resolution, {
          credits: Number(tier.credits),
          cost_micros_per_second: yuanToMicros(tier.cost_yuan_per_second),
        }]
  }))
}

function hasValidResolutionPrices(item) {
  return resolutionKeys(item).every((resolution) => (
    Number.isSafeInteger(Number(item.resolution_prices?.[resolution]?.credits))
    && Number(item.resolution_prices[resolution].credits) > 0
  ))
}

function hasValidModelMetadata(item) {
  const displayName = String(item.display_name ?? '').trim()
  if (displayName.length < 1 || displayName.length > 120) {
    ElMessage.warning('请填写 1-120 个字符的展示名称')
    return false
  }
  const publicNote = String(item.public_note ?? '').trim()
  if (publicNote.length > 500) {
    ElMessage.warning('公开备注不能超过 500 个字符')
    return false
  }
  item.display_name = displayName
  item.public_note = publicNote
  return true
}

const configuredModelCount = computed(() => prices.value.filter(
  (item) => item.configured && item.status === 'enabled',
).length)
const unconfiguredModelCount = computed(() => prices.value.filter((item) => !item.configured).length)
const disabledModelCount = computed(() => prices.value.filter(
  (item) => item.configured && item.status === 'disabled',
).length)
const filteredPrices = computed(() => {
  const query = modelSearch.value.toLowerCase()
  return filterModelPricesByProviderConfig(prices.value, providerConfigId).filter((item) => {
    const matchesSearch = !query
      || String(item.model).toLowerCase().includes(query)
      || String(item.display_name || '').toLowerCase().includes(query)
      || String(item.public_note || '').toLowerCase().includes(query)
    const matchesCategory = modelCategory.value === 'all' || item.category === modelCategory.value
    const matchesState = modelPricingState.value === 'all'
      || (modelPricingState.value === 'configured' && item.configured && item.status === 'enabled')
      || (modelPricingState.value === 'unconfigured' && !item.configured)
      || (modelPricingState.value === 'disabled' && item.configured && item.status === 'disabled')
    return matchesSearch && matchesCategory && matchesState
  })
})
const filteredPriceGroups = computed(() => groupModelPricesByProvider(filteredPrices.value))

async function loadAll() {
  if (!isSuperAdmin) return
  prices.value = (await listModelPrices()).map(normalizePrice)
  const [userResult, tenantResult, transactionResult, settingsResult, reportResult] = await Promise.allSettled([
    listPlatformUsers(),
    listAdminTenants(),
    listAdminCreditTransactions(),
    getLedgerSettings(),
    getLedgerReport(ledgerPeriod.value),
  ])
  if (userResult.status === 'fulfilled') users.value = userResult.value
  if (tenantResult.status === 'fulfilled') {
    tenants.value = tenantResult.value
    if (!creditForm.tenant_id) creditForm.tenant_id = tenantResult.value[0]?.id || ''
  }
  if (transactionResult.status === 'fulfilled') transactions.value = transactionResult.value
  if (settingsResult.status === 'fulfilled') {
    creditValueYuan.value = microsToYuan(settingsResult.value.credit_value_micros)
    usdCnyRate.value = microsToYuan(settingsResult.value.usd_cny_rate_micros || 7_200_000)
  }
  if (reportResult.status === 'fulfilled') {
    const report = reportResult.value
    ledgerReport.value = {
      ...emptyLedgerReport(),
      ...report,
      summary: { ...emptyLedgerReport().summary, ...(report?.summary || {}) },
      rows: Array.isArray(report?.rows) ? report.rows : [],
    }
  }
  if ([userResult, tenantResult, transactionResult, settingsResult, reportResult]
    .some((result) => result.status === 'rejected')) {
    ElMessage.warning('模型计费已加载，部分运营数据暂时不可用')
  }
}

async function syncProviderPricingNow() {
  syncingProviderPricing.value = true
  try {
    const result = await syncProviderPricing()
    const saved = (result.results || []).reduce((total, item) => total + Number(item.saved || 0), 0)
    const skippedManual = (result.results || []).reduce((total, item) => total + Number(item.skipped_manual || 0), 0)
    prices.value = (await listModelPrices()).map(normalizePrice)
    ElMessage.success(`已同步 ${saved} 个模型成本${skippedManual ? `，保留 ${skippedManual} 个手工成本` : ''}`)
  } finally {
    syncingProviderPricing.value = false
  }
}

async function unlock() {
  if (!isSuperAdmin) return
  if (adminToken.value.length < 32) return ElMessage.warning('管理员令牌长度不能少于 32 位')
  saveAdminToken(adminToken.value)
  loading.value = true
  try {
    await loadAll()
    unlocked.value = true
  } finally {
    loading.value = false
  }
}

async function saveModel(item) {
  const usesTierPrices = usesImageResolutionPricing(item) || usesVideoResolutionPricing(item)
  if (usesTierPrices && !hasValidResolutionPrices(item)) {
    return ElMessage.warning(item.category === 'image'
      ? '请填写当前图片模型已开放档位的正整数积分'
      : videoResolutionWarning(item))
  }
  if (!usesTierPrices && (!Number.isSafeInteger(Number(item.credits)) || Number(item.credits) <= 0)) {
    return ElMessage.warning('请填写正整数积分')
  }
  if (!hasValidModelMetadata(item)) return
  const tierPrices = usesTierPrices ? resolutionPricePayload(item) : null
  const firstTier = tierPrices?.[resolutionKeys(item)[0]]
  savingModel.value = item.model
  try {
    const saved = await updateModelPrice(item.model, {
      credits: firstTier?.credits ?? item.credits,
      display_name: item.display_name,
      public_note: item.public_note,
      category: item.category,
      status: item.status === 'unconfigured' ? 'enabled' : item.status,
      billing_unit: usesFixedRequestVideoPricing(item) ? 'request' : item.category === 'video' ? item.billing_unit : undefined,
      cost_unit: usesFixedRequestVideoPricing(item) ? 'request' : item.category === 'video' ? 'second' : usesImageResolutionPricing(item) ? 'image' : item.cost_unit,
      cost_micros_per_unit: firstTier?.cost_micros_per_second
        ?? firstTier?.cost_micros_per_unit
        ?? yuanToMicros(item.cost_yuan_per_unit),
      input_cost_micros_per_1k: yuanToMicros(item.input_cost_yuan_per_1k),
      output_cost_micros_per_1k: yuanToMicros(item.output_cost_yuan_per_1k),
      ...(usesFixedRequestVideoPricing(item)
        ? { resolution_prices: {} }
        : tierPrices ? { resolution_prices: tierPrices } : {}),
    })
    Object.assign(item, normalizePrice(saved), { configured: true })
    ElMessage.success(`${saved.display_name || saved.model} 已保存`)
  } finally {
    savingModel.value = ''
  }
}

async function addModel() {
  if (!newModel.model) return ElMessage.warning('请填写模型 ID')
  const usesTierPrices = usesImageResolutionPricing(newModel) || usesVideoResolutionPricing(newModel)
  if (usesTierPrices && !hasValidResolutionPrices(newModel)) {
    return ElMessage.warning(newModel.category === 'image'
      ? '请填写当前图片模型已开放档位的正整数积分'
      : videoResolutionWarning(newModel))
  }
  if (!usesTierPrices && (!Number.isSafeInteger(Number(newModel.credits)) || Number(newModel.credits) <= 0)) {
    return ElMessage.warning('请填写正整数积分')
  }
  if (!hasValidModelMetadata(newModel)) return
  const tierPrices = usesTierPrices ? resolutionPricePayload(newModel) : null
  const firstTier = tierPrices?.[resolutionKeys(newModel)[0]]
  savingModel.value = newModel.model
  try {
    const saved = await updateModelPrice(newModel.model, {
      credits: firstTier?.credits ?? newModel.credits,
      display_name: newModel.display_name,
      public_note: newModel.public_note,
      category: newModel.category,
      status: 'enabled',
      billing_unit: usesFixedRequestVideoPricing(newModel) ? 'request' : newModel.category === 'video' ? newModel.billing_unit : undefined,
      cost_unit: usesFixedRequestVideoPricing(newModel) ? 'request' : newModel.category === 'video' ? 'second' : usesImageResolutionPricing(newModel) ? 'image' : newModel.cost_unit,
      cost_micros_per_unit: firstTier?.cost_micros_per_second
        ?? firstTier?.cost_micros_per_unit
        ?? yuanToMicros(newModel.cost_yuan_per_unit),
      input_cost_micros_per_1k: yuanToMicros(newModel.input_cost_yuan_per_1k),
      output_cost_micros_per_1k: yuanToMicros(newModel.output_cost_yuan_per_1k),
      ...(usesFixedRequestVideoPricing(newModel)
        ? { resolution_prices: {} }
        : tierPrices ? { resolution_prices: tierPrices } : {}),
    })
    const index = prices.value.findIndex((item) => item.model === saved.model)
    if (index >= 0) prices.value[index] = { ...normalizePrice(saved), configured: true }
    else prices.value.push({ ...normalizePrice(saved), configured: true })
    Object.assign(newModel, {
      model: '',
      display_name: '',
      public_note: '',
      category: 'video',
      billing_unit: 'second',
      credits: 1,
      cost_unit: 'request',
      cost_yuan_per_unit: 0,
      input_cost_yuan_per_1k: 0,
      output_cost_yuan_per_1k: 0,
      resolution_prices: emptyResolutionPrices(),
    })
    ElMessage.success('模型计费规则已新增')
  } finally {
    savingModel.value = ''
  }
}

async function loadLedgerReport() {
  const report = await getLedgerReport(ledgerPeriod.value)
  ledgerReport.value = {
    ...emptyLedgerReport(),
    ...report,
    summary: { ...emptyLedgerReport().summary, ...(report?.summary || {}) },
    rows: Array.isArray(report?.rows) ? report.rows : [],
  }
}

async function saveLedgerSettings() {
  savingLedgerSettings.value = true
  try {
    const saved = await updateLedgerSettings({
      credit_value_micros: yuanToMicros(creditValueYuan.value),
      usd_cny_rate_micros: yuanToMicros(usdCnyRate.value),
    })
    creditValueYuan.value = microsToYuan(saved.credit_value_micros)
    usdCnyRate.value = microsToYuan(saved.usd_cny_rate_micros)
    await loadLedgerReport()
    ElMessage.success('每积分估值已保存')
  } finally {
    savingLedgerSettings.value = false
  }
}

async function saveUser(row) {
  savingUser.value = row.id
  try {
    const saved = await updatePlatformUser(row.id, { role: row.role, status: row.status })
    Object.assign(row, saved)
    ElMessage.success('账号状态已保存')
  } finally {
    savingUser.value = ''
  }
}

async function submitAdjustment() {
  if (!creditForm.tenant_id || !creditForm.amount || !creditForm.reason) {
    return ElMessage.warning('请选择工作区并填写非零积分和调账原因')
  }
  adjustingCredits.value = true
  try {
    await adjustTenantCredits(creditForm.tenant_id, {
      amount: creditForm.amount,
      reason: creditForm.reason,
    })
    const [tenantRows, transactionRows] = await Promise.all([
      listAdminTenants(),
      listAdminCreditTransactions(),
    ])
    tenants.value = tenantRows
    transactions.value = transactionRows
    creditForm.amount = 100
    creditForm.reason = ''
    ElMessage.success('积分调账已完成')
  } finally {
    adjustingCredits.value = false
  }
}

onMounted(async () => {
  if (isSuperAdmin && unlocked.value) {
    loading.value = true
    try {
      await loadAll()
      modelSearch.value = requestedModel
    } finally {
      loading.value = false
    }
  }
})
</script>

<style scoped>
.unlock-panel,
.billing-summary article,
.panel {
  border: 1px solid #292929;
  border-radius: 18px;
  background: rgba(18, 18, 18, .96);
  box-shadow: 0 20px 58px rgba(0, 0, 0, .22);
}
.unlock-panel { display: grid; gap: 20px; padding: 24px; }
.unlock-panel h2, .panel h2 { margin: 0 0 8px; }
.unlock-panel p, .panel-heading p, .field-hint { margin: 0; color: #929292; }
.panel-kicker { margin-bottom: 8px !important; color: #ff7139 !important; font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.admin-auth { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
.billing-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.billing-summary article { display: grid; gap: 7px; padding: 18px 20px; }
.billing-summary span { color: #858585; font-size: 12px; }
.billing-summary strong { font-size: 24px; }
.admin-tabs { margin-top: 10px; }
.panel { padding: 22px; }
.panel-heading { margin-bottom: 18px; }
.model-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.model-pricing-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.model-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 150px 150px; gap: 10px; margin-bottom: 14px; }
.model-list { display: grid; gap: 10px; }
.model-provider-group { margin-top: 8px; }
.model-provider-group-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 14px; border: 1px solid #3a302c; border-radius: 10px; background: rgba(255, 113, 57, .08); }
.model-provider-group-heading > div { display: grid; gap: 4px; min-width: 0; }
.model-provider-group-heading strong { color: #f2c1ad; font-size: 13px; }
.model-provider-group-heading small { overflow: hidden; color: #929292; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.model-row { display: grid; grid-template-columns: 1.2fr 120px 150px 120px auto; gap: 10px; align-items: center; padding: 14px; border: 1px solid #292929; border-radius: 12px; }
.model-row small { display: flex; grid-column: 1 / -1; gap: 8px; align-items: center; color: #8f9098; }
.model-provider-cost { color: #b9a598 !important; }
.model-row > .model-public-note { grid-column: 1 / -1; }
.cost-editor { display: grid; grid-column: 1 / -1; grid-template-columns: auto 140px 180px auto 180px auto; gap: 10px; align-items: center; padding-top: 10px; border-top: 1px dashed #353535; color: #9a9a9a; font-size: 12px; }
.resolution-pricing-editor { display: grid; grid-column: 1 / -1; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; padding-top: 10px; border-top: 1px dashed #353535; }
.new-model, .credit-form { display: grid; gap: 10px; align-items: center; margin: 18px 0 8px; padding-top: 18px; border-top: 1px dashed #3f4047; }
.model-field { display: grid; gap: 6px; color: #a8a9af; font-size: 12px; }
.model-field :deep(.el-input-number), .model-field :deep(.el-select) { width: 100%; }
.new-model { grid-template-columns: repeat(4, minmax(150px, 1fr)); align-items: end; }
.new-model > .model-public-note { grid-column: span 3; }
.credit-form { grid-template-columns: 1.2fr 160px 1.5fr auto; }
.ledger-heading { display: flex; justify-content: space-between; gap: 20px; align-items: end; }
.ledger-controls { display: flex; gap: 8px; align-items: center; color: #929292; font-size: 12px; }
.ledger-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
.ledger-summary article { display: grid; gap: 6px; padding: 16px; border: 1px solid #292929; border-radius: 12px; background: #151515; }
.ledger-summary span { color: #8f9098; font-size: 12px; }
.ledger-summary strong { font-size: 20px; }
.panel :deep(.el-table) { margin-top: 18px; }
.field-hint { font-size: 12px; }
@media (max-width: 900px) {
  .billing-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .model-row, .model-filters, .new-model, .credit-form, .admin-auth, .cost-editor, .resolution-pricing-editor { grid-template-columns: 1fr; }
  .model-provider-group-heading { align-items: flex-start; flex-direction: column; }
  .model-heading { align-items: stretch; flex-direction: column; }
  .new-model > .model-public-note { grid-column: auto; }
  .ledger-heading, .ledger-controls { align-items: stretch; flex-direction: column; }
  .ledger-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .billing-summary { grid-template-columns: 1fr; }
  .ledger-summary { grid-template-columns: 1fr; }
}
</style>
