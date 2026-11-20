#!/usr/bin/env bun

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const sourceDir = join(rootDir, ".ai", "skills");
const targetSkillDirs = [
  join(rootDir, ".claude", "skills"),
  join(rootDir, ".cursor", "skills"),
  join(rootDir, ".agents", "skills"),
  join(rootDir, ".opencode", "skills"),
];

type LinkResult = "created" | "updated" | "skipped";

type Skill = {
  name: string;
  path: string;
};

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function ensureRealDirectory(path: string): void {
  if (pathExists(path) === false) {
    mkdirSync(path, { recursive: true });
    return;
  }

  const stats = lstatSync(path);
  if (stats.isSymbolicLink() === true) {
    unlinkSync(path);
    mkdirSync(path, { recursive: true });
    return;
  }

  if (stats.isDirectory() === false) {
    throw new Error(`Expected a directory at ${path}`);
  }
}

function collectSkills(dir: string): Array<Skill> {
  if (existsSync(dir) === false) {
    throw new Error(`Missing skill source directory: ${dir}`);
  }

  const skills: Array<Skill> = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() === false) {
      continue;
    }
    if (entry.name.startsWith(".") === true) {
      continue;
    }

    const skillDir = join(dir, entry.name);
    if (existsSync(join(skillDir, "SKILL.md")) === true) {
      skills.push({ name: entry.name, path: skillDir });
      continue;
    }

    skills.push(...collectSkills(skillDir));
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function assertUniqueSkillNames(skills: ReadonlyArray<Skill>): void {
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const existing = seen.get(skill.name);
    if (existing !== undefined) {
      throw new Error(`Duplicate skill name "${skill.name}": ${existing} and ${skill.path}`);
    }
    seen.set(skill.name, skill.path);
  }
}

function resolveSymlinkTarget(linkPath: string): string {
  return resolve(dirname(linkPath), readlinkSync(linkPath));
}

function isCorrectSymlink(linkPath: string, expectedTarget: string): boolean {
  if (pathExists(linkPath) === false) {
    return false;
  }

  const stats = lstatSync(linkPath);
  if (stats.isSymbolicLink() === false) {
    return false;
  }

  return resolveSymlinkTarget(linkPath) === resolve(expectedTarget);
}

function isInsideDirectory(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);
  return (
    resolvedPath === resolvedDirectory ||
    resolvedPath.startsWith(`${resolvedDirectory}${sep}`) === true
  );
}

function linkSkill(targetDir: string, skillName: string, sourceSkillDir: string): LinkResult {
  const dest = join(targetDir, skillName);
  const relativeTarget = relative(targetDir, sourceSkillDir);

  if (isCorrectSymlink(dest, sourceSkillDir) === true) {
    return "skipped";
  }

  if (pathExists(dest) === true) {
    const stats = lstatSync(dest);
    if (stats.isSymbolicLink() === false) {
      throw new Error(`Refusing to replace non-symlink: ${dest}`);
    }
    unlinkSync(dest);
    symlinkSync(relativeTarget, dest);
    return "updated";
  }

  symlinkSync(relativeTarget, dest);
  return "created";
}

function pruneStaleLinks(targetDir: string, skillNames: ReadonlySet<string>): Array<string> {
  const removed: Array<string> = [];

  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") === true) {
      continue;
    }
    if (skillNames.has(entry.name) === true) {
      continue;
    }

    const dest = join(targetDir, entry.name);
    const stats = lstatSync(dest);
    if (stats.isSymbolicLink() === false) {
      continue;
    }

    const actual = resolveSymlinkTarget(dest);
    if (isInsideDirectory(actual, sourceDir) === false) {
      continue;
    }

    unlinkSync(dest);
    removed.push(dest);
  }

  return removed;
}

function initAiSkills(): void {
  const skills = collectSkills(sourceDir);
  assertUniqueSkillNames(skills);
  const skillNameSet = new Set(skills.map((skill) => skill.name));
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let pruned = 0;

  console.log(`Source: ${relative(rootDir, sourceDir) || "."}`);
  console.log(
    `Skills: ${skills.length === 0 ? "(none)" : skills.map((skill) => skill.name).join(", ")}`,
  );

  for (const targetDir of targetSkillDirs) {
    mkdirSync(dirname(targetDir), { recursive: true });
    ensureRealDirectory(targetDir);

    const removed = pruneStaleLinks(targetDir, skillNameSet);
    pruned += removed.length;

    for (const skill of skills) {
      const result = linkSkill(targetDir, skill.name, skill.path);
      if (result === "created") {
        created += 1;
      } else if (result === "updated") {
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    console.log(`Linked ${relative(rootDir, targetDir)}`);
  }

  console.log(
    `Done. created=${String(created)} updated=${String(updated)} skipped=${String(skipped)} pruned=${String(pruned)}`,
  );
}

initAiSkills();
