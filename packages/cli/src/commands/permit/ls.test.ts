import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { render } from "../../output/index.js";
import { permitLsSchema, toListItem, type PermissionListItem } from "./ls.js";

describe("permit ls", () => {
  const agent = { id: "agent-12345678-uuid" } as unknown as AgentSnapshotPayload;

  const fullPermission: AgentPermissionRequest = {
    id: "permission-1234-uuid",
    provider: "codex",
    name: "shell",
    kind: "tool",
    title: "Run shell command?",
    description: "echo hello",
    input: { command: "echo hello" },
    metadata: { workspace: "foo" },
  };

  const minimalPermission: AgentPermissionRequest = {
    id: "permission-minimal-uuid",
    provider: "codex",
    name: "shell",
    kind: "tool",
  };

  describe("toListItem", () => {
    it("keeps legacy fields for backward compatibility", () => {
      const item = toListItem(agent, fullPermission);

      expect(item.id).toBe(fullPermission.id.slice(0, 8));
      expect(item.agentId).toBe(agent.id);
      expect(item.agentShortId).toBe(agent.id.slice(0, 7));
      expect(item.name).toBe(fullPermission.name);
      expect(item.description).toBe(fullPermission.description);
    });

    it("exposes full requestId, kind, title, input, and metadata", () => {
      const item = toListItem(agent, fullPermission);

      expect(item.requestId).toBe(fullPermission.id);
      expect(item.kind).toBe("tool");
      expect(item.title).toBe("Run shell command?");
      expect(item.input).toEqual({ command: "echo hello" });
      expect(item.metadata).toEqual({ workspace: "foo" });
    });

    it("preserves the permission kind, including question", () => {
      const question: AgentPermissionRequest = {
        ...minimalPermission,
        id: "permission-question-uuid",
        kind: "question",
        title: "Continue?",
        input: { options: ["yes", "no"] },
      };
      const item = toListItem(agent, question);

      expect(item.requestId).toBe(question.id);
      expect(item.id).toBe(question.id.slice(0, 8));
      expect(item.kind).toBe("question");
      expect(item.title).toBe("Continue?");
      expect(item.input).toEqual({ options: ["yes", "no"] });
    });

    it("falls back missing optional fields to null or '-'", () => {
      const item = toListItem(agent, minimalPermission);

      expect(item.title).toBeNull();
      expect(item.input).toBeNull();
      expect(item.metadata).toBeNull();
      expect(item.description).toBe("-");
    });
  });

  describe("permitLsSchema", () => {
    it("keeps table columns unchanged", () => {
      expect(permitLsSchema.idField).toBe("id");
      const fields: string[] = [];
      for (const column of permitLsSchema.columns) {
        fields.push(String(column.field));
      }
      expect(fields).toEqual(["agentShortId", "id", "name", "description"]);
    });

    it("renders JSON with full requestId, kind, title, input, metadata and legacy fields", () => {
      const result = {
        type: "list" as const,
        data: [toListItem(agent, fullPermission)],
        schema: permitLsSchema,
      };

      const json = JSON.parse(render(result, { format: "json" }));

      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(1);

      const [row] = json as [PermissionListItem];
      expect(row.id).toBe(fullPermission.id.slice(0, 8));
      expect(row.requestId).toBe(fullPermission.id);
      expect(row.agentId).toBe(agent.id);
      expect(row.agentShortId).toBe(agent.id.slice(0, 7));
      expect(row.name).toBe(fullPermission.name);
      expect(row.description).toBe(fullPermission.description);
      expect(row.kind).toBe("tool");
      expect(row.title).toBe("Run shell command?");
      expect(row.input).toEqual({ command: "echo hello" });
      expect(row.metadata).toEqual({ workspace: "foo" });
    });

    it("renders missing optional fields as null in JSON", () => {
      const result = {
        type: "list" as const,
        data: [toListItem(agent, minimalPermission)],
        schema: permitLsSchema,
      };

      const json = JSON.parse(render(result, { format: "json" }));
      const [row] = json as [PermissionListItem];

      expect(row.title).toBeNull();
      expect(row.input).toBeNull();
      expect(row.metadata).toBeNull();
      expect(row.description).toBe("-");
    });

    it("uses the short id for quiet mode", () => {
      const result = {
        type: "list" as const,
        data: [toListItem(agent, fullPermission)],
        schema: permitLsSchema,
      };

      const quiet = render(result, { format: "json", quiet: true });
      expect(quiet.trim()).toBe(fullPermission.id.slice(0, 8));
    });
  });
});
