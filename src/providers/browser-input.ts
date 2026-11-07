import type { Locator, Page } from "playwright-core";

export function browserInputs(page: Page) {
  let filledSearch: { ref: string; locator: Locator } | undefined;

  page.on("framenavigated", () => {
    filledSearch = undefined;
  });
  return {
    async fill(locator: Locator, text: string, ref?: string) {
      filledSearch = undefined;
      // Search widgets can hydrate after input and replace the referenced node.
      // Keep a locator for the same named control in its form across that swap.
      const search = ref
        ? await locator.evaluate((element) => {
            if (
              !(element instanceof HTMLInputElement) ||
              window !== window.top ||
              (element.type !== "search" &&
                element.getAttribute("role") !== "combobox") ||
              !element.name ||
              !element.form?.contains(element)
            )
              return undefined;
            const action = element.form.getAttribute("action");
            const form =
              action === null
                ? "form:not([action])"
                : `form[action="${CSS.escape(action)}"]`;
            return `${form} input[name="${CSS.escape(element.name)}"]:visible`;
          })
        : undefined;
      const stable = search ? page.locator(search) : undefined;
      const unique = stable && (await stable.count()) === 1;
      await locator.fill(text);
      if (unique && ref) filledSearch = { ref, locator: stable };
    },

    async press(locator: Locator, key: string, ref?: string) {
      const target =
        filledSearch && filledSearch.ref === ref
          ? filledSearch.locator
          : locator;
      await target.press(key);
    },
  };
}
