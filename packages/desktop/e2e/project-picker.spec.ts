import { test, expect } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { installDesktopRuntime, waitForDirectoryDialog } from "./support/runtime";
import { expectOpenedProject } from "../../app/e2e/support/helpers/project-picker-ui";
import { expectNewWorkspaceForAddedProject } from "../../app/e2e/support/helpers/add-project-flow";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { connectSeedClient } from "../../app/e2e/support/helpers/seed-client";

test("Browse opens the folder selected by the desktop dialog", async ({
  page,
  projectPickerFixture,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: projectPickerFixture.projectPath,
  });
  await gotoAppShell(page);

  await page.getByTestId("sidebar-add-project").click();
  const browse = page.getByRole("button", { name: /^Browse/ });
  await expect(browse).toBeVisible({ timeout: 30_000 });
  await browse.click();

  const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
  projectPickerFixture.rememberProjectId(projectId);
  await expectNewWorkspaceForAddedProject(page, {
    serverId: getServerId(),
    projectId,
    projectName: projectPickerFixture.projectName,
    projectPath: projectPickerFixture.projectPath,
  });
  const client = await connectSeedClient();
  try {
    expect((await client.fetchWorkspaces({ filter: { projectId } })).entries).toEqual([]);
  } finally {
    await client.close();
  }
});

test("canceling Browse returns to the Add Project methods", async ({
  page,
  projectPickerFixture,
}) => {
  await installDesktopRuntime(page, {
    serverId: getServerId(),
    manageBuiltInDaemon: false,
    dialogOpenResult: null,
  });
  await gotoAppShell(page);

  await page.getByTestId("sidebar-add-project").click();
  const browse = page.getByRole("button", { name: /^Browse/ });
  await expect(browse).toBeVisible({ timeout: 30_000 });
  await browse.click();

  const dialogOptions = await waitForDirectoryDialog(page);
  expect(dialogOptions).toEqual({
    createDirectory: true,
    directory: true,
    multiple: false,
  });
  await expect(browse).toBeVisible();
  await expect(
    page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: projectPickerFixture.projectName }),
  ).toHaveCount(0);
});
