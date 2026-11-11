/** DSH client factory for the official usage links on the Cursor plugin detail page. */
window.__ModuleLoader__.load({
  id: "cursor-to-dsh",
  factory(require) {
    const { createElement } = require("react");
    const slot = "plugins.detail.section";

    return {
      name: "cursor-to-dsh",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: "cursor-to-dsh-usage" }, ({ subject }) => {
          if (subject.kind !== "bundle" || subject.pkg.name !== "cursor-to-dsh") return null;
          const zh = (document.documentElement.lang || navigator.language).startsWith("zh");
          const link = (href, label) => createElement("a", {
            href, target: "_blank", rel: "noopener noreferrer", style: { textDecoration: "underline" },
          }, label);
          return createElement("section", { "aria-label": zh ? "查看 Cursor 剩余额度" : "Check remaining Cursor usage" },
            createElement("strong", null, zh ? "查看 Cursor 剩余额度" : "Check remaining Cursor usage"),
            createElement("ul", null,
              createElement("li", null, link("https://cursor.com/dashboard/spending", zh ? "旧版 Cursor 套餐 · Spending" : "Legacy Cursor plans · Spending")),
              createElement("li", null, link("https://grok.com/dashboard", "The X Subscription · Usage")),
            ),
          );
        }));
      },
    };
  },
});
