import { describe, expect, it } from "vitest";
import { hasLanded, heroIntro, heroScroll, pinStart, wordDelay } from "./hero-intro-timeline.ts";

describe("hero intro timeline", () => {
  it("starts the first word at once", () => {
    expect(wordDelay(0)).toBe(0);
  });

  it("starts each word after the one before it, with a gap that shrinks", () => {
    const delays = [0, 1, 2, 3, 4, 5].map(wordDelay);
    const gaps = delays.slice(1).map((delay, index) => delay - (delays[index] ?? 0));
    expect(gaps[0]).toBeCloseTo(heroIntro.wordGap);
    gaps.slice(1).forEach((gap, index) => {
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(gaps[index] ?? 0);
    });
  });

  it("keeps a long headline inside its budget", () => {
    expect(wordDelay(40)).toBeLessThan(heroIntro.wordGap / (1 - heroIntro.wordGapDecay));
  });
});

describe("hero scroll", () => {
  it("lands the window at the end of the pin, and not before", () => {
    expect(hasLanded(0)).toBe(false);
    expect(hasLanded(heroScroll.landed - 0.05)).toBe(false);
    expect(hasLanded(heroScroll.landed)).toBe(true);
    expect(hasLanded(1)).toBe(true);
  });

  it("finishes every scroll-linked part when the pin lets go", () => {
    const ends = [heroScroll.window, heroScroll.lamp, heroScroll.rim, heroScroll.marks].map(
      ([, end]) => end,
    );
    ends.forEach((end) => expect(end).toBe(1));
  });
});

describe("pin start", () => {
  /** A laptop screen: the copy and the window at rest 48px apart, 48px below the top. */
  const laptop = {
    viewport: 900,
    header: 80,
    copyTop: 48,
    copyHeight: 280,
    windowTop: 376,
    windowHeight: 640,
    travel: 480,
  };

  /** Where the copy and the window sit on screen at `progress` through the pin, and the header's bottom. */
  const at = (layout: typeof laptop, progress: number) => {
    const start = pinStart(layout);
    const [first, then] = start.copy;
    const copyShift =
      progress <= start.headerGone
        ? first + ((then - first) * progress) / start.headerGone
        : then * ((1 - progress) / (1 - start.headerGone));
    return {
      header: Math.max(0, layout.header - layout.travel * progress),
      copyTop: layout.copyTop + copyShift,
      windowTop: layout.windowTop + start.window * (1 - progress),
    };
  };

  it("centres the copy between the header and a strip of the window", () => {
    const opening = at(laptop, 0);
    expect(opening.copyTop - opening.header).toBeCloseTo(
      opening.windowTop - (opening.copyTop + laptop.copyHeight),
    );
    expect(laptop.viewport - opening.windowTop).toBeCloseTo(126);
  });

  it("keeps the room above the copy equal to the room below it at every point of the pin", () => {
    for (const progress of [0, 0.05, 1 / 6, 0.3, 0.5, 0.8, 1]) {
      const place = at(laptop, progress);
      expect(place.copyTop - place.header).toBeCloseTo(
        place.windowTop - (place.copyTop + laptop.copyHeight),
      );
    }
  });

  it("ends with the copy and the window at rest", () => {
    const end = at(laptop, 1);
    expect(end.copyTop).toBeCloseTo(laptop.copyTop);
    expect(end.windowTop).toBeCloseTo(laptop.windowTop);
  });

  it("keeps the strip of the window between its bounds", () => {
    const brief = { ...laptop, copyHeight: 120, windowTop: 216 };
    const short = pinStart({ ...brief, viewport: 500 });
    const tall = pinStart({ ...laptop, viewport: 1400 });
    expect(500 - (brief.windowTop + short.window)).toBe(88);
    expect(1400 - (laptop.windowTop + tall.window)).toBe(150);
  });

  it("puts a copy too tall to centre just under the header, with the window right below it", () => {
    const phone = { ...laptop, viewport: 844, copyHeight: 640, windowTop: 736 };
    const opening = at(phone, 0);
    expect(opening.copyTop).toBe(phone.header + 16);
    expect(opening.windowTop).toBe(phone.header + 16 + 640 + 48);
  });

  it("never moves the copy down on its way up", () => {
    const phone = { ...laptop, viewport: 844, copyHeight: 640, windowTop: 736 };
    for (const layout of [laptop, phone]) {
      const steps = [0, 0.1, 1 / 6, 0.4, 0.7, 1].map((progress) => at(layout, progress).copyTop);
      steps.slice(1).forEach((top, index) => expect(top).toBeLessThanOrEqual(steps[index] ?? 0));
    }
  });

  it("takes the header's departure to the end of a pin shorter than the header", () => {
    expect(pinStart({ ...laptop, travel: 40 }).headerGone).toBe(1);
  });

  it("leaves room after the hero for the part of the window below the screen", () => {
    expect(pinStart(laptop).overflow).toBe(116);
    expect(pinStart({ ...laptop, windowHeight: 400 }).overflow).toBe(0);
  });
});
