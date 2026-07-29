import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "./fixtures";
import { expectAgentIdle } from "./helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { clickNewChat, gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace } from "./helpers/seed-client";
import {
  openAgentTimeline,
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineUntilOlderHistoryIsReachable,
  seedLongMockAgentTimeline,
} from "./helpers/timeline-pagination";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "./helpers/mock-agent";

interface TurnFrame {
  scrollHeight: number;
  workingVisible: boolean;
  promptVisible: boolean;
  promptTop: number | null;
  assistantVisible: boolean;
}

declare global {
  interface Window {
    __consecutiveTurnFrames?: { active: boolean; frames: TurnFrame[] };
  }
}

const test = baseTest.extend<{ tenSecondAgent: MockAgentWorkspace }>({
  tenSecondAgent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "consecutive-ten-second-turns-",
      title: "Consecutive ten-second turns",
      model: "ten-second-stream",
    });
    await provide(agent);
    await agent.cleanup();
  },
});

async function waitForTurnToComplete(page: Page, completedTurnCount: number): Promise<void> {
  await expect(page.getByText("(end of synthetic stream)", { exact: true })).toHaveCount(
    completedTurnCount + 1,
    { timeout: 30_000 },
  );
  await expectAgentIdle(page);
}

async function recordTurnFrames(page: Page, prompt: string): Promise<void> {
  await page.evaluate((promptText) => {
    const isVisible = (candidate: Element) => candidate.getBoundingClientRect().height > 0;
    // The timeline does not exist yet when a new agent is being created, so it is
    // resolved per frame rather than captured up front.
    const findScroll = () =>
      Array.from(document.querySelectorAll('[data-testid="agent-chat-scroll"]')).find(isVisible);
    const state = { active: true, frames: [] as TurnFrame[] };
    const sample = () => {
      const scroll = findScroll();
      // Re-find the row every frame: reconciliation replaces the node, and a stale
      // reference would keep reporting the position of something already detached.
      const prompt = Array.from(document.querySelectorAll('[data-testid="user-message"]')).find(
        (candidate) => isVisible(candidate) && candidate.textContent?.includes(promptText),
      );
      state.frames.push({
        scrollHeight: scroll ? scroll.scrollHeight : 0,
        workingVisible: Array.from(
          document.querySelectorAll('[data-testid="turn-working-indicator"]'),
        ).some(isVisible),
        promptVisible: Boolean(prompt),
        promptTop: prompt ? prompt.getBoundingClientRect().top : null,
        assistantVisible: Array.from(
          document.querySelectorAll('[data-testid="assistant-message"]'),
        ).some(isVisible),
      });
      if (state.active) requestAnimationFrame(sample);
    };
    window.__consecutiveTurnFrames = state;
    sample();
  }, prompt);
}

async function expectUninterruptedTurn(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const state = window.__consecutiveTurnFrames;
    if (!state) throw new Error("Turn frames were never recorded");
    state.active = false;
    const start = state.frames.findIndex((frame) => frame.promptVisible);
    // The turn ends when the working indicator goes away for good. Anything before
    // that is a blink: the footer left the layout and came back.
    const lastWorking = state.frames.reduce(
      (latest, frame, index) => (frame.workingVisible ? index : latest),
      -1,
    );
    const turn = state.frames.slice(start, lastWorking + 1);
    const blinkAt = turn.findIndex((frame) => !frame.workingVisible);
    let largestHeightDrop = 0;
    let largestHeightDropAt = -1;
    for (let index = 1; index < turn.length; index += 1) {
      const drop = turn[index - 1].scrollHeight - turn[index].scrollHeight;
      if (drop > largestHeightDrop) {
        largestHeightDrop = drop;
        largestHeightDropAt = index;
      }
    }
    return {
      start,
      blinkAt,
      largestHeightDrop,
      turnFrameCount: turn.length,
      largestHeightDropAt,
      heightsAroundDrop: turn
        .slice(Math.max(0, largestHeightDropAt - 6), largestHeightDropAt + 6)
        .map((frame) => frame.scrollHeight)
        .join(","),
    };
  });

  expect(result.start, "the submitted prompt never appeared").toBeGreaterThan(-1);
  expect(
    result.blinkAt,
    `the working indicator blinked off at frame ${result.blinkAt} of ${result.turnFrameCount} and came back`,
  ).toBe(-1);
  expect(
    result.largestHeightDrop,
    `the timeline lost ${result.largestHeightDrop}px of content mid-turn (first heights: ${result.heightsAroundDrop})`,
  ).toBe(0);
}

async function expectSubmittedPromptNeverMovedDown(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const state = window.__consecutiveTurnFrames;
    if (!state) throw new Error("Turn frames were never recorded");
    state.active = false;
    const start = state.frames.findIndex((frame) => frame.promptVisible);
    const tops = state.frames
      .slice(start)
      .map((frame) => frame.promptTop)
      .filter((top): top is number => top !== null);
    let largestDownwardShift = 0;
    let largestDownwardShiftAt = -1;
    for (let index = 1; index < tops.length; index += 1) {
      const shift = tops[index] - tops[index - 1];
      if (shift > largestDownwardShift) {
        largestDownwardShift = shift;
        largestDownwardShiftAt = index;
      }
    }
    return {
      start,
      largestDownwardShift,
      topsAroundShift: tops
        .slice(Math.max(0, largestDownwardShiftAt - 4), largestDownwardShiftAt + 4)
        .map((top) => Math.round(top))
        .join(","),
    };
  });

  expect(result.start, "the submitted prompt never appeared").toBeGreaterThan(-1);
  expect(
    Math.round(result.largestDownwardShift),
    `the submitted prompt was pushed down ${Math.round(result.largestDownwardShift)}px (tops: ${result.topsAroundShift})`,
  ).toBeLessThanOrEqual(1);
}

test("keeps the first submitted prompt in place once the assistant starts streaming", async ({
  page,
  tenSecondAgent,
}) => {
  await openAgentRoute(page, {
    workspaceId: tenSecondAgent.workspaceId,
    agentId: tenSecondAgent.agentId,
  });

  const prompt = "First prompt.";
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await composer.fill(prompt);
  await recordTurnFrames(page, prompt);
  await composer.press("Enter");

  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByTestId("assistant-message").first()).toBeVisible();
  await waitForTurnToComplete(page, 0);
  await expectSubmittedPromptNeverMovedDown(page);
});

// The first prompt of a brand new agent is submitted before the agent exists, so the
// authoritative timeline arrives after the row is already on screen. That is the only
// path where hydration can move an already-visible message.
test("keeps the first prompt of a new agent in place through authoritative hydration", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-agent-first-prompt-" });
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({ provider: "mock", providerPreferences: { mock: { mode: "load-test" } } }),
      );
    });
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);

    const prompt = "First prompt of a new agent.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await recordTurnFrames(page, prompt);
    await composer.press("Enter");

    await expect(
      page.getByTestId("user-message").filter({ hasText: prompt }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("assistant-message").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("turn-working-elapsed")).toHaveCount(1);
    await expectSubmittedPromptNeverMovedDown(page);
  } finally {
    await workspace.cleanup();
  }
});

test("keeps the turn footer and timeline height stable while a second turn runs", async ({
  page,
  tenSecondAgent,
}) => {
  await openAgentRoute(page, {
    workspaceId: tenSecondAgent.workspaceId,
    agentId: tenSecondAgent.agentId,
  });

  await submitMessage(page, "First prompt.");
  await waitForTurnToComplete(page, 0);

  const secondPrompt = "Second prompt.";
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await composer.fill(secondPrompt);
  await recordTurnFrames(page, secondPrompt);
  await composer.press("Enter");

  await expect(page.getByText(secondPrompt, { exact: true })).toBeVisible();
  await waitForTurnToComplete(page, 1);
  await expectUninterruptedTurn(page);
});

test("keeps the timeline height stable when submitting into a long timeline", async ({ page }) => {
  const agent = await seedLongMockAgentTimeline({ turns: 40 });
  try {
    await openAgentTimeline(page, agent);
    await expect(page.getByText(agent.newestPrompt, { exact: true })).toBeVisible();
    // A real long chat is fully loaded and virtualized before the user types again.
    await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
    await scrollTimelineToNewestLoadedEdge(page);

    const prompt = "Stability probe into a long timeline.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await recordTurnFrames(page, prompt);
    await composer.press("Enter");

    await expect(page.getByText(prompt, { exact: true }).last()).toBeVisible();
    // Observe the whole turn: wait for it to start before waiting for it to end.
    await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible();
    await expectAgentIdle(page, 60_000);
    await expectUninterruptedTurn(page);
  } finally {
    await agent.cleanup();
  }
});
