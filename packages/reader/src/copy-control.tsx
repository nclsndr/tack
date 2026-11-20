import { Check, ChevronDown } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { useContext, useId, type ReactNode } from "react";
import { Glyph } from "./glyph.tsx";
import { menuPanel, ReaderPortalContainer } from "./menu.tsx";
import type { CopyMode } from "./types.ts";

/** Every copy format, in menu order, with the line that says what it puts on the clipboard. */
const copyFormats = {
  readable: {
    label: "Readable + sources",
    description: "The text as rendered, with view state and the source lines it came from.",
  },
  raw: {
    label: "Raw source",
    description: "The saved Markdown or MDX of each block, with its source lines.",
  },
  reference: {
    label: "References only",
    description: "Only the source files and lines, without their content.",
  },
} as const satisfies Record<CopyMode, { label: string; description: string }>;

const isCopyMode = (value: unknown): value is CopyMode =>
  typeof value === "string" && Object.hasOwn(copyFormats, value);

/** The look both parts share when a selection is ready to copy: the reader's blue hand. */
const ready =
  "data-[ready=true]:border-pen data-[ready=true]:bg-pen data-[ready=true]:text-paper data-[ready=true]:hover:border-pen-strong data-[ready=true]:hover:bg-pen-strong";

/** One menu row: the check column, then the option's title over its description. */
const option =
  "grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-sm px-2.5 py-2 text-sm leading-snug text-body outline-none select-none data-highlighted:bg-hover";
const indicator = "col-start-1 row-start-1 inline-flex self-center text-pen";

function OptionText({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <>
      <span id={`${id}-title`} className="col-start-2 row-start-1 font-semibold text-ink">
        {title}
      </span>
      <span id={`${id}-description`} className="col-start-2 row-start-2 text-muted">
        {description}
      </span>
    </>
  );
}

/**
 * The reader header's copy control, a split button: the primary part copies the current text
 * selection, and the attached chevron opens a menu of copy formats (title, one-line description,
 * a check on the current one) and the component implementation toggle. The settings apply to
 * every copy the reader makes, so the caller owns them. Choosing a format closes the menu on the
 * chevron, as Escape does; the toggle keeps it open.
 *
 * @param selectedBlocks - Authored blocks the current selection covers; above zero both parts turn
 *   the reader's blue and the primary part shows the count.
 */
export function CopyControl({
  selectedBlocks,
  onCopy,
  mode,
  onModeChange,
  includeImplementations,
  onIncludeImplementationsChange,
}: {
  selectedBlocks: number;
  onCopy: () => void;
  mode: CopyMode;
  onModeChange: (mode: CopyMode) => void;
  includeImplementations: boolean;
  onIncludeImplementationsChange: (include: boolean) => void;
}): ReactNode {
  const container = useContext(ReaderPortalContainer);
  const id = useId();
  const isReady = selectedBlocks > 0;
  const implementationId = `${id}-implementation`;
  return (
    <div className="flex" role="group" aria-label="Copy">
      <button
        type="button"
        className={`relative rounded-r-none whitespace-nowrap hover:z-1 ${ready}`}
        data-ready={isReady}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCopy}
      >
        Copy selection
        {isReady ? (
          <span className="border-l border-current pl-2 tabular-nums opacity-85">
            {selectedBlocks === 1 ? "1 block" : `${selectedBlocks} blocks`}
          </span>
        ) : null}
      </button>
      <Menu.Root modal={false}>
        <Menu.Trigger
          className={`relative -ml-px w-8 justify-center rounded-l-none px-0 hover:z-1 data-popup-open:bg-hover data-[ready=true]:border-l-paper/40 ${ready}`}
          data-ready={isReady}
          aria-label={`Copy format: ${copyFormats[mode].label}`}
        >
          <Glyph
            icon={ChevronDown}
            className="transition-transform duration-200 in-data-popup-open:rotate-180"
          />
        </Menu.Trigger>
        <Menu.Portal container={container}>
          <Menu.Positioner className="z-70" side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className={`${menuPanel} w-80 gap-0.5 p-1`}>
              <Menu.RadioGroup
                className="grid gap-0.5"
                aria-label="Copy format"
                value={mode}
                onValueChange={(value: unknown) => {
                  // Coverage skip: the group only reports the values of the items it renders.
                  /* v8 ignore next -- @preserve */
                  if (isCopyMode(value) === false) return;
                  onModeChange(value);
                }}
              >
                {Object.entries(copyFormats).map(([value, format]) => (
                  <Menu.RadioItem
                    key={value}
                    value={value}
                    closeOnClick
                    className={option}
                    aria-labelledby={`${id}-${value}-title`}
                    aria-describedby={`${id}-${value}-description`}
                  >
                    <Menu.RadioItemIndicator className={indicator}>
                      <Glyph icon={Check} />
                    </Menu.RadioItemIndicator>
                    <OptionText
                      id={`${id}-${value}`}
                      title={format.label}
                      description={format.description}
                    />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <Menu.Separator className="mx-2.5 my-0.5 h-px bg-rule" />
              <Menu.CheckboxItem
                className={option}
                checked={includeImplementations}
                onCheckedChange={(checked: boolean) => onIncludeImplementationsChange(checked)}
                aria-labelledby={`${implementationId}-title`}
                aria-describedby={`${implementationId}-description`}
              >
                <Menu.CheckboxItemIndicator className={indicator}>
                  <Glyph icon={Check} />
                </Menu.CheckboxItemIndicator>
                <OptionText
                  id={implementationId}
                  title="Include component implementation"
                  description="Also cite the files that implement the components each block renders."
                />
              </Menu.CheckboxItem>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
