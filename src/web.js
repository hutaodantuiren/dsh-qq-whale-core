import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_RANGES = [
  /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/, /^fc00:/i, /^fe80:/i,
];

export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIP(host)) {
    if (net.isIPv6(host)) return host === '::1' || PRIVATE_RANGES.some((re) => re.test(host));
    return PRIVATE_RANGES.some((re) => re.test(host));
  }
  return false;
}

export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http/https URL');
  if (isPrivateHost(url.hostname)) throw new Error('不允许访问本机或内网地址');
  try {
    const records = await dns.lookup(url.hostname, { all: true });
    for (const record of records) {
      if (isPrivateHost(record.address)) throw new Error('URL 解析到内网地址，已拒绝');
    }
  } catch (error) {
    if (error.message.includes('内网')) throw error;
    // DNS 失败时交给 fetch 报错。
  }
  return url;
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(Buffer.from(value));
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function httpGet(url, { timeoutMs = 15000, maxBytes = 2097152, headers = {}, allowPrivate = false } = {}) {
  const target = allowPrivate ? new URL(url) : await assertPublicUrl(url);
  const response = await fetch(target, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (!allowPrivate && response.url) {
    try {
      if (isPrivateHost(new URL(response.url).hostname)) throw new Error('重定向到内网地址，已拒绝');
    } catch (error) {
      if (error.message.includes('内网')) throw error;
    }
  }
  const buffer = await readLimited(response, maxBytes);
  return { buffer, contentType: response.headers.get('content-type') || '', finalUrl: response.url };
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export function htmlToText(html) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br|section|article|header|footer)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).trim() : '';
}

export async function searchWeb(query, config) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const timeoutMs = config.web?.timeoutMs || 15000;
  const maxBytes = config.web?.maxBytes || 2097152;
  const errors = [];

  const engines = config.web?.searchEngine === 'duckduckgo' ? ['duckduckgo', 'bing'] : ['bing', 'duckduckgo'];
  for (const engine of engines) {
    try {
      if (engine === 'bing') {
        const { buffer } = await httpGet(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&ensearch=0`, {
          timeoutMs,
          maxBytes,
          headers: { accept: 'text/html,application/xhtml+xml' },
        });
        const results = parseBingResults(buffer.toString('utf8'));
        if (results.length) return { engine, query: q, results };
      } else {
        const { buffer } = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeoutMs, maxBytes });
        const results = parseDuckResults(buffer.toString('utf8'));
        if (results.length) return { engine, query: q, results };
      }
    } catch (error) {
      errors.push(`${engine}: ${error.message}`);
    }
  }
  throw new Error(`搜索失败：${errors.join('；')}`);
}

export function parseBingResults(html) {
  const results = [];
  const blocks = String(html || '').split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:/i.test(url)) continue;
    const title = htmlToText(link[2]).slice(0, 200);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]).slice(0, 400) : '';
    results.push({ title, url, snippet });
    if (results.length >= 8) break;
  }
  return results;
}

export function parseDuckResults(html) {
  const results = [];
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const url = decodeEntities(match[1]);
    if (!/^https?:/i.test(url)) continue;
    results.push({ title: htmlToText(match[2]).slice(0, 200), url, snippet: htmlToText(match[3]).slice(0, 400) });
    if (results.length >= 8) break;
  }
  return results;
}

export async function fetchWeb(url, config) {
  const { buffer, contentType, finalUrl } = await httpGet(url, {
    timeoutMs: config.web?.timeoutMs || 15000,
    maxBytes: config.web?.maxBytes || 2097152,
  });
  const raw = buffer.toString('utf8');
  const isHtml = /text\/html|application\/xhtml/i.test(contentType);
  const text = isHtml ? htmlToText(raw) : raw;
  return {
    title: isHtml ? extractTitle(raw) : '',
    url: finalUrl,
    contentType,
    text: text.slice(0, config.web?.maxTextChars || 8000),
    truncated: text.length > (config.web?.maxTextChars || 8000),
  };
}

export function htmlToArticle(html) {
  let text = String(html || '');
  text = text.replace(/<(script|style|noscript|svg|iframe|canvas|template)[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const main = text.match(/<article[\s\S]*?<\/article>/i)
    || text.match(/<main[\s\S]*?<\/main>/i)
    || text.match(/<div[^>]+(?:id|class)="[^"]*(?:article|content|post|entry)[^"]*"[\s\S]*?<\/div>/i);
  if (main) text = main[0];
  text = text.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, body) => `\n${'#'.repeat(Number(tag[1]))} ${body}\n`);
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<(p|div|section|tr|br|blockquote)[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|section|tr|blockquote)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export async function readWebPage(url, config) {
  const { buffer, contentType, finalUrl } = await httpGet(url, {
    timeoutMs: config.web?.timeoutMs || 15000,
    maxBytes: config.web?.maxBytes || 3145728,
  });
  const raw = buffer.toString('utf8');
  const isHtml = /text\/html|application\/xhtml/i.test(contentType);
  const title = isHtml ? extractTitle(raw) : '';
  let text = isHtml ? htmlToArticle(raw) : raw;
  if (isHtml && text.length < 80) text = htmlToText(raw);
  const maxChars = config.web?.readMaxChars || 12000;
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  return {
    title,
    site: (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })(),
    url: finalUrl,
    contentType,
    chars: clean.length,
    text: clean.slice(0, maxChars),
    truncated: clean.length > maxChars,
  };
}
