// Which release asset this machine needs. Chosen automatically from
// `process.platform` / `process.arch` (+ a musl probe on Linux) — the user is
// never asked to pick. Pure `pickOpengrepAsset` is unit-tested; `detectMusl`
// is the one IO probe.

import fs from 'node:fs/promises';
import type { OpengrepAssetName } from './versions.js';

export type AssetChoice = {
  asset: OpengrepAssetName;
  // Shown on the Settings card when the choice is a fallback the user should
  // know about (Windows on ARM runs the x64 build under emulation).
  note?: string;
};

export function pickOpengrepAsset(env: {
  platform: string;
  arch: string;
  musl: boolean;
}): AssetChoice | null {
  const { platform, arch, musl } = env;
  if (platform === 'win32') {
    if (arch === 'x64') return { asset: 'opengrep_windows_x86.exe' };
    if (arch === 'arm64') {
      return {
        asset: 'opengrep_windows_x86.exe',
        note:
          'No native Windows ARM64 build exists; the x64 binary runs under Windows ' +
          'built-in x64 emulation.',
      };
    }
    return null;
  }
  if (platform === 'linux') {
    const libc = musl ? 'musllinux' : 'manylinux';
    if (arch === 'x64') return { asset: `opengrep_${libc}_x86` as OpengrepAssetName };
    if (arch === 'arm64') return { asset: `opengrep_${libc}_aarch64` as OpengrepAssetName };
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { asset: 'opengrep_osx_arm64' };
    if (arch === 'x64') return { asset: 'opengrep_osx_x86' };
    return null;
  }
  return null;
}

// musl vs glibc on Linux. Alpine (the common musl distro) ships
// `/etc/alpine-release`; any musl system has its dynamic loader at
// `/lib/ld-musl-<arch>.so.1`. Both checks are cheap file probes, no spawn.
export async function detectMusl(platform = process.platform): Promise<boolean> {
  if (platform !== 'linux') return false;
  try {
    await fs.access('/etc/alpine-release');
    return true;
  } catch {
    /* not alpine */
  }
  try {
    const entries = await fs.readdir('/lib');
    return entries.some((e) => /^ld-musl-.*\.so\.1$/.test(e));
  } catch {
    return false;
  }
}

export async function chooseAssetForThisMachine(): Promise<AssetChoice | null> {
  return pickOpengrepAsset({
    platform: process.platform,
    arch: process.arch,
    musl: await detectMusl(),
  });
}
