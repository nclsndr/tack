/** One file or module a bundled file refers to, as the bundle reference scan reports it. */
export type BundleReference = {
  readonly kind: "module" | "asset" | "computed";
  readonly value: string;
};
