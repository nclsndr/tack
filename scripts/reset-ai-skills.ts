#!/usr/bin/env bun

import { lstatSync, readdirSync, readlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const sourceDir = join(rootDir, ".ai", "skills");
const targetSkillDirs = [
  join(rootDir, ".claude", "skills"),
  join(rootDir, ".cursor", "skills"),
  join(rootDir, ".agents", "skills"),
  join(rootDir, ".opencode", "skills"),
];

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function resolveSymlinkTarget(linkPath: string): string {
  return resolve(dirname(linkPath), readlinkSync(linkPath));
}

function isInsideDirectory(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);
  return (
    resolvedPath === resolvedDirectory ||
    resolvedPath.startsWith(`${resolvedDirectory}${sep}`) === true
  );
}

function resetAiSkills(targetDir: string): number {
  if (pathExists(targetDir) === false) {
    return 0;
  }

  const stats = lstatSync(targetDir);
  if (stats.isDirectory() === false) {
    throw new Error(`Expected a directory at ${targetDir}`);
  }

  return readdirSync(targetDir, { withFileTypes: true }).reduce((removed, entry) => {
    if (entry.name.startsWith(".") === true || entry.isSymbolicLink() === false) {
      return removed;
    }

    const linkPath = join(targetDir, entry.name);
    if (isInsideDirectory(resolveSymlinkTarget(linkPath), sourceDir) === false) {
      return removed;
    }

    unlinkSync(linkPath);
    return removed + 1;
  }, 0);
}

function main(): void {
  let removed = 0;

  for (const targetDir of targetSkillDirs) {
    const removedFromTarget = resetAiSkills(targetDir);
    removed += removedFromTarget;
    console.log(`Reset ${relative(rootDir, targetDir)} removed=${String(removedFromTarget)}`);
  }

  console.log(`Done. removed=${String(removed)}`);
}

main();
