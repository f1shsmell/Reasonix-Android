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
  // The delegation pair: one dispatches, the other reads a dispatched task's
  // prose back by page. Both belong to the 子任务 family.
  spawn_agents: "派发子任务",
  read_subagent_result: "读取子任务结果",
  // Background shells: one call starts a job, these read it, wait on it or end it.
  bash_output: "读取后台输出",
  kill_shell: "结束后台任务",
  wait: "等待后台任务",
  view_image: "查看图片",
  read_video: "查看视频",
  multi_edit: "修改文件",
  move_file: "移动文件",
  notebook_edit: "修改笔记本",
  delete_range: "删除代码",
  delete_symbol: "删除代码",
  browser_open: "打开网页",
  browser_read: "读取网页",
  browser_act: "操作网页",
  computer_read: "查看屏幕",
  computer_act: "操作电脑",
  present_files: "交付文件",
  render_chart: "生成图表",
  render_surface: "生成界面",
  submit_plan: "提交计划",
  update_goal: "更新目标",
  compress: "压缩上下文",
  context_budget: "查看上下文余量",
  ask: "提问",
  await_user: "等待你",
  conclude_no_changes: "收尾",
  read_session: "读取会话",
  list_sessions: "列出会话",
  dispatch_to_project: "派发到项目",
  send_peer_message: "发送会话消息",
  list_peers: "查看会话",
  open_projects: "打开项目",
  setting: "修改设置",
  recall: "检索记忆",
  code_index: "建立代码索引",
  import_web_image: "保存网页图片",
  read_mcp_resource: "读取 MCP 资源",
  // Stable proxy name: the target is drawn from `resolvedName` when present.
  use_capability: "按需调用工具",
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
    case "view_image":
    case "read_video":
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
    case "bash_output":
    case "kill_shell":
    case "wait":
      return "command";
    case "write_file":
    case "edit_file":
    case "apply_patch":
    case "str_replace_editor":
    case "multi_edit":
    case "move_file":
    case "notebook_edit":
    case "delete_range":
    case "delete_symbol":
      return "edit";
    case "web_search":
      return "web";
    case "fetch":
    case "web_fetch":
    case "browser_open":
    case "browser_read":
    case "import_web_image":
      return "fetch";
    case "todo_write":
    case "complete_step":
    case "submit_plan":
    case "update_goal":
    case "compress":
    case "context_budget":
    case "conclude_no_changes":
      return "task";
    case "ask_user_question":
    case "request_user_input":
    case "ask":
    case "await_user":
      return "ask";
    case "spawn_agents":
    case "read_subagent_result":
      return "agent";
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
      // A spawned task list is the call's payload; the first task's own title
      // (else its prompt) is what the row is about.
      const tasks = object.tasks;
      if (Array.isArray(tasks)) {
        const task = tasks.find(
          (entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === "object",
        );
        if (task) {
          if (typeof task.title === "string" && task.title.trim()) return oneLine(task.title);
          if (typeof task.task === "string" && task.task.trim()) return oneLine(task.task);
        }
      }
      // A proxied call's own arguments are nested under `arguments`; read those
      // rather than draw the envelope's `action` ("call") as the summary.
      const capability = object.capability_id;
      if (typeof capability === "string" && capability.trim()) {
        const nested = object.arguments;
        if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
          const inner = toolSummary({ ...row, args: JSON.stringify(nested) });
          if (inner) return inner;
        }
        return oneLine(capability);
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
