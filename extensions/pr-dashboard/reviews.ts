export type ReviewForge = "github" | "gitlab";
export type ReviewState = "open" | "merged" | "closed";

export interface Review {
  number: number;
  title: string;
  branch: string;
  url: string;
  state: ReviewState;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stateForReview(
  forge: ReviewForge,
  state: string,
  mergedAt: unknown,
): ReviewState {
  if (forge === "github") {
    if (mergedAt) {
      return "merged";
    }

    return state === "open" ? "open" : "closed";
  }

  if (state === "opened") {
    return "open";
  }

  return state === "merged" ? "merged" : "closed";
}

export function reviewsFromJson(
  forge: ReviewForge,
  output: string,
): Review[] | undefined {
  let values: unknown;

  try {
    values = JSON.parse(output);
  } catch {
    return undefined;
  }

  if (!Array.isArray(values)) {
    return undefined;
  }

  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }

    const fields = value as Record<string, unknown>;
    const number = forge === "github" ? fields.number : fields.iid;
    const title = stringField(fields.title);
    const branch = stringField(
      forge === "github" ? fields.headRefName : fields.source_branch,
    );
    const url = stringField(forge === "github" ? fields.url : fields.web_url);
    const rawState = stringField(fields.state)?.toLowerCase();

    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      !title ||
      !branch ||
      !url ||
      !rawState
    ) {
      return [];
    }

    return [
      {
        number,
        title,
        branch,
        url,
        state: stateForReview(forge, rawState, fields.mergedAt),
      },
    ];
  });
}
