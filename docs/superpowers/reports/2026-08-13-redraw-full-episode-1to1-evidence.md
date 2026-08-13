# ToAPIs Mini 480p 整集 1:1 复刻真实测试报告

## 结论

本次真实供应商链路执行完成，但整集内容验收不通过。

- 调用链：通过。9/9 个素材均为 `active`，9/9 次 generation POST 均返回独立任务 ID，9/9 个任务均为 `completed`，9/9 个 MP4 可下载、探针和完整解码。
- 媒体链：通过。9 段已按顺序合并并裁到源片时长附近，最终 MP4 含 H.264 视频和 AAC 音频。
- 人物链：不通过。生成画面是真实质感人物，但主角在同一镜头内会从外国成年男性跳回原亚洲角色；群演、父母和第 8 镜主角多数没有完成外国角色替换。
- 剧情/镜头链：部分通过。主要场景、动作方向和镜头顺序大体保留，但角色身份不连续，不能认定为整集 1:1 复刻。
- 语言链：不通过。音轨为英语，但只有第 5 镜准确命中目标句、第 9 镜大致命中；多镜台词偏离，第 3 镜本应无对白却生成了英语对白。
- 屏幕文字：不通过。第 4 镜等位置仍保留原中文硬字幕，第 8 镜屏幕内容也没有完成已验证的英文重制。

因此，本次结果只能证明 ToAPIs `seedance-2-mini` 的 480p 虚拟人多模态参考链可真实提交并返回可读人物视频，不能证明当前方案已具备整集 1:1 复刻能力。

## 执行边界

- 执行日期：2026-08-13（Asia/Shanghai）。
- 仅本地测试；未部署、未 SSH、未写生产数据库、未执行 `activate`、未 push。
- Key 仅从本地文件读入进程内存，未写入仓库、manifest 或报告。
- 供应商结果 URL 仅用于即时下载，未写入脱敏状态文件。
- generation POST 精确执行 9 次；未自动重试，也没有 `submission_unknown`。

## 输入与规格

- 源片：`C:\Users\canqu\Desktop\ac087bcd4cf5f856f85182834794853a.mp4`
- 源片 SHA-256：`24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae`
- 源片时长：68.733 秒
- 源片规格：720×1280、30 fps、HEVC + AAC 单声道
- 模型：`seedance-2-mini`
- 输出规格：480p、9:16、每段请求 8 秒、生成音频
- 角色图片素材：`pa_01KZWRZSMARJAPT66DS8KDCY0K`（执行前为 `active`）
- 虚拟人素材组：`pg_01KZWRZPKGMG5F91QCB55S6AWP`

## 供应商任务证据

| 镜头 | 源时间轴 | 视频素材 | generation 任务 | 终态 | 输出 SHA-256 |
|---|---:|---|---|---|---|
| 1 | 0–8 s | `pa_01KZX2G5MYTPV93DMV24A49F8A` | `tsk_vid_01KZX2P909214P60TF10AAKDRT` | completed | `311b3b58556cafef5198d8cf2922c4b19e6675feb5b1aacde6de44fbe7cc60ee` |
| 2 | 8–16 s | `pa_01KZX2GW9P6S6VNGF1505F20YV` | `tsk_vid_01KZX2PA7SHDZX1KG7RRZC8FFP` | completed | `b555d5ae4891a904932fb40c148033b287d13c2e84fb08de1bbdd403e92db17c` |
| 3 | 16–24 s | `pa_01KZX2HPBMXHD6EZ80NDN0Q953` | `tsk_vid_01KZX2PBYN69XZGK0ED9FNBB4G` | completed | `d71e63c4c9ae50b2b534e2f331dd06e5f5da59566d8cbf0f4b11e8faed211cba` |
| 4 | 24–32 s | `pa_01KZX2JE292DAWWCQ2Q50BENNG` | `tsk_vid_01KZX2PDJMZJT1G5FZANY5STZF` | completed | `b243c74e6865b8981d482300b0120da79d7d9bf9c9ad5578603ed38d8c1e6fd1` |
| 5 | 32–40 s | `pa_01KZX2K5GQRZY70MRA64D1XQ3F` | `tsk_vid_01KZX2PEEMTKAMK2BN1KC7NYS4` | completed | `0ca9e0c2edbe2818668f5798878b792c5d82c9c7297cb090c48a606da19d1101` |
| 6 | 40–48 s | `pa_01KZX2KREHW1A6KFF32H5WYFDY` | `tsk_vid_01KZX2PFRJ0SP0HDFNXD21NJHW` | completed | `94f073fe714564ca91466ce5a28a1fae198eaa203e9b4623d6dc1db65a312948` |
| 7 | 48–56 s | `pa_01KZX2MG8VSK8J5REJSTWE0B8J` | `tsk_vid_01KZX2PH2CN0HR63ACXYC33WYG` | completed | `e9e1e7465beb22fb20c862c07dace3daea7730f96c6262fb5f6890d37f6ad83d` |
| 8 | 56–64 s | `pa_01KZX2N4BDZ7NGKT2HMCFEP7V9` | `tsk_vid_01KZX2PJ5PC4VZJFPA4S4835JS` | completed | `b3c529e0b95a2e98dd1f832112b15335758caad223fe6b952cb49c41f8226899` |
| 9 | 64–68.733 s | `pa_01KZX2NQNFVYRSHJWA6G2GJG5S` | `tsk_vid_01KZX2PK1SC4WRE8FBYGPJ6PAR` | completed | `64d33f052d69390e4fb8e54db68ced406e6a1e8b8ef9c3dffab40e15087948c3` |

每段输出均为 496×864、24 fps、H.264 + AAC 双声道，时长约 8.096 秒，并通过完整 FFmpeg 解码。

## 整集媒体证据

- 最终 MP4：`C:\tmp\toapis-full-episode-20260813\redraw-full-episode-toapis-mini-480p.mp4`
- 文件大小：16,579,843 字节
- SHA-256：`50fc34b648aed37f3a12f82fee7354b4905725903a3b3f22ac798ff7042fd676`
- 探针：496×864、H.264、AAC 单声道 44.1 kHz、68.741344 秒
- 与源片时长差：+8.344 ms
- 完整 FFmpeg 解码：exit 0
- 脱敏 manifest：`C:\tmp\toapis-full-episode-20260813\submission-manifest.json`
- FFprobe：`C:\tmp\toapis-full-episode-20260813\ffprobe-final.json`
- 源片/生成抽帧对照：`C:\tmp\toapis-full-episode-20260813\review\source-vs-toapis-contact-sheet.jpg`
- 逐镜三帧图：`C:\tmp\toapis-full-episode-20260813\review\generated-sequence\generated-3frames-per-shot.jpg`

## 逐镜内容验收

| 镜头 | 人物/动作 | 英语音轨本地转写 | 结论 |
|---|---|---|---|
| 1 | 外国主角出现，但随后切回原亚洲群演和角色 | 生成了英语，但不是合同中的 4 句 | 不通过 |
| 2 | 外国主角与原亚洲角色混用，身份不连续 | 被转写为视频结尾式话术，偏离目标 3 句 | 不通过 |
| 3 | 外国主角骑车，动作方向基本保留 | 本应无对白，却生成 “I'm sorry” | 不通过 |
| 4 | 外国主角较稳定，思考/城市背景保留 | 台词偏离；画面仍有中文硬字幕 | 部分通过 |
| 5 | 外国主角与体育新闻/回家转场基本保留 | “I have my first seed money.” 准确命中 | 通过（单镜） |
| 6 | 家庭餐桌场景保留，但父母/家庭角色仍为亚洲人物 | 被转写为 “Thanks for watching!” | 不通过 |
| 7 | 开头为外国主角，电脑段又跳回原亚洲角色 | 台词偏离 | 不通过 |
| 8 | 电脑研究场景保留，但主角仍为原亚洲人物，中文屏幕内容存在 | 无对白，仅检测到短促音效 | 不通过 |
| 9 | 外国主角写计划，动作和收尾钩子保留 | 大致命中 “The World Cup is my starting ...” | 部分通过 |

音频转写使用本地 `faster-whisper small.en`，未调用额外付费 API。原始转写证据：

- `C:\tmp\toapis-full-episode-20260813\review\local-transcript-by-shot.json`
- `C:\tmp\toapis-full-episode-20260813\review\local-transcript-small-en.json`

## 成本证据

- 提交前 `used_credits`：1480.5768
- 完成后 `used_credits`：1722.2788
- 同一 token 观察到的差值：241.702 credits
- 按 200 credits/USD 换算：约 1.20851 USD
- token 返回 `unlimited_quota=true`，`remain_credits` 前后均显示 277.716
- 公开参考价曾给出 480p + 参考视频 5.58 credits/秒，即 72 秒约 401.76 credits；实际账户观察值更低。

该差值是同一 token 在测试窗口内的余额快照差。若同时有其他客户端共用此 token，差值不具备独占归因能力；本次 runner 自身精确发送了 9 次 generation POST。

## 下一步建议

当前失败不是 API 是否可调用的问题，而是工作流把「单张主角图 + 整段参考视频」直接交给生成模型，无法锁定多角色身份、逐句对白和硬字幕替换。下一阶段应先在本地实现以下门禁，再进行任何新付费测试：

1. 每个角色分别建立前脸、侧脸、全身身份包，不再让一张主角图承担多人镜头。
2. 先做人脸轨迹/说话人分轨；多人镜头按角色蒙版或角色轨道逐人替换。
3. 视觉生成关闭自由音频，英语对白改为独立 TTS/口型同步，再按原时间轴混音。
4. 对中文硬字幕先做 clean plate/inpaint，再叠加经过人工复核的英文字幕。
5. 先选第 1、6、7、8 镜做 4 镜困难集本地验收，人物身份与台词均通过后，才申请下一轮付费授权。

runner 已增加双重防误触：必须显式传入 `--confirm-nine-submissions`，且发现输出目录已有任何 generation task 时拒绝重跑。
