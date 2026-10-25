#!/usr/bin/env node
/**
 * 把当前 git 已跟踪文件发布到 GitHub（无需 git push，走 Git Data API）。
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish-github.mjs [owner] [repo]
 * token 需要 repo（或 fine-grained Contents: read/write + Administration: read/write 以创建仓库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const OWNER = process.argv[2] || 'hutaodantuiren';
const REPO = process.argv[3] || 'dsh-qq-whale';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN（需要 repo 权限）');
  process.exit(1);
}

async function api(urlPath, options = {}) {
  const response = await fetch(`${API}${urlPath}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `token ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${options.method || 'GET'} ${urlPath} -> ${response.status}: ${data?.message || text.slice(0, 200)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function ensureRepo() {
  try {
    return await api(`/repos/${OWNER}/${REPO}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      description: 'DeepSeek 小鲸鱼 QQ 桥接：SnowLuma OneBot v11 ↔ DeepSeek Harness，内置鲸鱼娘人格、二代仿真、群管理、表情包/头像、主人 agent 模式',
      private: false,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
}

async function main() {
  const repo = await ensureRepo();
  console.log(`仓库：${repo.full_name}`);

  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tree = [];
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(ROOT, file));
    const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buffer.toString('base64'), encoding: 'base64' }),
    });
    tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
    process.stdout.write('.');
  }
  console.log(`\n上传 ${tree.length} 个文件`);

  let parent = null;
  try {
    const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
    parent = ref.object.sha;
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error;
  }
  let parents = [];
  if (parent) {
    const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${parent}`);
    parents = [commit.sha];
  } else {
    try {
      const repoInfo = await api(`/repos/${OWNER}/${REPO}`);
      if (repoInfo.default_branch) {
        const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${repoInfo.default_branch}`);
        parents = [ref.object.sha];
      }
    } catch {
      /* empty repo */
    }
  }
  const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree }),
  });
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'feat: DeepSeek 小鲸鱼 QQ 桥接（DSH + SnowLuma）',
      tree: newTree.sha,
      parents,
    }),
  });
  if (parents.length) {
    await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${repo.default_branch || 'main'}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });
  } else {
    try {
      await api(`/repos/${OWNER}/${REPO}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
      });
    } catch (error) {
      if (error.status === 422) {
        await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: true }),
        });
      } else {
        throw error;
      }
    }
  }
  console.log(`完成：${repo.html_url || `https://github.com/${OWNER}/${REPO}`}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
