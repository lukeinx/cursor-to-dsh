/**
 * Browser half: Settings → Cursor (multi API keys + web tools default).
 * Built as a DSH client ModuleLoader factory (copied to lib/client.js).
 */
window.__ModuleLoader__.load({
  id: "cursor-to-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button, Input, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useEffect, useState, useSyncExternalStore } = React;

    const API = "/api/cursor-to-dsh";
    const NS = "cursor-to-dsh";
    const PLUGIN_VERSION = "0.3.0";

    const EN = {
      nav: "Cursor",
      title: "Cursor",
      intro: "Store multiple Cursor API keys here (write-only via DSH credentials). Pick which key is active, and set the default for Cursor webSearch / webFetch. Per-chat override: /cursor-web on|off in the conversation.",
      webTitle: "Web tools (default)",
      webHint: "When on, new Cursor agents may call webSearch / webFetch on Cursor's side (not DSH approvals). A chat can override with /cursor-web.",
      webOn: "Enabled",
      webOff: "Disabled",
      keysTitle: "API keys",
      keysHint: "Keys are never shown after save. Leave the input blank to keep the current key.",
      active: "Active",
      configured: "Key saved",
      missing: "Key missing",
      use: "Use",
      remove: "Remove",
      saveKey: "Save key",
      addTitle: "Add profile",
      addId: "Id",
      addLabel: "Label",
      add: "Add",
      refresh: "Refresh",
      busy: "Working…",
      placeholderKey: "Paste Cursor API key",
      placeholderId: "work",
      placeholderLabel: "Work",
      commandHint: "Chat commands: /cursor-keys, /cursor-key-set, /cursor-key-use, /cursor-web on|off, /cursor-web-default on|off.",
      pluginVersion: "Plugin version:",
      error: "Error",
    };
    const ZH = {
      nav: "Cursor",
      title: "Cursor",
      intro: "在此管理多把 Cursor API Key（经 DSH credentials 只写存储）。选择当前使用的 Key，并设置 webSearch / webFetch 的默认开关。单次对话可用 /cursor-web on|off 覆盖。",
      webTitle: "联网工具（默认）",
      webHint: "开启后，新建的 Cursor agent 可调用 Cursor 侧 webSearch / webFetch（不经 DSH 审批）。对话内可用 /cursor-web 覆盖。",
      webOn: "已开启",
      webOff: "已关闭",
      keysTitle: "API Key",
      keysHint: "保存后不会回显密钥。输入框留空表示保留现有 Key。",
      active: "使用中",
      configured: "已保存",
      missing: "未配置",
      use: "选用",
      remove: "删除",
      saveKey: "保存 Key",
      addTitle: "添加配置",
      addId: "Id",
      addLabel: "显示名",
      add: "添加",
      refresh: "刷新",
      busy: "处理中…",
      placeholderKey: "粘贴 Cursor API Key",
      placeholderId: "work",
      placeholderLabel: "工作",
      commandHint: "对话命令：/cursor-keys、/cursor-key-set、/cursor-key-use、/cursor-web on|off、/cursor-web-default on|off。",
      pluginVersion: "插件版本：",
      error: "错误",
    };

    let localeRuntime;
    const localeSubscribe = (listener) => (localeRuntime === void 0 ? () => {} : localeRuntime.subscribe(listener));
    const localeSnapshot = () => localeRuntime?.getSnapshot().revision ?? 0;
    function text(key) {
      const dictionary = localeRuntime?.getSnapshot().active === "zh" ? ZH : EN;
      return dictionary[key] ?? EN[key] ?? key;
    }
    function useLocaleRevision() {
      useSyncExternalStore(localeSubscribe, localeSnapshot, () => 0);
    }

    const css = {
      section: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 760, paddingBottom: 32 },
      title: { margin: 0, fontSize: 22, lineHeight: "30px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      intro: { margin: 0, fontSize: 14, lineHeight: "22px", color: "var(--dsw-alias-label-secondary)" },
      card: { display: "flex", flexDirection: "column", gap: 14, padding: 18, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)" },
      h3: { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      hint: { margin: 0, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      status: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
      actions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      profile: { display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2)" },
      profileTitle: { display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      field: { display: "flex", flexDirection: "column", gap: 6, minWidth: 220, flex: 1 },
      label: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      error: { margin: 0, whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-error, var(--dsw-alias-state-danger-label))" },
      versionLink: { color: "var(--dsw-alias-brand-primary)" },
    };

    async function request(path, method = "GET", body) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        cache: "no-store",
        body: body ? JSON.stringify(body) : undefined,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`Cursor settings request failed (HTTP ${response.status})`);
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error ?? `Cursor settings request failed (HTTP ${response.status})`);
      }
      return payload.value;
    }

    function CursorSettings() {
      useLocaleRevision();
      const [status, setStatus] = useState();
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState();
      const [drafts, setDrafts] = useState({});
      const [newId, setNewId] = useState("");
      const [newLabel, setNewLabel] = useState("");

      const refresh = async () => {
        try {
          const next = await request("/status");
          setStatus(next);
          setError(void 0);
          return next;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return void 0;
        }
      };

      useEffect(() => {
        let alive = true;
        request("/status").then(
          (value) => { if (alive) setStatus(value); },
          (cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); },
        );
        return () => { alive = false; };
      }, []);

      const run = async (fn) => {
        setBusy(true);
        setError(void 0);
        try {
          const next = await fn();
          if (next) setStatus(next);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy(false);
        }
      };

      const webOn = status?.enableWebTools === true;

      return jsxs("section", {
        style: css.section,
        children: [
          jsx("h2", { style: css.title, children: text("title") }),
          jsx("p", { style: css.intro, children: text("intro") }),

          jsxs("div", {
            style: css.card,
            children: [
              jsx("h3", { style: css.h3, children: text("webTitle") }),
              jsx("p", { style: css.hint, children: text("webHint") }),
              jsxs("div", {
                style: css.row,
                children: [
                  jsxs("div", {
                    style: css.status,
                    children: [
                      jsx(StateDot, { tone: webOn ? "success" : "neutral" }),
                      webOn ? text("webOn") : text("webOff"),
                    ],
                  }),
                  jsxs("div", {
                    style: css.actions,
                    children: [
                      jsx(Button, {
                        variant: webOn ? "outline" : "primary",
                        disabled: busy,
                        onClick: () => { void run(() => request("/web-default", "POST", { enabled: !webOn })); },
                        children: busy ? text("busy") : webOn ? text("webOff") : text("webOn"),
                      }),
                      jsx(Button, { variant: "outline", disabled: busy, onClick: () => { void run(refresh); }, children: text("refresh") }),
                    ],
                  }),
                ],
              }),
            ],
          }),

          jsxs("div", {
            style: css.card,
            children: [
              jsx("h3", { style: css.h3, children: text("keysTitle") }),
              jsx("p", { style: css.hint, children: text("keysHint") }),
              error ? jsx("p", { role: "alert", style: css.error, children: error }) : null,
              ...(status?.profiles ?? []).map((profile) =>
                jsxs("div", {
                  key: profile.id,
                  style: css.profile,
                  children: [
                    jsxs("div", {
                      style: css.row,
                      children: [
                        jsxs("div", {
                          style: css.profileTitle,
                          children: [
                            jsx(StateDot, { tone: profile.configured ? "success" : "danger" }),
                            `${profile.label} (${profile.id})`,
                            profile.active ? jsx("span", { style: css.meta, children: `· ${text("active")}` }) : null,
                          ],
                        }),
                        jsx("span", {
                          style: css.meta,
                          children: `${profile.configured ? text("configured") : text("missing")} · ${profile.apiKeyEnv}`,
                        }),
                      ],
                    }),
                    jsxs("div", {
                      style: css.row,
                      children: [
                        jsxs("div", {
                          style: css.field,
                          children: [
                            jsx("span", { style: css.label, children: text("saveKey") }),
                            jsx(Input, {
                              type: "password",
                              autoComplete: "new-password",
                              placeholder: text("placeholderKey"),
                              value: drafts[profile.id] ?? "",
                              disabled: busy,
                              onChange: (event) => {
                                const value = event?.target?.value ?? "";
                                setDrafts((prev) => ({ ...prev, [profile.id]: value }));
                              },
                            }),
                          ],
                        }),
                        jsxs("div", {
                          style: css.actions,
                          children: [
                            jsx(Button, {
                              variant: "primary",
                              disabled: busy || !(drafts[profile.id] || "").trim(),
                              onClick: () => {
                                void run(async () => {
                                  const key = (drafts[profile.id] || "").trim();
                                  const next = await request("/keys", "POST", { id: profile.id, label: profile.label, key });
                                  setDrafts((prev) => ({ ...prev, [profile.id]: "" }));
                                  return next;
                                });
                              },
                              children: text("saveKey"),
                            }),
                            jsx(Button, {
                              variant: "outline",
                              disabled: busy || profile.active,
                              onClick: () => { void run(() => request("/keys/use", "POST", { id: profile.id })); },
                              children: text("use"),
                            }),
                            jsx(Button, {
                              variant: "outline",
                              disabled: busy || (status?.profiles?.length ?? 0) <= 1,
                              onClick: () => { void run(() => request("/keys/remove", "POST", { id: profile.id })); },
                              children: text("remove"),
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              ),
            ],
          }),

          jsxs("div", {
            style: css.card,
            children: [
              jsx("h3", { style: css.h3, children: text("addTitle") }),
              jsxs("div", {
                style: css.row,
                children: [
                  jsxs("div", {
                    style: css.field,
                    children: [
                      jsx("span", { style: css.label, children: text("addId") }),
                      jsx(Input, {
                        value: newId,
                        placeholder: text("placeholderId"),
                        disabled: busy,
                        onChange: (event) => setNewId(event?.target?.value ?? ""),
                      }),
                    ],
                  }),
                  jsxs("div", {
                    style: css.field,
                    children: [
                      jsx("span", { style: css.label, children: text("addLabel") }),
                      jsx(Input, {
                        value: newLabel,
                        placeholder: text("placeholderLabel"),
                        disabled: busy,
                        onChange: (event) => setNewLabel(event?.target?.value ?? ""),
                      }),
                    ],
                  }),
                  jsx(Button, {
                    variant: "primary",
                    disabled: busy || !newId.trim(),
                    onClick: () => {
                      void run(async () => {
                        const next = await request("/keys/add", "POST", { id: newId.trim(), label: newLabel.trim() || undefined });
                        setNewId("");
                        setNewLabel("");
                        return next;
                      });
                    },
                    children: text("add"),
                  }),
                ],
              }),
            ],
          }),

          jsx("p", { style: css.hint, children: text("commandHint") }),
          jsxs("p", {
            style: css.hint,
            children: [
              text("pluginVersion"),
              " ",
              jsx("a", {
                href: `https://github.com/AngusFu/cursor-to-dsh/releases/tag/v${PLUGIN_VERSION}`,
                target: "_blank",
                rel: "noreferrer",
                style: css.versionLink,
                children: `cursor-to-dsh v${PLUGIN_VERSION}`,
              }),
            ],
          }),
        ],
      });
    }

    const inject = {
      locale: ["@deepseek-ai/dsh-client-locale"],
      slots: ["@deepseek-ai/dsh-client-ui-renderer"],
    };

    function apply(ctx) {
      localeRuntime = ctx.locale;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "cursor-to-dsh",
            order: 12,
            locale: NS,
            label: () => text("nav"),
          },
          CursorSettings,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
