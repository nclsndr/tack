import { defineScript } from "../src/script-api.ts";

defineScript({
  args: {
    name: { type: "string" },
    times: { type: "number", default: 1 },
    tone: { type: "string", choices: ["warm", "dry"] },
    shout: { type: "boolean", optional: true },
    labels: { type: "string", multiple: true, optional: true },
  },
  secrets: ["API_TOKEN"],
  run: ({ args, secrets }) => {
    const name: string = args.name;
    const times: number = args.times;
    const tone: "warm" | "dry" = args.tone;
    const shout: boolean | undefined = args.shout;
    const labels: ReadonlyArray<string> | undefined = args.labels;
    const token: string = secrets.API_TOKEN;
    // @ts-expect-error An optional argument may be absent.
    const always: boolean = args.shout;
    // @ts-expect-error Only declared arguments exist.
    void args.nmae;
    // @ts-expect-error Only declared secrets exist.
    void secrets.OTHER_TOKEN;
    return { name, times, tone, shout, labels, token, always };
  },
});

// @ts-expect-error A script needs a run function.
defineScript({ args: {} });
