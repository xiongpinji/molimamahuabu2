# 用户安全预部署门禁（user-safe-predeploy-v1）

## 强制规则

**未跑通本门禁、或门禁非 PASS，禁止部署到线上。**

本门禁要求从**用户路径**实测确认：

1. 本次变更不会引入破坏线上用户正常/安全使用的新 BUG  
2. 多端画布对齐不会在拖拽、连线、框选、节点生成中静默覆盖本端操作  
3. 每用户生成提交限流与流水线并发上限变更可预期，且普通用户不能改全局并发  
4. 既有鉴权、归属隔离、积分受保护合同仍绿  

## 命令

```bash
cd backend-node
npm run verify:user-safe-predeploy-gate
```

退出码 `0`：允许进入**候选制作**（仍须受保护发布 + 人工授权后才 activate）。  
退出码非 `0`：**NO-GO**，不得部署。

## 覆盖范围（本批）

- 画布 `canvas-revision` 轻量对齐轮询 + DramaCanvas 远端同步  
- 生成提交限流默认 300/分钟、流水线并发上限 300  
- 用户 HTTP 冒烟：鉴权/归属 + 画布 revision/并发设置  

## 通过后仍须

1. 受保护发布：从实时 `current` 克隆候选，只覆盖本批审计文件  
2. `npm --prefix backend-node run audit:canvas-credit-contract -- --require-build`（若含前端构建）  
3. 使用共享 `activate-protected-release.sh`，禁止直接替换 `current`  
4. **人工明确授权**后才可 VERIFY_ONLY / activate  
