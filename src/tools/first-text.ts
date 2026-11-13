/** The text of a tool result's first content block. Used by the tests. */
export function firstText(result: { content?: unknown }): string {
  const [block] = result.content as { type?: string; text?: unknown }[];
  if (typeof block?.text !== "string")
    throw new Error("The result does not start with a text block.");
  return block.text;
}
