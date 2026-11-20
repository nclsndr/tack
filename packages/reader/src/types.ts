/** A physical range in a saved, authored file. Lines are one-based and inclusive. */
export type SourceReference = {
  path: string;
  startLine: number;
  endLine: number;
  kind?: "data" | "fragment" | "implementation";
};

export type SourceBlock = {
  id: string;
  kind: string;
  readable: string;
  raw: string;
  version: string;
  source: SourceReference;
  contributors: SourceReference[];
  implementations?: SourceReference[];
};

export type DocumentMetadata = {
  title: string;
  type?: string;
  status?: string;
  tags: string[];
  layout?: string;
};

export type DocumentImport = {
  specifier: string;
  identifiers: string[];
  source: SourceReference;
};

/** Identifies the registered source that declared a docs resource. */
export type DocsResourceReference = {
  sourceRegistrationId: string;
  name: string;
};

/** A readable docs directory inside a registered source checkout. */
export type ReaderResource = DocsResourceReference & {
  sourcePath: string;
  directoryPath: string;
  /** Source declarations are re-read so saved inline settings and YAML links reload together. */
  readerConfig?: { kind: "source" | "file"; path: string } | undefined;
};

/**
 * A docs resource, or one selected document inside it, that could not join an otherwise usable
 * project corpus. A document issue carries the document's `path`; a resource issue omits it.
 */
export type ReaderResourceIssue = {
  resource: DocsResourceReference;
  sourcePath: string;
  code: string;
  message: string;
  path?: string | undefined;
};

/**
 * What a project root has checked out: a named branch, or a detached commit abbreviated to seven
 * characters. A root outside any git repository has no checkout, which the reader shows as `null`.
 */
export type ReaderCheckout =
  | { kind: "branch"; name: string }
  | { kind: "detached"; commit: string };

/** All docs resources selected for one project reader session. */
export type ReaderProjectInput = {
  project: { name: string; root: string };
  resources: ReaderResource[];
  issues: ReaderResourceIssue[];
  defaultWritingResource?: DocsResourceReference | undefined;
};

/** Provenance retained on every document, copied selection, and search result. */
export type ReaderDocumentResource = DocsResourceReference & { sourcePath: string };

export type ReaderDocument = {
  id: string;
  path: string;
  relativePath: string;
  route: string;
  title: string;
  metadata: DocumentMetadata;
  blocks: SourceBlock[];
  imports: DocumentImport[];
  searchText: string;
  source: string;
  resource?: ReaderDocumentResource;
};

/** One resource's independently loaded documents and any resource-local failure. */
export type ReaderResourceLoadResult = {
  resource: ReaderResource;
  documents: ReaderDocument[];
  issues: ReaderResourceIssue[];
  config?: ReaderConfig;
};

/** The browser and agent loader's shared, fault-tolerant project corpus. */
export type ReaderProjectCorpus = {
  documents: ReaderDocument[];
  resources: ReaderResourceLoadResult[];
  issues: ReaderResourceIssue[];
  complete: boolean;
};

type Customization<Preset extends string> = { preset?: Preset; module?: string };

export type ReaderConfig = {
  version: 1;
  worktree: string;
  configPath: string;
  content: { root: string; include: string[]; exclude: string[] }[];
  /** `archive` holds absolute folders whose documents leave the main index for its archive shelf. */
  navigation: Customization<"folders"> & { archive?: string[] };
  layouts: Customization<"reader">;
  components: Customization<"standard">;
  metadata: {
    preset?: "working-docs";
    types: string[];
    statuses: string[];
    tags: string[];
  };
};

export type CopyMode = "readable" | "raw" | "reference";

export type CopyInput = {
  blocks: SourceBlock[];
  readable?: string;
  state?: Record<string, unknown>;
  mode?: CopyMode;
  includeImplementations?: boolean;
  /** Saved sources indexed by absolute path, for raw imported-data context. */
  sources?: Record<string, string>;
  /** Docs resources that supplied the selected blocks. */
  resources?: ReaderDocumentResource[];
};
