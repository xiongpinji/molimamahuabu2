export function shouldShowRedrawEntry({ isProduction } = {}) {
  return isProduction !== true
}
