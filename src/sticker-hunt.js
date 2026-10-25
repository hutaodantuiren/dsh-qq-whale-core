import path from 'node:path';
import { searchImageUrls, downloadImages } from './avatar.js';

/**
 * 定时上网冲浪找表情包：百度/Bing 图片搜索 → 下载 → 入库（待识别）。
 */
export async function huntStickers({ config, store, log }) {
  const hunt = config.sticker?.hunt;
  if (!config.sticker?.enabled || hunt?.enabled === false) return { added: 0, items: [] };
  const queries = (hunt.queries || ['可爱 表情包 鲸鱼', 'DeepSeek 小鲸鱼 表情包', '蓝色大肥鱼 表情包']).slice(0, 6);
  const perQuery = Math.max(1, Math.min(3, hunt.count || 3));
  const dir = path.join(config.paths.media, 'stickers');
  const added = [];
  const errors = [];
  for (const query of queries) {
    try {
      const { urls } = await searchImageUrls(query, perQuery, log);
      if (!urls.length) continue;
      const { saved, errors: downloadErrors } = await downloadImages(urls, dir, config, log, perQuery, { maxBytes: 3 * 1024 * 1024 });
      errors.push(...downloadErrors);
      for (const item of saved) {
        const tags = query.split(/\s+/).filter((word) => word.length >= 2).slice(0, 4);
        const sticker = store.add({
          file: item.path,
          note: query,
          tags,
          source: 'web',
          desc: '',
        });
        if (sticker && !added.includes(sticker.id)) added.push(sticker.id);
      }
    } catch (error) {
      errors.push(`${query}: ${error.message}`);
      log?.warn?.(`表情包冲浪失败「${query}」：${error.message}`);
    }
  }
  store.save();
  log?.info?.(`表情包冲浪完成：新增 ${added.length} 张`);
  return { added: added.length, items: added, errors: errors.slice(0, 5) };
}
