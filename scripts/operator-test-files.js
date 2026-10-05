'use strict';
// Operator activation data belongs outside the checkout and cloud-synced folders.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PRIVATE_BASE = path.join(os.homedir(), '.codex', 'private', 'ott-phone-test');

function inside(file, dir) {
  const rel = path.relative(dir, file);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function privatePath(value) {
  const absolute = path.resolve(value);
  let parent = absolute;
  const suffix = [];
  while (!fs.existsSync(parent)) {
    suffix.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('A private output path is required.');
    parent = next;
  }
  const resolved = path.join(fs.realpathSync(parent), ...suffix);
  const root = fs.realpathSync(ROOT);
  if (inside(resolved, root) || inside(absolute, ROOT) ||
      /(?:^|[\\/])OneDrive(?:[^\\/]*)(?:[\\/]|$)/i.test(resolved) ||
      /(?:^|[\\/])OneDrive(?:[^\\/]*)(?:[\\/]|$)/i.test(absolute)) {
    throw new Error('Keep private test files outside the repository and OneDrive.');
  }
  let baseParent = PRIVATE_BASE;
  const baseSuffix = [];
  while (!fs.existsSync(baseParent)) { baseSuffix.unshift(path.basename(baseParent)); baseParent = path.dirname(baseParent); }
  const privateBase = path.join(fs.realpathSync(baseParent), ...baseSuffix);
  if (!inside(resolved, privateBase)) throw new Error('Use the dedicated private operator-test directory.');
  return resolved;
}
function protect(target, directory) {
  if (process.platform !== 'win32') { fs.chmodSync(target, directory ? 0o700 : 0o600); return; }
  // POSIX mode bits do not establish Windows ACLs. Replace existing/inherited read grants.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
if ($env:OTT_PRIVATE_KIND -eq 'directory') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $flags = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $item = New-Object System.IO.DirectoryInfo($env:OTT_PRIVATE_TARGET)
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $flags = [System.Security.AccessControl.InheritanceFlags]::None
  $item = New-Object System.IO.FileInfo($env:OTT_PRIVATE_TARGET)
}
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($owner, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $flags, 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, OTT_PRIVATE_TARGET: target, OTT_PRIVATE_KIND: directory ? 'directory' : 'file' },
    stdio: 'pipe', windowsHide: true,
  });
}
function writePrivate(file, content) {
  const target = privatePath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  privatePath(target); // Recheck newly created parents for links/junctions.
  protect(path.dirname(target), true);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Private output cannot be a symbolic link.');
  if (fs.existsSync(target)) protect(target, false);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { protect(target, false); fs.writeFileSync(fd, content); } finally { fs.closeSync(fd); }
  return target;
}
module.exports = { PRIVATE_BASE, privatePath, writePrivate };
