import type { HumanViewRegistry } from "./human-view.ts";
import { historyListView, historyShowView } from "./run-history.ts";
import { docsIconsView } from "./run-icons.ts";
import { readerSearchView, readerView } from "./run-reader.ts";
import { scriptRunView } from "./run-script.ts";
import { scriptShowView } from "./script-show.ts";
import { typesView } from "./types-view.ts";

/**
 * Dedicated views for the reader, the figure check, the docs icon lookup, script runs and
 * retained run history.
 */
export const runViews = {
  "docs-icons": docsIconsView,
  "docs-serve": readerView,
  "docs-search": readerSearchView,
  "script-run": scriptRunView,
  "script-show": scriptShowView,
  types: typesView,
  "script-history-list": historyListView,
  "script-history-show": historyShowView,
} satisfies HumanViewRegistry;
