export const actorReferenceUrl = new URL(
  './redraw-latin-american-case/actor-cast-reference.png',
  import.meta.url,
)

const shots = [
  {
    id: 'shot-1',
    start_ms: 0,
    end_ms: 8_000,
    dialogue: [{
      speaker_id: 'mateo',
      text: '不是哥们你谁啊',
      start_ms: 250,
      end_ms: 1_250,
      emotion: 'confused',
      overlap_group: null,
    }, {
      speaker_id: 'diego',
      text: '林江装疯卖傻有意思吗',
      start_ms: 1_250,
      end_ms: 3_500,
      emotion: 'mocking',
      overlap_group: null,
    }, {
      speaker_id: 'lucas',
      text: '林哥你没事吧',
      start_ms: 5_500,
      end_ms: 6_750,
      emotion: 'concerned',
      overlap_group: null,
    }, {
      speaker_id: 'lucas',
      text: '这是陆飞宇啊',
      start_ms: 6_750,
      end_ms: 8_000,
      emotion: 'explanatory',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '男主在校园门口被同学拦住',
    continuous_action: '同学质问男主，周围学生围观',
    ending_state: '朋友从人群中赶来',
  },
  {
    id: 'shot-2',
    start_ms: 8_000,
    end_ms: 16_000,
    dialogue: [{
      speaker_id: 'lucas',
      text: '而且不就是表白失败吗',
      start_ms: 8_000,
      end_ms: 9_500,
      emotion: 'teasing',
      overlap_group: null,
    }, {
      speaker_id: 'lucas',
      text: '下次再接再厉',
      start_ms: 9_500,
      end_ms: 10_750,
      emotion: 'dismissive',
      overlap_group: null,
    }, {
      speaker_id: 'mateo',
      text: '暖男可是排在舔狗后面的',
      start_ms: 13_750,
      end_ms: 16_000,
      emotion: 'wry',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '朋友介入校园冲突',
    continuous_action: '男主回应同学并跨上自行车',
    ending_state: '男主骑车离开',
  },
  {
    id: 'shot-3',
    start_ms: 16_000,
    end_ms: 24_000,
    dialogue: [],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '男主骑车离开校园',
    continuous_action: '男主穿过校园周边道路',
    ending_state: '男主停下并整理思路',
  },
  {
    id: 'shot-4',
    start_ms: 24_000,
    end_ms: 32_000,
    dialogue: [{
      speaker_id: 'mateo',
      text: '这里两个月后就会拆迁',
      start_ms: 24_000,
      end_ms: 26_500,
      emotion: 'realization',
      overlap_group: null,
    }, {
      speaker_id: 'mateo',
      text: '可现在的他连本金都没有',
      start_ms: 29_500,
      end_ms: 32_000,
      emotion: 'worried',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '男主独自思考未来',
    continuous_action: '男主意识到自己没有本金',
    ending_state: '男主开始寻找赚钱线索',
  },
  {
    id: 'shot-5',
    start_ms: 32_000,
    end_ms: 40_000,
    dialogue: [{
      speaker_id: 'mateo',
      text: '第一桶金有了',
      start_ms: 36_500,
      end_ms: 39_000,
      emotion: 'hopeful',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '体育新闻正在播放',
    continuous_action: '男主从新闻中发现机会',
    ending_state: '男主确定第一桶金目标',
  },
  {
    id: 'shot-6',
    start_ms: 40_000,
    end_ms: 48_000,
    dialogue: [{
      speaker_id: 'elena',
      text: '准大学生回来了',
      start_ms: 43_750,
      end_ms: 45_250,
      emotion: 'welcoming',
      overlap_group: null,
    }, {
      speaker_id: 'elena',
      text: '洗手吃饭',
      start_ms: 45_250,
      end_ms: 46_750,
      emotion: 'warm',
      overlap_group: null,
    }, {
      speaker_id: 'mateo',
      text: '这一世',
      start_ms: 46_750,
      end_ms: 48_000,
      emotion: 'resolute',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '家中餐桌已经摆好晚餐',
    continuous_action: '父母欢迎男主回家，男主情绪波动',
    ending_state: '男主回到自己的房间',
  },
  {
    id: 'shot-7',
    start_ms: 48_000,
    end_ms: 56_000,
    dialogue: [{
      speaker_id: 'mateo',
      text: '我要让父母过上好日子',
      start_ms: 48_750,
      end_ms: 50_500,
      emotion: 'resolute',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '夜间卧室昏暗',
    continuous_action: '男主坐到书桌前并打开电脑',
    ending_state: '电脑显示信息页面',
  },
  {
    id: 'shot-8',
    start_ms: 56_000,
    end_ms: 64_000,
    dialogue: [],
    screen_text: '新浪体育新闻中心；标题“南非对墨西哥”；正文与横幅低清',
    screen_text_target: 'Sina Sports news page; headline “South Africa vs. Mexico”; article body and banner copy require source-resolution transcription before release',
    screen_text_status: 'manual_review',
    screen_text_evidence: {
      method: 'manual_frame_review',
      reviewed_frame_times_ms: [58_000, 59_000, 60_000, 61_000, 62_000],
      confirmed: ['sina sports masthead', '南非对墨西哥 headline'],
      unresolved: ['article body copy', 'banner copy', 'browser chrome text'],
    },
    opening_state: '电脑页面显示机会信息',
    continuous_action: '男主浏览信息并确认行动方向',
    ending_state: '男主拿起笔准备记录',
  },
  {
    id: 'shot-9',
    start_ms: 64_000,
    end_ms: 68_733,
    dialogue: [{
      speaker_id: 'mateo',
      text: '世界杯就是我的起步资金',
      start_ms: 64_500,
      end_ms: 68_000,
      emotion: 'determined',
      overlap_group: null,
    }],
    screen_text: '',
    screen_text_target: '',
    screen_text_status: 'none',
    opening_state: '男主坐在书桌前',
    continuous_action: '男主写下行动计划',
    ending_state: '计划成为下一集钩子',
  },
]

for (const shot of shots) {
  shot.speaking_character_ids = [...new Set(shot.dialogue.map((turn) => turn.speaker_id))]
  shot.text_regions = shot.dialogue.map(({ start_ms, end_ms }, index) => ({
    region_key: `${shot.id}-subtitle-${index + 1}`,
    kind: 'text_subtitle',
    time_ranges: [[start_ms, end_ms]],
  }))
  if (shot.id === 'shot-8') {
    shot.text_regions.push({
      region_key: 'shot-8-screen-1',
      kind: 'text_screen',
      time_ranges: [[56_000, 64_000]],
    })
  }
  shot.face_track_review = {
    status: 'pending',
    unresolved_reason: '当前仅完成抽帧盘点，尚未完成该镜全片逐帧人脸轨迹审核',
  }
  shot.text_region_review = {
    status: 'pending',
    unresolved_reason: '当前仅完成抽帧盘点，尚未完成该镜全片逐帧文字区域审核',
  }
}

export const redrawLatinAmericanCase = Object.freeze({
  id: 'ac087bcd-latam-en-us',
  title: '拉美演员美式英语真实源片本地案例',
  reference_bundle_required: true,
  target: {
    language: 'en',
    locale: 'en-US',
    market: 'US',
    cast_direction: 'latin-american',
  },
  source: {
    sha256: '24eb1d8ba3ff11e6aa3e547b7ac400f6b177dcf541d1af36354d3e46cc05e9ae',
    duration_ms: 68_733,
    duration_tolerance_ms: 50,
    video: { width: 720, height: 1280, codec: 'hevc', frame_rate: 30 },
    audio: { codec: 'aac', channels: 1, sample_rate: 44_100 },
  },
  castingReference: {
    url: actorReferenceUrl,
    sha256: '35b1f9f65d819b12b11f61e17720f202a6ebb4292660a7fe93ec55fedddc319e',
    width: 941,
    height: 1672,
    kind: 'casting_reference',
    production_identity_pack: false,
  },
  cast: [
    { id: 'mateo', source_name: '男主', target_name: 'Mateo', role: 'protagonist', age_min: 18 },
    { id: 'diego', source_name: '男同学', target_name: 'Diego', role: 'classmate', age_min: 18 },
    { id: 'lucas', source_name: '男同学朋友', target_name: 'Lucas', role: 'friend', age_min: 18 },
    { id: 'elena', source_name: '母亲', target_name: 'Elena', role: 'mother', age_min: 35 },
    { id: 'rafael', source_name: '父亲', target_name: 'Rafael', role: 'father', age_min: 35 },
  ],
  sourceFacts: {
    duration_ms: 68_733,
    dialogue_evidence: {
      method: 'burned_subtitle_frame_sampling',
      sample_interval_ms: 250,
      status: 'manual_reviewed',
    },
    characters: [
      { id: 'mateo', source_name: '男主', relationships: [{ target_id: 'elena', type: 'son' }, { target_id: 'rafael', type: 'son' }] },
      { id: 'diego', source_name: '男同学', relationships: [{ target_id: 'mateo', type: 'classmate' }] },
      { id: 'lucas', source_name: '男同学朋友', relationships: [{ target_id: 'mateo', type: 'friend' }] },
      { id: 'elena', source_name: '母亲', relationships: [{ target_id: 'mateo', type: 'mother' }] },
      { id: 'rafael', source_name: '父亲', relationships: [{ target_id: 'mateo', type: 'father' }] },
    ],
    scenes: [
      { id: 'school', location: '校园门口', time: 'day', source_ranges: [{ start_ms: 0, end_ms: 16_000 }] },
      { id: 'street', location: '校园周边道路', time: 'day', source_ranges: [{ start_ms: 16_000, end_ms: 40_000 }] },
      { id: 'dining-room', location: '家中餐厅', time: 'evening', source_ranges: [{ start_ms: 40_000, end_ms: 48_000 }] },
      { id: 'bedroom', location: '卧室', time: 'night', source_ranges: [{ start_ms: 48_000, end_ms: 68_733 }] },
    ],
    props: [
      { id: 'bicycle', name: '自行车', evidence_ranges: [{ start_ms: 8_000, end_ms: 24_000 }] },
      { id: 'television', name: '电视', evidence_ranges: [{ start_ms: 32_000, end_ms: 40_000 }] },
      { id: 'computer', name: '电脑', evidence_ranges: [{ start_ms: 48_000, end_ms: 64_000 }] },
      { id: 'notebook', name: '笔记本', evidence_ranges: [{ start_ms: 64_000, end_ms: 68_733 }] },
    ],
    shots,
    causal_chain: [
      '校园冲突促使男主离开',
      '男主意识到缺少本金',
      '体育新闻带来第一桶金线索',
      '回家后男主在电脑前制定计划',
    ],
    locked_facts: [
      '男主从校园冲突中离开',
      '男主骑自行车',
      '父母在家中餐桌欢迎男主',
      '男主夜间使用电脑并写下计划',
    ],
    reversals: ['男主从表白失败的被动处境转向主动寻找机会'],
    episode_hook: '男主写下利用新信息赚取第一桶金的计划',
  },
  localization: {
    name_map: {
      男主: 'Mateo',
      男同学: 'Diego',
      男同学朋友: 'Lucas',
      母亲: 'Elena',
      父亲: 'Rafael',
    },
    culture_map: {
      校园门口: 'school entrance',
      校园周边道路: 'neighborhood street',
      家中餐厅: 'family dining room',
      卧室: 'bedroom',
    },
    glossary: {
      第一桶金: 'first seed money',
      自行车: 'bicycle',
      电脑: 'computer',
    },
    dialogue: [{
      shot_id: 'shot-1',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'mateo', localized_text: 'Who are you?', start_ms: 250, end_ms: 1_250 },
        { speaker_id: 'diego', localized_text: 'Mateo, you think acting crazy is funny?', start_ms: 1_250, end_ms: 3_500 },
        { speaker_id: 'lucas', localized_text: 'Mateo, are you okay?', start_ms: 5_500, end_ms: 6_750 },
        { speaker_id: 'lucas', localized_text: "That's Diego.", start_ms: 6_750, end_ms: 8_000 },
      ],
    }, {
      shot_id: 'shot-2',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'lucas', localized_text: 'You just got rejected.', start_ms: 8_000, end_ms: 9_500 },
        { speaker_id: 'lucas', localized_text: 'Try again next time.', start_ms: 9_500, end_ms: 10_750 },
        { speaker_id: 'mateo', localized_text: 'A nice guy ranks below a simp.', start_ms: 13_750, end_ms: 16_000 },
      ],
    }, {
      shot_id: 'shot-3',
      kind: 'silent',
      speech_required: false,
      turns: [],
    }, {
      shot_id: 'shot-4',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'mateo', localized_text: 'This place will be demolished in two months.', start_ms: 24_000, end_ms: 26_500 },
        { speaker_id: 'mateo', localized_text: 'But he has no capital right now.', start_ms: 29_500, end_ms: 32_000 },
      ],
    }, {
      shot_id: 'shot-5',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'mateo', localized_text: 'I have my first seed money.', start_ms: 36_500, end_ms: 39_000 },
      ],
    }, {
      shot_id: 'shot-6',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'elena', localized_text: "College kid's home.", start_ms: 43_750, end_ms: 45_250 },
        { speaker_id: 'elena', localized_text: 'Wash your hands and eat.', start_ms: 45_250, end_ms: 46_750 },
        { speaker_id: 'mateo', localized_text: 'In this life...', start_ms: 46_750, end_ms: 48_000 },
      ],
    }, {
      shot_id: 'shot-7',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'mateo', localized_text: 'My parents will live better.', start_ms: 48_750, end_ms: 50_500 },
      ],
    }, {
      shot_id: 'shot-8',
      kind: 'silent',
      speech_required: false,
      turns: [],
    }, {
      shot_id: 'shot-9',
      kind: 'spoken',
      speech_required: true,
      turns: [
        { speaker_id: 'mateo', localized_text: 'My fortune starts with the World Cup.', start_ms: 64_500, end_ms: 68_000 },
      ],
    }],
  },
  shotPrompts: {
    'shot-1': 'Same fixed Latino actors Mateo, Diego, and Lucas at the school entrance; Diego confronts Mateo before Lucas arrives, use the supplied natural American English dialogue, preserve each speaker turn, close framing, and confused reaction.',
    'shot-2': 'Same fixed Latino actors Mateo and Lucas as Lucas comments on the rejection and Mateo leaves by bicycle; use the supplied American English lines in the same order, preserve the original blocking and camera direction.',
    'shot-3': 'Same fixed Latino actor Mateo rides away from school on the same bicycle; preserve the rear tracking composition and travel direction; use only natural street ambience and bicycle movement sound effects; do not generate spoken dialogue, voiceover, narration, or intelligible vocalization.',
    'shot-4': 'Same fixed Latino actor Mateo sees the future demolition and worries that he has no capital; use the two supplied English inner-monologue lines, preserve the thoughtful close-ups and action timing.',
    'shot-5': 'Same fixed Latino actor Mateo sees sports news and realizes he has found his first seed money; use the supplied English inner-monologue line, preserve the bicycle movement, screen inserts, and transition home.',
    'shot-6': 'Same fixed Latino actors Mateo, Elena, and Rafael reunite at the family dinner table; use the supplied English family dialogue and inner monologue in order, preserve warm interior blocking and emotional close-up.',
    'shot-7': 'Same fixed Latino actor Mateo vows to give his parents a good life, then enters his dark bedroom and turns on the computer; use the supplied American English line and preserve the transition timing.',
    'shot-8': 'Same fixed Latino actor Mateo researches the opportunity on the computer and makes a decision; preserve the screen insert and determined close-up, avoid rendering unreadable Chinese text as verified English copy; use only quiet room ambience, keyboard, mouse, and computer interaction sound effects; do not generate spoken dialogue, voiceover, narration, or intelligible vocalization.',
    'shot-9': 'Same fixed Latino actor Mateo writes down the plan at his desk and says the supplied final English hook; preserve the seated pose and final hook timing.',
  },
  generationDurations: [8, 8, 8, 8, 8, 8, 8, 8, 8],
})

export function buildLocalIdentityPackInput(actor = {}) {
  return {
    target_actor_label: String(actor.target_name || '').trim(),
    confirmed_views: ['front', 'profile', 'full_body'],
    live_action_human_confirmed: true,
    adult_status: 'verified_18_plus',
    identity_consistency_confirmed: true,
  }
}

export function validateSourceProbe(probe) {
  const expected = redrawLatinAmericanCase.source
  const sha256 = String(probe?.sha256 || '').toLowerCase()
  if (sha256 !== expected.sha256) {
    throw new Error(`源片 SHA-256 不匹配：${sha256 || 'missing'}`)
  }

  const durationMs = Number(probe?.duration_ms)
  if (!Number.isFinite(durationMs)
    || Math.abs(durationMs - expected.duration_ms) > expected.duration_tolerance_ms) {
    throw new Error(`源片时长不匹配：${durationMs}`)
  }

  const video = probe?.video
  if (!video || Number(video.width) !== expected.video.width
    || Number(video.height) !== expected.video.height) {
    throw new Error(`源片尺寸不匹配：${video?.width || 0}x${video?.height || 0}`)
  }
  if (String(video.codec || '').toLowerCase() !== expected.video.codec) {
    throw new Error(`源片视频编码不匹配：${video.codec || 'missing'}`)
  }
  const frameRate = Number(video.frame_rate)
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - expected.video.frame_rate) > 0.01) {
    throw new Error(`源片帧率不匹配：${frameRate}`)
  }

  const audio = probe?.audio
  if (!audio) throw new Error('源片音频流缺失')
  if (String(audio.codec || '').toLowerCase() !== expected.audio.codec
    || Number(audio.channels) !== expected.audio.channels
    || Number(audio.sample_rate) !== expected.audio.sample_rate) {
    throw new Error(
      `源片音频流不匹配：${audio.codec || 'missing'}/${audio.channels || 0}/${audio.sample_rate || 0}`,
    )
  }

  return {
    sha256,
    duration_ms: durationMs,
    width: Number(video.width),
    height: Number(video.height),
    video_codec: String(video.codec).toLowerCase(),
    frame_rate: frameRate,
    audio_codec: String(audio.codec).toLowerCase(),
    channels: Number(audio.channels),
    sample_rate: Number(audio.sample_rate),
  }
}

export function buildLocalCaseManifest(verificationOverrides = {}) {
  return {
    case_id: redrawLatinAmericanCase.id,
    title: redrawLatinAmericanCase.title,
    source: redrawLatinAmericanCase.source,
    target: redrawLatinAmericanCase.target,
    cast: redrawLatinAmericanCase.cast,
    timeline: redrawLatinAmericanCase.sourceFacts.shots.map(({ id, start_ms, end_ms }) => ({
      id,
      start_ms,
      end_ms,
    })),
    verification: {
      source_upload_verified: false,
      workflow_contract_verified: false,
      visual_actor_replacement_verified: false,
      provider_mode: 'local_fixture',
      ...verificationOverrides,
    },
  }
}
