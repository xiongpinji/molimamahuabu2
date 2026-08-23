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
      turns: [{ id: 'g1-t1', speaker_id: 'c1', localized_text: 'Fue aqui.' }],
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
