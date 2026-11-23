import { Effect, Path } from "effect";
import { SecureRandom } from "effect/crypto";
import {
  makeCheckReport,
  type CheckFinding,
  type CheckItem,
} from "../../domain/check/check-schema.ts";
import { emptyState } from "../../domain/state/state-schema.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import { makeCommandSnapshot } from "../snapshot/command-snapshot.ts";
import { checkSource } from "../sources/source-check.ts";
import { profilePublications } from "../sources/profile-publications.ts";
import { checkProfileInContext } from "../profiles/profile-check.ts";
import { inspectBundle } from "../profiles/bundle-check.ts";
import { discoverCheckInput, documentationFiles } from "./path-discovery.ts";
import { locateFinding } from "./finding-location.ts";
import { documentationDetectors, type DocumentationDetector } from "./documentation.ts";
import { declarationFileName } from "../sources/declaration-file.ts";
import { unresolvedDependencyEdges } from "../../domain/choices/dependency-resolution.ts";
import { dependencyEdgeFindings } from "./dependency-edges.ts";

/** Checks explicit files/source folders as one stateless authoring scope; never reads StateStore. */
export const checkPaths = Effect.fnUntraced(function* (
  paths: ReadonlyArray<string>,
  options: {
    readonly additionalDocumentationDetectors?: ReadonlyArray<DocumentationDetector>;
  } = {},
) {
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const inputs = yield* Effect.forEach(paths, discoverCheckInput);
  const folders = [
    ...new Set(
      inputs.flatMap((input) =>
        input.kind === "source" ? [input.path] : input.owner === undefined ? [] : [input.owner],
      ),
    ),
  ];
  const base = emptyState();
  const registrations = yield* Effect.forEach(folders, (directory) =>
    random.uuidV4().pipe(Effect.map((id) => ({ id, canonicalPath: directory }))),
  );
  const snapshot =
    folders.length === 0
      ? undefined
      : yield* makeCommandSnapshot({ ...base, data: { ...base.data, sources: registrations } });
  const sources: ReadonlyArray<DeclaredSourceInspection> =
    snapshot === undefined ? [] : yield* snapshot.sourceInspections;
  const catalog = snapshot === undefined ? undefined : yield* snapshot.catalog;
  const unresolvedEdges = catalog === undefined ? [] : unresolvedDependencyEdges(catalog);
  const checks: CheckItem[] = [];
  const findings: CheckFinding[] = [];
  const seen = new Set<string>();
  const detectors = [
    ...documentationDetectors,
    ...(options.additionalDocumentationDetectors ?? []),
  ];
  const addFindings = (found: ReadonlyArray<Parameters<typeof locateFinding>[0]>) =>
    Effect.forEach(found, (finding) =>
      locateFinding(finding).pipe(
        Effect.map((located) => {
          findings.push(located);
        }),
      ),
    );
  const firstVisit = (kind: CheckItem["kind"], file: string) => {
    const key = `${kind}:${file}`;
    if (seen.has(key) === true) return false;
    seen.add(key);
    return true;
  };
  const readFailure = (file: string, code: string, message: string) => {
    findings.push({ code, severity: "error", file, line: 1, message });
  };
  const profile = Effect.fnUntraced(function* (file: string, ownerPath?: string) {
    if (firstVisit("profile", file) === false) return;
    const source = sources.find((candidate) => candidate.registration.canonicalPath === ownerPath);
    if (source?.status !== "healthy" || catalog === undefined) {
      checks.push({ kind: "profile", path: file, details: [] });
      readFailure(
        file,
        "check-profile-source",
        "A profile needs a healthy owning tack.yaml source. Include its source folder and any companion sources in this check.",
      );
      return;
    }
    const publication = profilePublications(
      source.registration.canonicalPath,
      source.declaration,
    ).publications.find(
      (candidatePublication) =>
        path.join(source.registration.canonicalPath, candidatePublication.path) === file,
    );
    if (publication === undefined) {
      checks.push({ kind: "profile", path: file, details: [] });
      readFailure(
        file,
        "profile-unpublished",
        "This profile file is not published by its source. Add its name/path to the version-2 tack.yaml profiles list.",
      );
      return;
    }
    const report = yield* checkProfileInContext(
      {
        source: {
          canonicalPath: source.registration.canonicalPath,
          declaration: source.declaration,
        },
        registration: source.registration,
        catalog,
      },
      publication.name,
    );
    const addressLine = (address: (typeof report.direct)[number]) =>
      `${address.kind} ${catalog.sources?.find((owner) => owner.registration.id === address.sourceRegistrationId)?.label ?? address.sourceRegistrationId}:${address.name}`;
    checks.push({
      kind: "profile",
      path: file,
      details: [
        `Structure: ${report.structural} · Source linkage: ${report.linkage}`,
        `Direct members (${report.direct.length})`,
        ...report.direct.map(addressLine),
        `Required dependencies (${report.required.length})`,
        ...report.required.map(addressLine),
      ],
    });
    yield* addFindings(
      report.findings.map((finding) =>
        finding.code === "profile-source-unregistered"
          ? {
              ...finding,
              message: finding.message.replace(
                "not registered and healthy.",
                "not present and healthy in these check paths.",
              ),
              remedy:
                "Include the missing companion source folder among tack check paths. This stateless check never fetches or reads registrations; source-based application still needs registration.",
            }
          : finding,
      ),
    );
  });
  const documents = Effect.fnUntraced(function* (input: string) {
    yield* Effect.gen(function* () {
      const files = yield* documentationFiles(input);
      if (files.length === 0 && firstVisit("docs", input) === true)
        checks.push({ kind: "docs", path: input, details: ["No Markdown documents found."] });
      for (const file of files) {
        if (firstVisit("docs", file) === false) continue;
        const observations = yield* Effect.forEach(detectors, (detector) => detector.inspect(file));
        checks.push({
          kind: "docs",
          path: file,
          details: observations.flatMap((observation) => observation.details),
        });
        findings.push(...observations.flatMap((observation) => observation.findings));
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (firstVisit("docs", input) === true)
            checks.push({ kind: "docs", path: input, details: [] });
          readFailure(input, "check-docs-read", error.message);
        }),
      ),
    );
  });
  const observeSource = Effect.fnUntraced(function* (directory: string) {
    if (firstVisit("source", directory) === false) return;
    const report = yield* checkSource(directory);
    checks.push({
      kind: "source",
      path: directory,
      details: Object.entries(report.counts).map(([kind, count]) => `${kind}: ${count}`),
    });
    yield* addFindings(report.findings);
    const inspected = sources.find(
      (candidate) => candidate.registration.canonicalPath === directory,
    );
    if (inspected?.status !== "healthy" || catalog === undefined) return;
    for (const issue of inspected.labelIssues ?? [])
      readFailure(path.join(directory, declarationFileName), issue.code, issue.message);
    findings.push(
      ...(yield* dependencyEdgeFindings(
        unresolvedEdges.filter(
          (edge) => edge.requester.sourceRegistrationId === inspected.registration.id,
        ),
        inspected.label ?? directory,
      )),
    );
    const published = profilePublications(directory, inspected.declaration);
    for (const publication of published.publications)
      yield* profile(path.join(directory, publication.path), directory);
    const docs = catalog.entries.flatMap((entry) =>
      entry.sourceRegistrationId === inspected.registration.id &&
      entry.address.kind === "docs" &&
      "directoryPath" in entry
        ? [entry.directoryPath]
        : [],
    );
    for (const docsDirectory of docs) yield* documents(docsDirectory);
  });
  const bundle = Effect.fnUntraced(function* (file: string) {
    if (firstVisit("bundle", file) === false) return;
    yield* inspectBundle(file).pipe(
      Effect.map((archive) => {
        checks.push({
          kind: "bundle",
          path: file,
          details: [
            `Bundle version ${archive.manifest.version} · ${archive.manifest.identity}`,
            `Profile ${archive.manifest.profile.name}`,
            ...archive.manifest.sources.flatMap((source) =>
              source.resources.map(
                (resource) =>
                  `${resource.direct === true ? "direct" : "required"} ${resource.kind} ${source.name ?? source.key}:${resource.name}`,
              ),
            ),
            `Exact payload (${archive.manifest.files.length} files/directories)`,
          ],
        });
      }),
      Effect.catch((error) =>
        Effect.sync(() => {
          checks.push({ kind: "bundle", path: file, details: [] });
          readFailure(file, "code" in error ? error.code : "check-bundle-invalid", error.message);
        }),
      ),
    );
  });
  for (const input of inputs) {
    if (input.findings.length > 0) {
      checks.push({ kind: input.kind, path: input.path, details: [] });
      findings.push(...input.findings);
      continue;
    }
    if (input.kind === "source") yield* observeSource(input.path);
    else if (input.kind === "profile") yield* profile(input.path, input.owner);
    else if (input.kind === "bundle") yield* bundle(input.path);
    else yield* documents(input.path);
  }
  return makeCheckReport(checks, findings);
});
