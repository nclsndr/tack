import { providerNameProblem, type ImportProvider } from "./provider.ts";

/** Problems that make a list of providers unusable: bad or duplicate names, shared hosts. */
export const registryProblems = (
  providers: ReadonlyArray<ImportProvider>,
): ReadonlyArray<string> => [
  ...providers.flatMap((provider) => {
    const problem = providerNameProblem(provider.name);
    return problem === undefined ? [] : [problem];
  }),
  ...providers.flatMap((provider, index) =>
    providers.findIndex((other) => other.name === provider.name) === index
      ? []
      : [`Two providers are named ${provider.name}.`],
  ),
  ...providers.flatMap((provider, index) =>
    provider.hosts.flatMap((host) =>
      providers.some((other, otherIndex) => otherIndex < index && other.hosts.includes(host))
        ? [`More than one provider serves ${host}.`]
        : [],
    ),
  ),
];
