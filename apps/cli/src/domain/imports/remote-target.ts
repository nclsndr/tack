/**
 * What a provider says about one repository: the git URL, the protocols it asks git to use, and
 * how to get access. The protocols are a request: the fetch layer never allows one outside
 * {@link productionProtocols}.
 */
export type RemoteTarget = {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  /** Where a fixture remote keeps this repository, relative to the fixture root, without `.git`. */
  readonly fixturePath: string;
  /** What an operator can do when git cannot read the repository without credentials. */
  readonly authenticationHelp: string;
};
