/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderDrillDownTrailingState } from "./model-browser-drill-down-state";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          "modelSelector.modelCount": "1 model",
          "modelSelector.modelCountPlural": "2 models",
          "modelSelector.loadingShort": "Loading",
          "modelSelector.error": "Error",
          "modelSelector.stale": "Stale",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("@/components/model-browser-view", () => ({
  resolveProviderDrillDownState: (selection: {
    kind: string;
    stale?: boolean;
    refreshError?: string;
    rows?: unknown[];
  }) => {
    if (selection.kind === "loading") {
      return { kind: "loading" as const };
    }
    if (selection.kind === "error") {
      return { kind: "error" as const };
    }
    if (selection.stale) {
      return {
        kind: "stale" as const,
        modelCount: selection.rows?.length ?? 0,
        refreshError: selection.refreshError,
      };
    }
    return { kind: "healthy" as const, modelCount: selection.rows?.length ?? 0 };
  },
}));

vi.mock("@/styles/theme", () => ({
  ICON_SIZE: { sm: 14, md: 20 },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web", select: (options: { default?: unknown }) => options.default },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: unknown) => unknown) =>
      typeof factory === "function"
        ? factory({
            fontSize: { sm: 13 },
            colors: { foregroundMuted: "#aaa", foreground: "#fff" },
            spacing: { 1: 4 },
          })
        : factory,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => Component,
}));

vi.mock("lucide-react-native", () => ({
  AlertTriangle: () => React.createElement("span", { "data-icon": "AlertTriangle" }),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "tooltip-content" }, children),
}));

const staleSelection = {
  kind: "models" as const,
  stale: true,
  refreshError: "ACP initialize timed out after 20000ms",
  rows: [
    {
      favoriteKey: "codex:gpt-5.4",
      provider: "codex",
      providerLabel: "Codex",
      modelId: "gpt-5.4",
      modelLabel: "GPT 5.4",
      description: "gpt-5.4",
    },
  ],
};

describe("ProviderDrillDownTrailingState", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("renders stale selection as a degraded warning state", () => {
    act(() => {
      root.render(<ProviderDrillDownTrailingState selection={staleSelection} />);
    });

    expect(container.textContent).toContain("Stale");
    expect(container.querySelector('[data-testid="model-provider-stale-state"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tooltip-content"]')?.textContent).toContain(
      "ACP initialize timed out after 20000ms",
    );
  });
});
