function toAbsoluteUrl(url: string | null | undefined) {
  if (!url || typeof window === 'undefined') return null;

  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return null;
  }
}

function upsertPublicCompanyIcon(rel: string, href: string, type?: string) {
  if (typeof document === 'undefined') return;

  let element = document.head.querySelector<HTMLLinkElement>(`link[data-public-company-icon="${rel}"]`)
    ?? document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement('link');
    element.rel = rel;
    document.head.appendChild(element);
  }

  if (!element.hasAttribute('data-public-company-icon-original-href') && element.hasAttribute('href')) {
    element.setAttribute('data-public-company-icon-original-href', element.getAttribute('href') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-original-type') && element.hasAttribute('type')) {
    element.setAttribute('data-public-company-icon-original-type', element.getAttribute('type') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-original-sizes') && element.hasAttribute('sizes')) {
    element.setAttribute('data-public-company-icon-original-sizes', element.getAttribute('sizes') || '');
  }

  if (!element.hasAttribute('data-public-company-icon-generated')) {
    element.setAttribute('data-public-company-icon-generated', element.hasAttribute('href') ? 'false' : 'true');
  }

  element.setAttribute('data-public-company-icon', rel);
  element.rel = rel;
  element.href = href;

  if (type) {
    element.type = type;
  } else {
    element.removeAttribute('type');
  }

  if (rel === 'alternate icon') {
    element.setAttribute('sizes', 'any');
  }
}

export function removePublicCompanyIcons() {
  if (typeof document === 'undefined') return;

  document.head.querySelectorAll<HTMLLinkElement>('link[data-public-company-icon]').forEach((element) => {
    const wasGenerated = element.getAttribute('data-public-company-icon-generated') === 'true';

    if (wasGenerated) {
      element.remove();
      return;
    }

    const originalHref = element.getAttribute('data-public-company-icon-original-href');
    const originalType = element.getAttribute('data-public-company-icon-original-type');
    const originalSizes = element.getAttribute('data-public-company-icon-original-sizes');

    if (originalHref) {
      element.href = originalHref;
    } else {
      element.removeAttribute('href');
    }

    if (originalType) {
      element.type = originalType;
    } else {
      element.removeAttribute('type');
    }

    if (originalSizes) {
      element.setAttribute('sizes', originalSizes);
    } else {
      element.removeAttribute('sizes');
    }

    element.removeAttribute('data-public-company-icon');
    element.removeAttribute('data-public-company-icon-original-href');
    element.removeAttribute('data-public-company-icon-original-type');
    element.removeAttribute('data-public-company-icon-original-sizes');
    element.removeAttribute('data-public-company-icon-generated');
  });
}

export function syncPublicCompanyIcons(logoUrl: string | null | undefined) {
  const absoluteLogoUrl = toAbsoluteUrl(logoUrl);
  if (!absoluteLogoUrl) {
    removePublicCompanyIcons();
    return;
  }

  upsertPublicCompanyIcon('icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('alternate icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('shortcut icon', absoluteLogoUrl);
  upsertPublicCompanyIcon('apple-touch-icon', absoluteLogoUrl);
}
