import { describe, expect, it } from "vitest";

import { definingSentence, questions } from "./landing/content.ts";
import { repositoryUrl, siteUrl } from "./site.ts";
import { jsonLd, landingData } from "./structured-data.ts";

describe("the landing page's structured data", () => {
  const [application, faq] = landingData["@graph"];

  it("describes Tack with the defining sentence, its package name and its homes", () => {
    expect(application).toMatchObject({
      "@type": "SoftwareApplication",
      name: "Tack",
      alternateName: "@tackup/cli",
      description: definingSentence,
      url: siteUrl("/"),
      sameAs: [repositoryUrl, "https://www.npmjs.com/package/@tackup/cli"],
    });
  });

  it("asks the questions the page answers, word for word", () => {
    expect(faq.mainEntity).toEqual(
      questions.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    );
  });
});

describe("jsonLd", () => {
  it("is a head script whose text parses back to the data", () => {
    const [tag, props] = jsonLd({ a: "b" });
    expect(tag).toBe("script");
    expect(props.type).toBe("application/ld+json");
    expect(JSON.parse(props.children)).toEqual({ a: "b" });
  });

  it("cannot close its script tag early", () => {
    const [, props] = jsonLd({ text: "</script><script>alert(1)</script>" });
    expect(props.children).not.toContain("</");
    expect(JSON.parse(props.children)).toEqual({ text: "</script><script>alert(1)</script>" });
  });
});
