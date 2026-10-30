/**
 * What a tool step is called, and which family it belongs to.
 *
 * Kept apart from the React rows so the process summary can rank activities
 * without importing a component, and so one name table owns both the row title
 * and the collapsed run's wording.
 */

import type { ToolRow } from "./transcript";

const TOOL_LABELS: Record<string, string> = {
  bash: "执行命令",
  shell: "执行命令",
  execute_command: "执行命令",
  run_command: "执行命令",
  pwsh: "执行命令",
  write_stdin: "执行命令",
  read_file: "读取文件",
  view_file: "读取文件",
  read_image: "读取图片",
  write_file: "写入文件",
  edit_file: "修改文件",
  apply_patch: "修改文件",
  str_replace_editor: "修改文件",
  grep: "搜索内容",
  content_search: "搜索内容",
  glob: "查看目录",
  list_dir: "查看目录",
  ls: "查看目录",
  web_search: "搜索网页",
  fetch: "抓取网页",
  web_fetch: "抓取网页",
  todo_write: "更新任务",
  complete_step: "完成任务",
  ask_user_question: "提问",
  request_user_input: "提问",
};

export type ToolCategory =
  | "read"
  | "search"
  | "directory"
  | "command"
  | "edit"
  | "web"
  | "fetch"
  | "task"
  | "ask"
  | "agent"
  | "tool";

/** The family a run's title groups this call under. */
export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case "read_file":
    case "view_file":
    case "read_image":
      return "read";
    case "grep":
    case "content_search":
      return "search";
    case "glob":
    case "list_dir":
    case "ls":
      return "directory";
    case "bash":
    case "shell":
    case "execute_command":
    case "run_command":
    case "pwsh":
    case "write_stdin":
      return "command";
    case "write_file":
    case "edit_file":
    case "apply_patch":
    case "str_replace_editor":
      return "edit";
    case "web_search":
      return "web";
    case "fetch":
    case "web_fetch":
      return "fetch";
    case "todo_write":
    case "complete_step":
      return "task";
    case "ask_user_question":
    case "request_user_input":
      return "ask";
    default:
      return name.startsWith("subagent") ? "agent" : "tool";
  }
}

/** A short family name for the collapsed run, not the row's own title. */
export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  read: "读取",
  search: "搜索",
  directory: "查看目录",
  command: "执行命令",
  edit: "修改",
  web: "搜索网页",
  fetch: "抓取",
  task: "更新任务",
  ask: "提问",
  agent: "子任务",
  tool: "工具",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The most specific string in a call's arguments, on one line. */
export function toolSummary(row: ToolRow): string {
  const raw = row.args?.trim() ?? "";
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      for (const key of [
        "command",
        "cmd",
        "path",
        "file_path",
        "query",
        "pattern",
        "url",
        "prompt",
        "content",
      ]) {
        const value = object[key];
        if (typeof value === "string" && value.trim()) return oneLine(value);
      }
      const first = Object.values(object).find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (first) return oneLine(first);
    }
  } catch {
    // A call whose arguments are not JSON is shown as written.
  }
  return oneLine(raw);
}
