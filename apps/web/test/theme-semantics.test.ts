import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import type { GraphNode } from "@conflux/shared";
import { StatusDot } from "../src/components/StatusDot.tsx";
import { Sidebar } from "../src/components/Sidebar.tsx";
import { SessionNode } from "../src/components/SessionNode.tsx";
import { GroupFrame } from "../src/components/GroupFrame.tsx";
import { applyThemeColors, BUILTIN_THEMES } from "../src/theme.ts";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const config = readFileSync(new URL("../tailwind.config.js", import.meta.url), "utf8");
type Rgb = number[];

function luminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(a: Rgb, b: Rgb): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function cssTokens(selector: string): Record<string, Rgb> {
  const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  return Object.fromEntries(
    [...block.matchAll(/--tk-([\w-]+):\s*([\d ]+);/g)].map((match) => [
      match[1],
      match[2].trim().split(/\s+/).map(Number),
    ]),
  );
}

for (const [mode, selector] of [
  ["light", ":root"],
  ["dark", 'html[data-theme="dark"]'],
]) {
  test(`${mode} semantic labels maintain AA contrast on panels and their soft surfaces`, () => {
    const tokens = cssTokens(selector);
    for (const semantic of ["success", "warning", "danger", "info", "neutral"]) {
      assert.ok(tokens[semantic], `${semantic} is defined`);
      for (const background of ["paper", "surface", `${semantic}-soft`]) {
        assert.ok(
          contrast(tokens[semantic], tokens[background]) >= 4.5,
          `${semantic} on ${background} meets 4.5:1`,
        );
      }
    }
  });

  test(`${mode} faint metadata stays readable on surfaces and active rows`, () => {
    const tokens = cssTokens(selector);
    const alpha = Number(config.match(/faint:\s*"rgb\(var\(--tk-ink\) \/ ([\d.]+)\)"/)?.[1]);
    for (const name of ["paper", "surface"]) {
      for (const tileAlpha of [0, 0.09]) {
        const background = tokens[name].map(
          (v, i) => v * (1 - tileAlpha) + tokens.ink[i] * tileAlpha,
        );
        const foreground = background.map((v, i) => v * (1 - alpha) + tokens.ink[i] * alpha);
        assert.ok(contrast(foreground, background) >= 4.5, `${name} metadata meets 4.5:1`);
      }
    }
  });
}

test("accent button text remains readable for every built-in palette", () => {
  for (const theme of BUILTIN_THEMES) {
    const written = new Map<string, string>();
    applyThemeColors(
      {
        dataset: {},
        style: {
          setProperty: (key, value) => void written.set(key, value),
          removeProperty: (key) => void written.delete(key),
        },
      },
      theme.colors,
    );
    const foreground = written.get("--tk-on-accent");
    assert.ok(foreground, `${theme.name} sets button foreground`);
    for (const token of ["--tk-accent", "--tk-accent-deep"]) {
      assert.ok(
        contrast(foreground.split(" ").map(Number), written.get(token)!.split(" ").map(Number)) >=
          4.5,
        `${theme.name} ${token} button meets 4.5:1`,
      );
    }
  }
});

test("session status exposes a readable label and does not treat ended sessions as errors", () => {
  for (const [status, busy, color, label] of [
    ["active", false, "success", "在线"],
    ["active", true, "warning", "忙碌"],
    ["stale", false, "neutral", "离线"],
    ["ended", false, "neutral", "已结束"],
  ] as const) {
    const markup = renderToStaticMarkup(createElement(StatusDot, { status, busy }));
    assert.match(markup, new RegExp(`bg-${color}`));
    assert.match(markup, new RegExp(`aria-label="${label}"`));
    assert.match(markup, /role="img"/);
  }
});

test("sidebar and graph nodes expose the same labeled session states", () => {
  const sessions = [
    { id: "online", status: "active", busy: false },
    { id: "busy", status: "active", busy: true },
    { id: "offline", status: "stale", busy: false },
    { id: "ended", status: "ended", busy: false },
  ].map((state) => ({
    ...state,
    name: state.id,
    type: "session",
    context_count: 0,
    pending_inbox: 0,
  })) as GraphNode[];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const sidebar = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Sidebar, {
        activeTab: "graph",
        onTabChange: () => {},
        sessions,
        selectedSessionId: null,
        onSelectSession: () => {},
      }),
    ),
  );
  for (const [index, color, label] of [
    [0, "success", "在线"],
    [1, "warning", "忙碌"],
    [2, "neutral", "离线"],
    [3, "neutral", "已结束"],
  ] as const) {
    const graph = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SessionNode, {
          id: sessions[index].id,
          data: sessions[index],
          selected: false,
          dragging: false,
        } as Parameters<typeof SessionNode>[0]),
      ),
    );
    const indicator = new RegExp(`aria-label="${label}"[^>]*bg-${color}`);
    assert.match(sidebar, indicator, `sidebar ${label}`);
    assert.match(graph, indicator, `graph ${label}`);
  }
  client.clear();
});

test("graph group summaries use success for online and neutral for offline", () => {
  for (const [activeCount, color, label] of [[2, "success", "2 在线"], [0, "neutral", "离线"]] as const) {
    const html = renderToStaticMarkup(createElement(GroupFrame, {
      data: { key: "dir:project", variant: "dir", count: 3, activeCount, expanded: false, width: 420, height: 56 },
    } as Parameters<typeof GroupFrame>[0]));
    assert.match(html, new RegExp(`text-${color}`));
    assert.match(html, new RegExp(`bg-${color}`));
    assert.match(html, new RegExp(label));
  }
});
