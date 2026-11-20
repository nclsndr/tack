import { describe, expect, it } from "vitest";
import {
  atBottom,
  followAfter,
  following,
  unseenLabel,
  type FollowEvent,
} from "./scroll-follow.ts";

const run = (events: ReadonlyArray<FollowEvent>) => events.reduce(followAfter, following);

describe("scroll follow", () => {
  it("counts a view within a few pixels of the end as at the bottom", () => {
    expect([
      atBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }),
      atBottom({ scrollTop: 580, clientHeight: 400, scrollHeight: 1000 }),
      atBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }),
      atBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 }),
    ]).toEqual([true, true, false, true]);
  });

  it("follows new messages until the reader scrolls up", () => {
    expect(run([{ kind: "grew", added: 2 }])).toEqual({ follow: true, unseen: 0 });
    expect(run([{ kind: "scrolled", atBottom: false }])).toEqual({ follow: false, unseen: 0 });
  });

  it("counts the messages that arrive below a reader who scrolled up", () => {
    expect(
      run([
        { kind: "scrolled", atBottom: false },
        { kind: "grew", added: 1 },
        { kind: "grew", added: 2 },
        { kind: "scrolled", atBottom: false },
      ]),
    ).toEqual({ follow: false, unseen: 3 });
  });

  it("follows again, with nothing unseen, once the reader is back at the bottom or jumps there", () => {
    const behind: ReadonlyArray<FollowEvent> = [
      { kind: "scrolled", atBottom: false },
      { kind: "grew", added: 1 },
    ];

    expect(run([...behind, { kind: "scrolled", atBottom: true }])).toEqual(following);
    expect(run([...behind, { kind: "jumped" }])).toEqual(following);
    expect(run([...behind, { kind: "cleared" }])).toEqual(following);
  });

  it("names the unseen messages as the hint reads them", () => {
    expect([unseenLabel(1), unseenLabel(4)]).toEqual([
      "1 new message (click) ↓",
      "4 new messages (click) ↓",
    ]);
  });
});
