export const genericRedrawProject = {
  duration_ms: 12_000,
  target: { locale: 'es-ES', market: 'ES' },
  project: {
    title: '通用三镜验收项目',
    execution_mode: 'auto',
    budget_limit_credits: 100,
    max_auto_attempts_per_shot: 1,
    default_locale: 'es-ES',
    default_market: 'ES',
    localization_level: 'faithful',
  },
  characters: [
    { id: 'c1', source_name: '林薇', display_name: '林薇', relationship: '调查记者' },
    { id: 'c2', source_name: '周启', display_name: '周启', relationship: '便利店店主' },
  ],
  scenes: [
    { id: 's1', location: '便利店后巷', time: '雨夜', source_ranges: [{ start_ms: 0, end_ms: 12_000 }] },
  ],
  props: [
    { id: 'p1', name: '旧收据', evidence_ranges: [{ start_ms: 4_400, end_ms: 7_300 }] },
  ],
  shots: [
    { id: 'shot-1', index: 1, start_ms: 0, end_ms: 4_000 },
    { id: 'shot-2', index: 2, start_ms: 4_000, end_ms: 8_000 },
    { id: 'shot-3', index: 3, start_ms: 8_000, end_ms: 12_000 },
  ],
}

const spanishSpeechSynthesis = Object.freeze({
  engine: 'eSpeak NG',
  engine_version: '1.52-dev',
  source_project: 'espeak-ng/espeak-ng',
  source_release: '1.51',
  voice: 'Spanish_(Spain)',
  voice_code: 'es',
  culture: 'es-ES',
})

export const genericSpanishSpeechFixtures = Object.freeze({
  'Fue aquí.': Object.freeze({
    sha256: 'c3b0e6e675018f183346da8ec86d1bf6cfc3d673e9573d3859bd5a6b2071bc3c',
    synthesis: spanishSpeechSynthesis,
    base64: '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VVVVVVVVVVVV//MoxJkAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
  }),
  'No sigas.': Object.freeze({
    sha256: 'c1a7affda5f5a74248e9599b159370f94b01e7099c1cc581ab4f01b095225044',
    synthesis: spanishSpeechSynthesis,
    base64: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMQAAAAAAAAAAAAAA//NYwAAAAAAAAAAAAEluZm8AAAAPAAAAIAAACbQAGRkZISEhKCgoMDAwNzc3Pz8/RkZGTU1NVVVVVVxcXGRkZGtra3Nzc3p6eoGBgYmJiZCQkJCYmJifn5+mpqaurq61tbW9vb3ExMTMzMzM09PT2tra4uLi6enp8fHx+Pj4////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQEUQAAAAAAAAm0NNrKVwAAAAAAAAAAAAAA//MoxAANEFKARU8YAAWoDCkLYPQQguDg3lvE0IQdDx4nDkQxwgRBoPg+9QIAhwff8HwfKAg7/9YIO//8QHPKYYvVuMTkrBrK//MoxAYOgXKwAZgoADANAUbEhNyBB1+NKglrzQ4uqIDzBA0b////9Q8J9g4MfDAsv+q//Ua/zfLfRQMrZFzkdUkGg/A9DTWK//MoxAcO4MbISctIAAMkbD4Pk0IoG4ooHQtpn+0amKMitpUEwIYUQZUQuJ01mZoP//+oH1GUA+9PLyAsCAPiDkKVSYH/yLP6//MoxAYNobbYyHgHSfLX69F9piu+BPFHNYgZYoNTwMdxjhnpKetVbXEKNbfz///4grodDDq1DjjG4SJ8XbV12kSNIAKAAfJ8//MoxAoPwa7id0toADjGC4ul4Jw0aAqJzDcApngULjlAhRSOkmFUTRJMFuap9aX///////+k602stKszNRI3/vWR5mm95sPu//MoxAYOAYrEAYloAEP4gAIWX/BUiDkwrLhf5JheRgC47V+i/ND7/////y99Sv6BfmR4MzQS/0/////w+UvoFIPH7f7//+v///MoxAkPYxLEAYIoAbf/+//////V3/n3Xr/Xz609FZ3k/Lce6zGjhUzisVRViJ4oIjQ+oMIRFz1UVFRRhwqB0CmFAf4d3/////MoxAYOGxrYC4EoAf/////////////T/t33zvdR37tdTfOkuOFFYYOhAFVS63FlQ4uxRcVNJoqkOZBYzsHiCt5zExFfzI09//MoxAgPMpLUAY8oAYvZR38Dwqf/////+p//oT9jv4gBzD/kZrnI5g/bIY4oJCp1kFG/eWpNmT8TdyOr/Z5cSebGzctK4wHg//MoxAYOgk7kAYwoAfQ5TgyblZJ/P////////6Fc3qwFQ+rCJXqYWVKoZRih4tkEJhAWVKspEVE/HlLc34qINaiRqbAAAzAG//MoxAcMqZMCVcsQAtMTZw9ghGxPBB2AKjqPF46jzDv//////////6SlQqp/q9RM6Y/NFwmSVyd9UxNosAABigD7X9XPeLc9//MoxA8MuFrjD08QAM4udgXUdWHlt4qcx5v////hwQgANHOXQCRAKGe0WUFRQWb/NF8aK+erXsSEWzLKnmNTW1qtlyd7nP5///MoxBcQ+e60AY9QAHdD//////QiIzRZ6KMQJQXv5hAexpg8JBuBWEUppqHKn/GxNAINHuCv2///IandhPNjmcyuPct0Uuq4//MoxA4QGSKsAY9oAGEv7IXwdZMd0jRQToKoeSejUt2ZKt+7MtajN//utCtSy8Y6Ef//6lyDNd5/2u/hf9/9Smdo7NVows1J//MoxAgNoRLUAYZYAD7Bh1GixPD6kbk0P9fkOysDBJJ5z//9nZocvmHTqLH68mQ/p1p0HPdyn/p+GHmatt4YhTaDCBTMZuUG//MoxAwPOT7UAYNYAI88bOlgnCZDGhNHbKw7R0sayieQ4gvRKX1CJ0qJkf9f+3///cc5/PHO3z3LmnH+zy0nzO6+tI4Kjsx8//MoxAoNIOa4A8NAADDA1B4tgUmh6LQLdN/Pyq1lCx0sLWDKCH/6Fnf/+y/Gf+38oFgQggjD4YUDbDa2SYYWZBQTjVvP/+SH//MoxBAMovL8fgBE/s6/ln5//kX7P/9//9qP/6rT92PPd2JZVLEyJY5ng0h1uVk1Alslbhz9yqaI8RkI72cbsLiIJIm1OhI4//MoxBgNEPLUfUAYAkiwnQHu6meYq1KzlbNOLie///eRMJjYswsQe7sV///////RP////9E96/p/6Kqb2MYcpo7oQiiKLu5U//MoxB4OIxK0AYAoAJUqw0aYxwGVEEkxQhREWD8oiRmXKpiiSOUSdf///////////Uv+v//Uolylo6hQEylo6hQE36lMYxjV//MoxCAMgr5UAcAQAQoCboYxnQMBCjgUGf/wvCn4i0xBTUUzLjEwMFVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxCkAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxGQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxJ8AAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//MoxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
  }),
})

export const genericSourceFacts = {
  schema_version: '2.0',
  duration_ms: genericRedrawProject.duration_ms,
  story: ['雨夜收据暴露失踪案线索'],
  characters: genericRedrawProject.characters,
  scenes: genericRedrawProject.scenes,
  props: genericRedrawProject.props,
  shots: [
    {
      id: 'shot-1',
      index: 1,
      start_ms: 0,
      end_ms: 4_000,
      composition: '林薇站在便利店后巷入口，雨水打湿风衣肩线',
      camera_movement: '手持轻微前推',
      opening_state: '林薇低头检查手机录音',
      continuous_action: '她抬头看见后门灯箱闪烁',
      ending_state: '她走向半开的后门',
      visible_character_ids: ['c1'],
      dialogue: [{
        id: 'g1-t1',
        speaker_id: 'c1',
        start_ms: 900,
        end_ms: 2_300,
        source_text: '他最后出现的地方就是这里',
      }],
      text_regions: [{
        id: 'g1-text-1',
        kind: 'subtitle',
        source_text: '暂停营业',
        polygon: [[0.62, 0.12], [0.88, 0.12], [0.88, 0.24], [0.62, 0.24]],
      }],
      audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.96, speaker_mapping: 0.71, text_regions: 0.97, shot_boundary: 0.98 },
    },
    {
      id: 'shot-2',
      index: 2,
      start_ms: 4_000,
      end_ms: 8_000,
      composition: '周启从货架阴影里递出一张褪色收据',
      camera_movement: '定机位轻微横移',
      opening_state: '林薇停在收银台前',
      continuous_action: '周启把旧收据推到灯下',
      ending_state: '林薇看清收据上的地址',
      visible_character_ids: ['c1', 'c2'],
      dialogue: [{
        id: 'g2-t1',
        speaker_id: 'c2',
        start_ms: 4_800,
        end_ms: 6_500,
        source_text: '别查了，有人会盯上你',
      }],
      text_regions: [],
      audio_contract: { dialogue_mode: 'spoken', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.95, speaker_mapping: 0.69, text_regions: 0.96, shot_boundary: 0.97 },
    },
    {
      id: 'shot-3',
      index: 3,
      start_ms: 8_000,
      end_ms: 12_000,
      composition: '周启独自看着旧收据上的地址被雨水晕开，镜头停在日期上',
      camera_movement: '缓慢下摇到特写',
      opening_state: '周启把收据放在玻璃柜台上',
      continuous_action: '雨水顺着周启袖口滴到纸面',
      ending_state: '日期旁露出失踪者姓名首字母',
      visible_character_ids: ['c2'],
      dialogue: [],
      text_regions: [],
      audio_contract: { dialogue_mode: 'silent', ambient_audio: 'preserve_or_rebuild' },
      confidence: { character_mapping: 0.96, speaker_mapping: 0.2, text_regions: 0.98, shot_boundary: 0.97 },
    },
  ],
  causal_chain: ['林薇追查失踪案来到便利店', '周启交出旧收据后暴露新地址'],
  locked_facts: ['林薇在雨夜调查便利店后巷', '周启递出旧收据警告她停手'],
  reversals: ['旧收据指向失踪者最后停留地点'],
  episode_hook: '收据日期旁出现失踪者姓名首字母',
}

export const genericLocalization = {
  name_map: { c1: 'Clara Vega', c2: 'Diego Santos' },
  culture_map: { 便利店后巷: 'callejon tras la tienda' },
  glossary: { 旧收据: 'recibo antiguo' },
  dialogue: [
    {
      shot_id: 'shot-1',
      turns: [{ id: 'g1-t1', speaker_id: 'c1', localized_text: 'Fue aquí.' }],
    },
    {
      shot_id: 'shot-2',
      turns: [{ id: 'g2-t1', speaker_id: 'c2', localized_text: 'No sigas.' }],
    },
    { shot_id: 'shot-3', turns: [] },
  ],
  text_map: {
    'shot-1:g1-text-1': 'Cerrado',
  },
  confidence: {
    names: 0.99,
    dialogue_semantics: 0.99,
    dialogue_timing: 0.99,
    culture: 0.99,
    screen_text: 0.99,
  },
}

export const genericReferencePreparationCase = {
  schema_version: 'redraw-generic-reference-preparation-fixture-v1',
  characters: [
    {
      source_character_key: 'c1',
      target_actor_label: 'Clara Vega',
      identity: { relative_path: 'generic-preparation/characters/c1/identity.png', color: '#b54d63' },
      replacement_identity: { relative_path: 'generic-preparation/characters/c1/identity-v2.png', color: '#d07487' },
      voice: { relative_path: 'generic-preparation/characters/c1/voice.mp3', frequency: 540 },
      wardrobe: { relative_path: 'generic-preparation/characters/c1/wardrobe.png', color: '#27496d' },
    },
    {
      source_character_key: 'c2',
      target_actor_label: 'Diego Santos',
      identity: { relative_path: 'generic-preparation/characters/c2/identity.png', color: '#8a5a36' },
      voice: { relative_path: 'generic-preparation/characters/c2/voice.mp3', frequency: 680 },
      wardrobe: { relative_path: 'generic-preparation/characters/c2/wardrobe.png', color: '#4a3f69' },
    },
  ],
  shots: [
    { source_shot_id: 'shot-1', character_keys: ['c1'], color: '#315c7d' },
    { source_shot_id: 'shot-2', character_keys: ['c1', 'c2'], color: '#4e6e58' },
    { source_shot_id: 'shot-3', character_keys: ['c2'], color: '#76513b' },
  ].map((shot) => ({
    ...shot,
    representative_frame: { relative_path: `generic-preparation/shots/${shot.source_shot_id}/frame.png` },
    person_mask: { relative_path: `generic-preparation/shots/${shot.source_shot_id}/person-mask.png` },
    text_mask: { relative_path: `generic-preparation/shots/${shot.source_shot_id}/text-mask.png` },
    clean_plate: { relative_path: `generic-preparation/shots/${shot.source_shot_id}/clean.png` },
    motion_reference: { relative_path: `generic-preparation/shots/${shot.source_shot_id}/motion.mp4` },
  })),
}

export const genericFullProductAcceptance = {
  project: {
    locale: 'es-ES',
    market: 'ES',
    execution_mode: 'auto',
    budget_limit_credits: 100,
  },
  source: { duration_ms: 12_000 },
  characters: { identities: 2, voices: 2, wardrobes: 2 },
  shots: { total: 3, dialogue: 2, silent_with_ambience: 1 },
  audio_evidence: {
    spoken_transcripts: ['Fue aquí.', 'No sigas.'],
    offline_synthesis: true,
    silent_ambience: 1,
  },
  provider: { adapter: 'icreat_task', submitted: 3, polled: 3, downloaded: 3 },
  candidate_qa: { approved: 3, automatic: 3, held_reservations: 0 },
  release: {
    status: 'completed',
    duration_seconds: 12,
    has_audio: true,
    downloads: ['mp4', 'srt', 'vtt', 'report'],
  },
  recovery: { refreshed_from_backend: true, approved_shots: 3, completed_exports: 1 },
  interaction: {
    ui_driven: true,
    asset_batches: 1,
    identity_packs: 2,
    voice_bindings: 2,
    asset_approvals: 5,
    coverage_approvals: 1,
    reference_preparations: 4,
    reference_asset_approvals: 7,
    shot_saves: 3,
    generation_batches: 1,
    candidate_qa_presented: 3,
    dialogue_starts: 1,
    release_creates: 1,
    downloads: 4,
  },
}
