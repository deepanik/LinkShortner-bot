export function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s]+/gi) || [];
  return matches.map((u) => u.replace(/[),.;!?]+$/g, ""));
}

export function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isDomainMatch(host, ruleDomain) {
  if (!host || !ruleDomain) return false;
  return host === ruleDomain || host.endsWith(`.${ruleDomain}`);
}

export function pickMatchedUrl(urls, rules) {
  for (const url of urls) {
    const host = hostFromUrl(url);
    if (!host) continue;
    for (const rule of rules) {
      if (isDomainMatch(host, rule.domain)) {
        return { url, rule };
      }
    }
  }
  return null;
}
