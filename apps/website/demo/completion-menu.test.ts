import { describe, expect, it } from "vitest";
import { acceptMenu, menuLine, moveMenu, openMenu } from "./completion-menu.ts";

const completion = {
  line: "cd ~/code/ap",
  head: "cd ",
  options: [{ value: "~/code/api/" }, { value: "~/code/app/" }, { value: "~/code/apz" }],
};

describe("completion menu", () => {
  it("opens with nothing selected, keeping the line Tab already completed", () => {
    const menu = openMenu(completion);

    expect(menu.index).toBe(-1);
    expect(menuLine(menu)).toBe("cd ~/code/ap");
  });

  it("selects forward on each Tab and wraps around", () => {
    const first = moveMenu(openMenu(completion), 1);
    const third = moveMenu(moveMenu(first, 1), 1);

    expect(menuLine(first)).toBe("cd ~/code/api/");
    expect(menuLine(third)).toBe("cd ~/code/apz");
    expect(menuLine(moveMenu(third, 1))).toBe("cd ~/code/api/");
  });

  it("selects backward with Shift+Tab, starting from the last", () => {
    const last = moveMenu(openMenu(completion), -1);

    expect(menuLine(last)).toBe("cd ~/code/apz");
    expect(menuLine(moveMenu(last, -1))).toBe("cd ~/code/app/");
  });

  it("accepts the selection with a space after it, but not after a folder", () => {
    expect(acceptMenu(moveMenu(openMenu(completion), -1))).toBe("cd ~/code/apz ");
    expect(acceptMenu(moveMenu(openMenu(completion), 1))).toBe("cd ~/code/api/");
    expect(acceptMenu(openMenu(completion))).toBe("cd ~/code/ap");
  });
});
