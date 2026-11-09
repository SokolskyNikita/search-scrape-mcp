import { messages } from "../config/messages.js";
import { z } from "zod";

export function toolInput<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      return messages.input.unknownFields(issue.keys, Object.keys(shape));
    },
  });
}
