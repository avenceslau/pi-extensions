import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import type { Review } from "./types.ts";

export async function selectReviews(
  ctx: ExtensionCommandContext,
  reviews: Review[],
  selected: ReadonlySet<string>,
): Promise<Set<string> | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Shepherd review selection requires TUI mode", "error");

    return undefined;
  }

  const working = new Set(
    [...selected].filter((key) => reviews.some((review) => review.key === key)),
  );

  return ctx.ui.custom<Set<string>>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = reviews.map((review) => ({
      id: review.key,
      label: `${review.key} · ${review.title} · ${review.summary}`,
      currentValue: working.has(review.key) ? "selected" : "ignored",
      values: ["selected", "ignored"],
    }));

    const container = new Container();
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Select reviews for Shepherd")),
        1,
        1,
      ),
    );

    const settings = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, value) => {
        if (value === "selected") {
          working.add(id);
        } else {
          working.delete(id);
        }
      },
      () => done(new Set(working)),
      { enableSearch: true },
    );

    container.addChild(settings);
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "Enter toggles · type to search · Esc accepts selection",
        ),
        1,
        0,
      ),
    );

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        settings.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

export async function chooseReview(
  ctx: ExtensionCommandContext,
  reviews: Review[],
  title: string,
): Promise<Review | undefined> {
  if (reviews.length === 0) {
    ctx.ui.notify("Shepherd has no selected reviews", "warning");

    return undefined;
  }

  if (reviews.length === 1) {
    return reviews[0];
  }

  const labels = reviews.map((review) => `${review.key} · ${review.title}`);
  const selected = await ctx.ui.select(title, labels);
  const index = selected ? labels.indexOf(selected) : -1;

  return index >= 0 ? reviews[index] : undefined;
}
