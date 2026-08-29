const characters = [
  { id: 'host', name: 'Maya', role: 'shop owner' },
  { id: 'chef', name: 'Noah', role: 'product lead' },
  { id: 'buyer', name: 'Ava', role: 'returning customer' },
  { id: 'assistant', name: 'Leo', role: 'operations assistant' },
  { id: 'courier', name: 'Iris', role: 'delivery partner' },
]

const dialogues = [
  'Welcome back, we prepared a brighter sample for you.',
  'The new recipe keeps the flavor clear and balanced.',
  'I can see the package label much better now.',
  'Let us place the hero product beside the window.',
  'This close-up should show the texture without glare.',
  'Please confirm the delivery note before we seal it.',
  'The customer story feels warmer with this angle.',
  'Now we can show the final box and receipt together.',
  'Great, this version is ready for the live review.',
]

export const redrawLiveNineShotProject = {
  contract: 'redraw-live-nine-shot-project-fixture-v1',
  locale: 'en-US',
  market: 'US',
  project: {
    title: 'Nine Shot Product Acceptance Dry Run',
    default_locale: 'en-US',
    default_market: 'US',
    execution_mode: 'auto',
    budget_limit_credits: 1,
    max_auto_attempts_per_shot: 1,
  },
  required_inputs: {
    source_video: { env: 'REDRAW_LIVE_SOURCE_VIDEO' },
    identity_images: characters.map((character, index) => ({
      character_id: character.id,
      env: `REDRAW_LIVE_IDENTITY_${index + 1}`,
    })),
    motion_references: dialogues.map((_, index) => ({
      shot_index: index + 1,
      env: `REDRAW_LIVE_MOTION_${index + 1}`,
    })),
  },
  source: {
    filename: 'redraw-live-nine-shot-source.mp4',
    mime_type: 'video/mp4',
    duration_ms: 45_000,
    width: 1280,
    height: 720,
  },
  characters,
  shots: dialogues.map((line, index) => {
    const character = characters[index % characters.length]
    return {
      shot_index: index + 1,
      start_ms: index * 5_000,
      end_ms: (index + 1) * 5_000,
      duration: 5,
      resolution: '480p',
      aspect_ratio: '16:9',
      speaker: character.name,
      character_id: character.id,
      localized_dialogue: line,
      prompt: `Shot ${index + 1}: ${character.name} presents a clear product-review moment in a bright retail studio.`,
      opening_state: `${character.name} is ready in frame.`,
      continuous_action: `${character.name} demonstrates the product naturally.`,
      ending_state: `${character.name} completes the review beat.`,
    }
  }),
}
