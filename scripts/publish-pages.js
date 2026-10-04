#!/usr/bin/env node
'use strict';
/* Publish only the committed static site. A temporary Git index leaves the working tree intact. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-pages-index-'));
const indexEnv = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };

function git(args, input, env = process.env) {
  const result = cp.spawnSync('git', args, { cwd: root, env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  return result.stdout;
}

try {
  if (git(['status', '--porcelain', '--untracked-files=all', '--', 'site']).trim()) {
    throw new Error('Commit site/ changes before publishing. GitHub Pages receives committed files only.');
  }
  const revision = git(['rev-parse', 'HEAD']).trim();
  const entries = git(['ls-tree', '-rz', 'HEAD:site']).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, hash] = line.slice(0, tab).split(' ');
    return { mode, type, hash, name: line.slice(tab + 1) };
  }).filter(entry => entry.type === 'blob' && !entry.name.startsWith('api/') && entry.name !== 'vercel.json'
    && !entry.name.startsWith('.vercel/') && !/^\.env(?:\.|$)/.test(entry.name));
  const emptyBlob = git(['hash-object', '-w', '--stdin'], '').trim();
  entries.push({ mode: '100644', hash: emptyBlob, name: '.nojekyll' });
  git(['read-tree', '--empty'], undefined, indexEnv);
  git(['update-index', '-z', '--index-info'], entries.map(entry => `${entry.mode} ${entry.hash}\t${entry.name}\0`).join(''), indexEnv);
  const tree = git(['write-tree'], undefined, indexEnv).trim();
  const remote = git(['ls-remote', '--heads', 'origin', 'gh-pages']).trim();
  const parentArgs = [];
  if (remote) {
    git(['fetch', 'origin', 'gh-pages']);
    const parent = git(['rev-parse', 'FETCH_HEAD']).trim();
    if (git(['rev-parse', `${parent}^{tree}`]).trim() === tree) {
      console.log('GitHub Pages already has this static site.');
      process.exitCode = 0;
    } else parentArgs.push('-p', parent);
  }
  if (!remote || parentArgs.length) {
    const commit = git(['commit-tree', tree, ...parentArgs, '-m', `Publish OTT static website from ${revision.slice(0, 7)}`]).trim();
    git(['push', 'origin', `${commit}:refs/heads/gh-pages`]);
    console.log(`Published ${entries.length} static files to gh-pages (${commit.slice(0, 7)}).`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // Only our exact temporary index files and its now-empty directory are removed.
  fs.rmSync(path.join(scratch, 'index'), { force: true });
  fs.rmSync(path.join(scratch, 'index.lock'), { force: true });
  fs.rmdirSync(scratch);
}
