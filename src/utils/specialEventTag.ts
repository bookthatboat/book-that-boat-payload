export const getEventLabel = (tag: string | { label?: string; slug?: string }): string => {
  if (typeof tag === 'string') return tag
  return tag.label || tag.slug || ''
}
