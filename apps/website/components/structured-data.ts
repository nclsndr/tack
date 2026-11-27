import { definingSentence, questions } from "./landing/content.ts";
import { repositoryUrl, siteUrl } from "./site.ts";

/** The package's page on npm. */
const packageUrl = "https://www.npmjs.com/package/@tackup/cli";

/**
 * The landing page as schema.org data: what Tack is, under the name of its package and with its
 * homes, so a reader can tell it from the other tools named tack, and the questions the page
 * answers, word for word.
 */
export const landingData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "Tack",
      alternateName: "@tackup/cli",
      description: definingSentence,
      url: siteUrl("/"),
      applicationCategory: "DeveloperApplication",
      license: "https://opensource.org/licenses/MIT",
      isAccessibleForFree: true,
      sameAs: [repositoryUrl, packageUrl],
    },
    {
      "@type": "FAQPage",
      mainEntity: questions.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
} as const;

/**
 * A page's head script that carries structured data. `<` is escaped, so no string in the data can
 * close the script.
 */
export const jsonLd = (data: unknown): ["script", { type: string; children: string }] => [
  "script",
  { type: "application/ld+json", children: JSON.stringify(data).replaceAll("<", "\\u003c") },
];
