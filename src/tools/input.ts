import { z } from "zod";

export function toolInput<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const unknown = issue.keys.map((key) => JSON.stringify(key)).join(", ");
      return `Unknown field${issue.keys.length === 1 ? "" : "s"} ${unknown}. Valid fields are ${Object.keys(shape).join(", ")}.`;
    },
  });
}
