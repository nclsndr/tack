import { agentAdapterDescriptor } from "../../domain/agents/agent-adapter.ts";
import { deliversKind } from "../../domain/agents/agent-layout.ts";
import { selectedDependencyAddresses } from "../../domain/choices/dependency-resolution.ts";
import type { AgentAdapterId } from "../../domain/links/agent-adapter-schema.ts";
import { resolveContextSelection } from "../../domain/profiles/profile-application.ts";
import {
  isLinkableAddress,
  resourceAddressIdentity,
  type Catalog,
  type LinkableAddress,
} from "../../domain/sources/catalog-schema.ts";
import type { State } from "../../domain/state/state-schema.ts";

/** A resource that a user sync links for one adapter. */
export type UserLink = {
  readonly adapter: AgentAdapterId;
  readonly address: LinkableAddress;
};

/**
 * What a user sync links: each skill or command the user namespace selects, for every enabled
 * adapter that delivers its kind into the user's folders. It is decided from the selection, not
 * from the links on disk, so a removed user pick gives a project its own link back on the next
 * sync.
 */
export const userLinksOf = (
  state: State,
  catalog: Catalog,
  includeOptional: boolean,
): ReadonlyArray<UserLink> => {
  const addresses = selectedDependencyAddresses(
    resolveContextSelection(state, catalog, { _tag: "user" }, includeOptional).resolution,
  ).filter(isLinkableAddress);
  return state.data.enabledAdapters.flatMap((adapter) =>
    addresses
      .filter((address) =>
        deliversKind(agentAdapterDescriptor(adapter), { _tag: "user" }, address.kind),
      )
      .map((address) => ({ adapter, address })),
  );
};

/**
 * The resources among a project's `selected` ones that `adapter` leaves to the user's link: the
 * ones the same adapter links for the user. An agent would list such a resource twice, once from
 * each folder. A resource whose name another selected resource of its kind needs stays in, so the
 * plan still reports that collision.
 */
export const linkedForUser = (
  selected: ReadonlyArray<LinkableAddress>,
  userLinks: ReadonlyArray<UserLink>,
  adapter: AgentAdapterId,
): ReadonlyArray<LinkableAddress> => {
  const linked = new Set(
    userLinks.flatMap((link) =>
      link.adapter === adapter ? [resourceAddressIdentity(link.address)] : [],
    ),
  );
  const sharesName = (address: LinkableAddress) =>
    selected.some(
      (other) =>
        other.kind === address.kind &&
        other.name === address.name &&
        resourceAddressIdentity(other) !== resourceAddressIdentity(address),
    );
  return selected.filter(
    (address) => linked.has(resourceAddressIdentity(address)) && sharesName(address) === false,
  );
};
