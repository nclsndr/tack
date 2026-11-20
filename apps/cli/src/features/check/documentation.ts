import { Effect, type FileSystem, type Path } from "effect";
import { ReaderCorpus } from "../../services/reader-corpus.ts";
import { checkDocsFigures } from "../reader/figure-check.ts";
import type { CheckFinding } from "../../domain/check/check-schema.ts";

/** Static docs validators return observations without executing authored content. */
export type DocumentationDetector = {
  readonly name: string;
  readonly inspect: (
    file: string,
  ) => Effect.Effect<
    { readonly details: ReadonlyArray<string>; readonly findings: ReadonlyArray<CheckFinding> },
    never,
    ReaderCorpus | FileSystem.FileSystem | Path.Path
  >;
};

/** Uses the reader's static figure, icon and component validators without executing authored code. */
const figureDetector: DocumentationDetector = {
  name: "figures",
  inspect: (file) =>
    checkDocsFigures([file]).pipe(
      Effect.map((report) => ({
        details: [
          `Figures (${report.figures})`,
          `Icons (${report.icons})`,
          `Author components (${report.components})`,
        ],
        findings: report.documents.flatMap((document) => [
          ...document.figures.flatMap((figure): ReadonlyArray<CheckFinding> =>
            figure.status === "issues"
              ? [
                  {
                    code: "figure-issues",
                    severity: "error",
                    file: document.path,
                    line: Math.max(1, figure.line),
                    message: `${figure.id}: ${figure.issues.join("; ")}`,
                  },
                ]
              : figure.status === "not-checked"
                ? [
                    {
                      code: "figure-not-checked",
                      severity: "warning",
                      file: document.path,
                      line: Math.max(1, figure.line),
                      message: `${figure.id}: ${figure.reason}`,
                    },
                  ]
                : (figure.unchecked ?? []).map((message) => ({
                    code: "figure-partly-checked",
                    severity: "warning",
                    file: document.path,
                    line: Math.max(1, figure.line),
                    message: `${figure.id}: ${message}`,
                  })),
          ),
          ...document.iconIssues.map((issue): CheckFinding => ({
            code: "icon-unknown",
            severity: "error",
            file: document.path,
            line: Math.max(1, issue.line),
            message: issue.message,
          })),
          ...document.componentIssues.map((issue): CheckFinding => ({
            code: "component-issue",
            severity: "error",
            file: document.path,
            line: Math.max(1, issue.line),
            message: issue.message,
          })),
        ]),
      })),
      Effect.catch((error) =>
        Effect.succeed({
          details: [],
          findings: [
            {
              code: "check-docs-read",
              severity: "error" as const,
              file,
              line: 1,
              message: error.message,
            },
          ],
        }),
      ),
    ),
};

/** Shipped static docs checks; append independent validators here as they become available. */
export const documentationDetectors: ReadonlyArray<DocumentationDetector> = [figureDetector];
