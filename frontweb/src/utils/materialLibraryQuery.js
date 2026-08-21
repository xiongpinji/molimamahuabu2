export function buildMaterialLibraryQuery(scope, dramaId, page, pageSize, keyword) {
  const params = {
    page,
    page_size: pageSize,
    keyword: keyword || undefined,
  }
  if (scope === 'global') params.global = 1
  else params.drama_id = dramaId
  return params
}
