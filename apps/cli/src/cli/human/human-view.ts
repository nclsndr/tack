import type { Option } from "effect";
import type { Invocation } from "../commands/index.ts";
import type { DeclaredPayload, PayloadSlot } from "../commands/declarations.ts";
import type { PublicEnvelope } from "../envelope/public-outcome.ts";
import type { Style } from "./style.ts";

type InvocationTag = Invocation["_tag"];

/**
 * The payload slots of an envelope, decoded with the schemas its invocation declares. A slot that
 * is empty, undeclared or of another shape is `None`.
 */
export type Payloads<Tag extends InvocationTag> = {
  readonly [Slot in PayloadSlot]: Option.Option<DeclaredPayload<Tag, Slot>>;
};

/**
 * The dedicated view of one invocation. It declines a payload it cannot show, such as a `None`
 * slot, and the generic view shows it instead. `details` is true under `--details`: the view shows
 * every row it would otherwise cap. A view that caps nothing ignores it.
 */
export type HumanView<Tag extends InvocationTag = InvocationTag> = (
  envelope: PublicEnvelope,
  payloads: Payloads<Tag>,
  style: Style,
  details: boolean,
) => string | undefined;
/** The view of every invocation, by tag. */
export type HumanViews = { readonly [Tag in InvocationTag]: HumanView<Tag> };

/** Views for some invocations; an invocation without one renders through the generic view. */
export type HumanViewRegistry = Partial<HumanViews>;
