export function isSafeInternalHref(value: string | null | undefined) {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'));
}

export function appendFromParam(href: string, from: string | null | undefined) {
  if (!isSafeInternalHref(from)) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}from=${encodeURIComponent(from!)}`;
}
