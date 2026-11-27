import {
  choiceNamespaceIdentity,
  type SkillChoice,
} from "../../../domain/choices/choice-schema.ts";
import { AgentAdapterIdSchema } from "../../../domain/agents/agent-adapter-schema.ts";
import { ChoiceListPayloadSchema } from "../../../features/choices/choice.ts";
import { AdapterListPayloadSchema } from "../../../features/reconciliation/agent.ts";
import type { HumanViewRegistry } from "./render.ts";
import { cell, paragraph, table } from "./text.ts";
import { addressText, factRows, headingLines, plural } from "./view.ts";
import { decoderFor, resultView } from "./inspection-support.ts";
import { commandLine } from "../command-line.ts";

const namespaceTitle = (namespace: SkillChoice["namespace"]) =>
  namespace._tag === "project" ? `Project ${namespace.projectName}` : "User";

/** Choices grouped by namespace, in the order the list already has. */
const groupByNamespace = (choices: ReadonlyArray<SkillChoice>) => {
  const groups = new Map<string, { namespace: SkillChoice["namespace"]; choices: SkillChoice[] }>();
  for (const choice of choices) {
    const key = choiceNamespaceIdentity(choice.namespace);
    const group = groups.get(key) ?? { namespace: choice.namespace, choices: [] };
    group.choices.push(choice);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const choiceListView = resultView(
  decoderFor(ChoiceListPayloadSchema),
  ({ choices }, _envelope, style) => {
    const groups = groupByNamespace(choices);
    const [first] = groups;
    return {
      scope: plural(choices.length, "choice"),
      body:
        groups.length === 0
          ? [paragraph("No choices are stored.", { width: style.width })]
          : groups.map(({ namespace, choices: members }) => [
              ...headingLines(namespaceTitle(namespace), plural(members.length, "choice"), style),
              ...table(
                members.map((choice) => [
                  cell(choice.decision === "include" ? "+ include" : "− exclude"),
                  cell(addressText(choice.address, style)),
                ]),
                { width: style.width },
              ),
            ]),
      hints:
        first === undefined
          ? [commandLine("catalog")]
          : [
              first.namespace._tag === "project"
                ? commandLine("sync", "--project", first.namespace.projectName)
                : commandLine("sync", "--user"),
            ],
    };
  },
);

const adapterListView = resultView(
  decoderFor(AdapterListPayloadSchema),
  ({ enabledAdapters: enabled }, _envelope, style) => {
    const known = AgentAdapterIdSchema.literals;
    const disabled = known.filter((adapter) => !enabled.includes(adapter));
    return {
      scope: `${enabled.length} of ${known.length} enabled`,
      body: [
        enabled.length === 0
          ? paragraph("No adapters are enabled, so no skills are delivered.", {
              width: style.width,
            })
          : undefined,
        factRows(
          [
            ...(enabled.length === 0 ? [] : [["Enabled", [cell(enabled.join(", "))]] as const]),
            ...(disabled.length === 0
              ? []
              : [["Not enabled", [cell(disabled.join(", "))]] as const]),
          ],
          style,
        ),
      ],
      hints: [
        enabled.length === 0 && disabled[0] !== undefined
          ? commandLine("adapter-set", disabled[0])
          : commandLine("status"),
      ],
    };
  },
);

/** Choice and adapter list views. */
export const listViews: HumanViewRegistry = {
  pick: choiceListView,
  adapter: adapterListView,
};
