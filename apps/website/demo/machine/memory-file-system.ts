import { ByteSize, Effect, FileSystem, Option, Path, PlatformError, Stream } from "effect";
import {
  type MemoryVolume,
  VolumeError,
  type VolumeErrorCode,
  type VolumeStat,
} from "./memory-volume.ts";

const posix = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path;
  }).pipe(Effect.provide(Path.layer)),
);

/** POSIX path operations whose relative paths resolve against `cwd` instead of the process's. */
export const makeMemoryPath = (cwd: string): Path.Path =>
  Path.Path.of({ ...posix, resolve: (...segments) => posix.resolve(cwd, ...segments) });

/** The reason Node's platform layer gives each `errno` code; any other code is `Unknown`. */
const reasons: Readonly<Record<VolumeErrorCode, PlatformError.SystemErrorTag>> = {
  EEXIST: "AlreadyExists",
  EINVAL: "Unknown",
  EISDIR: "BadResource",
  ELOOP: "BadResource",
  ENOENT: "NotFound",
  ENOTDIR: "BadResource",
  ENOTEMPTY: "Unknown",
};

const failure = (method: string, path: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: cause instanceof VolumeError ? reasons[cause.code] : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: String(cause),
    cause,
  });

const unsupported = (method: string, path: string) =>
  failure(method, path, new Error(`${method} is not supported by the memory file system.`));

const types = { file: "File", directory: "Directory", symlink: "SymbolicLink" } as const;

const infoOf = (stat: VolumeStat): FileSystem.File.Info => ({
  type: types[stat.type],
  mtime: Option.some(stat.mtime),
  atime: Option.some(stat.mtime),
  birthtime: Option.some(stat.mtime),
  dev: 0n,
  ino: Option.none(),
  mode: stat.mode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(stat.size),
  blksize: Option.none(),
  blocks: Option.none(),
});

/**
 * Effect's file system over one memory volume. Relative paths resolve through `path`, so the
 * working directory is the one the invocation runs in.
 */
export const makeMemoryFileSystem = (
  volume: MemoryVolume,
  path: Path.Path,
): FileSystem.FileSystem => {
  /** Runs one synchronous volume operation on an absolute path as an effect. */
  const attempt = <A>(method: string, target: string, operation: (absolute: string) => A) => {
    const absolute = path.resolve(target);
    return Effect.try({
      try: () => operation(absolute),
      catch: (cause) => failure(method, absolute, cause),
    });
  };

  let temporaryCount = 0;
  const temporaryName = (
    options: {
      readonly directory?: string | undefined;
      readonly prefix?: string | undefined;
      readonly suffix?: string | undefined;
    } = {},
  ) => {
    temporaryCount += 1;
    return path.join(
      path.resolve(options.directory ?? "/tmp"),
      `${options.prefix ?? "tmp-"}${temporaryCount}${options.suffix ?? ""}`,
    );
  };

  const readDirectory = (directory: string, recursive: boolean): Array<string> =>
    volume.readdir(directory).flatMap((name) => {
      const child = `${directory}/${name}`;
      return recursive === true && volume.lstat(child).type === "directory"
        ? [name, ...readDirectory(child, true).map((nested) => `${name}/${nested}`)]
        : [name];
    });

  const copyEntry = (from: string, to: string) => {
    const stat = volume.lstat(from);
    if (stat.type === "symlink") return volume.symlink(volume.readlink(from), to);
    if (stat.type === "file")
      return volume.writeFile(to, volume.readFile(from), { mode: stat.mode });
    volume.mkdir(to, { mode: stat.mode });
    return volume.readdir(from).forEach((name) => copyEntry(`${from}/${name}`, `${to}/${name}`));
  };

  const makeTempDirectory: FileSystem.FileSystem["makeTempDirectory"] = (options) =>
    Effect.suspend(() => {
      const name = temporaryName(options);
      return attempt("makeTempDirectory", name, (absolute) => {
        volume.mkdir(path.dirname(absolute), { recursive: true });
        volume.mkdir(absolute);
        return absolute;
      });
    });

  const makeTempFile: FileSystem.FileSystem["makeTempFile"] = (options) =>
    Effect.suspend(() => {
      const name = temporaryName(options);
      return attempt("makeTempFile", name, (absolute) => {
        volume.mkdir(path.dirname(absolute), { recursive: true });
        volume.writeFile(absolute, new Uint8Array(), { exclusive: true });
        return absolute;
      });
    });

  const removedWithScope = (created: Effect.Effect<string, PlatformError.PlatformError>) =>
    Effect.acquireRelease(created, (absolute) =>
      Effect.sync(() => volume.remove(absolute, { recursive: true, force: true })),
    );

  const open: FileSystem.FileSystem["open"] = (target, options = {}) =>
    attempt("open", target, (absolute) => {
      const flag = options.flag ?? "r";
      const exclusive = flag.includes("x");
      const mode = options.mode ?? 0o644;
      if (flag.startsWith("w")) volume.writeFile(absolute, new Uint8Array(), { exclusive, mode });
      else if (flag.startsWith("a") && (exclusive === true || volume.exists(absolute) === false))
        volume.writeFile(absolute, new Uint8Array(), { exclusive, mode });
      let content = volume.readFile(absolute);
      let position = flag.startsWith("a") ? content.byteLength : 0;
      const store = (next: Uint8Array<ArrayBuffer>) =>
        attempt("write", absolute, () => {
          volume.writeFile(absolute, next);
          content = next;
        });
      const write = (buffer: Uint8Array) => {
        const next = new Uint8Array(Math.max(content.byteLength, position + buffer.byteLength));
        next.set(content);
        next.set(buffer, position);
        return store(next).pipe(
          Effect.map(() => {
            position += buffer.byteLength;
            return buffer.byteLength;
          }),
        );
      };
      const readAlloc = (size: number) =>
        Effect.sync(() => {
          const chunk = content.slice(position, position + size);
          position += chunk.byteLength;
          return chunk.byteLength === 0 ? Option.none() : Option.some(chunk);
        });
      return {
        [FileSystem.FileTypeId]: FileSystem.FileTypeId,
        stat: attempt("stat", absolute, (resolved) => infoOf(volume.stat(resolved))),
        seek: (offset, from) =>
          Effect.sync(() => {
            position = Number(offset) + (from === "current" ? position : 0);
            return BigInt(position);
          }),
        sync: Effect.void,
        read: (buffer) =>
          readAlloc(buffer.byteLength).pipe(
            Effect.map(
              Option.match({
                onNone: () => 0,
                onSome: (chunk) => {
                  buffer.set(chunk);
                  return chunk.byteLength;
                },
              }),
            ),
          ),
        readAlloc,
        truncate: (length = 0) => store(content.slice(0, length)),
        write,
        writeAll: (buffer) => Effect.asVoid(write(buffer)),
      } satisfies FileSystem.File;
    });

  return FileSystem.make({
    access: (target) => attempt("access", target, (absolute) => void volume.stat(absolute)),
    copy: (from, to, options) =>
      attempt("copy", to, (absolute) => {
        if (options?.overwrite === true) volume.remove(absolute, { recursive: true, force: true });
        copyEntry(path.resolve(from), absolute);
      }),
    copyFile: (from, to) =>
      attempt("copyFile", to, (absolute) =>
        volume.writeFile(absolute, volume.readFile(path.resolve(from))),
      ),
    chmod: (target, mode) => attempt("chmod", target, (absolute) => volume.chmod(absolute, mode)),
    chown: (target) => attempt("chown", target, (absolute) => void volume.stat(absolute)),
    link: (from, to) =>
      attempt("link", to, (absolute) => volume.link(path.resolve(from), absolute)),
    lstat: (target) => attempt("lstat", target, (absolute) => infoOf(volume.lstat(absolute))),
    makeDirectory: (target, options) =>
      attempt("makeDirectory", target, (absolute) =>
        volume.mkdir(absolute, {
          ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
        }),
      ),
    makeTempDirectory,
    makeTempDirectoryScoped: (options) => removedWithScope(makeTempDirectory(options)),
    makeTempFile,
    makeTempFileScoped: (options) => removedWithScope(makeTempFile(options)),
    open: (target, options) => Effect.acquireRelease(open(target, options), () => Effect.void),
    readDirectory: (target, options) =>
      attempt("readDirectory", target, (absolute) =>
        readDirectory(volume.realpath(absolute), options?.recursive === true),
      ),
    readDirectoryEntries: (target) =>
      attempt("readDirectoryEntries", target, (absolute) => {
        const directory = volume.realpath(absolute);
        return volume.readdir(directory).map((name) => ({
          name,
          type: types[volume.lstat(`${directory}/${name}`).type],
        }));
      }),
    readFile: (target) => attempt("readFile", target, (absolute) => volume.readFile(absolute)),
    readLink: (target) => attempt("readLink", target, (absolute) => volume.readlink(absolute)),
    realPath: (target) => attempt("realPath", target, (absolute) => volume.realpath(absolute)),
    remove: (target, options) =>
      attempt("remove", target, (absolute) =>
        volume.remove(absolute, {
          ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
          ...(options?.force === undefined ? {} : { force: options.force }),
        }),
      ),
    rename: (from, to) =>
      attempt("rename", to, (absolute) => volume.rename(path.resolve(from), absolute)),
    stat: (target) => attempt("stat", target, (absolute) => infoOf(volume.stat(absolute))),
    symlink: (target, link) =>
      attempt("symlink", link, (absolute) => volume.symlink(target, absolute)),
    truncate: (target, length = 0) =>
      attempt("truncate", target, (absolute) =>
        volume.writeFile(absolute, volume.readFile(absolute).slice(0, length)),
      ),
    utimes: (target) => attempt("utimes", target, (absolute) => void volume.stat(absolute)),
    watch: (target) => Stream.fail(unsupported("watch", target)),
    writeFile: (target, data, options) =>
      attempt("writeFile", target, (absolute) => {
        const flag = options?.flag ?? "w";
        volume.writeFile(absolute, data, {
          exclusive: flag.includes("x"),
          append: flag.startsWith("a"),
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
        });
      }),
  });
};
