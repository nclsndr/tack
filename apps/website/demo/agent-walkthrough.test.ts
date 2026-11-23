import { agentPrompt } from "@tackup/harness/prompts/landing";
import { describe, expect, it } from "vitest";
import {
  agentCalls,
  agentPacing,
  agentTypingDelay,
  agentWalkthrough,
  beatFigures,
  nextStep,
  pastes,
  replyPause,
  resumeStep,
  runAgentCall,
  spinnerFigures,
} from "./agent-walkthrough.ts";
import { makeDemoSession, type DemoSession } from "./demo-shell.ts";
import { demoWalkthrough } from "./demo-walkthrough.ts";

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/** What the explorer and Tack would show of the machine, with the docs mount's random id masked. */
const endState = async (session: DemoSession) => {
  const shown = await session.run(
    "tree ~/code/app && tree ~/code/api && tree ~/.claude && tree ~/.cursor && tack status --project app && tack status --project api",
    100,
  );
  return plain(shown.output).replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, "<id>");
};

/** Runs the CLI walkthrough from `from` to its end; returns each step's exit code. */
const finishInTerminal = async (session: DemoSession, from: number) => {
  const codes = [];
  for (const step of demoWalkthrough.slice(from))
    codes.push((await session.run(step.command, 100)).exitCode);
  return codes;
};

/** What each live output must say, because the reply after it says so. */
const facts: ReadonlyArray<readonly [command: string, fact: string]> = [
  ["tack init", "Enabled claude, codex, cursor."],
  ["tack init", "~/.claude/skills/my-notes"],
  ["tack source add ~/skills --skills .", "2 skills"],
  ["tack source add ~/team-docs --commands commands --docs handbook", "1 command"],
  ["tack check ~/skills", "skill: 2"],
  ["tack sync --project app", "11 changes planned"],
  ["tack sync --project api --apply", "0 failed"],
  ["tack status --project app", "7 linked, 0 need attention"],
  ["cd ~/skills && git pull --ff-only", "ship/SKILL.md"],
];

describe("agent walkthrough", () => {
  it("opens with the landing page's agent prompt, word for word", () => {
    expect(agentWalkthrough[0]?.events[0]).toEqual({ kind: "user", text: agentPrompt });
  });

  it("gives every beat a caption, one user message first and a reply last", () => {
    expect(
      agentWalkthrough.map((beat) => [
        beat.caption !== "",
        beat.events[0]?.kind,
        beat.events.at(-1)?.kind,
      ]),
    ).toEqual(agentWalkthrough.map(() => [true, "user", "assistant"]));
  });

  it("runs every call on the demo machine, and each output says what the reply after it claims", async () => {
    const session = makeDemoSession();
    const outcomes: Array<Awaited<ReturnType<typeof runAgentCall>>> = [];
    for (const call of agentCalls) outcomes.push(await runAgentCall(session, call, 100));
    const outputOf = (command: string) =>
      plain(outcomes[agentCalls.findIndex((call) => call.command === command)]?.output ?? "");

    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual(agentCalls.map(() => 0));
    expect(facts.filter(([command, fact]) => outputOf(command).includes(fact) === false)).toEqual(
      [],
    );
  });

  it("ends in the same state as the CLI walkthrough", async () => {
    const byAgent = makeDemoSession();
    for (const call of agentCalls) await runAgentCall(byAgent, call, 100);
    const byHand = makeDemoSession();
    await finishInTerminal(byHand, 0);

    expect(await endState(byAgent)).toBe(await endState(byHand));
  });

  it("hands over to the terminal after any call, which finishes the walkthrough to the same state", async () => {
    const reference = makeDemoSession();
    await finishInTerminal(reference, 0);
    const expected = await endState(reference);
    const handOffs = [];
    for (let done = 0; done <= agentCalls.length; done += 1) {
      const session = makeDemoSession();
      for (const call of agentCalls.slice(0, done)) await runAgentCall(session, call, 100);
      const codes = await finishInTerminal(session, resumeStep(done));
      handOffs.push({
        done,
        failed: codes.some((code) => code !== 0),
        same: (await endState(session)) === expected,
      });
    }

    expect(handOffs.filter((handOff) => handOff.failed === true || handOff.same === false)).toEqual(
      [],
    );
  });

  it("shows a scripted output for a call the demo machine cannot run, and changes nothing", async () => {
    const session = makeDemoSession();
    const scripted = agentCalls.filter((call) => call.output !== undefined);
    const outcomes = [];
    for (const call of scripted) outcomes.push(await runAgentCall(session, call, 80));

    expect(scripted.map((call) => call.command)).toEqual([
      "npm install --global @tackup/cli",
      "tack guide onboarding",
      "tack check ~/team-docs",
    ]);
    expect(outcomes).toEqual(scripted.map((call) => ({ output: call.output, exitCode: 0 })));
    expect(session.machine().volume.exists("/home/you/.tack")).toBe(false);
  });
});

describe("terminal hand-off", () => {
  it("resumes the CLI walkthrough at the start before any call, and at its last step after all", () => {
    expect(resumeStep(0)).toBe(0);
    expect(resumeStep(agentCalls.length)).toBe(demoWalkthrough.length - 1);
  });

  it("moves to the next suggested step only when the visitor ran the suggested one", () => {
    const step = demoWalkthrough[2]?.command ?? "";

    expect(nextStep(2, `  ${step} `)).toBe(3);
    expect(nextStep(2, "tack status")).toBe(2);
    expect(nextStep(demoWalkthrough.length, "anything")).toBe(demoWalkthrough.length);
  });
});

describe("agent pacing", () => {
  it("pastes a long message at once and types a short one", () => {
    expect([pastes(agentPrompt), pastes("Yes.")]).toEqual([true, false]);
  });

  it("types faster than the terminal does, within a person's range", () => {
    expect([agentTypingDelay(0), agentTypingDelay(0.999)]).toEqual([
      agentPacing.typeMinimum,
      agentPacing.typeMaximum - 1,
    ]);
  });

  it("leaves a longer reply on screen longer, up to a ceiling", () => {
    expect(replyPause(0)).toBe(agentPacing.afterReply);
    expect(replyPause(10)).toBe(agentPacing.afterReply + 10 * agentPacing.afterReplyPerWord);
    expect(replyPause(1000)).toBe(agentPacing.afterReplyMaximum);
  });
});

describe("agent thinking figures", () => {
  it("derives a beat's time and tokens from what it does, more for a longer beat", () => {
    const figures = agentWalkthrough.map((beat) => beatFigures(beat));
    const short = beatFigures({
      caption: "x",
      events: [
        { kind: "user", text: "Yes." },
        { kind: "assistant", text: "Done." },
      ],
    });

    expect(
      figures.every((figure) => figure.seconds > short.seconds && figure.tokens > short.tokens),
    ).toBe(true);
    expect(figures.every((figure) => Number.isInteger(figure.seconds))).toBe(true);
  });

  it("counts the live spinner up from zero to the beat's figures as its events play", () => {
    const figures = { seconds: 8, tokens: 695 };

    expect(spinnerFigures(figures, 0, 4)).toEqual({ seconds: 0, tokens: 0 });
    expect(spinnerFigures(figures, 2, 4)).toEqual({ seconds: 4, tokens: 348 });
    expect(spinnerFigures(figures, 4, 4)).toEqual(figures);
  });
});
